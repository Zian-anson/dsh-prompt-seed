# DSH 提示词优化功能 —— 架构设计与模块划分

> **文档状态：历史设计稿（v0.1.0 时期）**
>
> 本文记录的是最初的设计决策与理由，**不是当前实现的规格**。实现已在多处前进，
> 判断现状请以这两份为准：
> - 面向使用者：[README.md](../README.md)（含 0.9.x 的信号 / 短指令 / 会话三分支）
> - 逐项实测：[FEATURES.md](./FEATURES.md)
>
> 已知与现状的差异（截至 0.9.2）：
>
> | 本文的表述 | 现状 |
> |---|---|
> | 4 状态机 idle / busy / revert / error | **5 状态**，新增 `declined`（中性盾：拒绝硬猜、内容太短、引用守恒失败） |
> | 只有补全与精确两条输入路径 | 另有**信号**（数字 / 继续）、**短指令**（改一下 / 不对）、**会话消息**（提问 / 观点）三个分支，各有独立契约与度规则 |
> | 模板覆盖 `system` / `user` / `audit` 三份 | **六份**（另加 `signal.md` / `deictic.md` / `conversational.md`） |
> | 保真判定为字符串守恒 | 现有**语义审判**（五类越线分类 + 定向修复 + 无条件复核）；字符串守恒降为辅助判据 |
> | 构建产物为 4 个模块 | **6 个宿主模块** + 入口 + 浏览器包 |

> 目标：在 DSH Web GUI 的输入框上提供提示词优化能力：
> **一键优化（✨）→ 原地回填 → 一键撤销（↺）**，且失败时绝不清空用户输入。
> 交付形态：**一个 DSH 组合包（bundle）** —— Cordis Host 插件 + 浏览器半区 bundle，
> 通过 `dsh plugin add` 装进 profile。

---

## 1. 设计目标与不变量

| # | 不变量 | 为什么 |
|---|---|---|
| I1 | 优化失败时，用户输入**一个字符都不能丢** | 丢输入是最不可接受的失败，所有错误分支都必须保持输入框原样 |
| I2 | 结果只能写回**用户未改动过的**输入框 | 否则会覆盖用户在等待期间的输入（DSH 的 `draftRev` 提供了廉价 CAS） |
| I3 | 撤销只在"内容仍等于优化结果"时可用 | 用户一改就说明他接受了当前文本，此时给"恢复原文"是陷阱 |
| I4 | 输出语言必须与输入语言一致 | 中英混排产品里最容易翻车的点，需在 system 与 user 各声明一次并配正反例 |
| I5 | 插件卸载后**不留任何痕迹** | 样式、Slot 占位、RPC handler 全部随 Fiber 回收 |

---

## 2. 架构总览

```
                       ┌──────────────────────────── DSH Web (Browser) ────────────────────────────┐
                       │                                                                            │
  ┌─────────────┐      │   ┌──────────────────────────┐                                             │
  │  用户输入    │──────┼──►│  Composer (Lexical)      │                                             │
  └─────────────┘      │   │  InputState.draft/rev    │                                             │
                       │   └───────────┬──────────────┘                                             │
                       │               │ useInput(selector)                                         │
                       │               ▼                                                            │
        ✨/↺ 点击  ───► │   ┌──────────────────────────────────────────────┐                         │
                       │   │  lib/client.js  OptimizeButton                │                         │
                       │   │  · 4 状态机: idle / busy / revert / error     │                         │
                       │   │  · 备份 { before, after }                     │                         │
                       │   │  · 发散检测 (draft ≠ after → 丢备份)          │                         │
                       │   │  · stale 保护 (seq + draftRev)                │                         │
                       │   └───────────────┬──────────────────────────────┘                         │
                       │                   │ inputActions.setDraft(text)                           │
                       │                   │                                                       │
                       │                   │  fetch(POST /api/prompt-seed/optimize)           │
                       └───────────────────┼───────────────────────────────────────────────────────┘
                                           │  回环限定的 JSON 路由
                       ┌───────────────────▼───────────────────────────────────────────────────────┐
                       │                        DSH Host (Node.js)                                  │
                       │                                                                           │
                       │   ┌──────────────────────────────────────────────┐                        │
                       │   │  lib/index.js  ctx.webServer.register(...)     │                        │
                       │   │  · guardLoopback(peer + Host 头)               │                        │
                       │   │  · validateInput  → empty_input / too_long    │                        │
                       │   │  · resolveRoute(ctx.get('agentDefaultModel')) │                        │
                       │   │  · optimizePromptText(...)                    │                        │
                       │   │  · normalizeResult(...)                       │                        │
                       │   └───────────────┬──────────────────────────────┘                        │
                       │                   │                                                       │
                       │        ┌──────────┴───────────┐                                           │
                       │        ▼                      ▼                                           │
                       │  ┌──────────────┐      ┌──────────────────┐                                │
                       │  │ prompt-      │      │  ctx.get('llm')  │──► provider adapter ──► LLM   │
                       │  │ templates    │      │  .stream(...)    │                                │
                       │  └──────────────┘      └──────────────────┘                                │
                       └───────────────────────────────────────────────────────────────────────────┘
```

