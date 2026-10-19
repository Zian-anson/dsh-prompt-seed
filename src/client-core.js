/** Browser-safe feature controllers. Each instance owns one (conversation, kind). */
const COPY_FIELDS = ['source', 'ref', 'offset', 'length', 'label', 'appearance', 'clipboardText', 'invalid'];
const copy = (value) => JSON.parse(JSON.stringify(value));
const editable = (input) => input && (input.phase === undefined || input.phase === 'plain' || input.phase === 'claimed');

export function draftDocument(input) {
  const references = (input.occurrences ?? []).map((item) => Object.fromEntries(COPY_FIELDS.filter((field) => item[field] !== undefined).map((field) => [field, item[field]])));
  const token = input.claim?.token;
  return { text: String(input.draft ?? ''), references, ...(typeof token === 'string' ? { command: { token } } : {}) };
}

/** Relocate intact chip spellings; ambiguous or missing references never become plain text. */
export function rewriteDocument(original, text, semanticSupported) {
  if (!original || typeof text !== 'string') return null;
  if ((original.references.length || original.command) && !semanticSupported) return null;
  if (original.command && !text.startsWith(original.command.token.trimEnd())) return null;
  const groups = new Map();
  for (const ref of original.references) {
    if (typeof ref.clipboardText !== 'string' || !ref.clipboardText || original.text.slice(ref.offset, ref.offset + ref.length) !== ref.clipboardText) return null;
    const list = groups.get(ref.clipboardText) ?? [];
    list.push(ref);
    groups.set(ref.clipboardText, list);
  }
  const references = [];
  for (const [spelling, group] of groups) {
    const positions = [];
    for (let at = text.indexOf(spelling); at >= 0; at = text.indexOf(spelling, at + spelling.length)) positions.push(at);
    if (positions.length !== group.length) return null;
    group.forEach((ref, index) => references.push({ ...ref, offset: positions[index] }));
  }
  references.sort((a, b) => a.offset - b.offset);
  let end = original.command?.token.trimEnd().length ?? 0;
  for (const ref of references) {
    if (ref.offset < end) return null;
    end = ref.offset + ref.length;
  }
  return { text, references, ...(original.command ? { command: copy(original.command) } : {}) };
}

function stamp(input) {
  return { key: input.key, rev: input.draftRev, document: draftDocument(input), attachments: JSON.stringify(input.attachmentIds ?? input.imageIds ?? []) };
}
function matches(input, before) {
  return Boolean(before && input.key === before.key && Number.isFinite(before.rev) && input.draftRev === before.rev &&
    JSON.stringify(draftDocument(input)) === JSON.stringify(before.document) &&
    JSON.stringify(input.attachmentIds ?? input.imageIds ?? []) === before.attachments);
}
const initialState = () => ({ status: 'idle', jobId: null, preview: '', note: '', error: '', original: null, candidate: null, pending: null, originalMessageId: null, originalJobId: null, contextAvailable: false });

