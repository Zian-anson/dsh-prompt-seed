# dsh-prompt-seed

[English](README.md) | **简体中文**

[![CI](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml/badge.svg)](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Zian-anson/dsh-prompt-seed)](https://github.com/Zian-anson/dsh-prompt-seed/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2ea44f.svg)](https://github.com/topics/dsh-plugin)
[![tests: 200 passing](https://img.shields.io/badge/tests-238%20passing-brightgreen.svg)](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。输入一行种子草稿，
点 **✦**，草稿原地改写成一个 agent 真正能执行的具体 prompt——**把你没写出来的中间细节展开**，
同时由语义保真闸门保证意思和语气不走样。点 **↺** 一键恢复原文。

```
帮我做个图片压缩的功能
        │  点击 ✦
        ▼
帮我做一个图片压缩功能：支持上传 jpg、png、webp，可设置压缩质量或目标体积，
压缩前后显示文件大小与清晰度对比，多张可批量压缩打包下载。注意处理大图不卡页面、
透明 png 保持透明、格式不支持时给提示、压缩失败保留原图。
        │  原地写回（凭证：保真 ✓ · +178 字 · 补全：格式、质量、边界情况）
        ▼
↺ 原文 · ✦ 再来
        │  再生成一版后
        ▼
↺ 原文 · ✦ 再来 · ‹ 上一版
```

## 功能特性

- **补全式展开**：一行种子展开为具体可执行请求（实测 10–25 倍），而非近原样润色
- **精确模式**：已完整的指令近原样保留（1.0–1.1 倍），带锚定词守恒的跳审短路
- **语义保真闸门**：独立审判调用，五类越线分类（曲解/加范围/矛盾/变语气/注水）+ 按类定向修复 + 无条件复核
- **信号推断（0.9.0）**：纯数字/「继续」类输入按上下文锚点推断（选项/待答问题/待续提议），对不上就明确说无法推断，零模型调用也不硬猜
- **短指令度契约（0.9.0）**：「改一下」「不对」类输入消解指代后有度展开：动词逐字保留、180 字硬上限、禁新增目标/技术栈/范围
- **深度档位**：自动/轻/标准/深度，右键 ✦ 切换；标准档与基线逐字节一致
- **版本历史**：✦ 再来一版（保留最近 3 版）、‹ 回退一版、↺ 恢复原文
- **模板可覆盖**：`$DSH_HOME/prompt-seed/prompts/` 下放同名文件即替换内置契约，改完下一次点击就生效
- **隐私**：不持有任何 API key、无遥测、唯一出站请求就是宿主本来就会发的模型调用；本地回环路由三重校验（peer 地址、Host 完整形状、Origin）防 DNS rebinding 与跨站页面误打

## 兼容性

| 项 | 值 |
|---|---|
| 宿主 | `dsh >=0.2.0-rc.1 <0.3.0-0`（engines 声明）；实测 `0.2.0-rc.2` |
| Node | `>=22.19` |
| 运行时依赖 | **零**——5 个 ES 模块，安装无需构建 |

0.x 阶段次版本号可能包含破坏性变更；补丁版本不会。宿主缺 seam 时插件**自禁用而不拖崩宿主启动**。

## 安装

安装已发布的 tarball（当前唯一可用通道，按版本钉住）：

```sh
dsh plugin --profile <name> add \
  https://github.com/Zian-anson/dsh-prompt-seed/releases/download/v0.12.0/dsh-prompt-seed-0.12.0.tgz
```

> **如果报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`**：先下载资产，再按本地路径安装——字节完全相同，本地路径不受该问题影响：
>
> ```sh
> curl -LO https://github.com/Zian-anson/dsh-prompt-seed/releases/download/v0.12.0/dsh-prompt-seed-0.12.0.tgz
> dsh plugin --profile <name> add ./dsh-prompt-seed-0.9.3.tgz
> ```
>
> 成因在上游不在本包：pnpm 为 `https` tarball 依赖写 lockfile 时不写 `integrity` 字段，随后又在复核阶段拒绝自己的条目。发布资产本身与仓库逐字节一致，可用 `node tools/verify-release.mjs v0.9.3` 复核。

发布到 npm 后，这条命令同样可用：

```sh
dsh plugin --profile <name> add dsh-prompt-seed   # npm 通道，待发布
```

验证后再启动：

```sh
dsh --profile <name> --dump-config     # 应出现 dsh-prompt-seed 行
dsh --profile <name>
```

✦ 按钮出现在输入框工具区、模型选择器左侧。卸载：`dsh plugin --profile <name> remove dsh-prompt-seed`。

## 使用方法

1. 随手输入一行草稿——有错别字也没关系。
2. 点 **✦**，等 1–6 秒，草稿原地替换，不弹窗。**插件自己选操作**（0.9.4）：真种子
   补全展开；完整但含混的草稿按原长度**澄清梳理**（同义、理顺指代、不加内容，
   硬上限 1.5×）；已精确的指令近原样通过。不用选模式，一次点击对任何输入都给合理结果。
3. 悬停 **↺** 读凭证：保真判定、字数变化、补全了什么。
4. 不满意？**✦** 再来一版，**‹** 回上一版，**↺** 恢复原文；自己编辑过草稿则撤销自动失效。

**信号与短指令**（0.9.0）：

| 输入 | 上下文锚点 | 结果 |
|---|---|---|
| `1` | 「要不要继续？1. 继续梳理 2. 先停」 | 展开选中项：继续梳理 |
| `15` | 「这个月几号发布？」 | 数字即回答：15 号发布 |
| `42` | 选项只有 1/2 | **无法推断（零模型调用，不硬猜）** |
| `改一下` | 刚把按钮改成红色 | 「先给我两三个候选颜色」量级的有度展开 |
| `不对` | 方案不符合预期 | 指出错在哪、按原意重做，不引入新技术栈 |

## 下一步输入预测（0.9.6）

草稿为空、且会话里已经有来有回（用户说了、助手答了、当前没有在跑的回合）时，**✦** 的位置换成
**水晶球**：点它读会话尾部，推断你接下来最可能发的那句话，直接填进输入框；一开始打字就交回星标。

预测**按上下文分型**，不固定长度——能预测的东西本身随语境变。分型由确定性规则判定（零额外模型
调用），每型有各自的字数预算：

| 会话尾部的锚点 | 分型 | 预算 | 写出来的东西 |
|---|---|---|---|
| 助手给了编号选项 | choice | ≤ 20 字 | 复述最可能被选中的那一项 |
| 助手停在提问上 | answer | ≤ 40 字 | 直接回答该问题 |
| 助手问「要不要继续」 | continue | ≤ 20 字 | 确认，最多带一个短条件 |
| 任务刚交付完（本轮有工具活动，或尾部有交付措辞） | next-step | ≤ 40 字 | 针对该工作的下一步动作 |
| 刚发生了失败 | repair | ≤ 40 字 | 修复或重试 |
| 以上都不是 | **cannot_predict（零模型调用）** | — | 什么都不写，图标转中性并给出说明 |

硬保证在代码里，不指望提示词自觉：一句话、不得是清单；超预算 → 收紧重试一次 → 按句读边界确定性
收尾；真故障在图标旁显示「预测失败，点击重试」，绝不静默。拒绝是中性态而不是红色故障——
`cannot_predict` 与信号分支的 `cannot_infer` 同构：**推不出来就不说话，不硬猜一句"继续"**。

空会话里什么都不显示（星标也去掉）；有了一段上下文，入口才出现。

**预测的配置**（0.9.7 起）：预测读会话尾部，由独立的 `predict` 行配置键控制（默认开启，
`predict: false` 关闭）；`context: false` 只关闭改写/审判的上下文注入，不再连带禁用预测。
另新增 `requestTimeoutMs`（默认 120000）：单条请求的墙钟硬上限——provider 挂起时把
「永久挂死」变成可重试的结构化错误（`request_timeout`），并向 `llm.stream` 透传中止信号。
完整配置表见[英文 README](README.md#install)。

## 目录结构

| 路径 | 职责 |
|---|---|
| `src/prompt-templates.js` | 提示词契约资产、输出归一化、输入校验 |
| `src/host-core.js` | 路由解析、`llm.stream` 消费、错误归一化、自适应契约与各分支路由 |
| `src/signal-inference.js` | 信号分类、锚点推断、度校验（全确定性纯函数） |
| `src/session-context.js` | 按需提取最近用户话轮；预测窗口（助手取尾部 + 本轮工具活动） |
| `src/prediction.js` | 预测分型判定与输出校验（全确定性纯函数） |
| `src/sample-log.js` | 本地事件日志（samples.jsonl） |
| `src/host-plugin.js` | Cordis 宿主插件 → `lib/index.js` |
| `src/client-plugin.js` | 浏览器半区工厂 → 包成 `lib/client.js` |
| `tools/build.mjs` | 构建脚本：复制宿主半区、包裹浏览器半区 |
| `test/optimizer.test.mjs` | 238 项单元/契约/路由测试 |
| `docs/FEATURES.md` | 逐项实测核对的功能清单 |

`src/` 是经过测试的唯一事实源；`lib/` 是构建产物（**有意提交**，DSH 直接从 lib 加载，CI 有漂移守卫），不要手改。

## 开发

```sh
npm test        # 先构建 lib/ 再跑 238 项测试
npm run build   # tools/build.mjs → lib/
```

本地测试免发布：`npm pack` 后 `dsh plugin --profile plugin-lab add /tmp/dsh-prompt-seed-<版本>.tgz`。

**升级后行为没变？重启 App。** 宿主半区是 ES 模块，Node 模块缓存按 URL——同名重装落在同一路径，
运行中的进程会继续执行旧模块。用 `?debug=1` 看 `_debug.codeVersion` 确认实际加载的版本。

## 已知限制

1. 引用芯片（@文件 / 命令）会降级为纯文本——平台没有从文本重建芯片节点的 API；守恒校验会拒绝丢失芯片标签的写回。
2. UI 文案仅中文（locale 服务未接）；非流式。最差路径（被拒时走满四次调用）约 20 秒——`auditProvider` / `auditModel` 可把两次审判挪到更快的模型上，`deadlineMs` 可给可选调用设墙钟预算；两者缺省都不设，行为与从前一致。
3. 闸门判定默认共享会话默认模型（可用 `auditProvider` / `auditModel` 单独路由）；`TONE_SHIFTED` / `PADDED` 是审判模型的判断而非确定性检查。反向的取舍同样是有意的：修复稿即使与上一稿逐字相同也**仍要复核**，因为首次判决本身就可能是一次误报。

## 协议

MIT——见 [LICENSE](LICENSE)。

本项目与 DeepSeek 无隶属、授权或赞助关系。「DeepSeek Harness」「DSH」指本插件所适配的开源宿主应用；
这是一个独立的第三方插件，本仓库中的任何许可均不授予任何商标权利。