**为什么 Host 层不自己发 HTTP**：DSH 已有 `llm` 服务（adapter 注册表 + 流式 API）与
adapter 治理层（路由、重试策略、凭据解析）。自建一条到模型供应商的 HTTP 通道意味着把
鉴权、重试、凭据三件事各实现一遍，**多一跳、多一套凭据、多一处会腐化的鉴权代码**。

**为什么两半区之间走 HTTP 路由而不是 Remote 服务**：本插件的跨半区载荷只有一个
请求/响应字段对。Remote 需要 Typert 的构建期 schema 生成链路，而路由是更小的接缝，
也不会把本包的构建绑到 DSH 的内部代码生成器上。路由只接受回环来源（见 ADR-7）。

---

## 3. 模块划分

| 模块 | 文件 | 运行位置 | 职责 | 依赖 |
|---|---|---|---|---|
| M1 提示词模板 | `src/prompt-templates.js` → `lib/prompt-templates.js` | Host | 持有唯一的 meta-prompt 资产；渲染 user prompt；4 级输出清洗；输入校验；脚本检测 | 无 |
| M2 编排核心 | `src/host-core.js` → `lib/host-core.js` | Host | 路由解析、`llm.stream` 消费、chunk 拼接、错误码归一化 | M1 |
| M3 Host 半区 | `src/host-plugin.js` → `lib/index.js` | Host | Cordis 插件：`ctx.webServer.register` 注册回环限定路由、回环防护、请求体读取与 JSON 响应 | M1, M2 |
| M4 浏览器半区 | `src/client-plugin.js` → `lib/client.js` | Browser | ✨ 按钮、4 状态机、备份/撤销、发散检测、stale 保护、样式注入 | `slots`, `React` |
| M5 构建器 | `tools/build.mjs` | 构建期 | 复制 Host 三件套；把 M4 的工厂体包成 `__ModuleLoader__` 模块 | M1–M4 |
| M6 测试 | `test/optimizer.test.mjs` | 构建期 | 32 个用例覆盖 M1/M2 全部分支 + 路由与回环防护 + bundle 可执行性 | 全部 |

**为什么 M1/M2 与 M3 分开？** M1/M2 是零 Cordis 依赖的纯逻辑，可以直接被
`node --test` import；M3 只做接线。这样绝大部分行为（模板、清洗、错误码、流拼接）
不需要任何运行时就跑得起单测，而 M3 的接线本身用桩 `req`/`res` 驱动真实 handler 来测。

**为什么浏览器半区需要打包？** DSH 客户端不加载普通 ESM，而是按
`window.__ModuleLoader__.load({ id, factory })` 注册的模块表工作：factory **只注册不执行**，
真正的副作用发生在 materialize（首次 require）时。因此 M4 的源码写成工厂函数体，
由 M5 包上外壳并声明 `exports.name / inject / apply`。

---

## 4. 数据流（一次成功优化的完整时序）

