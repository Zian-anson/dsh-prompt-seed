/** Browser UI: independent rewrite and prediction controls over safe shared primitives. */
const ROUTE = '/api/prompt-seed/optimize';
const CLIENT_VERSION = '0.21.1';
const controllers = new Map();
const creating = new Set();
const memoryDraftKeys = new Map();
function storage() { try { return window.sessionStorage; } catch { return undefined; } }
function stored(key) { try { return storage()?.getItem(key); } catch { return null; } }
function save(key, value) { try { storage()?.setItem(key, value); } catch { /* optional */ } }
function remove(key) { try { storage()?.removeItem(key); } catch { /* optional */ } }
function postJson(body) {
  return fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  });
}
function probeComposerButton() {
  // Fail-open: a probe failure keeps the built-in tools visible; only an
  // explicit ui.composerButton === false marks the optimize entry as
  // host-owned. Prediction is never host-owned and stays available either
  // way. Synchronous failures (e.g. fetch unavailable) must not escape
  // apply either.
  try {
    return postJson({ action: 'status', conversationKey: 'prompt-seed:probe' }).then(
      (data) => data?.ui?.composerButton === false,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

async function streamRequest(body, onEvent) {
  const response = await fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
  return readEventResponse(response, onEvent);
}
function draftKey(workspaceId) {
  const name = 'prompt-seed:unbound:v2:' + (workspaceId || 'default');
  let key = stored(name);
  if (!key) {
    key = memoryDraftKeys.get(name) ?? ('draft:' + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)));
    memoryDraftKeys.set(name, key);
    save(name, key);
  }
  return key;
}
function SparkIcon() {
  return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' }, [
    React.createElement('path', { key: 'p', d: 'M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2z', fill: 'currentColor' }),
  ]);
}

function CrystalIcon() {
  return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': 'true' }, [
    React.createElement('circle', { key: 'c', cx: 12, cy: 9.8, r: 6.2 }),
    React.createElement('path', { key: 'g', d: 'M9.6 8.4a3 3 0 0 1 2.3-1.4' }),
    React.createElement('path', { key: 'b', d: 'M9.1 15.5l-.9 3.3h7.6l-.9-3.3' }),
  ]);
}

function SpinnerIcon() {
  return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', className: 'dsh-opt-spin' }, [
    React.createElement('circle', { key: 't', cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', strokeWidth: 2.4, opacity: 0.18 }),
    React.createElement('path', { key: 'a', d: 'M20.5 12a8.5 8.5 0 0 0-8.5-8.5', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' }),
  ]);
}

function MoreIcon() {
  return React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' }, [
    ...[5, 12, 19].map((cx) => React.createElement('circle', { key: cx, cx, cy: 12, r: 1.8 })),
  ]);
}

const CSS = `
.ps-tools{position:relative;display:inline-flex;align-items:center;gap:2px;color:inherit}
.ps-button{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;padding:5px;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer}
.ps-button:hover:not(:disabled){background:rgba(127,127,127,.14)}
.ps-button:focus-visible,.ps-panel button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.ps-button:disabled{opacity:.3;cursor:default}
.ps-secondary{opacity:.65;min-width:26px}
.ps-status{font-size:12px;line-height:1.4;white-space:nowrap;opacity:.72}
.ps-pending{color:#326bd6;opacity:1}
.ps-pending::after{content:"";position:absolute;right:2px;top:2px;width:5px;height:5px;border-radius:50%;background:currentColor}
.ps-secondary{position:relative}
.ps-error{color:var(--color-danger,#bc4747);opacity:1}
.ps-panel{position:absolute;z-index:100;right:0;bottom:calc(100% + 10px);width:360px;max-width:calc(100vw - 36px);padding:16px;border:1px solid rgba(127,127,127,.25);border-radius:12px;background:var(--background-color,#fff);color:var(--text-color,#252525);box-shadow:0 10px 36px #0002}
.ps-panel-title{font-size:13px;font-weight:600;margin:0 0 12px}
.ps-result{white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;font-size:14px;line-height:1.65;margin:0 0 14px;user-select:text}
.ps-panel-hint{font-size:13px;line-height:1.5;margin:0 0 12px;opacity:.75}
.ps-panel-actions{display:flex;justify-content:flex-end;gap:8px}
.ps-panel button{font:inherit;font-size:13px;border:1px solid #8884;background:transparent;color:inherit;border-radius:6px;padding:5px 10px;cursor:pointer}
.ps-panel button:disabled{opacity:.4;cursor:default}
.ps-panel .ps-primary{background:#326bd6;color:#fff;border-color:#326bd6}
.ps-actions{width:160px;padding:6px;display:flex;flex-direction:column;gap:2px}
.ps-actions button{border:0;padding:8px 10px;text-align:left}
.ps-actions button:hover{background:rgba(127,127,127,.12)}
.dsh-opt-spin{animation:ps-spin .9s linear infinite}
@keyframes ps-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.dsh-opt-spin{animation:none}}
@media(prefers-color-scheme:dark){.ps-panel{background:var(--background-color,#262626);color:var(--text-color,#eee)}}
`;
function injectStyles() {
  if (typeof document === 'undefined') return () => {};
  if (document.getElementById('dsh-prompt-seed-style')) return () => {};
  const el = document.createElement('style');
  el.id = 'dsh-prompt-seed-style'; el.textContent = CSS; document.head.appendChild(el);
  return () => el.remove();
}

