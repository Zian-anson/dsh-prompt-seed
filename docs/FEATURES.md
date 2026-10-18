# 功能清单与验证结果（0.19.2）

> 本文件按 0.19.2 的实际实现核对。所有非招呼输入只调用一次；没有路由、shape、语义校验或补救。

## 核心模块

| 模块 | 职责 | 验证 |
|---|---|---|
| 分析器 | 只分 passthrough / optimize；没有 route/shape/ambiguity | 19 项测试 |
| Prompt 契约 | 单一改写契约；不回答/不执行/不新增要求 | 单测 |
| 调用预算 | 内容输入恰好 1 次；无补救 | 单测 + wire |
| 最小校验 | 空结果/模型错误回原文；明确代码锚点丢失回原文 | 单测 |
| 流式路由 | NDJSON meta/delta/final；JSON 降级；15s 无输出看门狗；abort | 单测 + wire |
| 会话任务 | Host 内存 JobStore；切会话不取消；status/bind/cancel/consume；无数字徽标 | 单测 + wire |
| 首次优化建会话 | 空白新对话第一次优化创建真实 Session、生成标题、交接草稿、绑定 job | bundle + 手工 |
| 客户端 | 单按钮、流式预览、取消、撤销、再来一版；首次优化建会话 | bundle + 真实点击 |
| 输出上限 | 不传 maxTokens；不做字数上限/语义截断 | 单测 |
| 安全 | 回环 peer/Host/Origin；POST；application/json；64KB body | wire |

## 明确移除

- 五路由 / shape / ambiguity / targetRatio / clarityGain / invented_anchor / speech-act / taskified / 长度门
- repair / 第二次调用 / semantic audit / re-audit / language repair / unfold-tighten
- maxTokens、12s 总时长切流；旧 task-store 磁盘登记簿

## 验证覆盖

- **单元测试**：11 项（最小分析、prompt、单调用、passthrough、锚点、空/错误、client bundle、自重启）
- **真实 socket 检查**：`npm run check:wire`，13 项
- **文档/安装守卫**：`npm run check:docs`、`npm run check:install`
- **真实模型 benchmark**：`npm run bench`（行为/延迟；质量需人工盲评）

## 验收线

| 指标 | 目标 |
|---|---|
| 非 passthrough 调用 | 恰好 1 次 |
| passthrough | 0 次 |
| p50 / p95 / max | ≤ 3s / ≤ 8s / ≤ 20s |
| 灾难性失败 | 0（丢锚点、错语言、答非所问、把问题改成任务） |
| 人类可用性 | ≥80% 案例“可用” |

## 说明

- 0.19.2 的 benchmark 仍在真实 provider 上运行；provider 尾部延迟用 15s 超时兜底。
- 旧版 302 项以内部分支为中心的测试已被替换；数字以本文件与 README 为准。

## 数字口径

- 验证手段：单元测试 19 项 · 真实 socket 检查 13 项 · 文档/安装守卫 2 项
- **单元测试**（19 项）
| 模块 | 数量 |
|---|---|
| **单元测试** | ✅ 19 项全通过 |
| 真实 socket | `npm run check:wire`，13 项 |