```
用户点击 ✨
  │
  ├─ Client: busy=true, error='' , seq = ++seqRef, 记录 revAtStart = draftRev
  │
  ├─ fetch(POST /api/prompt-seed/optimize, { text: draft })
  │     │
  │     ├─ Host: guardLoopback(req, res)                      // peer 地址 + Host 头
  │     ├─ Host: validateInput(text)
  │     │        ├─ '' → { ok:false, code:'empty_input' }
  │     │        └─ >8000 → { ok:false, code:'input_too_long' }
  │     ├─ Host: resolveRoute(ctx.get('agentDefaultModel'))   // {provider, model, reasoningEffort?}
  │     ├─ Host: buildSystemPromptFor(text)                   // 模板 + 部署约束 + 脚本提示
  │     ├─ Host: renderUserPrompt(text)                       // 模板.replace('{input}', text)
  │     ├─ Host: collectStream(llm.stream({...}))             // 拼 text-delta，捕获 finish.failure
  │     ├─ Host: normalizeResult(raw)                         // 围栏→标签→引号→标签
  │     └─ Host: → { ok:true, text: cleaned }
  │
  ├─ Client: if (seqRef.current !== seq) return               // 被更新的请求取代 → 丢弃
  ├─ Client: if (draftRevRef.current !== revAtStart) return    // 用户期间改过 → 丢弃 (I2)
  ├─ Client: setBackup({ before: draft, after: res.text })
  ├─ Client: inputActions.setDraft(res.text)                  // 原地回填
  └─ Client: busy=false → 按钮切到 ↺ 态
```

---

## 5. 状态机（Client）

```
                 ┌─────────────────────────────────────────────────┐
                 │                                                 │
   draft 为空 ───►  HIDDEN  ──── 用户输入 ────►  IDLE ✨            │
   （不占位）                                     │                │
                                                 │ click          │
                                                 ▼                │
                                              BUSY ⟳ ─── click ───┤ (取消：seq++，回 IDLE)
                                                 │                │
                            ┌────────────────────┴──────────────┐ │
                            │ ok                                │ │ 失败
                            ▼                                   ▼ │
                       REVERT ↺ ──── draft ≠ after ────► IDLE ✨   │
                            │                    (丢备份)         │
                            │ click                                │
                            └──► setDraft(before) ────────────────┘
                                                 │
                                            ERROR ⚠（tooltip 显示 error）
                                                 │
                                            draft 变化 ──► IDLE
```

`phase !== 'plain'`（提交/声称中）会强制回到 IDLE 并作废在途请求。

---

## 6. 接口契约

### 6.1 Client → Host（回环限定的 HTTP 路由）

```ts
// POST /api/prompt-seed/optimize
// 请求
type OptimizeRequest = { text: string };

// 业务结果一律 200，结果在 body 里
type OptimizeOk = { ok: true; text: string };

// 失败（Client 直接把 error 显示在按钮 tooltip 上）
type OptimizeFail = {
  ok: false;
  code: 'empty_input' | 'input_too_long' | 'llm_unavailable'
      | 'model_unavailable' | 'llm_error' | 'empty_result'
      | 'truncated' | 'unknown';
  error: string;   // 面向用户的中文文案
};

// 传输层失败用状态码，不混进业务结果
// 403 forbidden         非回环来源
// 405 method_not_allowed 非 POST
// 400 bad_request        请求体非法 JSON 或超限
```

### 6.2 Host → 模型（`ctx.get('llm').stream`）

```ts
{
  provider, model,                  // 取自 agentDefaultModel.currentSelection()
  reasoningEffort?,                 // 有则透传
  system:   buildSystemPromptFor(text),
  messages: [{ id, role:'user', content:[{type:'text', text: renderUserPrompt(text)}],
               source: { kind:'plugin', plugin:'prompt-seed' } }],
  temperature: 0.2,
  maxTokens:   1200,
}
```

### 6.3 Slot 注册

```js
slots.inject('conversation.input.right', () =>
  slots.register(
    { name: 'conversation.input.right', id: 'prompt-seed', order: -10 },
    (props) => React.createElement(OptimizeButton, props),
  )
)
```

- `conversation.input.right` 是 list 型槽（"Compact controls before the composer submit action"），
  现有占用者只有 `usage-billing-cost-chip`（order 0），`order: -10` 让我们落在它左侧。
- 该槽的 standardProps 提供 `useInput: SnapshotSelectorHook<InputState>` 与 `inputActions: InputActions`，
  **因此读取草稿、回填草稿都不需要任何 Host 往返**；唯一的跨半区调用是那一次优化请求。

---

## 7. 关键设计决策记录（ADR）

### ADR-1 用 `llm` 服务而不是自建 HTTP
DSH 的 `llm` 服务已经是 adapter 注册表 + 流式调用 API，还带 `llm/stream` 拦截点、
重试策略与凭据治理。在同一进程内另开一条 HTTP 通道，等于把鉴权、重试、凭据解析
各实现一遍，而这三件事恰恰是最容易随基础设施演进腐化的部分。
**决定**：`ctx.get('llm').stream()`，鉴权/路由/重试交给基础设施。

