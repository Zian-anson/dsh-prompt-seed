/* dsh-prompt-seed — browser half. 由 tools/build.mjs 生成，请勿手改。 */
window.__ModuleLoader__.load({
	id: "dsh-prompt-seed",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Shell-provided seed module; see the client module loader resolution order. */
		var React = require("react");

  /**
   * prompt-seed / 浏览器半区（0.15.0）
   * ---------------------------------------------------------------------------
   * 一个按钮 + 一次流式请求。没有后台任务、预测、深度档位、引用芯片。
   * 流式 delta 只进入预览行；final ok 才写回 composer。
   */

  const ROUTE = '/api/prompt-seed/optimize';

  const STRINGS = {
    zh: {
      idle: '优化提示词',
      busy: '优化中… {s}s · 点击取消',
      cancel: '取消',
      done: '已更新',
      unchanged: '未找到可补充的细节，已保留原文',
      nothing: '这条消息不需要优化',
      undo: '恢复原文',
      redo: '再来一版',
      failed: '优化失败，已保留原文',
      timeout: '优化超时，已保留原文',
      edited: '草稿已修改，结果已保留，点击取回',
      ready: '结果已就绪 · 点击取回',
      bind_hint: '新会话优化会在首条消息后绑定到当前对话',
      job_lost: '任务已过期，请重试',
      creating: '正在创建对话…',
      refresh_failed: '状态同步失败，稍后自动重试',
      predict_idle: '预测下一句',
      predict_busy: '预测中…',
      predict_unavailable: '这段上下文里没有可预测的下一步',
      predict_failed: '预测失败',
      reason: '原因：{reason}',
    },
    en: {
      idle: 'Optimize prompt',
      busy: 'Optimizing… {s}s · click to cancel',
      cancel: 'Cancel',
      done: 'Updated',
      unchanged: 'Nothing to add — original kept',
      nothing: 'Nothing to optimize here',
      undo: 'Restore original',
      redo: 'Try again',
      failed: 'Optimization failed — original kept',
      timeout: 'Timed out — original kept',
      edited: 'Draft changed; result kept — click to retrieve',
      ready: 'Result ready · click to retrieve',
      bind_hint: 'This new-chat optimization will bind to the conversation after its first message',
      job_lost: 'The job expired — try again',
      creating: 'Creating conversation…',
      refresh_failed: 'Status sync failed; retrying',
      predict_idle: 'Predict next message',
      predict_busy: 'Predicting…',
      predict_unavailable: 'Nothing predictable from this context',
      predict_failed: 'Prediction failed',
      reason: 'Reason: {reason}',
    },
  };

  function resolveLanguage(ctx) {
    try {
      var locale = typeof ctx?.get === 'function' ? ctx.get('locale') : undefined;
      if (locale !== null && typeof locale === 'object' && typeof locale.id === 'string') {
        return locale.id.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
      }
    } catch (e) { /* locale optional */ }
    try {
      if (typeof window === 'object' && window.navigator && typeof window.navigator.language === 'string') {
        return window.navigator.language.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
      }
    } catch (e) { /* non-browser */ }
    return 'zh';
  }

  function makeT(lang) {
    var table = STRINGS[lang] || STRINGS.zh;
    return function (key, params) {
      var text = table[key] != null ? table[key] : (STRINGS.zh[key] != null ? STRINGS.zh[key] : key);
      if (params) {
        for (var name in params) text = text.split('{' + name + '}').join(String(params[name]));
      }
      return text;
    };
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

  /**
   * 会话里是否已经"有来有回"：旧行为来自 useSession 的 14 个字段。
   * blank / running / awaitingFirstTurn 任一为真都不预测。
   */
  function hasConversationContext(session) {
    if (session === null || session === undefined || typeof session !== 'object') return false;
    if (session.blank === true) return false;
    if (session.running === true) return false;
    if (session.awaitingFirstTurn === true) return false;
    return true;
  }

  function SpinnerIcon() {
    return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', className: 'dsh-opt-spin' }, [
      React.createElement('circle', { key: 't', cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', strokeWidth: 2.4, opacity: 0.18 }),
      React.createElement('path', { key: 'a', d: 'M20.5 12a8.5 8.5 0 0 0-8.5-8.5', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' }),
    ]);
  }

  function UndoIcon() {
    return React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' }, [
      React.createElement('path', { key: 'p', d: 'M9 7H5v-4M5 7c2.2-2.7 5.4-4 9-4 5 0 9 4 9 9s-4 9-9 9c-3.3 0-6.2-1.8-7.8-4.5', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    ]);
  }

  const CSS = [
    '.dsh-opt-group{display:inline-flex;align-items:center;gap:6px;max-width:100%}',
    '.dsh-opt-main{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:4px 6px;border-radius:6px;opacity:.85}',
    '.dsh-opt-main:hover{opacity:1;background:rgba(127,127,127,.12)}',
    '.dsh-opt-main:disabled{opacity:.35;cursor:default}',
    '.dsh-opt-spin{animation:dsh-opt-spin 0.9s linear infinite}',
    '@keyframes dsh-opt-spin{to{transform:rotate(360deg)}}',
    '.dsh-opt-secondary{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:inherit;opacity:.7;cursor:pointer;font-size:12px;padding:2px 4px;border-radius:4px}',
    '.dsh-opt-secondary:hover{opacity:1;background:rgba(127,127,127,.12)}',
    '.ps-preview{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:.55}',
    '.ps-note{font-size:12px;opacity:.65;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  ].join('\n');

  function injectStyles(css) {
    try {
      var id = 'dsh-prompt-seed-style';
      if (document.getElementById(id) !== null) return function () {};
      var el = document.createElement('style');
      el.id = id;
      el.textContent = css;
      document.head.appendChild(el);
      return function () { el.remove(); };
    } catch (e) {
      return function () {};
    }
  }

  /**
   * 把 NDJSON 响应逐事件读出来。
   * @param {Response} response fetch 响应。
   * @param {(event: object) => void} onEvent 事件回调。
   * @returns {Promise<object | null>} final 事件。
   */
  async function readEvents(response, onEvent) {
    const contentType = String(response.headers.get('content-type') || '');
    if (contentType.indexOf('application/x-ndjson') === -1) {
      const data = await response.json();
      if (data && data.type === 'final') onEvent(data);
      return data;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final = null;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === '') continue;
        let event;
        try { event = JSON.parse(line); } catch (e) { continue; }
        onEvent(event);
        if (event.type === 'final') final = event;
      }
    }
    const rest = buffer.trim();
    if (rest !== '') {
      try {
        const event = JSON.parse(rest);
        onEvent(event);
        if (event.type === 'final') final = event;
      } catch (e) { /* 半行丢弃 */ }
    }
    return final;
  }

  function feedback(kind, final, before, after) {
    try {
      fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          feedback: { kind: kind, route: final?.route || null, charsDelta: (after || '').length - (before || '').length },
          runId: final?.requestId || undefined,
        }),
      }).catch(function () {});
    } catch (e) { /* 反馈不阻塞 */ }
  }


  const UNBOUND_KEY = 'dsh-prompt-seed:unbound';
  var memoryUnbound = null;
  var sessionKeys = new WeakMap();

  function uuid() {
    try {
      if (typeof crypto === 'object' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) { /* fallback */ }
    return 'draft-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function readUnbound() {
    let value = memoryUnbound;
    try {
      if (typeof sessionStorage === 'object') value = sessionStorage.getItem(UNBOUND_KEY);
    } catch (e) { /* storage unavailable */ }
    // 只有 draft: key 才是新会话令牌；旧版本/异常写入的 s: 值一律丢弃，避免串会话。
    return typeof value === 'string' && value.indexOf('draft:') === 0 ? value : null;
  }

  function ensureUnbound() {
    var existing = readUnbound();
    if (typeof existing === 'string' && existing !== '') return existing;
    var key = 'draft:' + uuid();
    try {
      if (typeof sessionStorage === 'object') sessionStorage.setItem(UNBOUND_KEY, key);
      else memoryUnbound = key;
    } catch (e) {
      memoryUnbound = key;
    }
    return key;
  }

  function clearUnbound() {
    memoryUnbound = null;
    try {
      if (typeof sessionStorage === 'object') sessionStorage.removeItem(UNBOUND_KEY);
    } catch (e) { /* ignore */ }
  }

  function keyFor(sessionId, session) {
    if (typeof sessionId === 'string' && sessionId !== '') return 's:' + sessionId;
    if (session !== null && typeof session === 'object') {
      var known = sessionKeys.get(session);
      if (typeof known === 'string') return known;
      var key = ensureUnbound();
      sessionKeys.set(session, key);
      return key;
    }
    return ensureUnbound();
  }

  function resolveSessionId(props, snapshot) {
    if (typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId;
    if (props.session !== null && typeof props.session === 'object') {
      if (typeof props.session.id === 'string' && props.session.id !== '') return props.session.id;
      if (typeof props.session.sessionId === 'string' && props.session.sessionId !== '') return props.session.sessionId;
    }
    if (snapshot !== null && typeof snapshot === 'object') {
      if (typeof snapshot.id === 'string' && snapshot.id !== '') return snapshot.id;
      if (typeof snapshot.sessionId === 'string' && snapshot.sessionId !== '') return snapshot.sessionId;
    }
    return undefined;
  }


  const FIRST_KEY_PREFIX = 'prompt-seed:first:';
  const ORIGIN_PREFIX = 'prompt-seed:origin:';
  const DRAFT_KEY_PREFIX = 'prompt-seed:draft:';

  function storageGet(key) {
    try { if (typeof sessionStorage === 'object') return sessionStorage.getItem(key); } catch (e) { /* ignore */ }
    return null;
  }

  function storageSet(key, value) {
    try { if (typeof sessionStorage === 'object') sessionStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  function storageRemove(key) {
    try { if (typeof sessionStorage === 'object') sessionStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function saveFirstPending(sessionId, text, autoTitle) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    storageSet(FIRST_KEY_PREFIX + sessionId, JSON.stringify({ text: text, autoTitle: autoTitle, createdAt: Date.now() }));
  }

  function readFirstPending(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    const raw = storageGet(FIRST_KEY_PREFIX + sessionId);
    if (typeof raw !== 'string' || raw === '') return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string' && parsed.text.trim() !== '') return parsed;
    } catch (e) { /* ignore */ }
    return null;
  }

  function clearFirstPending(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') storageRemove(FIRST_KEY_PREFIX + sessionId);
  }

  function markOriginSession(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') storageSet(ORIGIN_PREFIX + sessionId, '1');
  }

  function isOriginSession(sessionId) {
    return typeof sessionId === 'string' && sessionId !== '' && storageGet(ORIGIN_PREFIX + sessionId) === '1';
  }

  function saveSessionDraft(sessionId, text) {
    if (!isOriginSession(sessionId)) return;
    if (typeof text !== 'string' || text === '') storageRemove(DRAFT_KEY_PREFIX + sessionId);
    else storageSet(DRAFT_KEY_PREFIX + sessionId, text);
  }

  function readSessionDraft(sessionId) {
    if (!isOriginSession(sessionId)) return '';
    const value = storageGet(DRAFT_KEY_PREFIX + sessionId);
    return typeof value === 'string' ? value : '';
  }

  /**
   * 生成会话标题：不额外调用模型。
   * @param {string} text 输入/优化稿。
   * @returns {string} 标题。
   */
  function titleFrom(text) {
    let s = String(text ?? '').replace(/\r/g, '\n').trim();
    s = (s.split('\n')[0] ?? '').trim();
    s = s.replace(/^[#>*\-\d.、)\s]+/, '').trim();
    s = s.replace(/^(请|帮我|帮忙|麻烦|我想|我要|需要|能否|可以)[，,：:\s]*/i, '').trim();
    s = s.replace(/[。！？?!.；;：:，,\s]+$/g, '').trim();
    const chars = Array.from(s);
    if (chars.length > 24) s = chars.slice(0, 24).join('').trim();
    return s === '' ? '新对话' : s;
  }


  function resolveWorkspaceId(props, session, snapshot) {
    if (typeof props.workspaceId === 'string' && props.workspaceId !== '') return props.workspaceId;
    if (session !== null && typeof session === 'object' && typeof session.workspaceId === 'string' && session.workspaceId !== '') return session.workspaceId;
    if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.workspaceId === 'string' && snapshot.workspaceId !== '') return snapshot.workspaceId;
    return undefined;
  }

  function resolveCwd(props, session, snapshot) {
    if (typeof props.cwd === 'string' && props.cwd !== '') return props.cwd;
    if (session !== null && typeof session === 'object' && typeof session.cwd === 'string' && session.cwd !== '') return session.cwd;
    if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.cwd === 'string' && snapshot.cwd !== '') return snapshot.cwd;
    return undefined;
  }

  function postJson(payload) {
    return fetch(ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (response) { return response.json(); });
  }

  function jobFinal(job) {
    return job !== null && typeof job === 'object' && job.result !== null && typeof job.result === 'object' ? job.result : null;
  }

  function jobTerminal(job) {
    return job !== null && typeof job === 'object' && (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled');
  }

  function OptimizeButton(props) {
    const useInput = props.useInput;
    const inputActions = props.inputActions;
    const tr = typeof props.tr === 'function' ? props.tr : makeT('zh');
    const sessionApi = props.sessionApi;
    const draft = useInput(function (s) { return s.draft; });
    const draftRev = useInput(function (s) { return s.draftRev; });
    const phase = useInput(function (s) { return s.phase; });
    const useSession = typeof props.useSession === 'function' ? props.useSession : null;
    const sessionSnapshot = useSession !== null ? useSession(function (s) { return s; }) : undefined;
    const session = props.session !== undefined && props.session !== null ? props.session : sessionSnapshot;
    const sessionId = resolveSessionId(props, sessionSnapshot);
    const conversationKey = keyFor(sessionId, session);
    const blankSession = (session !== null && typeof session === 'object' && session.blank === true) ||
      (sessionSnapshot !== null && typeof sessionSnapshot === 'object' && sessionSnapshot.blank === true) ||
      (props.session !== null && typeof props.session === 'object' && props.session.blank === true);

    const [busyState, setBusyState] = React.useState(false);
    const [previewState, setPreviewState] = React.useState('');
    const [elapsedState, setElapsedState] = React.useState(0);
    const [errorState, setErrorState] = React.useState('');
    const [noteState, setNoteState] = React.useState('');
    const [jobIdState, setJobIdState] = React.useState(null);
    const [readyState, setReadyState] = React.useState(null);
    const [historyState, setHistoryState] = React.useState([]);
    const [predictBusyState, setPredictBusyState] = React.useState(false);
    const [predictNoteState, setPredictNoteState] = React.useState('');

    const abortRef = React.useRef(null);
    const jobIdRef = React.useRef(null);
    const readyRef = React.useRef(null);
    const draftRef = React.useRef(draft);
    const draftRevRef = React.useRef(draftRev);
    const mountedRef = React.useRef(true);
    const startingRef = React.useRef(false);
    const localRunRef = React.useRef(false);
    const consumedRef = React.useRef(new Set());
    const creatingRef = React.useRef(false);
    const autoStartTextRef = React.useRef('');

    draftRef.current = draft;
    draftRevRef.current = draftRev;
    jobIdRef.current = jobIdState;
    readyRef.current = readyState;

    React.useEffect(function () {
      return function () {
        mountedRef.current = false;
        if (abortRef.current) abortRef.current.abort();
      };
    }, []);

    React.useEffect(function () {
      if (!busyState) { setElapsedState(0); return undefined; }
      const started = Date.now();
      const timer = setInterval(function () { if (mountedRef.current) setElapsedState(Math.floor((Date.now() - started) / 1000)); }, 1000);
      return function () { clearInterval(timer); };
    }, [busyState]);

    React.useEffect(function () {
      setHistoryState(function (current) {
        if (current.length === 0) return current;
        return draft === current[current.length - 1].after ? current : [];
      });
      setErrorState('');
      setNoteState('');
      setPredictNoteState('');
    }, [draft]);


    React.useEffect(function () {
      const text = autoStartTextRef.current;
      if (text !== '' && draft === text) {
        autoStartTextRef.current = '';
        run(text);
      }
    }, [draft]);

    React.useEffect(function () {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      if (autoStartTextRef.current !== '') return;
      const pending = readFirstPending(sessionId);
      if (pending !== null) {
        autoStartTextRef.current = pending.text;
        inputActions.setDraft(pending.text);
        draftRef.current = pending.text;
        saveSessionDraft(sessionId, pending.text);
        clearFirstPending(sessionId);
        return;
      }
      const saved = readSessionDraft(sessionId);
      if (saved !== '' && (typeof draftRef.current !== 'string' || draftRef.current === '')) {
        inputActions.setDraft(saved);
        draftRef.current = saved;
      }
    }, [sessionId]);

    React.useEffect(function () {
      if (typeof sessionId === 'string' && sessionId !== '') saveSessionDraft(sessionId, draft);
    }, [draft, sessionId]);

    function feedback(kind, final, before, after) {
      try {
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            feedback: { kind: kind, route: final?.route || null, charsDelta: (after || '').length - (before || '').length },
            runId: final?.requestId || undefined,
          }),
        }).catch(function () {});
      } catch (e) { /* 反馈不阻塞 */ }
    }

    function applyJob(job, before) {
      if (!job || job.id === undefined || consumedRef.current.has(job.id)) return;
      const result = job.result;
      if (!result || result.ok !== true || typeof result.text !== 'string' || result.text === '') return;
      const beforeText = typeof before === 'string' ? before : job.inputText;
      if (before === job.inputText && draftRef.current !== beforeText) {
        setBusyState(false);
        setReadyState(job);
        setNoteState(tr('ready'));
        return;
      }
      consumedRef.current.add(job.id);
      inputActions.setDraft(result.text);
      setHistoryState(function (current) {
        const next = current.concat([{ before: beforeText, after: result.text, route: result.route, jobId: job.id, requestId: result.requestId }]);
        return next.slice(-3);
      });
      feedback('applied', result, beforeText, result.text);
      setBusyState(false);
      setPreviewState('');
      setReadyState(null);
      setNoteState(result.changed === false ? tr('unchanged') : tr('done'));
      jobIdRef.current = null;
      setJobIdState(null);
      postJson({ action: 'consume', jobId: job.id }).catch(function () {});
    }

    function failJob(job, message) {
      if (!job || consumedRef.current.has(job.id)) return;
      consumedRef.current.add(job.id);
      setBusyState(false);
      setPreviewState('');
      setReadyState(null);
      setErrorState(message || tr('failed'));
      jobIdRef.current = null;
      setJobIdState(null);
      // 失败不立即 consume：切回该会话时仍应看到原因；TTL 会清理。
    }

    function handleJob(job) {
      if (!job || !mountedRef.current || job.consumed === true || consumedRef.current.has(job.id)) return;
      if (typeof job.conversationKey === 'string' && job.conversationKey !== '' && typeof sessionId !== 'string' && readUnbound() === null) {
        try { if (typeof sessionStorage === 'object') sessionStorage.setItem(UNBOUND_KEY, job.conversationKey); } catch (e) { /* ignore */ }
      }
      if (job.status === 'running') {
        jobIdRef.current = job.id;
        setJobIdState(job.id);
        setBusyState(true);
        setPreviewState(typeof job.partialText === 'string' ? job.partialText.slice(-600) : '');
        setErrorState('');
        return;
      }
      if (job.status === 'done') {
        const result = job.result;
        if (result && result.ok === true) {
          if (job.inputText !== '' && draftRef.current === job.inputText) {
            applyJob(job, job.inputText);
          } else {
            jobIdRef.current = job.id;
            setJobIdState(job.id);
            setBusyState(false);
            setPreviewState('');
            setReadyState(job);
            setNoteState(tr('ready'));
          }
        } else {
          failJob(job, (result && result.error) || job.error || tr('failed'));
        }
        return;
      }
      if (job.status === 'failed') { failJob(job, job.error || tr('failed')); return; }
      if (job.status === 'cancelled') { failJob(job, tr('cancel')); }
    }

    function queryKey() {
      return conversationKey;
    }

    function refreshStatus() {
      if (!mountedRef.current) return;
      const key = queryKey();
      postJson({ action: 'status', sessionId: sessionId, conversationKey: key }).then(function (res) {
        if (!mountedRef.current) return;
        if (!res || res.ok !== true) { setErrorState(tr('refresh_failed')); return; }
        const job = res.job;
        if (job === null || job === undefined) {
          if (!startingRef.current && !localRunRef.current && jobIdRef.current !== null) {
            jobIdRef.current = null;
            setJobIdState(null);
            setBusyState(false);
            setPreviewState('');
            setNoteState(tr('job_lost'));
          }
          return;
        }
        handleJob(job);
      }).catch(function () {
        if (mountedRef.current) setErrorState(tr('refresh_failed'));
      });
    }

    React.useEffect(function () {
      if (phase !== undefined && phase !== 'plain') return undefined;
      refreshStatus();
      return undefined;
    }, [sessionId, conversationKey, phase]);

    React.useEffect(function () {
      function onVisible() {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') refreshStatus();
      }
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
      return function () { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible); };
    }, []);

    React.useEffect(function () {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;
      const unbound = readUnbound();
      if (typeof unbound !== 'string' || unbound === '') return undefined;
      postJson({ action: 'bind', conversationKey: unbound, sessionId: sessionId }).then(function (res) {
        if (res && res.ok === true) clearUnbound();
        refreshStatus();
      }).catch(function () { /* 下一次 status 会重试 */ });
      return undefined;
    }, [sessionId]);

    React.useEffect(function () {
      if (!busyState || jobIdState === null) return undefined;
      let stopped = false;
      const timer = setInterval(function () {
        if (stopped || !mountedRef.current) return;
        const key = queryKey();
        postJson({ action: 'status', sessionId: sessionId, conversationKey: key }).then(function (res) {
          if (stopped || !mountedRef.current) return;
          if (res && res.ok === true && res.job) handleJob(res.job);
        }).catch(function () { /* 下一次 tick 重试 */ });
      }, 800);
      return function () { stopped = true; clearInterval(timer); };
    }, [busyState, jobIdState, sessionId, conversationKey]);

    const busy = busyState;
    const ready = readyState;
    const predictBusy = predictBusyState;
    const hasContent = typeof draft === 'string' && draft.trim() !== '';
    const hasContext = hasConversationContext(session) || (session === undefined && typeof sessionId === 'string' && sessionId !== '');
    const predictMode = !busy && !predictBusy && ready === null && !hasContent && hasContext;
    const history = historyState;
    const last = history.length > 0 ? history[history.length - 1] : null;


    async function startFirstOptimize(text) {
      if (creatingRef.current) return;
      if (sessionApi === undefined || sessionApi === null || typeof sessionApi.create !== 'function' || typeof sessionApi.open !== 'function') {
        run(text);
        return;
      }
      const workspaceId = resolveWorkspaceId(props, session, sessionSnapshot);
      const cwd = resolveCwd(props, session, sessionSnapshot);
      creatingRef.current = true;
      setBusyState(true);
      setPreviewState('');
      setErrorState('');
      setNoteState(tr('creating'));
      try {
        const request = workspaceId !== undefined ? { workspaceId: workspaceId } : (cwd !== undefined ? { cwd: cwd } : {});
        const created = await sessionApi.create(request);
        const newId = created !== null && typeof created === 'object'
          ? (typeof created.sessionId === 'string' ? created.sessionId : created.id)
          : undefined;
        if (typeof newId !== 'string' || newId === '') throw new Error('session create returned no id');
        const autoTitle = titleFrom(text);
        markOriginSession(newId);
        saveFirstPending(newId, text, autoTitle);
        saveSessionDraft(newId, text);
        if (newId === sessionId) {
          try {
            if (typeof sessionApi.rename === 'function') await sessionApi.rename(newId, autoTitle);
          } catch (titleError) {
            console.warn('[prompt-seed] session title failed', titleError);
          }
          creatingRef.current = false;
          run(text);
          return;
        }
        sessionApi.open(newId);
        try {
          if (typeof sessionApi.rename === 'function') await sessionApi.rename(newId, autoTitle);
        } catch (titleError) {
          console.warn('[prompt-seed] session title failed', titleError);
        }
      } catch (error) {
        creatingRef.current = false;
        if (mountedRef.current) {
          setBusyState(false);
          setNoteState('');
          setErrorState((error && error.message) || tr('failed'));
        }
      }
    }

    async function run(text) {
      if (busy || text.trim() === '') return;
      const before = text;
      const revAtStart = draftRevRef.current;
      const key = keyFor(sessionId, session);
      const runId = 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const controller = new AbortController();
      abortRef.current = controller;
      startingRef.current = true;
      localRunRef.current = true;
      setBusyState(true);
      setPreviewState('');
      setErrorState('');
      setNoteState('');
      setReadyState(null);
      let final = null;
      let finalJob = null;
      try {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
          body: JSON.stringify({ action: 'optimize', text: before, sessionId: sessionId, conversationKey: key, runId: runId, stream: true }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const data = await response.json().catch(function () { return null; });
          throw new Error((data && data.error) || ('HTTP ' + response.status));
        }
        const data = await readEvents(response, function (event) {
          if (!mountedRef.current) return;
          if (event.type === 'meta' && typeof event.jobId === 'string') {
            startingRef.current = false;
            jobIdRef.current = event.jobId;
            setJobIdState(event.jobId);
            if (typeof sessionId !== 'string' && typeof event.conversationKey === 'string' && event.conversationKey.indexOf('draft:') === 0) {
              try { if (typeof sessionStorage === 'object') sessionStorage.setItem(UNBOUND_KEY, event.conversationKey); } catch (e) { /* ignore */ }
            }
          }
          if (event.type === 'delta' && typeof event.text === 'string') {
            setPreviewState(function (current) {
              const next = current + event.text;
              return next.length > 600 ? next.slice(-600) : next;
            });
          }
          if (event.type === 'final') {
            final = event;
            finalJob = { id: event.jobId, status: event.ok === true ? 'done' : 'failed', inputText: before, result: event, error: event.error || null };
            if (event.ok === true) {
              if (draftRevRef.current === revAtStart && draftRef.current === before) applyJob(finalJob, before);
              else {
                setBusyState(false);
                setPreviewState('');
                setReadyState(finalJob);
                setNoteState(tr('ready'));
              }
            } else {
              failJob(finalJob, event.error || tr('failed'));
            }
          }
        });
        if (final === null && data !== null && typeof data === 'object') {
          if (data.code === 'job_running' && data.job) handleJob(data.job);
          else if (data.code === 'nothing_to_optimize') setNoteState(tr('nothing'));
          else if (data.code) setErrorState(data.error || tr('failed'));
        }
      } catch (error) {
        if (error && error.name === 'AbortError') {
          if (mountedRef.current && !jobIdRef.current) setNoteState(tr('cancel'));
        } else if (mountedRef.current) {
          setErrorState((error && error.message) || tr('failed'));
        }
      } finally {
        startingRef.current = false;
        localRunRef.current = false;
        if (abortRef.current === controller) abortRef.current = null;
        if (mountedRef.current && jobIdRef.current === null && final === null && readyRef.current === null) {
          setBusyState(false);
          setPreviewState('');
        }
      }
    }

    function cancelJob() {
      const id = jobIdRef.current;
      if (abortRef.current) abortRef.current.abort();
      if (typeof id === 'string' && id !== '') {
        postJson({ action: 'cancel', jobId: id }).then(function (res) {
          if (!res || res.ok !== true) {
            if (mountedRef.current) setErrorState(res && res.error ? res.error : tr('failed'));
            refreshStatus();
          }
        }).catch(function () { /* 下一次 status 会处理 */ });
      } else {
        const key = keyFor(sessionId, session);
        postJson({ action: 'status', sessionId: sessionId, conversationKey: key }).then(function (res) {
          if (res && res.ok === true && res.job && res.job.status === 'running') {
            return postJson({ action: 'cancel', jobId: res.job.id });
          }
          return null;
        }).catch(function () {});
      }
      if (typeof id === 'string' && id !== '') postJson({ action: 'consume', jobId: id }).catch(function () {});
      jobIdRef.current = null;
      setJobIdState(null);
      setBusyState(false);
      setPreviewState('');
      setReadyState(null);
      setNoteState(tr('cancel'));
    }

    async function runPredict() {
      if (predictBusyState || busy) return;
      if (typeof sessionId !== 'string' || sessionId === '') {
        setPredictNoteState(tr('predict_unavailable'));
        return;
      }
      setPredictBusyState(true);
      setPredictNoteState('');
      setErrorState('');
      try {
        const res = await postJson({ action: 'predict', sessionId: sessionId });
        if (res && res.ok === true && typeof res.text === 'string' && res.text.trim() !== '') {
          inputActions.setDraft(res.text.trim());
          setPredictNoteState('');
        } else if (res && res.code === 'cannot_predict') {
          setPredictNoteState(tr('predict_unavailable'));
        } else {
          setPredictNoteState(tr('predict_failed') + (res && res.error ? '：' + res.error : ''));
        }
      } catch (error) {
        setPredictNoteState(tr('predict_failed') + (error && error.message ? '：' + error.message : ''));
      } finally {
        if (mountedRef.current) setPredictBusyState(false);
      }
    }

    function onClick() {
      if (creatingRef.current) return;
      if (predictBusyState) return;
      if (predictMode) { runPredict(); return; }
      if (ready !== null) { applyJob(ready, draftRef.current); return; }
      if (busy) { cancelJob(); return; }
      if (blankSession || typeof sessionId !== 'string' || sessionId === '') { startFirstOptimize(draft); return; }
      run(draft);
    }

    function onUndo() {
      if (last === null) return;
      inputActions.setDraft(last.before);
      feedback('reverted', { requestId: last.requestId, route: last.route }, last.after, last.before);
      setHistoryState(function (current) { return current.slice(0, -1); });
      setNoteState(tr('undo'));
    }

    function onRedo() {
      const source = last !== null ? last.before : draft;
      run(source);
    }

    const showPredict = predictMode || predictBusy;
    const label = busy
      ? tr('busy', { s: elapsedState })
      : predictBusy
        ? tr('predict_busy')
        : predictMode
          ? tr('predict_idle')
          : ready !== null
            ? tr('ready')
            : tr('idle');
    const icon = busy || predictBusy
      ? React.createElement(SpinnerIcon, { key: 'icon' })
      : showPredict
        ? React.createElement(CrystalIcon, { key: 'icon' })
        : React.createElement(SparkIcon, { key: 'icon' });
    const children = [icon];

    const main = React.createElement('button', {
      type: 'button',
      className: 'dsh-opt-main',
      onClick: onClick,
      disabled: predictBusy || (!busy && ready === null && !hasContent && !predictMode),
      title: label,
      'aria-label': label,
      'data-testid': 'prompt-seed-optimize',
    }, children);

    const extras = [];
    if (busy && previewState !== '') {
      extras.push(React.createElement('span', { key: 'preview', className: 'ps-preview', title: previewState }, previewState.slice(-80)));
    }
    if (!busy && !predictMode && history.length > 0) {
      extras.push(React.createElement('button', {
        key: 'undo', type: 'button', className: 'dsh-opt-secondary', onClick: onUndo,
        title: tr('undo'), 'aria-label': tr('undo'), 'data-testid': 'prompt-seed-undo',
      }, [React.createElement(UndoIcon, { key: 'i' })]));
      extras.push(React.createElement('button', {
        key: 'redo', type: 'button', className: 'dsh-opt-secondary', onClick: onRedo,
        title: tr('redo'), 'aria-label': tr('redo'), 'data-testid': 'prompt-seed-redo',
      }, [React.createElement(SparkIcon, { key: 'i' })]));
    }
    if (!sessionId && busy) {
      extras.push(React.createElement('span', { key: 'bind', className: 'ps-note', title: tr('bind_hint') }, tr('bind_hint')));
    }
    const note = errorState || noteState || predictNoteState;
    if (note) extras.push(React.createElement('span', { key: 'note', className: 'ps-note', title: note }, note));

    if (extras.length === 0) return main;
    return React.createElement('span', { className: 'dsh-opt-group' }, [main].concat(extras));
  }

  function serviceOf(ctx, name) {
    try {
      if (typeof ctx.get === 'function') return ctx.get(name);
      return ctx[name];
    } catch (e) { return undefined; }
  }

  function apply(ctx) {
    const slots = ctx.slots;
    if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
      console.warn('[prompt-seed] slots service unavailable; the button will not be mounted.');
      return;
    }
    ctx.effect(function () { return injectStyles(CSS); }, 'prompt-seed:styles');
    // 当前 DSH 中文界面下 locale 仍可能返回 en-US；用户明确要求中文按钮。
    const tr = makeT('zh');
    const sessionApi = {
      create: async function (request) {
        const sessions = serviceOf(ctx, 'sessions');
        if (sessions === undefined || typeof sessions.create !== 'function') throw new Error('sessions service unavailable');
        return sessions.create(request);
      },
      open: function (id) {
        const ui = serviceOf(ctx, 'uiWorkspace');
        if (ui === undefined || typeof ui.openSession !== 'function') throw new Error('uiWorkspace service unavailable');
        return ui.openSession(id);
      },
      rename: async function (id, title) {
        const sessions = serviceOf(ctx, 'sessions');
        if (sessions === undefined || typeof sessions.using !== 'function') return;
        const result = await sessions.using(id, { source: 'prompt-seed' }, function (reference) {
          return reference.binding.session.rename(title);
        });
        if (result && result.ok === false) throw new Error(result.error?.message || 'rename failed');
      },
    };
    try {
      slots.inject('conversation.input.right', function () {
        return slots.register(
          { name: 'conversation.input.right', id: 'prompt-seed', order: -10 },
          function (props) { return React.createElement(OptimizeButton, Object.assign({}, props, { tr: tr, sessionApi: sessionApi })); },
        );
      });
    } catch (error) {
      console.warn('[prompt-seed] could not mount into conversation.input.right.', error);
    }
  }

		exports.name = "prompt-seed";
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
//# sourceURL=dsh-prompt-seed/lib/client.js
