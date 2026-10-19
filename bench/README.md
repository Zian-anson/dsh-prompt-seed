# 评测：先看信息增益，再看速度

`corpus.json` 是 30 条改写样本，`predict-corpus.json` 是 10 条带合成对话的预测样本。
`acceptance-results.json` 保存本轮真实 Host 模型输出、逐条评阅和分功能延迟。

## 使用独立测试 Host

先在测试 profile 中通过 DSH 自己的模型设置配置可用模型，再运行：

```sh
npm run bench -- --dsh <compatible-dsh-cli> --profile web --out bench/latest.json
node tools/quality-judge.mjs bench/latest.json
```

可用 `--patch <模型配置覆盖文件>` 复用已有的宿主适配器声明；凭据仍由 DSH 服务解析。
`--provider / --model` 只能选择该 Host 已注册的通道，不会自动配置适配器或读取凭据。
`--start / --limit` 限定样本。失败不会自动重试。

## 需要桌面账号连接时

须先获准临时修改 desktop profile 并确认空闲。用正常 Cordis 配置临时加载 `tools/bench-host.mjs`，
配置 `autorun:false` 和本地 `out` 路径；重启后由回环 `POST /api/prompt-seed-benchmark`、
`Content-Type: application/json` 显式启动一次。完成后删除这条临时配置，空闲时正常重启。
该开发入口不在发布包中，不修改用户会话，也不读取凭据。

## 评阅口径

改写只把“让接收者更容易理解或做好”的具体增益算作 better；同义词、礼貌化、重复原意算 same。
未确定的范围/决定、角色颠倒、事实和授权失真记在 distortion；不能用长度增加替代质量。
分母为样本预先标注的 `improvable:true`，目标至少 80%。准确原文允许 same。
预测按用户口吻、现有偏好与当前对话是否合理判断；无依据的正确弃答单列。

延迟采用最近秩百分位，优化与预测分别统计，零调用样本不纳入。p50 ≤3 秒、p95 ≤8 秒。
固定样本的直接评阅与真实界面操作分别记录，不能互相替代。