### ADR-2 非流式回填，而不是逐 token 打字机
逐 token 调 `inputActions.setDraft` 会：① 每 token 触发一次编辑器事务与 `draftRev` 递增，
② 把回填的 `draftRev` 与用户输入的 `draftRev` 混在一起，让 I2 的 CAS 失效。
**决定**：Host 端拼完整流再一次性返回；Client 只写一次。

### ADR-3 用 `draftRev` 做 CAS，而不是快照比对
判断"用户是否在等待期间改过输入"有两条路：把回填前后的内容做深比较，或者用修订号。
深比较方案还必须额外引入"这次写入是我自己发起的"指纹，否则无法区分
程序化写入触发的 `onContentChanged` 回声与用户真实输入。
DSH 的 `InputState` 直接给出单调递增的 `draftRev`，**发起时记一个 rev，回来时比一下即可**，
既不需要深比较也不需要对回声做特判。
**决定**：请求前记 `revAtStart`，返回后 `draftRevRef.current !== revAtStart` 就丢弃。

### ADR-4 有引用 chip 时禁用优化
`inputActions.setDraft(text)` 是**整体替换**，而 `InputState.draft` 是 chip 展开后的
clipboard 投影；整体替换会把 `@file`、`/command` chip 退化成纯文本。
**决定**：`occurrences.length > 0` 时按钮禁用并在 tooltip 里说明原因。
公共 action 面只提供整体替换，因此这是能力边界决定的收敛，而非实现疏漏；
若将来 `InputActions` 暴露按 occurrence 局部改写的动词，此限制即可解除。

### ADR-5 前端取消不撤销已发出的请求
`fetch` 的 abort 只影响浏览器侧，模型调用的成本在请求发出时就已付出。
让前端"取消"去撤销一个已经完成的 RPC 既做不到也无收益。
**决定**：取消 = 递增 `seqRef` 让结果作废 + 立即恢复 UI，底下的 RPC 跑完即丢弃。
用户感知到的取消是即时的，不需要基础设施提供取消语义。

### ADR-6 `finish=max-tokens` 一律当失败，哪怕已经产出正文
`max-tokens` 意味着模型还想继续，所以拿到的必然是半截结果。
"有正文就回填"看起来更宽容，实际是把一段未完成的 prompt 塞进用户的输入框，
用户很可能直接回车发出去。而模板自己就写着 `Do not end with an unfinished list`。
**决定**：新增 `truncated` 错误码，无论正文是否为空一律拒绝，输入框保持原样。
依据：真实模型探针在 200 token 预算下复现了 `finish=max-tokens` + 正文 0 字符，
而"假 llm 永远返回 stop"的测试替身永远掩盖这条路径。详见 §10。

### ADR-7 跨半区走回环限定的 HTTP 路由，而不是 Remote 服务
两条路都能把结果送到浏览器。Remote 需要 Typert 的构建期 schema 生成，本插件只有一个
`{text}` → `{ok, text}` 的载荷，为它引入代码生成链不划算；HTTP 路由是更小的接缝。
代价是路由对同机其它进程可见，因此必须自带来源校验。
**决定**：`ctx.webServer.register({ kind:'exact', path, handler })`，并在 handler 顶部
调用 `guardLoopback`。校验**同时**看 peer socket 地址与 `Host` 头：只看 peer 挡不住
DNS rebinding（浏览器会替你发出请求），只看 Host 头则等于把内网任意来源都放进来。

---

## 8. 扩展点

1. **模型可见的 Tool**：`harness.defineTool` 可注册 `optimize_prompt`，让 Agent 自己
   在对话中调用同一套 `optimizePromptText`。当前 Package 未注册以保持动作空间最小。
2. **风格/场景选择器**：在 `conversation.input.right` 之外再加一个 Slot 承载下拉，
   把选中的风格拼到 `SYSTEM_SUFFIX`。当前版本不含此项，属于增量能力。
3. **双语 UI**：Client 通过 `ctx.get('locale')` 注册字典，替换硬编码中文。
4. **导出为模型可见的工具**：在 Host 半区再加一行 `ctx.tools.register`，把同一条
   路由背后的 `optimizePromptText` 暴露给模型，让 Agent 能主动改写用户草稿。
   当前未注册，以保持模型的动作空间最小。

