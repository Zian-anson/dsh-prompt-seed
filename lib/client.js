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
   * prompt-seed / 浏览器半区（Cordis 客户端插件）
   * ---------------------------------------------------------------------------
   * 本文件是一个**工厂函数体**，由 tools/build.mjs 包进
   * `window.__ModuleLoader__.load({ id, factory })` 并产出 lib/client.js。
   *
   * 与 Host 半区的通信走 Host 注册的 HTTP 路由（本插件没有 Remote 面）。
   * 下方 ROUTE 必须与 src/host-plugin.js 的 DEFAULT_ROUTE 保持一致。
   */

  const ROUTE = '/api/prompt-seed/optimize';
  const MIN_TEXT_LENGTH = 1;

  /** 隐式反馈窗口：超过这个时长再撤销/重试，语义太模糊，不作为标签。 */
  const FEEDBACK_WINDOW_MS = 30000;

  /** 历史保留版本数（B 项：不满意可以换一版，也可以回到上一版）。 */
  const HISTORY_MAX = 3;

  /** localStorage 键：本地信号统计与深度档位。 */
  const SIGNAL_KEY = 'dsh-prompt-seed/signals';
  const DEPTH_KEY = 'dsh-prompt-seed/depth';

  /** 深度档位（D/E 项）：auto 由本地信号统计决定，其余为手动固定。 */
  const DEPTH_MODES = ['auto', 'light', 'standard', 'deep'];
  const DEPTH_LABELS = { auto: '自动', light: '轻', standard: '标准', deep: '深度' };

  function readStored(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeStored(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* 隐私模式等场景下静默降级为不记忆 */ }
  }

  /**
   * 记一次隐式信号（D 项自适应深度的输入）。
   * @param {string} kind applied / reverted / retried / submitted。
   * @returns {object} 更新后的统计。
   */
  function bumpSignal(kind) {
    const stats = readStored(SIGNAL_KEY, {});
    stats[kind] = (Number(stats[kind]) || 0) + 1;
    writeStored(SIGNAL_KEY, stats);
    return stats;
  }

  /**
   * 自适应深度：用本地反馈统计反过来调自己（D 项）。
   *
   * 这是反馈闭环的第一个真实用途——数据管道建好之后不拿它调参，就只是一份日志。
   * 规则刻意保守：
   *  - 冷启动（任一信号不足 2 次）一律用标准档，不让两三次点击就把档位带偏；
   *  - `reverted`（点完立刻撤销 = 补多了）多于 `submitted` → 降档到轻；
   *  - `retried`（改完再点 = 补少了）多于 `reverted` → 升档到深度。
   * 全部在本地算，零额外调用、零上报。
   * @param {object} stats 本地信号统计。
   * @returns {'light' | 'standard' | 'deep'} 建议档位。
   */
  function autoDepth(stats) {
    const reverted = Number(stats.reverted) || 0;
    const retried = Number(stats.retried) || 0;
    const submitted = Number(stats.submitted) || 0;
    if (retried >= 2 && retried > reverted) return 'deep';
    if (reverted >= 2 && reverted > submitted) return 'light';
    return 'standard';
  }

  /** @returns {string} 记住的深度档位，非法值回落 auto。 */
  function storedDepthMode() {
    const mode = readStored(DEPTH_KEY, {}).mode;
    return DEPTH_MODES.indexOf(mode) === -1 ? 'auto' : mode;
  }

  /**
   * 解析最终深度：手动档位优先，auto 交给统计。
   * @param {string} mode auto / light / standard / deep。
   * @param {object} stats 本地信号统计。
   * @returns {'light' | 'standard' | 'deep'} 请求体里的 depth。
   */
  function resolveDepth(mode, stats) {
    return mode === 'light' || mode === 'standard' || mode === 'deep' ? mode : autoDepth(stats);
  }

  const CSS = [
    '.dsh-seed-btn{display:inline-flex;align-items:center;justify-content:center;',
    'width:28px;height:28px;padding:0;border:none;border-radius:8px;background:transparent;',
    'color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s,color .15s;',
    'flex:0 0 auto;vertical-align:middle;}',
    '.dsh-seed-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
    '.dsh-seed-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
    '.dsh-seed-btn:disabled{opacity:.4;cursor:not-allowed;}',
    '.dsh-seed-btn[data-mode="revert"]{width:auto;padding:0 7px;gap:4px;color:var(--dsw-alias-brand-primary);}',
    // 拒绝是"已保留原文"的安全结果，不是故障：用中性色，红色只留给真正的错误。
    '.dsh-seed-btn[data-mode="declined"]{color:var(--dsw-alias-label-secondary);}',
    '.dsh-seed-btn[data-mode="error"]{color:var(--dsw-alias-state-error-primary);}',
    '.dsh-seed-btn svg{width:16px;height:16px;display:block;}',
    '.dsh-opt-delta{margin-left:3px;font-size:10px;line-height:1;font-weight:600;',
    'color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums;}',
    '@keyframes dsh-seed-spin{to{transform:rotate(360deg);}}',
    '.dsh-seed-btn[data-mode="busy"] svg{animation:dsh-seed-spin .9s linear infinite;}',
    // 空草稿时不再整块消失（旧实现 return null 会让按钮随输入有无闪进闪出），
    // 改为常驻 + 降透明度：位置稳定，也顺带解决了"这功能在哪"的发现问题。
    '.dsh-seed-btn[data-empty="1"]{opacity:.45;}',
    // 有内容但没点过时的呼吸微光：一眼看出这里有个可用的动作，不抢视线。
    '@keyframes dsh-opt-breathe{0%,100%{box-shadow:0 0 0 0 rgba(120,150,255,0);}50%{box-shadow:0 0 0 3px rgba(120,150,255,.16);}}',
    '.dsh-seed-btn[data-glow="1"]{animation:dsh-opt-breathe 2.8s ease-in-out infinite;}',
    '.dsh-opt-group{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;}',
    '.dsh-opt-secondary{display:inline-flex;align-items:center;justify-content:center;',
    'width:auto;min-width:28px;height:28px;padding:0 7px;gap:4px;border:none;border-radius:7px;background:transparent;',
    'color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto;',
    'font-size:12px;line-height:1;font-weight:500;white-space:nowrap;',
    'transition:background .15s,color .15s;}',
    '.dsh-opt-secondary:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
    '.dsh-opt-secondary:disabled{opacity:.4;cursor:not-allowed;}',
    '.dsh-opt-secondary svg{width:14px;height:14px;display:block;}',
    '.dsh-opt-label{font-size:12px;line-height:1;font-weight:500;white-space:nowrap;}',
    // 闸门标记：✓ 已审判通过 / ⟳ 收敛过 / · 未审判（精确输入短路）。凭证必须可核对，
    // 所以它显示的是闸门判定结果，而不是长度——长度是别人也有的维度。
    '.dsh-opt-gate{margin-left:3px;font-size:9px;line-height:1;font-weight:700;',
    'color:var(--dsw-alias-brand-primary);}',
    '.dsh-seed-btn[data-gate="unverified"] .dsh-opt-gate{color:var(--dsw-alias-label-secondary);}',
  ].join('');

  /**
   * 注入本插件自己的样式表，返回随 Fiber 回收的清理函数。
   * 客户端插件没有 styles 服务，社区惯例是自建 style 元素。
   * @param {string} css 样式文本。
   * @returns {() => void} 清理函数。
   */
  function injectStyles(css) {
    const element = document.createElement('style');
    element.setAttribute('data-dsh-plugin', 'prompt-seed');
    element.textContent = css;
    document.head.appendChild(element);
    return function disposeStyles() {
      element.remove();
    };
  }

  function SparkIcon() {
    return React.createElement(
      'svg',
      { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      React.createElement('path', { d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z' }),
      React.createElement('path', { d: 'M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z' }),
    );
  }

  function RevertIcon() {
    return React.createElement(
      'svg',
      { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      React.createElement('path', { d: 'M4 9h11a5 5 0 0 1 0 10h-6' }),
      React.createElement('path', { d: 'M8 5L4 9l4 4' }),
    );
  }

  function BusyIcon() {
    return React.createElement(
      'svg',
      { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': 'true' },
      React.createElement('path', { d: 'M12 3a9 9 0 1 0 9 9', opacity: 0.9 }),
    );
  }

  function WarningIcon() {
    return React.createElement(
      'svg',
      { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      React.createElement('path', { d: 'M12 4l9 16H3L12 4z' }),
      React.createElement('path', { d: 'M12 10v4' }),
      React.createElement('path', { d: 'M12 17h.01' }),
    );
  }

  /** 拒绝态图标：盾牌（"已保留原文"），与红色警告三角区分开。 */
  function ShieldIcon() {
    return React.createElement(
      'svg',
      { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      React.createElement('path', { d: 'M12 3l7 3v6c0 4.4-3 8.2-7 9-4-0.8-7-4.6-7-9V6l7-3z' }),
      React.createElement('path', { d: 'M9 12l2 2 4-4' }),
    );
  }

  function PrevIcon() {
    return React.createElement(
      'svg',
      { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      React.createElement('path', { d: 'M15 6l-6 6 6 6' }),
    );
  }

  function EyeIcon() {
    return React.createElement(
      'svg',
      { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      React.createElement('path', { d: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z' }),
      React.createElement('circle', { cx: 12, cy: 12, r: 2.6 }),
    );
  }

  function OptimizeButton(props) {
    const useInput = props.useInput;
    const inputActions = props.inputActions;

    const draft = useInput(function (s) { return s.draft; });
    const draftRev = useInput(function (s) { return s.draftRev; });
    const phase = useInput(function (s) { return s.phase; });
    // 引用芯片：取标签而不是整个数组——数组每次投影都是新引用，会引发无谓重渲染。
    // 标签是芯片在草稿文本里的可读形态（@文件 / /命令），也是改写必须原样保留的锚点。
    const chipKey = useInput(function (s) {
      const list = Array.isArray(s.occurrences) ? s.occurrences : [];
      return list.map(function (o) { return String(o && o.label ? o.label : ''); }).join('\u0000');
    });
    const chips = chipKey === '' ? [] : chipKey.split('\u0000');

    // 会话 id：host 侧据此注入最近会话上下文（消解"这个 bug"类指代）。
    // standard kit 的形状在挂载期内稳定，条件分支跨 render 恒定，满足 hook 规则；
    // 任何一环缺失都安全降级为不带上下文。
    const useSession = typeof props.useSession === 'function' ? props.useSession : null;
    const sessionSnapshot = useSession !== null ? useSession(function (s) { return s; }) : undefined;
    const sessionIdRef = React.useRef(undefined);
    sessionIdRef.current =
      typeof props.sessionId === 'string' && props.sessionId !== ''
        ? props.sessionId
        : sessionSnapshot != null && typeof sessionSnapshot === 'object'
          ? (typeof sessionSnapshot.id === 'string' ? sessionSnapshot.id
            : typeof sessionSnapshot.sessionId === 'string' ? sessionSnapshot.sessionId : undefined)
          : undefined;

    const busyState = React.useState(false);
    const busy = busyState[0];
    const setBusy = busyState[1];
    const errorState = React.useState('');
    const error = errorState[0];
    const setError = errorState[1];
    // 拒绝（改写会改变原意，原文已保留）与"错误"是两件事：前者是安全结果，后者是故障。
    // 分开存，红色警告只留给真正的错误。
    const declinedState = React.useState('');
    const declined = declinedState[0];
    const setDeclined = declinedState[1];
    // 历史保留最近 HISTORY_MAX 版（B 项）：不满意可以"再来一版"，也可以回上一版。
    // backup 由 history 末项派生，不再单独存一份，避免两处状态不同步。
    const historyState = React.useState([]);
    const history = historyState[0];
    const setHistory = historyState[1];
    const backup = history.length > 0 ? history[history.length - 1] : null;
    // 深度档位（D/E 项）：auto 由本地信号统计决定，右键星标可循环切换并记住。
    const depthModeState = React.useState(storedDepthMode());
    const depthMode = depthModeState[0];
    const setDepthMode = depthModeState[1];
    // 被拒版本（F 项）：闸门拒绝时把稿子带回来，只在用户显式点击时才写进输入框。
    const rejectedState = React.useState('');
    const rejected = rejectedState[0];
    const setRejected = rejectedState[1];

    const seqRef = React.useRef(0);
    const draftRevRef = React.useRef(draftRev);
    const backupRef = React.useRef(null);
    // 上一稿的运行记录 + 本次运行开始时的引用标签：前者回传隐式信号，后者在写回前
    // 逐条校验引用文本是否保住（丢一个就宁可不写）。
    const lastRunRef = React.useRef(null);
    const chipsAtRunRef = React.useRef([]);
    const depthModeRef = React.useRef(depthMode);

    /**
     * 回传一次隐式信号。零打扰：不弹窗、不阻塞、失败静默。
     * kind: 'reverted'（立刻撤销=补多了）/ 'retried'（改了再优化）/ 'submitted'（真的发出去了=采纳）。
     */
    function postSignal(kind, run) {
      // 每一次信号同时进本地统计——自适应深度（D 项）靠它调档。
      bumpSignal(kind);
      try {
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            feedback: {
              kind: kind,
              tier: run.tier,
              charsDelta: run.after.length - run.before.length,
              elapsedMs: Date.now() - run.at,
            },
          }),
        }).catch(function () {});
      } catch (e) { /* 反馈绝不打断主流程 */ }
    }

    function sendFeedback(kind) {
      const last = lastRunRef.current;
      if (last === null) return;
      lastRunRef.current = null;
      if (Date.now() - last.at > FEEDBACK_WINDOW_MS) return;
      postSignal(kind, last);
    }
    draftRevRef.current = draftRev;
    backupRef.current = backup;
    depthModeRef.current = depthMode;

    // 内容发散检测：用户一旦改动，永久丢弃备份，撤销入口随之消失。
    // 同时清掉拒绝/错误提示——它们描述的是"刚才那份草稿"，草稿一变即为陈旧的。
    React.useEffect(function () {
      setHistory(function (current) {
        if (current.length === 0) return current;
        return draft === current[current.length - 1].after ? current : [];
      });
      // 草稿被清空且上一稿仍在窗口内 → 优化结果被发出去用了（采纳）。
      // 实测只靠 phase 离开 plain 会漏：提交时 plain→submitting→plain 太快，
      // React 会把中间态合并掉，effect 看不到变化（v0.7.0 真实使用中确认）。
      if (draft === '') sendFeedback('submitted');
      setDeclined('');
      setError('');
      setRejected('');
    }, [draft]);

    // 会话离开 plain 阶段（提交/切换）时清掉残留态。
    React.useEffect(function () {
      if (phase === 'plain') return;
      seqRef.current += 1;
      setBusy(false);
      setError('');
      setDeclined('');
      // 草稿被提交（离开 plain）且上一稿仍在反馈窗口内 → 优化结果被真正采用，最强正信号。
      sendFeedback('submitted');
    }, [phase]);

    const hasRun = backup !== null;
    const isRevertMode = !busy && hasRun;
    const chipsPresent = chips.length > 0;
    const hasContent = draft.trim().length >= MIN_TEXT_LENGTH;
    // 含引用时不再禁用：平台没有"从文本重建芯片节点"的接口（setDraft / insertText 都会
    // 剥掉占位符 U+FFFC），引用必然降级为纯文本——这点在 tooltip 明说，并由写回前的
    // "引用标签守恒校验"兜底：任何标签丢失就拒绝写回，绝不静默丢引用。
    const canRun = hasContent && phase === 'plain';
    const mode = busy ? 'busy' : isRevertMode ? 'revert' : declined !== '' ? 'declined' : error !== '' ? 'error' : 'idle';

    /**
     * 跑一次优化并把结果写回草稿。
     * @param {string} text 要优化的文本。
     * @param {number} revAtStart 发起时的 draftRev：期间用户改过草稿就丢弃这次响应。
     * @param {boolean} keepHistory true = 追加为新版本（"再来一版"），false = 全新一版。
     */
    const runOptimize = function (text, revAtStart, keepHistory) {
      chipsAtRunRef.current = chips.slice();
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      setBusy(true);
      setError('');
      setDeclined('');
      setRejected('');

      fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: text,
          sessionId: sessionIdRef.current,
          // 深度档位随请求下发（D/E 项）：auto 时由本地反馈统计决定，零额外调用。
          depth: resolveDepth(depthModeRef.current, readStored(SIGNAL_KEY, {})),
        }),
      }).then(function (response) {
        return response.json();
      }).then(function (res) {
        if (seqRef.current !== seq) return;
        if (draftRevRef.current !== revAtStart) return;
        if (!res || res.ok !== true) {
          if (res && res.code === 'nothing_to_optimize') {
            setDeclined(res.error || '内容太短，没有可优化的信息');
            return;
          }
          // cannot_infer 与 nothing_to_optimize 同类：这是**设计内的中性拒绝**，
          // 不是故障。纯信号（数字/继续）在上下文里找不到锚点时，系统"拒绝硬猜"
          // 正是它该做的事——用红色 ⚠ 报成错误会让用户以为插件坏了，而正确
          // 反应是"补一句你想问什么"。走 declined（中性盾）态。
          if (res && res.code === 'cannot_infer') {
            setDeclined(res.error || '上下文不足以推断这个输入的含义，请直接写出想说的内容');
            return;
          }
          // 同一类的另外两个确定性守卫：内容过长 / 内容为空。它们与 nothing_to_optimize
          // 一样是"设计内的不做"，用户改一下就能继续——渲染成红色 ⚠ 会让用户以为插件坏了
          // （与 cannot_infer 的修法同理，见 2c16426）。
          if (res && res.code === 'input_too_long') {
            setDeclined(res.error || '内容过长，请精简后再优化');
            return;
          }
          if (res && res.code === 'empty_input') {
            setDeclined(res.error || '请先输入内容');
            return;
          }
          if (res && res.code === 'fidelity_rejected') {
            // 先报**类别**（"增加了原本没有的要求"），再给一个具体例子。
            // 旧实现直接把模型的原句糊上去，读起来像内部日志，而且看不出"为什么这算问题"。
            const structured = Array.isArray(res.violations) ? res.violations : [];
            const labels = [];
            for (const item of structured) {
              const label = String(item && item.label ? item.label : '').trim();
              if (label !== '' && labels.indexOf(label) === -1) labels.push(label);
            }
            const example = structured
              .map(function (item) { return String(item && item.text ? item.text : '').replace(/[（(][^（()）]*[)）]\s*$/, '').trim(); })
              .filter(function (item) { return item !== ''; })
              .map(function (item) { return item.length > 28 ? item.slice(0, 28) + '…' : item; })
              .slice(0, 1);
            const reason = labels.length > 0 ? labels.slice(0, 2).join('、') : '';
            const tail = example.length > 0 ? '（例如：' + example[0] + '）' : '';
            setDeclined(reason !== '' ? res.error + ' · ' + reason + tail : res.error);
            // 被拒版本随结果回来：留在本地，等用户显式点"查看"才写进输入框（不变量 I1）。
            if (typeof res.rejected === 'string' && res.rejected !== '') setRejected(res.rejected);
            return;
          }
          setError((res && res.error) || '优化失败');
          return;
        }
        // 引用标签守恒：改写必须原样保留每个引用标签，丢一个就拒绝写回。
        const lostChips = chipsAtRunRef.current.filter(function (label) {
          return label !== '' && res.text.indexOf(label) === -1;
        });
        if (lostChips.length > 0) {
          setDeclined('改写会丢失引用标记，已保留原文');
          return;
        }
        const entry = {
          before: text,
          after: res.text,
          // 闸门凭证（A 项）：审判判定结果 + "补了什么"摘要，一起随版本存下来。
          gate: res.gate !== null && typeof res.gate === 'object' ? res.gate : null,
          detail: typeof res.detail === 'string' ? res.detail : '',
        };
        setHistory(function (current) {
          const next = keepHistory ? current.concat([entry]) : [entry];
          return next.slice(-HISTORY_MAX);
        });
        inputActions.setDraft(res.text);
        const run = { at: Date.now(), tier: res.tier || '', before: text, after: res.text };
        lastRunRef.current = run;
        // applied = 改写确实被写回了输入框。它既是客户端存活的证据（样本里看得到就说明
        // 浏览器跑的是新版），也是"点了按钮但没写回"这类问题的分母。
        postSignal('applied', run);
      }).catch(function (err) {
        if (seqRef.current !== seq) return;
        setError(err && err.message ? String(err.message) : '优化失败');
      }).then(function () {
        if (seqRef.current === seq) setBusy(false);
      });
    };

    const onClick = function () {
      if (busy) {
        seqRef.current += 1;
        setBusy(false);
        setError('');
        setDeclined('');
        return;
      }
      if (isRevertMode) {
        const first = history[0];
        if (first === undefined) return;
        sendFeedback('reverted');
        setHistory([]);
        setError('');
        setDeclined('');
        setRejected('');
        inputActions.setDraft(first.before);
        return;
      }
      if (!canRun) return;

      // 上一稿还在反馈窗口内又点了一次（说明改过草稿，撤销入口已消失）→ 补少了/换方向。
      sendFeedback('retried');
      runOptimize(draft, draftRev, false);
    };

    /** "再来一版"（B 项）：拿**原文**重新补一次，结果追加为历史新版本。 */
    const onRegenerate = function () {
      const first = history[0];
      if (first === undefined || busy) return;
      runOptimize(first.before, draftRevRef.current, true);
    };

    /** 回到上一版：从历史里弹掉当前版本，写回上一版正文。 */
    const onPrevious = function () {
      if (history.length < 2) return;
      const previous = history[history.length - 2];
      setHistory(history.slice(0, -1));
      inputActions.setDraft(previous.after);
    };

    /** 查看被拒版本（F 项）：用户显式点击才写回，并且可以一键撤销。 */
    const onViewRejected = function () {
      if (rejected === '') return;
      const text = rejected;
      setRejected('');
      setDeclined('');
      setHistory([{ before: draft, after: text, gate: null, detail: '' }]);
      inputActions.setDraft(text);
    };

    /** 右键星标循环切换深度档位（D/E 项）：不占工具行空间，选择记忆在本地。 */
    const onContextMenu = function (event) {
      event.preventDefault();
      const next = DEPTH_MODES[(DEPTH_MODES.indexOf(depthMode) + 1) % DEPTH_MODES.length];
      setDepthMode(next);
      writeStored(DEPTH_KEY, { mode: next });
    };

    // 闸门凭证（A 项）：把审判判定结果变成可核对的一行。生态里最接近的竞品凭证是
    // "保真 5/5"（只报硬事实有没有丢），我们能报的是**语义**有没有变——这是最硬的差异，
    // 却曾经在界面上完全不可见（旧实现只显示字符增减，那恰好是别人也有的维度）。
    const gateVerdict = backup !== null && backup.gate !== null ? backup.gate.verdict : null;
    const gateMark = gateVerdict === 'ok' || gateVerdict === 'thin' ? '✓' : gateVerdict === 'repaired' ? '⟳' : '';
    const gateText = gateVerdict === 'repaired'
      ? '已收敛 ' + (backup.gate.repairs || 1) + ' 轮'
      : gateVerdict === 'unverified'
        ? '未审判（输入已精确）'
        : gateVerdict === 'thin'
          ? '保真 ✓（补得少）'
          : gateVerdict === 'ok'
            ? '保真 ✓'
            : '';

    const delta = isRevertMode && backup !== null ? backup.after.length - backup.before.length : 0;
    const deltaText = delta > 0 ? '增加 ' + delta + ' 字' : delta < 0 ? '精简 ' + (-delta) + ' 字' : '长度不变';
    const depthLabel = depthMode === 'auto'
      ? '自动（当前' + DEPTH_LABELS[resolveDepth('auto', readStored(SIGNAL_KEY, {}))] + '档）'
      : DEPTH_LABELS[depthMode];

    // 空草稿不再整块消失（旧实现 return null，按钮会随输入有无闪进闪出），
    // 改为常驻 + 降透明度：位置稳定，也顺带解决"这功能在哪"的发现问题。
    const tooltip = error !== ''
      ? error
      : declined !== ''
        ? declined + '。点击可重试'
        : busy
          ? '优化中… 点击取消'
          : isRevertMode
            ? [
                gateText,
                deltaText,
                backup.detail !== '' ? '补全：' + backup.detail : '',
                '点击恢复原文',
              ].filter(function (part) { return part !== ''; }).join(' · ')
              + (chipsAtRunRef.current.length > 0 ? '（引用已变为纯文本）' : '')
            : (chipsPresent
                ? '优化提示词（含 ' + chips.length + ' 个引用：优化后引用会变成纯文本）'
                : '优化提示词')
              + ' · 深度：' + depthLabel + '（右键切换）';

    const icon = busy
      ? React.createElement(BusyIcon)
      : isRevertMode
        ? React.createElement(RevertIcon)
        : declined !== ''
          ? React.createElement(ShieldIcon)
          : error !== ''
            ? React.createElement(WarningIcon)
            : React.createElement(SparkIcon);

    const children = [icon];
    if (isRevertMode) {
      children.push(React.createElement('span', { key: 'label', className: 'dsh-opt-label' }, '原文'));
      if (gateMark !== '') {
        children.push(React.createElement('span', { key: 'gate', className: 'dsh-opt-gate' }, gateMark));
      }
      if (delta !== 0) {
        children.push(React.createElement('span', { key: 'delta', className: 'dsh-opt-delta' }, (delta > 0 ? '+' : '') + delta));
      }
    }

    const main = React.createElement(
      'button',
      {
        type: 'button',
        className: 'dsh-seed-btn',
        'data-mode': mode,
        'data-empty': hasContent ? '0' : '1',
        'data-glow': mode === 'idle' && hasContent ? '1' : '0',
        'data-gate': gateVerdict === null ? '' : gateVerdict,
        onClick: onClick,
        onContextMenu: onContextMenu,
        disabled: busy ? false : !isRevertMode && !canRun,
        title: tooltip,
        'aria-label': tooltip,
        'data-testid': 'prompt-seed-button',
      },
      children,
    );

    // 次级动作只在对应状态下出现，平时不占工具行空间：
    //  ↺ 态 → "再来一版"（B 项，解决输出方差）+ 有历史时"上一版"
    //  拒绝态 → "查看被拒版本"（F 项，让用户能自己判断闸门是否误判）
    const extras = [];
    if (isRevertMode) {
      extras.push(React.createElement(
        'button',
        {
          key: 'regenerate',
          type: 'button',
          className: 'dsh-opt-secondary',
          onClick: onRegenerate,
          title: '再来一版（拿原文重新补全，结果可回到上一版）',
          'aria-label': '再来一版',
          'data-testid': 'prompt-seed-regenerate',
        },
        [
          React.createElement(SparkIcon, { key: 'icon' }),
          React.createElement('span', { key: 'label', className: 'dsh-opt-label' }, '再来'),
        ],
      ));
      if (history.length > 1) {
        extras.push(React.createElement(
          'button',
          {
            key: 'previous',
            type: 'button',
            className: 'dsh-opt-secondary',
            onClick: onPrevious,
            title: '回到上一版',
            'aria-label': '回到上一版',
            'data-testid': 'prompt-seed-previous',
          },
          [
            React.createElement(PrevIcon, { key: 'icon' }),
            React.createElement('span', { key: 'label', className: 'dsh-opt-label' }, '上一版'),
          ],
        ));
      }
    }
    if (mode === 'declined' && rejected !== '') {
      extras.push(React.createElement(
        'button',
        {
          key: 'view-rejected',
          type: 'button',
          className: 'dsh-opt-secondary',
          onClick: onViewRejected,
          title: '查看被拒版本（闸门判定它会改变原意，可一键撤销）',
          'aria-label': '查看被拒版本',
          'data-testid': 'prompt-seed-view-rejected',
        },
        React.createElement(EyeIcon),
      ));
    }

    if (extras.length === 0) return main;
    return React.createElement('span', { className: 'dsh-opt-group' }, [main].concat(extras));
  }

  /** 注册按钮到 Composer 输入区右侧，并在插件卸载时回收样式。 */
  function apply(ctx) {
    const slots = ctx.slots;
    // 能力探测 + 自禁用（同 Host 半区）：旧宿主上槽位服务可能不存在，
    // 这时必须**说清楚原因再退出**，而不是抛异常或静默什么都不做——
    // "按钮没出现"和"插件坏了"对用户是两种完全不同的信息。
    if (slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") {
      console.warn(
        '[prompt-seed] slots service unavailable; the button will not be mounted. ' +
          'This host is older than the plugin expects (requires dsh >=0.2.0-rc.1 <0.3.0-0).',
      );
      return;
    }

    ctx.effect(function () {
      return injectStyles(CSS);
    }, 'prompt-seed:styles');

    try {
      slots.inject('conversation.input.right', function () {
        return slots.register(
          { name: 'conversation.input.right', id: 'prompt-seed', order: -10 },
          function (props) {
            return React.createElement(OptimizeButton, props);
          },
        );
      });
    } catch (error) {
      console.warn('[prompt-seed] could not mount into conversation.input.right; the slot is missing on this host.', error);
    }
  }

		exports.name = "prompt-seed";
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
//# sourceURL=dsh-prompt-seed/lib/client.js