/** One contextual entry; feature controllers retain separate lifecycles and recovery. */
function ComposerControls({ tools, input, canPredict, hostOwnsOptimize }) {
  const [states, setStates] = React.useState(() => tools.map(({ controller }) => controller.getState()));
  const [panel, setPanel] = React.useState(null);
  const anchor = React.useRef(null);
  React.useEffect(() => {
    const unsubscribers = tools.map(({ controller }, index) => controller.subscribe((next) => {
      setStates((previous) => previous.map((state, i) => i === index ? next : state));
    }));
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  }, [tools]);
  React.useEffect(() => {
    if (!panel || typeof document === 'undefined') return undefined;
    const dismiss = (event) => { if (anchor.current && !anchor.current.contains(event.target)) setPanel(null); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [panel]);
  // A host-owned optimize entry (ui.button=false, e.g. dsh-composer-optimize)
  // leaves prediction as the only built-in tool; the ✦ entry stays with the host.
  const selected = hostOwnsOptimize ? 1 : (input.draft.trim() ? 0 : 1);
  const controller = tools[selected].controller;
  const state = states[selected];
  const prediction = selected === 1;
  const busy = state.status === 'running';
  const ready = state.pending !== null;
  const eligible = (index) => index === 0 || (canPredict && states[index].contextAvailable);
  const label = busy ? (prediction ? '预测中' : '优化中') + ' · 点击取消'
    : ready ? (prediction ? '查看预测结果' : '查看优化结果')
      : controller.untouched() ? (prediction ? '换一句' : '换一版') : (prediction ? '预测下一句' : '优化提示词');
  const notice = busy ? '' : state.error ? '失败'
    : state.status === 'neutral' ? ({ '已清楚，保留原文': '未改动', '暂时无法预测': '暂无预测', '这条消息不需要优化': '无需优化' }[state.note] ?? '') : '';
  const detail = state.error || (state.status === 'neutral' ? state.note : '');
  // Host-owned optimize: render nothing where prediction is not meaningful —
  // but a running, pending or failed prediction stays reachable for cancel,
  // retrieval and error reading, and an untouched applied prediction keeps
  // its 换一句/撤回预测 actions.
  if (hostOwnsOptimize && input.draft.trim() && !tools[1].controller.untouched()
    && states[1].status !== 'running' && !states[1].pending && !states[1].error) return null;
  const actions = [];
  for (let index = 0; index < tools.length; index++) {
    if (hostOwnsOptimize && index === 0) continue; // the host owns the optimize entry
    const feature = tools[index].controller;
    const featureState = states[index];
    const name = index === 0 ? '优化' : '预测';
    if (index !== selected && featureState.status === 'running') actions.push({ id: 'cancel-' + feature.kind, text: '取消' + name, run: () => { void feature.cancel(); setPanel(null); } });
    else if (index !== selected && featureState.pending) actions.push({ id: 'view-' + feature.kind, text: '查看' + name + '结果', run: () => setPanel({ mode: 'result', index }) });
    else if (index !== selected && featureState.error) actions.push({ id: 'error-' + feature.kind, text: name + '失败', run: () => setPanel({ mode: 'error', index }) });
    if (featureState.status === 'running') continue;
    if (index === 0 && featureState.original && featureState.original.text !== input.draft) actions.push({ id: 'undo', text: '恢复原文', run: () => { if (feature.restore()) setPanel(null); else setPanel({ mode: 'original', index }); } });
    if (index === 1 && feature.untouched()) {
      if (feature.canRun(eligible(index))) actions.push({ id: 'again-predict', text: '换一句', run: () => { setPanel(null); void feature.run(eligible(index)); } });
      actions.push({ id: 'withdraw', text: '撤回预测', run: () => { feature.withdraw(); setPanel(null); } });
    }
  }
  const other = states[1 - selected];
  const otherName = prediction ? '优化' : '预测';
  const moreLabel = hostOwnsOptimize ? '预测操作'
    : other.status === 'running' ? otherName + '中 · 草稿操作' : other.pending ? otherName + '结果待取 · 草稿操作' : other.error ? otherName + '失败 · 草稿操作' : '草稿操作';
  const moreState = hostOwnsOptimize ? state : other;
  const children = [React.createElement('button', {
    key: 'main', type: 'button', className: 'ps-button', title: detail ? detail + ' · ' + label : label, 'aria-label': label,
    'data-testid': 'prompt-seed-' + controller.kind, 'data-client-version': CLIENT_VERSION,
    disabled: !busy && !ready && !controller.canRun(eligible(selected)), onClick: () => {
      setPanel(null);
      if (busy) { void controller.cancel(); return; }
      if (ready) { setPanel({ mode: 'result', index: selected }); return; }
      void controller.run(eligible(selected));
    },
  }, React.createElement(busy ? SpinnerIcon : prediction ? CrystalIcon : SparkIcon))];
  if (actions.length) children.push(React.createElement('button', {
    key: 'more', type: 'button', className: 'ps-button ps-secondary' + (moreState.pending ? ' ps-pending' : moreState.error ? ' ps-error' : ''),
    title: moreLabel, 'aria-label': moreLabel, 'aria-expanded': panel?.mode === 'actions', 'aria-haspopup': 'dialog',
    'data-testid': 'prompt-seed-more', onClick: () => setPanel(panel?.mode === 'actions' ? null : { mode: 'actions' }),
  }, React.createElement(other.status === 'running' ? SpinnerIcon : MoreIcon)));
  if (notice) children.push(React.createElement('span', { key: 'notice', className: 'ps-status' + (state.error ? ' ps-error' : ''), title: detail, role: 'status' }, notice));
  if (panel?.mode === 'actions' && actions.length) children.push(React.createElement('div', {
    key: 'actions', role: 'dialog', 'aria-label': '草稿操作', className: 'ps-panel ps-actions',
  }, [
    ...actions.map((action) => React.createElement('button', { key: action.id, type: 'button', 'data-testid': 'prompt-seed-' + action.id, onClick: action.run }, action.text)),
    React.createElement('button', { key: 'close', type: 'button', onClick: () => setPanel(null) }, '关闭'),
  ]));
  else if (panel && panel.mode !== 'actions') {
    const feature = tools[panel.index].controller;
    const featureState = states[panel.index];
    const original = panel.mode === 'original';
    const error = panel.mode === 'error';
    const text = original ? feature.previewOriginal() : error ? featureState.error : featureState.pending?.text;
    const canReplace = !error && (original ? feature.canRestore() : feature.canReplace());
    const title = original ? '原文预览' : (panel.index === 0 ? '优化' : '预测') + (error ? '失败' : '结果');
    if (typeof text === 'string' && text) children.push(React.createElement('div', { key: 'panel', role: 'dialog', 'aria-label': title, className: 'ps-panel' }, [
      React.createElement('div', { key: 'title', className: 'ps-panel-title' }, title),
      React.createElement('div', { key: 'text', className: 'ps-result' }, text),
      !error && !canReplace && React.createElement('div', { key: 'hint', className: 'ps-panel-hint' }, '无法安全替换，可复制所需文字。'),
      React.createElement('div', { key: 'buttons', className: 'ps-panel-actions' }, [
        React.createElement('button', { key: 'close', type: 'button', onClick: () => setPanel(null) }, '关闭'),
        !error && React.createElement('button', { key: 'apply', type: 'button', className: 'ps-primary',
          disabled: !canReplace, 'data-testid': 'prompt-seed-replace-' + feature.kind,
          onClick: () => { if (original ? feature.restore(true) : feature.replace()) setPanel(null); },
        }, '替换草稿'),
      ]),
    ]));
  }
  return React.createElement('span', { ref: anchor, className: 'ps-tools', 'aria-label': '提示词工具',
    onKeyDown: (event) => { if (event.key === 'Escape') setPanel(null); },
  }, children);
}

function ComposerTools(props) {
  const input = props.useInput((state) => state);
  const session = typeof props.useSession === 'function' ? props.useSession((state) => state) : props.session;
  const sessionId = props.sessionId || session?.sessionId || session?.id || props.session?.id;
  const workspaceId = props.workspaceId || session?.workspaceId;
  const key = sessionId ? 's:' + sessionId : draftKey(workspaceId);
  const current = React.useRef(null);
  current.current = { ...input, key };
  const tools = React.useMemo(() => {
    return ['optimize', 'predict'].map((kind) => {
      const name = key + ':' + kind;
      const io = {
        key, sessionId, inputIdentity: props.inputActions, storage: storage(), semanticSupported: typeof props.inputActions.persistDraft === 'function',
        readInput: () => current.current,
        writeInput: (doc) => props.inputActions.setDraft(doc),
        persistDraft: () => props.inputActions.persistDraft?.(),
        post: postJson, stream: streamRequest,
      };
      let controller = controllers.get(name);
      if (!controller) { controller = createFeatureController(kind, io); controllers.set(name, controller); }
      return { controller, io };
    });
  }, [key, props.inputActions]);

  React.useEffect(() => {
    const handoffKey = 'prompt-seed:handoff:' + sessionId;
    const unsentKey = 'prompt-seed:unsent:' + key;
    const saved = stored(sessionId ? handoffKey : unsentKey);
    if (saved && !current.current.draft && !(current.current.attachmentIds?.length)) {
      try { const doc = JSON.parse(saved); if (typeof doc?.text === 'string' && Array.isArray(doc.references) && (!(doc.references.length || doc.command) || typeof props.inputActions.persistDraft === 'function')) props.inputActions.setDraft(doc.references.length || doc.command ? doc : doc.text); } catch { /* invalid handoff */ }
    }
    if (sessionId) remove(handoffKey);
    for (const entry of tools) {
      entry.io.onStarted = () => {
        if (sessionId || entry.controller.kind !== 'optimize' || creating.has(key) || !props.sessionApi?.available) return;
        creating.add(key);
        void (async () => {
          try {
            const created = await props.sessionApi.create(workspaceId ? { workspaceId } : props.cwd ? { cwd: props.cwd } : {});
            const newId = created?.sessionId || created?.id;
            if (!newId) throw new Error('创建对话未返回标识');
            const live = current.current;
            const doc = live.key === key ? draftDocument(live) : JSON.parse(stored(unsentKey) || 'null');
            if (doc) save('prompt-seed:handoff:' + newId, JSON.stringify(doc));
            if (await entry.controller.bind(newId)) {
              controllers.delete(key + ':optimize');
              controllers.set('s:' + newId + ':optimize', entry.controller);
            }
            if (current.current.key === key) props.sessionApi.open(newId);
            remove('prompt-seed:unbound:v2:' + (workspaceId || 'default'));
            memoryDraftKeys.delete('prompt-seed:unbound:v2:' + (workspaceId || 'default'));
          } catch (error) {
            console.warn('[prompt-seed] session handoff failed; generation remains in the original draft', error);
          } finally { creating.delete(key); }
        })();
      };
      void entry.controller.attach(entry.io);
    }
    const refresh = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') for (const entry of tools) void entry.controller.refresh();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh);
    const timer = setInterval(() => {
      for (const entry of tools) if (entry.controller.getState().status === 'running') void entry.controller.refresh();
    }, 1200);
    return () => {
      clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refresh);
      for (const entry of tools) entry.controller.detach();
    };
  }, [tools]);
  React.useEffect(() => {
    for (const entry of tools) entry.controller.observe(current.current);
    if (!sessionId) save('prompt-seed:unsent:' + key, JSON.stringify(draftDocument(current.current)));
  }, [input, tools, key, sessionId]);
  React.useEffect(() => { for (const entry of tools) void entry.controller.refresh(); }, [session?.running, session?.pendingSubmissions?.length]);
  const canPredict = session?.blank !== true && session?.running !== true && session?.awaitingFirstTurn !== true;
  return React.createElement(ComposerControls, { key, tools, input, canPredict, hostOwnsOptimize: props.hostOwnsOptimize === true });
}

function apply(ctx) {
  try {
    ctx.effect(injectStyles, 'prompt-seed:styles');
    ctx.inject(['slots', 'sessions', 'uiWorkspace'], (scope) => {
      const sessions = scope.sessions;
      const workspace = scope.uiWorkspace;
      const sessionApi = {
        available: typeof sessions?.create === 'function' && typeof workspace?.openSession === 'function',
        create: (request) => sessions.create(request), open: (id) => workspace.openSession(id),
      };
      // 0.21.1: a host can own the optimization entry (e.g. the
      // dsh-composer-optimize package); ui.button=false then hides only the
      // built-in ✦ entry. The slot is still registered — prediction has no
      // host replacement and the crystal ball must keep appearing.
      void probeComposerButton().then((hostOwnsOptimize) => {
        if (hostOwnsOptimize) console.info('[prompt-seed] optimize entry is host-owned (ui.button=false); prediction stays available');
        try {
          scope.slots.inject('conversation.input.right', () => scope.slots.register(
            { name: 'conversation.input.right', id: 'prompt-seed', order: -10 },
            (props) => props.useInput && props.inputActions ? React.createElement(ComposerTools, { ...props, sessionApi, hostOwnsOptimize }) : null,
          ));
        } catch (error) { console.warn('[prompt-seed] toolbar unavailable', error); }
      });
    });
  } catch (error) { console.warn('[prompt-seed] initialization failed', error); }
}
