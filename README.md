# dsh-prompt-seed

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml/badge.svg)](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Zian-anson/dsh-prompt-seed)](https://github.com/Zian-anson/dsh-prompt-seed/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests: 15 passing](https://img.shields.io/badge/tests-15%20passing-brightgreen.svg)](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml)

A DeepSeek Harness composer plugin. Type a rough draft, click **✦**, and it is rewritten in place.

**0.19.1 is a minimal optimizer.** Every non-passthrough input gets exactly one model call and
one contract: rewrite the draft into a clearer version of the same message. Do not answer it, do
not execute it, do not add requirements. Preserve intent, speech act, language, uncertainty and
explicit paths/identifiers. There are no routes, shapes, ambiguity scores, target ratios, repair
calls, or semantic validation gates.

The only guards are: empty/model error returns the original; a lost explicit path/file/URL/
identifier returns the original. Everything else is left to the model and to undo.

First-optimize session creation is unchanged: in a blank new conversation the first optimize
creates a real Session, generates its title, opens it with the draft, and binds the job to that
sessionId. No message is sent. maxTokens is not set; a 15s idle watchdog and a 20s host budget
remain.

## What it does

| Draft | Result |
|---|---|
| 帮我做个登录页 | a more executable version of the same request |
| 现在是不是该发布了？ | the same question, clarified |
| 我觉得效果不好 | the same complaint, with object/criterion made explicit |
| 好了 | no model call; neutral "nothing to optimize" |
| 删除 src/a.js 的 export，跑测试 | near-verbatim; src/a.js must survive |
| (empty input, conversation context) | crystal-ball prediction |

There is no route table. If input is not empty/greeting, it is optimized once.

## Sessions, switching, and recovery

Optimization is a **host-owned job**, not a component-local fetch.

- Switch to another conversation while a job runs: the local stream detaches, the host job
  continues. Switching never cancels.
- Return: the button restores running progress or the finished result. If the draft is unchanged,
  the result is applied; if you edited it, the result stays ready and the button says "result
  ready — click to retrieve". A changed draft is never overwritten.
- New conversation with no sessionId yet: the client uses a draft conversationKey and binds it to
  the sessionId when the first message creates one. Only one unbound new-chat job is allowed at a
  time.
- Explicit cancel is the only cancel. Refresh/pages hidden/conversation switch do not cancel.
- A job running in another conversation produces **no counter or badge** in the current composer.
- Jobs are in-memory with a 10-minute TTL. Host restart loses jobs cleanly (idle, no stale
  spinner); page refresh against the same host restores them.
- API actions: optimize / status / bind / cancel / consume. There is no list-all-tasks endpoint.

## Install

```sh
dsh plugin --profile <name> add \
  https://github.com/Zian-anson/dsh-prompt-seed/releases/download/v0.19.1/dsh-prompt-seed-0.19.1.tgz
```

Or use the local tarball while developing:

```sh
dsh plugin --profile <name> add ./dsh-prompt-seed-0.19.1.tgz
```

The button appears in the composer tool row. Remove it with
`dsh plugin --profile <name> remove dsh-prompt-seed`.

## Config

```yaml
config:
  route: /api/prompt-seed/optimize
  provider: opencode-go        # optional; omit to follow the host picker
  model: deepseek-v4.1-flash
  requestTimeoutMs: 20000
  context: true
  samples: ~/.dsh/prompt-seed/samples.jsonl
  templates: true
```

Removed in 0.19.1: `pipeline`, `depth`, `auditProvider`, `auditModel`, `deadlineMs`,
`rewriteReasoningEffort`, `predict`, `tasks`. Those features were either latency multipliers
or unverifiable; they are recoverable from the v0.14.4 tag.

Prompt overrides live in `$DSH_HOME/prompt-seed/prompts/{optimize}.md`.

## HTTP API

`POST /api/prompt-seed/optimize`

Request:

```json
{ "action": "optimize", "text": "...", "sessionId": "...", "conversationKey": "draft:...", "stream": true }
```

Actions: `optimize`, `status`, `bind`, `cancel`, `consume`. `status` returns the current
conversation's job (`{ok, job}`), `bind` attaches an unbound draft job to a sessionId, and
`cancel` is explicit only. Jobs are keyed by sessionId and/or a draft conversationKey; there
is no list-all-tasks endpoint.

`stream:true` returns NDJSON:

```text
{"type":"meta","route":"optimize","reasons":[],"promptVersion":"0.19.1"}
{"type":"delta","text":"..."}
{"type":"final","ok":true,"text":"...","route":"optimize","changed":true,"calls":1,"ttftMs":900,"ms":2600}
```

Without `stream`, the same final is returned as one JSON object. `?debug=1` adds a `_debug`
block to the JSON final. The route is loopback-only and requires `application/json`.

Failure is explicit: `empty_result`, `truncated`, `validation_failed` (with a reason and the
rejected draft), `request_timeout`, or `nothing_to_optimize`. The original draft is never
silently replaced on failure.

| Validation | Count |
|---|---|
| Real-socket checks | ✅ 13 checks, run by `npm test` |

## Development

```sh
npm test        # builds lib/, runs 15 tests, 13 real-socket checks, docs/install guards
npm run bench   # real-model benchmark on the default route
```

The benchmark corpus is `bench/corpus.json`; the runner is `tools/bench.mjs`. It checks exactly
one call for content, zero for passthrough, failures, anchor preservation and p50/p95 latency.
Quality is **not** machine-judged: use the 30-40 case blind review described in the release
notes. Release gate: p95 ≤ 8 s, zero failures/bad calls/anchor loss, and human acceptance ≥80%.

## Limits

- A single provider call can still be slow; 15 s without a new token aborts, the host budget is
  20 s, and a healthy stream is not cut at 12 s.
- `reasoningEffort: "low"` is sent when the selected route declares reasoning; the DSH adapter
  rejects `none` for this route. The plugin does not add hidden retries.
- Context uses the recent 3 user turns + 2 assistant tails, max 1400 chars, only to resolve
  references; it is not a rewrite target.
- Prediction is back for an empty composer; depth modes remain removed; optimization jobs are
  host-owned and session-scoped.

## License

MIT.