---

## 9. 验证

```bash
npm run verify        # 构建产物 + 23 个单元测试
node --test test/*.test.mjs
```

覆盖范围：

| 类别 | 用例 |
|---|---|
| 输出清洗 | 引号（ASCII/中文/日文）、markdown 围栏、`Enhanced prompt:` / `优化后的提示词：` 前缀、组合场景 |
| 输入校验 | 空串、纯空白、非字符串、超长、正常 |
| 脚本检测 | CJK / Latin / Mixed / Unknown |
| 模板完整性 | 语言一致性规则、`Do NOT answer questions`、追加硬约束 |
| 渲染 | `{input}` 替换干净、模板主体保留 |
| 流拼接 | `text-delta` 累积、`finish.error` 捕获、`finish.aborted` 捕获 |
| 错误分支 | 8 个错误码全覆盖，含 `llm.stream` 同步抛错 |
| 不变量 I1 | 失败时返回值**不含** `text` 字段 |
| 产物一致性 | `package.json` 的每个入口都真实存在；`cordis.patch.yml` 按包名引用；`lib/client.js` 的模块 id 等于包名 |
| **产物可执行性** | 用桩 `req`/`res` 驱动真实路由 handler（成功 / 空输入 / 405 / 400 / 超限 / 403 / 缺 llm / 缺模型 / 自定义 path）；用 `__ModuleLoader__` 桩 materialize 真实浏览器 bundle，断言导出形状与槽位注册 |
| 跨产物一致性 | 浏览器半区请求的路由必须等于 Host 半区导出的 `DEFAULT_ROUTE` |
| 真实安装 | `npm pack` → `dsh plugin --profile plugin-lab add <tgz>` → `--dump-config` 出现本插件的层与行 |

**测试确实抓到了一个真 bug**：`normalizeResult` 最初写成 `标签(引号(围栏(x)))`，
对 `` ```\nEnhanced prompt: "…"\n``` `` 这种输入，剥引号时首字符是标签的一部分而不是引号，
引号永远剥不掉。修正为 `围栏 → 标签 → 引号 → 标签`，
见 `src/prompt-templates.js` 与 `test/optimizer.test.mjs:80`。

---

## 10. 真实模型上的实测（而不是估算）

单元测试和构建产物烟测都只用到假 `llm`。剩下唯一没被覆盖的风险是
"**手工构造的 `Message` 形状和输出预算是否真的能被 adapter 接受**"。
为此写了两个一次性 Host-only 探针插件，跑完后已 `cordis_undefine` 清理。

### 探针 1：Message 形状

```
route:  command-code / deepseek/deepseek-v4.1-flash
ok:     true
chunks: ["block-start", "reasoning-delta", "block-end", "usage", "finish"]
```

→ **手工构造的消息形状被 adapter 完全接受**，不需要 `createUserMessage`。
（本包刻意不依赖 `@deepseek-ai/dsh-llm`：手工构造只用到运行时真正读取的字段，
换来零运行时依赖，也让这一层能被普通 `node --test` 直接加载。）

同时暴露问题：该轮 `finish: "max-tokens"`、正文 0 字符 —— 200 token 预算
被 `reasoning-delta` 全部吃光。于是有了探针 2。

### 探针 2：输出预算与语言一致性

探针直接 `fs.readText` 读取构建产物，从中抽出**真实的**
`SYSTEM_TEMPLATE` / `SYSTEM_SUFFIX` / `USER_TEMPLATE`，再对中/英/混排三种输入
各跑一次真实调用，预算固定 1200：

| 输入 | finish | 正文字符 | 输出 token | cacheRead | CJK / Latin |
|---|---|---|---|---|---|
| `帮我看看这段代码有没有问题` | stop | 169 | 513 | 128 | 154 / 0 |
| `check my code for bugs` | stop | 712 | 537 | 384 | 0 / 559 |
| `这个函数有 bug，can you help me fix it?` | stop | 90 | 449 | 384 | 75 / 6 |

三条结论直接改变了实现：

1. **`MAX_OUTPUT_TOKENS = 1200` 不是猜的** —— 三次实测 449–537 token 全部 `finish=stop`，
   余量约 2.2 倍。这个余量并不宽裕，因此 `truncated` 守卫不是理论上的防御。