export function createFeatureController(kind, options) {
  let io = options;
  let identity = { key: options.key, sessionId: options.sessionId };
  let state = initialState();
  let active = false;
  let auto = null;
  let autoOwner = null;
  let attempt = null;
  let generation = 0;
  let cancelled = false;
  let cancelPromise = null;
  let applied = null;
  let baselineKnown = false;
  let lastMessageId = null;
  let sawSubmission = false;
  let refreshInFlight = null;
  const listeners = new Set();
  const handled = new Set();
  const storageKey = () => 'prompt-seed:v2:' + identity.key + ':' + kind;
  try {
    const saved = JSON.parse(io.storage?.getItem(storageKey()) ?? 'null');
    if (saved && ['idle', 'running', 'ready', 'applied', 'error', 'neutral'].includes(saved.status)) state = { ...initialState(), ...saved };
  } catch { /* storage is optional */ }
  function persist() {
    try { io.storage?.setItem(storageKey(), JSON.stringify(state)); } catch { /* full/disabled storage */ }
  }
  function update(patch) {
    state = { ...state, ...patch };
    persist();
    for (const listener of listeners) listener(state);
  }
  function input() { return io.readInput(); }
  function ownsInput() { return active && input()?.key === identity.key; }
  function untouched() { return ownsInput() && state.candidate !== null && matches(input(), applied); }
  function payload(extra = {}) { return { kind, sessionId: identity.sessionId, conversationKey: identity.key, ...extra }; }
  function consume(id) { void io.post(payload({ action: 'consume', jobId: id })).catch(() => {}); }
  function safeDocument(original, text) {
    const document = rewriteDocument(original, text, io.semanticSupported);
    if (!document) return null;
    // Explicit replacement replaces prose, not newly inserted semantic references.
    const current = draftDocument(input());
    const signature = ({ offset, length, ...ref }) => JSON.stringify(ref);
    const remaining = document.references.map(signature);
    for (const ref of current.references) {
      const index = remaining.indexOf(signature(ref));
      if (index < 0) return null;
      remaining.splice(index, 1);
    }
    if (current.command && current.command.token !== document.command?.token) return null;
    return document;
  }
  function applyPending(explicit = false) {
    const pending = state.pending;
    if (!pending || !ownsInput() || !editable(input())) return false;
    if (!explicit && !matches(input(), auto)) return false;
    const document = safeDocument(pending.original, pending.text);
    if (!document) { update({ status: 'ready', note: '引用无法安全还原，请查看结果', error: '' }); return false; }
    const before = input();
    const beforeStamp = stamp(before);
    const noChange = JSON.stringify(draftDocument(before)) === JSON.stringify(document);
    // Same text needs no editor transaction, especially for an already precise request.
    applied = { ...beforeStamp, document, rev: before.draftRev + (noChange ? 0 : 1) };
    update({ status: pending.changed === false ? 'neutral' : 'applied', original: pending.original,
      candidate: document, pending: null, preview: '', jobId: null, error: '',
      note: pending.changed === false ? '已清楚，保留原文' : (kind === 'predict' ? '已填入预测，可编辑后发送' : '已优化'),
      originalMessageId: lastMessageId });
    try {
      if (!noChange) io.writeInput(document.references.length || document.command ? document : document.text);
      io.persistDraft?.();
    } catch {
      applied = null;
      update({ status: 'ready', pending, error: '无法写入输入框，请查看结果' });
      return false;
    }
    consume(pending.jobId);
    return true;
  }
  function receive(job) {
    if (!job || job.kind !== kind || (job.sessionId ? job.sessionId !== identity.sessionId : job.conversationKey !== identity.key)) return;
    if (job.consumed || handled.has(job.id)) return;
    if (cancelled && (state.jobId === job.id || attempt?.runId === job.runId)) { void cancelKnown(job.id); return; }
    if (job.status === 'running') {
      update({ status: 'running', jobId: job.id, preview: job.partialText ?? '', error: '' });
      return;
    }
    handled.add(job.id);
    const result = job.result;
    if (result?.ok === true && typeof result.text === 'string') {
      const original = attempt?.jobId === job.id ? attempt.original
        : kind === 'predict' ? { text: '', references: [] }
        : state.originalJobId === job.id ? state.original : { text: job.inputText ?? '', references: [] };
      update({ status: 'ready', jobId: job.id, preview: '', error: '', note: '结果已就绪 · 查看结果',
        pending: { original, text: result.text, changed: result.changed, jobId: job.id } });
      applyPending();
    } else {
      const neutral = ['nothing_to_optimize', 'cannot_predict', 'cancelled'].includes(result?.code);
      update({ status: neutral ? 'neutral' : 'error', jobId: null, preview: '', pending: null,
        error: neutral ? '' : (result?.error ?? job.error ?? '生成失败，未修改草稿'),
        note: neutral ? (result?.code === 'cancelled' ? '已取消' : result?.code === 'cannot_predict' ? '暂时无法预测' : '这条消息不需要优化') : '' });
    }
  }
  async function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const version = generation;
      const previousJobId = state.jobId;
      try {
        const res = await io.post(payload({ action: 'status' }));
        if (version !== generation) return;
        if (!res?.ok) throw new Error('状态同步失败');
        const messageId = res.lastUserMessageId ?? null;
        update({ contextAvailable: res.contextKnown === true && res.hasAssistant === true });
        if (baselineKnown && messageId !== null && messageId !== lastMessageId) {
          auto = null;
          applied = null;
          // A new persisted user message, not a temporary submitting phase, commits cleanup.
          update({ original: null, candidate: null, pending: null, originalMessageId: messageId });
          if (res.job?.id) { handled.add(res.job.id); consume(res.job.id); } update({ status: 'idle', jobId: null, note: '', preview: '' });
        } else if (!baselineKnown && state.originalMessageId !== null && messageId !== null && state.originalMessageId !== messageId) {
          update({ original: null, candidate: null, pending: null, originalMessageId: messageId });
          if (res.job?.id) { handled.add(res.job.id); consume(res.job.id); } update({ status: 'idle', jobId: null, note: '', preview: '' });
        }
        baselineKnown = true;
        lastMessageId = messageId;
        if (res.job) receive(res.job);
        else if (state.jobId && state.jobId === previousJobId) {
          auto = null;
          update({ status: 'idle', jobId: null, pending: null, preview: '', note: '任务已过期，请重试' });
        }
      } catch { if (version === generation) update({ error: '状态同步失败，可再次点击重试' }); }
      finally { refreshInFlight = null; }
    })();
    return refreshInFlight;
  }
  async function cancelKnown(id) {
    if (!id || cancelPromise) return cancelPromise;
    cancelPromise = (async () => {
      try {
        const res = await io.post(payload({ action: 'cancel', jobId: id }));
        if (!res?.ok) throw new Error('取消失败');
        handled.add(id);
        update({ status: 'neutral', jobId: null, preview: '', pending: null, note: '已取消', error: '' });
      } catch { cancelled = false; update({ error: '取消失败，请重试' }); }
      finally { cancelPromise = null; }
    })();
    return cancelPromise;
  }
  return {
    kind,
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    attach(next = {}) {
      if (autoOwner !== (next.inputIdentity ?? io.inputIdentity)) auto = null;
      io = { ...io, ...next }; active = true;
      return refresh().then(() => { if (state.pending) applyPending(); });
    },
    detach() { active = false; },
    observe(current) {
      if (!current || current.key !== identity.key) return;
      if (applied && !matches(current, applied)) { applied = null; if (state.status !== 'running' && !state.pending) update({ status: 'idle', note: '', error: '' }); }
      if (auto && !matches(current, auto)) auto = null;
      if (!editable(current)) { sawSubmission = true; auto = null; }
      else if (sawSubmission) { sawSubmission = false; void refresh(); }
    },
    untouched,
    canRun(contextAvailable = true) {
      if (!ownsInput() || !editable(input()) || state.status === 'running') return false;
      if (kind === 'optimize') return input().draft.trim() !== '';
      return Boolean(identity.sessionId && contextAvailable && (input().draft.trim() === '' || untouched()));
    },
    async run(contextAvailable = true) {
      if (!this.canRun(contextAvailable)) return false;
      const source = kind === 'predict' ? { text: '', references: [] }
        : untouched() && state.original ? copy(state.original) : draftDocument(input());
      const thisGeneration = ++generation;
      auto = stamp(input());
      autoOwner = io.inputIdentity;
      cancelled = false;
      attempt = { original: source, jobId: null };
      update({ status: 'running', jobId: null, error: '', note: '', preview: '', pending: null, original: source });
      const runId = 'r-' + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));
      attempt.runId = runId;
      try {
        const result = await io.stream(payload({ action: kind, text: source.text, stream: true, runId }), (event) => {
          if (thisGeneration !== generation) return;
          if (event.type === 'meta' && event.jobId) {
            attempt.jobId = event.jobId;
            update({ jobId: event.jobId, originalJobId: event.jobId });
            if (cancelled) void cancelKnown(event.jobId);
            else io.onStarted?.(event.jobId);
          }
          if (cancelled) return;
          if (event.type === 'delta') update({ preview: (state.preview + (event.text ?? '')).slice(-600) });
          if (event.type === 'final') {
            if (!attempt.jobId) attempt.jobId = event.jobId;
            receive({ id: event.jobId, kind, sessionId: identity.sessionId, conversationKey: identity.key, inputText: source.text,
              status: event.ok ? 'done' : 'failed', result: event });
          }
        });
        if (thisGeneration !== generation) return false;
        if (cancelled) { if (result?.job?.id) await cancelKnown(result.job.id); return false; }
        if (result?.code === 'job_running') { auto = null; attempt = null; receive(result.job); }
        else if (result?.code && result.type !== 'final') {
          update({ status: result.code === 'cannot_predict' ? 'neutral' : 'error', note: result.code === 'cannot_predict' ? '暂时无法预测' : '', error: result.code === 'cannot_predict' ? '' : result.error });
        } else if (state.status === 'running') await refresh();
      } catch (error) {
        if (thisGeneration !== generation) return false;
        if (state.jobId) { update({ error: '连接中断，任务继续；正在恢复状态' }); await refresh(); }
        else {
          auto = null;
          update({ status: 'error', error: error?.message ?? '连接失败，未修改草稿', preview: '' });
          await refresh();
        }
      }
      return true;
    },
    cancel() { cancelled = true; auto = null; update({ note: '正在取消…' }); return cancelKnown(state.jobId); },
    refresh,
    receive,
    previewOriginal: () => state.original?.text ?? '',
    canRestore() { return Boolean(state.original && ownsInput() && editable(input()) && safeDocument(state.original, state.original.text)); },
    canReplace() { return Boolean(state.pending && ownsInput() && editable(input()) && safeDocument(state.pending.original, state.pending.text)); },
    replace() { return applyPending(true); },
    restore(explicit = false) {
      if (kind !== 'optimize' || !state.original || !ownsInput() || !editable(input())) return false;
      if (!explicit && !untouched()) return false;
      const document = safeDocument(state.original, state.original.text);
      if (!document) return false;
      io.writeInput(document.references.length || document.command ? document : document.text);
      io.persistDraft?.();
      applied = null;
      update({ candidate: null, status: 'idle', note: '已恢复原文' });
      return true;
    },
    withdraw() {
      if (kind !== 'predict' || !untouched() || !editable(input())) return false;
      io.writeInput('');
      io.persistDraft?.();
      applied = null;
      update({ status: 'idle', candidate: null, note: '已撤回预测' });
      return true;
    },
    async bind(sessionId, key = 's:' + sessionId) {
      const res = await io.post(payload({ action: 'bind', sessionId }));
      if (!res?.ok || !res.job) return false;
      const previousKey = storageKey();
      identity = { sessionId, key };
      auto = null; // A remounted editor's revision is a different clock.
      try { io.storage?.removeItem(previousKey); } catch { /* optional */ }
      update({});
      return true;
    },
  };
}

/** Same parser is used by both transports; it owns no feature state. */
export async function readEventResponse(response, onEvent) {
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error ?? ('HTTP ' + response.status));
  }
  if (!String(response.headers.get('content-type')).includes('application/x-ndjson')) {
    const result = await response.json();
    if (result?.type === 'final') onEvent(result);
    return result;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final = null;
  const line = (value) => {
    if (!value.trim()) return;
    const event = JSON.parse(value);
    onEvent(event);
    if (event.type === 'final') final = event;
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    }
    buffer += decoder.decode();
    line(buffer);
    return final;
  } finally { reader.releaseLock(); }
}
