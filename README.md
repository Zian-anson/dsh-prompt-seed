# dsh-prompt-seed

**English** | [简体中文](README.zh-CN.md)

[![tests: 63 passing](https://img.shields.io/badge/tests-63%20passing-brightgreen.svg)](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml)

One contextual DSH composer entry: **✦ Optimize when the draft has content; 🔮 Crystal ball when empty**. The tools improve the draft or predict the user's most likely next reply. Neither sends messages.

> Version 0.20.0. See [acceptance evidence](docs/ACCEPTANCE.md) for model quality, real-UI verification and known limitations.

## Rewrite with useful substance

Short drafts gain essential execution details, boundaries and proportionate verification. Long spoken drafts become organized and shorter. Precise requests stay concise.
Preserve intent, scope, facts, authorization, language, numbers, technical names and negative requirements—including “discuss only, do not implement.” Do not invent features, metrics or an unchosen stack.

After generation, **Another version** uses the round's original draft, not the previous rewrite. Manual edits start a new round on the next click. Use **⋯ → Restore original** directly while untouched; after editing, preview it before explicitly replacing the draft.
Empty input, greetings and pure confirmations make no call. Unchanged results say “Unchanged,” distinct from improvement and failure.

## Predict the reply, not a recommended action

Crystal ball is available when the composer is empty, the conversation has an assistant reply and the assistant is idle. It uses recent conversation and user style to suggest one short reply: acknowledgement, question, correction, extra information or continuation. With insufficient evidence it reports “Unable to predict for now.” Blank conversations make no call.
After a prediction fills the draft, the main icon switches to Optimize. **⋯** offers **Another reply** and **Withdraw** while the candidate is untouched; editing removes those actions.

Success has no persistent text; a spinner indicates progress. Failure and unchanged results use short labels with details on hover. **⋯** appears only when recovery, background cancellation or a retained result is available. Switching the icon does not cancel either feature’s job.

## Independent features, safe drafts

Each feature owns its prompt, context strategy, controller, task state, result and undo. Only connection, task storage, timeout and safe-write primitives are shared.

- At most one model call per generation; no hidden retries, repair calls or semantic judge.
- Jobs are scoped by conversation **and kind**. Switching, unmounting or disconnecting never cancels them; explicit cancellation only affects its own kind.
- Automatic application requires the same conversation, editable input and unchanged draft revision, semantic references and attachments. Editing and reverting to the same text still prevents overwrite.
- When unchanged state cannot be proved, including reload/remount, results remain available in a preview with explicit **Replace draft**.
- Reference chips use the host's semantic draft API. Unsafe reconstruction or newly inserted incompatible chips makes the result preview-only. Text writes do not change attachments.
- Each conversation retains its latest rewrite original/candidate across edits and switches. Confirmed submission clears recovery; submission failure retains it. Draft persistence remains host-owned; recovery records live in the browser tab.
- Existing session IDs, including blank sessions, are reused without creating a session or changing its title. A truly unbound draft starts generation first, then asynchronously creates a necessary session and binds that same job, without stealing navigation.
- Host jobs have a ten-minute in-memory retention period. Host restart removes stale running state cleanly.

## Install

Published release:

```sh
dsh plugin --profile <name> add \
  https://github.com/Zian-anson/dsh-prompt-seed/releases/download/v0.20.0/dsh-prompt-seed-0.20.0.tgz
```

For a local candidate, run `npm pack`, then `dsh plugin --profile <name> add ./dsh-prompt-seed-0.20.0.tgz`.
Keep the previous package for recovery and restart DSH while idle after Host changes. Use the compatible CLI bundled with Desktop. Do not edit the installed copy.
Remove with `dsh plugin --profile <name> remove dsh-prompt-seed`.

## Config

```yaml
config:
  route: /api/prompt-seed/optimize
  # provider / model: specify both, or follow the Host default selection
  requestTimeoutMs: 20000
  context: true
  samples: true
  templates: true
```

User templates in `$DSH_HOME/prompt-seed/prompts/` remain intact: `optimize.md` takes precedence, then legacy `seed.md`.
Existing `clarify`, `precise` and `chat` files are preserved but are not selected by the single rewrite contract.
Local sample logs contain input/output previews and are never automatically uploaded; `samples:false` disables them.

## HTTP compatibility

`POST /api/prompt-seed/optimize` remains loopback-only and requires `application/json`.

```json
{ "action": "optimize", "kind": "optimize", "text": "...", "sessionId": "...", "stream": true }
```

Actions: `optimize / predict / status / bind / cancel / consume`. Queries and binding default to optimize when `kind` is omitted. New clients pass `"optimize"` or `"predict"`. Cancellation/consumption retain legacy jobId-only calls; an explicit kind validates ownership.

Both generators accept `stream:true` and return NDJSON `meta / delta / final` events with jobId and kind.
Nonstream optimize retains its final JSON. Nonstream predict retains `{ok:true,text}` or `{ok:false,code,error}` without requiring new fields.
Status adds `protocolVersion:2`, context availability and the last persisted user-message identifier, not chat content. `?debug=1` adds diagnostics to nonstream optimize.
Failures, empty/truncated results and lost explicit full paths/files/URLs/identifiers never overwrite the draft.

## Development and acceptance

Node ≥22.19; zero runtime dependencies, no install step needed.

```sh
npm test        # builds lib/, runs 63 tests and documentation/install guards
npm run bench -- --dsh <compatible-dsh-command> --profile web
node tools/quality-judge.mjs bench/latest.json  # offline review sheet, no model call
```

| Validation | Count |
|---|---|
| Real-socket checks | ✅ 13 checks, run by `npm test` |

`src/` is authoritative; rebuild `lib/` after editing. Behavioral tests drive the shipped toolbar/controller with controllable drafts, sessions and model streams rather than checking function names.

`bench/corpus.json` contains 30 rewrite cases; `bench/predict-corpus.json` contains 10 contextual prediction cases.
The benchmark temporarily loads a development-only plugin into a separate web Host and uses DSH's `llm` service and templates. It never reads credentials or calls a provider directly. Synthetic context stays in fixtures, not user sessions; the benchmark entry is not packaged.
The test Host must already have a working model connection. Desktop-account evaluation requires explicit temporary-loading approval; see [benchmark setup](bench/README.md).
Options: `--start`, `--limit`, `--out`, `--provider`, `--model`.

Measure both features separately, excluding zero-call cases: p50 ≤3 seconds, p95 ≤8 seconds. At least 80% of improvable rewrite cases should gain useful substance without distortion. Synonyms, politeness and filler do not count; precise originals may remain unchanged. Judge predictions by whether the user might plausibly reply that way, not whether they advance the task. Model evaluation and static checks do not replace real DSH clicks.

## Limits

A model can be slow or wrong. Idle timeout is 15 seconds; the default total Host budget is 20 seconds. Rewrite context favors newest messages: up to 3 user turns and 2 assistant tails, 1400 characters total. Prediction has its own six-turn window. Without reliable revision/semantic APIs, results remain preview-only.

DSH 0.2.1-rc.2 does not persist unsent image attachments across app restart. Rewriting preserves them, but after restarting, reattach the original images. Text and reference chips use host-owned draft recovery; see [acceptance evidence](docs/ACCEPTANCE.md).

MIT.