2. **语言一致性在真实模型上生效** —— 中文出纯中文、英文出纯英文、混排出"保留术语 +
   连接语句归并主导语言"，且三种输入下 `normalizeResult` 全都无事可做
   （无标签、无围栏、无首尾引号）。
3. **`finish=max-tokens` 必须显式处理** —— 这是探针 1 抓到的真实失败路径。
   原实现让 `max-tokens` 静默穿透：有正文就**把半截 prompt 写进用户输入框**，
   没正文就落到语义模糊的 `empty_result`。修正为新增 `truncated` 错误码，
   **无论有没有正文一律拒绝**（模板本身禁止"未完成的列表"），
   见 `src/host-core.js` 与 `test/optimizer.test.mjs` 的
   `finish=max-tokens 一律拒绝，即使已经产出正文`。

### 探针 3：模板重写后的等价性回归

把两段 meta-prompt 重写为本项目自有文本后，用同一套探针重跑三案例，
确认行为等价（数据见探针 2 的表）。这次回归还抓出了重写版自身的一处缺陷：
规则写着"混排输入不得翻译任何部分"，但模型会把连接语句归并到主导语言。
**矛盾在规则而不在模型** —— 归并比逐字保留更可读，且用户所用的术语并未丢失。
规则已改为"保留术语 + 连接语句用主导语言"，并加了回归守卫测试
`混排语言规则不自相矛盾`。

第 2 条与第 3 条都是**只有跑真实模型才能发现**的：前者无法用单测证明，
后者由一个"假 llm 永远返回 stop"的测试替身永远掩盖。

---

## 11. 打包模型：bundle 与 profile

DSH 的插件分发建立在两个不同的对象上，各自由一份 `package.json` 描述，都在 `dsh` 键下：

| 对象 | manifest | 回答的问题 | 谁写 |
|---|---|---|---|
| **组合包 bundle** | `dsh.bundle` | 这个包贡献什么？一个 patch 文件 | 本仓库 |
| **profile** | `dsh.profile` | 这套配置由哪些组合包按什么顺序组成？ | `dsh plugin` 维护 |

本仓库是一个组合包，因此：

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

```yaml
- insert:
    - id: prompt-seed
      name: dsh-prompt-seed     # 按包名，不是相对路径
```

行必须按**包名**引用，Node 的模块解析才能找到已安装的代码。

### 浏览器半区靠 `dsh.client` 声明

```json
{ "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-conversation"] } } }
```

宿主侧扫描 Loader 里每个包的 `dsh.client`：`platform` 必须是 `"web"`，
且 `exports["./client"]` 必须解析到一个字符串路径，否则装载期直接抛错。
`react` 属于 shell 提供的 seed 模块，按解析顺序（seed word → shell 实例）
**不需要**在 `dsh.client.external` 里声明。

### 层顺序与覆盖语义

生效配置按以下顺序逐层组合，后者按行胜出：

1. profile 的 `dsh.profile.bundles`，按列表顺序（`@deepseek-ai/dsh-base` 恒在首位）；
2. profile 自己的 `cordis.patch.yml`；
3. `$DSH_HOME/cordis.patch.yml`；
4. 命令行上的 `--patch <path>`。

patch **替换**目标行的整个 `config`，不是深度合并——所以用户可以在自己的 profile 里
覆盖本插件的 `route`，而无需改动本包。

### 分发形态

| 形态 | 用户执行 | 代价 |
|---|---|---|
| npm 包 | `dsh plugin add dsh-prompt-seed` | 无；`lib/` 已预构建 |
| tarball | `dsh plugin add ./x.tgz` | 无；不可变、可校验，适合发布前评审 |
| Git 依赖 | `dsh plugin add github:you/repo` | 拉的是**源码**，需要自包含的 `prepare`，且用户必须显式 `allowBuilds` 授权——那等于让你的代码在沙箱之外于其机器上执行 |

本包只走前两条：`files` 白名单确保 `lib/` 与 `cordis.patch.yml` 进 tarball，
`prepack` 保证发布前一定重新构建。

### 验收判据

安装后**先不要启动**，用 `--dump-config` 确认层与行都在：

```sh
dsh plugin --profile plugin-lab add ./dsh-prompt-seed-0.1.0.tgz
dsh --profile plugin-lab --dump-config | grep -A2 '# == dsh-prompt-seed'
```

实测输出：

```
# == dsh-prompt-seed
- id: prompt-seed
  name: dsh-prompt-seed
```
