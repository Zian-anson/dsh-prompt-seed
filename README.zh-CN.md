# dsh-prompt-seed

[English](README.md) | **简体中文**

[![tests: 68 passing](https://img.shields.io/badge/tests-68%20passing-brightgreen.svg)](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml)

DSH 输入框只显示一个主工具：**有内容时 ✦ 优化，空白时 🔮 预测下一句**。都只填入草稿，不自动发送。

> 当前版本 0.21.1；真实模型质量、界面验收与已知限制见 [验收记录](docs/ACCEPTANCE.md)。

## ✦ 把意思表达清楚，而不只是换同义词

短草稿补必要的执行细节、边界与验证；长篇口述整理压缩；准确指令保持简洁。
例如“首页加载太慢，优化一下”可以明确为定位瓶颈、实施针对性改进并比较前后表现。
不改变目标、事实、范围和授权，不添加独立功能、随意指定技术栈或编造指标。
“先讨论，不改代码”、数字、技术名称和否定要求必须保留。

- 点击生成后，主操作是“换一版”，始终使用本轮原稿。
- 手动编辑后变回“优化”，以当前草稿开始新一轮。
- “⋯”中可恢复最近一轮原文；手改后先预览，再明确“替换草稿”。
- 空输入、纯招呼、纯确认零调用。无改进显示“未改动”，不冒充成功优化。

## 🔮 猜下一句，不替你决定下一步

输入为空、已有助手回复且助手不在生成时可用。结合近期对话和你的口吻，通常给出一句候选，可能是确认、追问、纠正、补充或继续指令。
没有依据显示“暂时无法预测”。空白会话不调用模型。

预测填入后，主图标随草稿变为优化；“⋯”中仍可“换一句”或“撤回预测”。编辑后成为普通草稿，不再提供可能清空手写内容的撤回操作。

成功后不常驻显示文字，运行只显示转圈；失败和无改进用简短提示，详情可悬停查看。仅有还原、后台任务或待取结果时出现“⋯”；切换图标不取消任务，后台取消与结果取回也在这里。

## 草稿保护和任务恢复

两个功能有独立的提示词、上下文、控制器、任务、结果和撤销记录。基础连接和任务引擎共享，但取消、取回和消费只影响对应功能。

- 每次生成最多一次模型调用，无隐藏重试、补救调用或模型审判。
- 切会话、卸载组件、断流不取消任务；只有显式取消才终止。
- 自动写回要求会话一致、编辑器可编辑、草稿版本及引用/附件均未改变。编辑后又改回相同文字也不会被覆盖。
- 无法证明未变（包括刷新或新编辑器实例）时显示“查看结果”。预览后才能明确替换。
- 引用使用宿主语义草稿接口恢复；无法无损恢复时只能查看/复制候选。新增引用也不会被替换操作悄悄清掉。附件不由纯文本写回修改。
- 每会话保留最近一轮原文和候选；发送成功后清理，提交失败保留。草稿本身沿用宿主持久化，插件恢复记录保存在当前浏览器页签。
- 已有 sessionId（含空白会话）直接优化，不另建会话、不改标题。确实没有标识时先启动一次生成，再异步创建必要会话、绑定原任务；不会抢回用户已切换的页面。
- Host 任务保留十分钟。Host 重启后任务丢失，旧转圈清除；不恢复陈旧运行状态。

## 安装

已发布版：

```sh
dsh plugin --profile <name> add \
  https://github.com/Zian-anson/dsh-prompt-seed/releases/download/v0.21.1/dsh-prompt-seed-0.21.1.tgz
```

开发候选：`npm pack` 后用 `dsh plugin --profile <name> add ./dsh-prompt-seed-0.21.1.tgz` 安装。
Host 改动需要空闲时重启 DSH。先保留旧安装包用于恢复；不要编辑 profile 中的安装副本。
桌面版应使用应用自带的兼容 CLI。卸载：`dsh plugin --profile <name> remove dsh-prompt-seed`。

## 配置

```yaml
config:
  route: /api/prompt-seed/optimize
  # provider / model 成对指定；省略则沿用 Host 当前默认模型
  requestTimeoutMs: 20000
  context: true
  samples: true
  templates: true
  # ui:
  #   button: true   # 0.21.1：外部包接管优化入口时设为 false；只隐藏 ✦，水晶球保留
```

模板覆盖仍从 `$DSH_HOME/prompt-seed/prompts/` 读取：`optimize.md` 优先、`seed.md` 为旧版回退。
已有 `clarify` / `precise` / `chat` 文件不覆盖、不删除；单契约改写不再选择这些分路模板。
本地样本仅记录输入/输出预览，`samples: false` 可关闭；不自动上传。

## HTTP API 兼容

`POST /api/prompt-seed/optimize`，仅回环、`application/json`。

```json
{ "action": "optimize", "kind": "optimize", "text": "...", "sessionId": "...", "stream": true }
```

地址及 `optimize / predict / status / bind / cancel / consume` 保留。
查询与绑定省略 `kind` 时仍为优化任务；新调用传 `"optimize"` 或 `"predict"`。
取消和消费保留旧 jobId 调用方式，新调用另传 kind 校验归属。

两种生成都可 `stream:true`，返回 NDJSON `meta / delta / final`，包含 jobId 和 kind。
非流式 optimize 返回原 final JSON；非流式 predict 保持 `{ok:true,text}` 或 `{ok:false,code,error}`，不要求新字段。
`status` 增加 `protocolVersion:2`、`ui.composerButton` 标志、上下文是否可用及最后持久化用户消息标识，不返回聊天正文。
`?debug=1` 给非流式优化附加诊断信息。

模型失败、空结果、截断、完整路径/文件名/URL/标识符丢失均不写回，不自动重试。

## 开发与验证

Node ≥22.19，零运行时依赖，无需 `npm install`。

```sh
npm test        # 构建 lib/，再跑 68 项测试、13 项真实 socket 检查、文档/安装守卫
npm run bench -- --dsh <兼容的DSH命令> --profile web
node tools/quality-judge.mjs bench/latest.json  # 生成离线评阅表，不调用模型
```

| 文件 | 内容 |
|---|---|
| `test/*.test.mjs` | 68 项单元/契约/路由测试 |
| `src/` → `lib/` | 唯一源码 → 生成物，请勿手改 lib |
| `bench/corpus.json` | 30 条改写样本及信息增益/失真标准 |
| `bench/predict-corpus.json` | 10 条带上下文预测样本 |

基准在独立 web Host 中临时加载开发评测插件，复用 DSH 的 `llm` 通道和模板，不读取凭据、不直接请求供应商。
合成上下文只存在于评测夹具，不注入真实用户会话；评测入口不随发布包安装。
测试 Host 须先配置可用模型；需要桌面账号通道时须获准临时加载，见[评测说明](bench/README.md)。
`--start / --limit / --out / --provider / --model` 可限定范围、输出和宿主模型选择。

两项功能分别统计延迟，排除零调用样本：p50 ≤3 秒、p95 ≤8 秒。
改写在有优化空间的样本中至少 80% 有实质改善；同义词替换、礼貌化、套话不算。
准确原文允许不变；预测按“像用户可能的回复”评阅，不按“推动任务”评分。
行为测试和模型评阅不能替代兼容 DSH 中的实际点击验收。

## 限制

模型可能慢或判断错误；保留 15 秒无输出超时和默认 20 秒总预算。
改写上下文从最近向前选取最多 3 条用户、2 条助手，合计 1400 字符；预测单独取最近 6 条。
缺少语义草稿或可靠版本信息的宿主只能预览，不冒险覆盖。
DSH 0.2.1-rc.2 不持久化未发送的图片附件：改写时保留，重启后需重新附加；文字与引用沿用宿主恢复。详见[验收记录](docs/ACCEPTANCE.md)。

MIT。
