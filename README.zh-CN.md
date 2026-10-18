# dsh-prompt-seed

[English](README.md) | **简体中文**

[![CI](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml/badge.svg)](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Zian-anson/dsh-prompt-seed)](https://github.com/Zian-anson/dsh-prompt-seed/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests: 19 passing](https://img.shields.io/badge/tests-19%20passing-brightgreen.svg)](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml)

DSH 输入框插件：写下粗糙草稿，点 **✦**，原地改写。

**0.19.2 是最小优化器。** 所有非招呼输入只调用一次模型，只执行一个契约：把草稿改写成
同一条消息的更清楚版本。不回答、不执行、不新增要求；保留意图、言语行为、语言、确定性、
路径和标识符。没有路由、没有 shape、没有 ambiguity、没有倍率、没有补救、没有语义校验门。

只保留两个保护：空结果/模型错误回原文；原文明确的路径/文件/URL/标识符丢失回原文。
其余交给模型和撤销。

首次优化建会话/标题保持不变：空白新对话第一次优化会创建真实 Session、生成标题、带着
草稿打开，并把任务绑定到 sessionId；不自动发送消息。maxTokens 不设置；保留 15s 无输出
看门狗和 20s 总预算。

## 它做什么

| 草稿 | 结果 |
|---|---|
| 帮我做个登录页 | 同一请求的更可执行版本 |
| 现在是不是该发布了？ | 同一问题，更清楚 |
| 我觉得效果不好 | 同一抱怨，把对象/判据说清楚 |
| 好了 | 0 次调用，中性返回“无需优化” |
| 删除 src/a.js 的 export，跑测试 | 近原样；src/a.js 必须保留 |
| （空输入，有会话上下文） | 水晶球预测 |

没有路由表。非空/非招呼输入都只优化一次。

## 会话切换与恢复

优化任务是 **Host 持有的任务**，不再绑在组件/请求上。

- 优化中切到别的会话：本地流断开，Host 任务继续；切会话绝不取消。
- 切回来：按钮恢复 running 进度或已完成结果。草稿没变 -> 自动写回；草稿变了 -> 保留结果并显示“结果已就绪 · 点击取回”，绝不覆盖。
- 新会话还没有 sessionId：client 用 draft conversationKey 先跑，首条消息产生 sessionId 后 bind。同一时间只允许一个未绑定的新会话任务。
- 只有显式取消才会取消；刷新、页面隐藏、切会话都不取消。
- 别的会话有任务在跑时，当前输入框**不显示任何数字徽标**。
- 任务在 Host 内存中，TTL 10 分钟；Host 重启会干净地清空（idle，不出现 stale 转圈）；同一 Host 下刷新页面可恢复。
- API：optimize / status / bind / cancel / consume；没有“列出所有任务”的接口。

## 安装

```sh
dsh plugin --profile <name> add \
  https://github.com/Zian-anson/dsh-prompt-seed/releases/download/v0.19.2/dsh-prompt-seed-0.19.2.tgz
```

本地开发也可以用 tarball：

```sh
dsh plugin --profile <name> add ./dsh-prompt-seed-0.19.2.tgz
```

按钮出现在输入框工具行。卸载：`dsh plugin --profile <name> remove dsh-prompt-seed`。

## 配置

```yaml
config:
  route: /api/prompt-seed/optimize
  provider: opencode-go        # 可选；不填则跟随宿主模型选择
  model: deepseek-v4.1-flash
  requestTimeoutMs: 20000
  context: true
  samples: ~/.dsh/prompt-seed/samples.jsonl
  templates: true
```

0.19.2 删除了 `pipeline`、`depth`、`auditProvider`、`auditModel`、`deadlineMs`、
`rewriteReasoningEffort`、`predict`、`tasks`。这些功能要么是延迟放大器，要么无法验证；
可从 v0.14.4 tag 回滚。

模板覆盖：`$DSH_HOME/prompt-seed/prompts/{optimize}.md`。

## HTTP API

`POST /api/prompt-seed/optimize`

请求：

```json
{ "action": "optimize", "text": "...", "sessionId": "...", "conversationKey": "draft:...", "stream": true }
```

动作：`optimize`、`status`、`bind`、`cancel`、`consume`。`status` 只返回当前会话的任务
（`{ok, job}`）；`bind` 把未绑定的 draft 任务绑到 sessionId；`cancel` 只有显式调用才取消。
没有“列出所有任务”的接口。

`stream:true` 返回 NDJSON：

```text
{"type":"meta","route":"optimize","reasons":[],"promptVersion":"0.19.2"}
{"type":"delta","text":"..."}
{"type":"final","ok":true,"text":"...","route":"optimize","changed":true,"calls":1,"ttftMs":900,"ms":2600}
```

不带 `stream` 时返回单个 JSON；`?debug=1` 在 JSON final 里带 `_debug`。路由只接受本机回环与
`application/json`。

失败是显式的：`empty_result`、`truncated`、`validation_failed`（带原因和被拒稿）、
`request_timeout`、`nothing_to_optimize`。失败时绝不静默替换原稿。

| 文件 | 内容 |
|---|---|
| `test/optimizer.test.mjs` | 19 项单元/契约/路由测试 |

## 开发

```sh
npm test        # 构建 lib/，再跑 19 项测试、13 项真实 socket 检查、文档/安装守卫
npm run bench   # 默认生产路由的真实模型 benchmark
```

benchmark 语料在 bench/corpus.json，执行器在 tools/bench.mjs：检查内容恰好 1 次调用、
passthrough 0 次、失败、锚点保留和 p50/p95。质量不交给机器判定；按发版说明做 30–40 条
盲评。发布门槛：p95 ≤ 8s、0 失败/坏调用/锚点丢失、人工可接受率 ≥80%。

## 限制

- 单次 provider 调用仍可能慢；15s 无新 token 才中止，Host 总预算 20s，不会在 12s 处切健康流。
- 发送 `reasoningEffort: "low"`；DSH adapter 不接受 `none`。插件不偷偷加重试。
- 上下文使用最近 3 条用户 + 2 条助手尾部（≤1400 字），只用于消解指代。
- 空输入预测（水晶球）已恢复；深度档位仍移除；优化任务改为 Host 持有的会话任务。

## 许可

MIT。