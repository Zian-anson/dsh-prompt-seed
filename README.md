# dsh-prompt-seed

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml/badge.svg)](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Zian-anson/dsh-prompt-seed)](https://github.com/Zian-anson/dsh-prompt-seed/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2ea44f.svg)](https://github.com/topics/dsh-plugin)
[![tests: 127 passing](https://img.shields.io/badge/tests-127%20passing-brightgreen.svg)](https://github.com/Zian-anson/dsh-prompt-seed/actions/workflows/ci.yml)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. Type a one-line
draft, click **✦**, and it is rewritten in place into a prompt an agent can actually act on —
**unfolding the intermediate detail you did not write down**, while a semantic fidelity gate makes
sure the meaning and the tone survive. Click **↺** to get your original back.

```
make an image compression feature
        │  click ✦
        ▼
Make an image compression feature: accept jpg, png and webp uploads; let me set
a quality level or a target size; show a before/after comparison of file size and
sharpness; compress several images in one batch and download them as one archive.
Keep the page responsive on large images, keep transparent pngs transparent, say
so when a format is unsupported, and keep the original when a compression fails.
        │  written in place, button becomes ↺
        │  (credential: fidelity ✓ · +178 chars · filled in: formats, quality, edge cases)
        ▼
one-click revert · ✦ regenerate another version · ‹ step back a version
```

## Why this one

The "rewrite my draft" slot in the DSH ecosystem is crowded — there are 26+ plugins in it. Most of
them **polish**: strip filler, tighten wording, cap the length, and refuse to add anything the user
did not write. This plugin does the opposite thing on purpose: a one-line seed is usually an
*insufficient* prompt, and the value is in the detail the user could not write.

| | typical prompt-optimizer plugin | dsh-prompt-seed |
|---|---|---|
| vague one-liner | returned nearly unchanged, or padded with `(TBD: …)` placeholders | **unfolded into a concrete, executable request** (measured 10–25×) |
| already-precise instruction | reworded, sometimes with extra procedure appended | **left essentially as-is** (measured 1.0–1.1×), via a separate precise-input contract |
| fidelity check | deterministic string check: did every path / identifier / number survive? | **semantic audit** by a second call, classifying the failure: `DISTORTED` / `SCOPE_ADDED` / `CONTRADICTED` / `TONE_SHIFTED` / `PADDED` |
| on a violation | accept, or reject outright | **targeted repair by violation class**, re-audited; only reject if it still distorts |
| what you see | a length ratio | **a gate credential**: fidelity ✓ · +150 chars · filled in: edge cases, failure handling |
| not happy with the result | revert and click again | **✦ regenerate** (keeps up to 3 versions) and **‹ step back** |

`PADDED` (padding a request that was already complete) and `TONE_SHIFTED` (a request rewritten into
a different register) have no counterpart in any of the plugins surveyed — a string-equality check
cannot catch "nothing was lost, but the meaning changed".

Being explicit about the trade-off: this plugin **adds detail the user did not write**. That is the
product, and it is also the risk. The gate exists to make it safe — anything that changes what was
asked for, narrows it, contradicts it, or pads it is caught and repaired. If you want a plugin that
never adds anything, one of the conservative ones will suit you better.

## Compatibility

| | |
|---|---|
| Host | `dsh >=0.2.0-rc.1 <0.3.0-0` (declared as `engines.dsh`); tested on `0.2.0-rc.2` |
| Node | `>=22.19` (matches the host's own requirement) |
| Runtime dependencies | **none** — the package is 5 ES modules, no build toolchain needed to install |

DSH is in developer preview and its README warns of breaking changes, so this plugin declares a
range and **disables itself instead of breaking the host's boot** when a seam is missing: if the
`webServer` or `slots` service is absent, it logs one readable line naming the missing seam and the
host version it wants, then stays out of the way. Host boot is all-or-nothing — one plugin that
throws stops the whole process — so self-disabling is the only acceptable failure mode here.

During `0.x`, **minor version bumps may contain breaking changes** (SemVer §4); patch bumps will not.

## Install

Install the released tarball (works today, pinned by version):

```sh
dsh plugin --profile <name> add \
  https://github.com/Zian-anson/dsh-prompt-seed/releases/download/v0.9.2/dsh-prompt-seed-0.9.2.tgz
```

The npm channel lights up once the package is published there:

```sh
dsh plugin --profile <name> add dsh-prompt-seed   # npm, pending publication
```

Verify the bundle and row landed before booting:

```sh
dsh --profile <name> --dump-config     # must show "# == dsh-prompt-seed"
dsh --profile <name>
```

The ✦ button appears in the composer tool row, immediately left of the model selector. Remove it
with `dsh plugin --profile <name> remove dsh-prompt-seed`.

## Quick start

1. Type a rough draft — one line is fine, typos are fine.
2. Click **✦** and wait 1–6 s. The draft is replaced in place; nothing pops up.
3. Hover the **↺** button to read the credential: gate verdict, size change, and what was filled in.
4. Not quite right? **✦** next to it generates another version; **‹** steps back to the previous one.
5. **↺** restores your original. Editing the draft yourself also clears the undo — the plugin never
   overwrites what you have since typed.

## Signals and short directives (0.9.0)

Two input shapes that the elaboration contract was never designed for get dedicated semantics:

**A bare signal** — a number like 42, or a go-ahead like "continue" or "ok" — carries no task content. Its only
meaning is: continue with what the conversation left pending. So it is resolved against an anchor
(the latest assistant turn plus the latest user turn) in a fixed priority order, and **refused
honestly when nothing matches**:

| Anchor found in context | Inference | Example |
|---|---|---|
| an option list the number matches | **choice** | 1 + "Continue? 1. keep organizing 2. stop for now" → keep organizing |
| a question the assistant left pending | **answer** | 15 + "When does it ship this month?" → ships on the 15th |
| the user's own unanswered question / a continuation offer | **continue** | "continue" → proceed with the offered action |
| nothing matches | **cannot_infer, zero model calls** | 42 against options 1/2 is a deterministic refusal — never a guess |

**A short directive** — "fix it" / "wrong" / "change it" — has a clear verb and a missing object. Expansion
runs inside a **degree contract**: the referent must come from context; divergence is allowed only
inside the natural sub-parts of the user's own verb and its implied follow-ups; new goals, tools,
numbers, or scope are forbidden; the verb must survive verbatim; the output is hard-capped at 180
characters, with one tightened retry before rejection. An unresolvable referent is reported, not
invented (an unresolvable referent maps to cannot_infer).

Measured against the live model: a short directive in a button-color context expands to a single
sentence under 40 characters with the user's verb preserved and nothing invented, while a mismatched
number refuses in 0 model calls.

## How it works

Two halves, one package:

```
┌─ Browser ────────────────────────────────────────────────┐
│ lib/client.js   __ModuleLoader__ bundle                  │
│   slots.register('conversation.input.right', …)          │
│   4 states: ✨ idle / ⟳ busy / ↺ revert / ⚠ error         │
│   undo backup + draftRev CAS + divergence detection      │
└──────────────────────┬───────────────────────────────────┘
                       │  POST /api/prompt-seed/optimize  { text }
┌──────────────────────▼───────────────────────────────────┐
│ lib/index.js    Cordis plugin (host)                     │
│   ctx.webServer.register({ kind: 'exact', path, handler })│
│   loopback-only (peer address AND Host header)           │
│                                                          │
│   CONTRACT: elaborate, never distort                     │
│   ① rewrite call      ctx.get('llm').stream(...)         │
│        │                fills in the intermediate detail  │
│        │                the user could not write          │
│   ② elaboration gate  deterministic: substantively        │
│        │                unchanged? → retry at temp .4/.7  │
│   ③ distortion audit  2nd cheap call, semantic rule:      │
│        │                OK | DISTORTED | SCOPE_ADDED |    │
│        │                CONTRADICTED | TONE_SHIFTED | THIN│
│        ├─ OK, not THIN            → accept (tier full)   │
│        ├─ THIN + seed input       → ④ elaborate once →   │
│        │                            re-audit → tier       │
│        │                            elaborated | thin     │
│        ├─ unparsable / call failed → accept (fail-open)  │
│        └─ distortion → ④ targeted repair (keep the added  │
│              │            detail, drop only the violation)│
│              └─ ⑤ re-audit → tier repaired | rejected     │
└──────────────────────┬───────────────────────────────────┘
                       ▼
                 current default model
```

`tier` in the response body says where the accepted text came from: `full` (first draft
passed), `elaborated` (too thin → elaborated once), `repaired` (distorted → repaired),
`thin` (elaboration introduced distortion, so the thin but faithful draft was kept).

The browser half talks to the host half over one loopback-only HTTP route rather than a
generated Remote service: the payload is a single request/response pair, and a route avoids
binding this package's build to Typert's schema code generation.

| Service | Used by | If missing |
|---|---|---|
| `webServer` | host half (`inject`) | plugin does not load — a hard dependency |
| `llm` | host half (optional read) | `llm_unavailable` |
| `agentDefaultModel` | host half (optional read) | `model_unavailable` |
| `slots` | browser half (`inject`) | button does not mount |

## Configuration

The row accepts a few optional keys; defaults are correct for almost everyone.

```yaml
- insert:
    - id: prompt-seed
      name: dsh-prompt-seed
      config:
        route: /api/prompt-seed/optimize   # route path (this is the default)
        # provider: zai-coding-cn               # pin the model route (provider + model
        # model: glm-5.3-flash                  #   work as a pair; defaults to agentDefaultModel)
        # context: false                        # disable session-context injection (on by default)
```

Changing `route` requires editing `src/client-plugin.js`'s `ROUTE` and rebuilding — the browser
half is a compiled bundle, so the two must be changed together. A test asserts they match.

| Key | Default | Meaning |
|---|---|---|
| `route` | `/api/prompt-seed/optimize` | route path; changing it requires editing `ROUTE` in `src/client-plugin.js` and rebuilding |
| `provider` + `model` | host default | pin the rewrite/audit model (both keys together) |
| `context` | `true` | session-context injection; now read **on demand** (short draft or anaphora only) |
| `samples` | `$DSH_HOME/prompt-seed/samples.jsonl` | event log path; `false` disables logging entirely |
| `templates` | `true` | allow `$DSH_HOME/prompt-seed/prompts/*.md` to override the built-in prompts |

**Depth** is a client-side setting (right-click the ✦ button): `auto` (from local feedback counts),
`light`, `standard`, `deep`. It is not a row config key because it is per-user, not per-profile.

**Prompt overrides**: drop `system.md`, `user.md` or `audit.md` into
`$DSH_HOME/prompt-seed/prompts/` to replace the built-in contract. They are re-read **on every
request**, so an edit takes effect on the next click — no app restart.

**Context injection** sends the session's most recent user/assistant messages (≤4 messages,
≤300 chars each) to the rewrite and audit prompts as a reference-resolution-only block.
It fails open at every step — no session id, no `sessionQuery` service, corrupt reads, or
`context: false` all degrade silently to context-free optimization.

**Model routing**: rewriting rewards instruction-following over raw generation, but the
floor is higher than "any flash will do". Measured across providers (v0.4.6): glm-5.2
passes every case class cleanly — including the two gray zones where both flash-tier
models fail (procedural insertions into already-precise requests, and conversation
narration leaking into reference resolution). Flash models are fine for the simple
classes and cheaper, but the retry chain they trigger erases the latency win. The
tested-good route is one config line:
`provider: zai-coding-cn, model: glm-5.2`.

## Error codes

The route always answers `200` for business outcomes and puts the outcome in the body.

| `code` | Cause | User-facing message (the UI ships Chinese strings today; English meaning below) |
|---|---|---|
| `empty_input` | draft is blank | Type something first. |
| `input_too_long` | over 8000 characters | Too long — trim it and try again. |
| `llm_unavailable` | `llm` service not mounted | Model service unavailable. |
| `model_unavailable` | no default model | No usable default model. |
| `llm_error` | call threw, or `finish` was `error`/`aborted` | Model call failed. |
| `empty_result` | empty after normalization | The model returned nothing usable. |
| `truncated` | `finish.kind === 'max-tokens'` | Result was truncated — shorten the input and retry. |
| `nothing_to_optimize` | input is a bare greeting / punctuation only | Too short — nothing to optimize (a neutral hint, not a failure). |
| `fidelity_rejected` | rewrite and targeted repair both distort the request | The rewrite would change your meaning; your text was kept (the tooltip appends the `added` list: what the audit flagged). |
| `forbidden` | non-loopback peer or Host | — (403) |

## Privacy and data flow

The plugin holds **no API key** and stores no credentials: it calls the host's own `llm` service, so
model access and credential handling stay exactly where they already are.

- **The only outbound request is the model call the host would make anyway.** No telemetry, no
  update check, no third-party endpoint.
- **One local HTTP route** (`POST /api/prompt-seed/optimize`), reachable only from loopback: the
  handler verifies both the peer socket address and the `Host` header, so a DNS-rebinding page
  cannot reach it from a browser.
- **Session context is read on demand**, not always: only when the draft is short (≤12 chars) or
  contains an anaphor, and never for a precise instruction that already names its files. It is used
  to resolve references, never as content to rewrite.
- **The local event log** (`$DSH_HOME/prompt-seed/samples.jsonl`) records the outcome of each run —
  code, tier, depth, gate verdict, violation classes, character counts, latency — plus the **first
  400 characters** of the input, so that "is the depth right / is the gate misfiring" can be answered
  with data instead of opinion. Set `samples: false` in the row config to disable it entirely.
- **Implicit feedback** is four local counters (`applied` / `reverted` / `retried` / `submitted`)
  kept in `localStorage`; they tune the depth setting on your machine and are never uploaded.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No ✦ button | host older than `0.2.0-rc.1`, or the `slots` service is missing | open the browser console — the plugin logs which seam is missing and the version it wants |
| Click does nothing | the route is not registered | check the host log for the `[prompt-seed] loaded` banner; confirm `--dump-config` shows the row |
| "Model service unavailable" / "No usable default model" | host `llm` or `agentDefaultModel` not mounted | configure a session model, or set `provider` + `model` in the row config |
| Result is longer/shorter than you want | depth setting | **right-click the ✦ button** to cycle `auto / light / standard / deep`; the choice is remembered |
| Result was reverted automatically | the fidelity gate judged the rewrite would change your meaning | hover the shield — the tooltip names the violation class; the eye button lets you view the rejected draft anyway |
| Output keeps getting rejected | the model is weak at instruction-following | point the row at a stronger model (`provider` + `model`) |
| You edited the prompts but nothing changed | override files must be at `$DSH_HOME/prompt-seed/prompts/` (`system.md`, `user.md`, `audit.md`) | files are re-read on every request, so a correct path takes effect on the next click |
| **You upgraded the plugin but behaviour is unchanged** | the host half is an ES module, and **Node's module cache is keyed by URL** — reinstalling the same package name lands on the same path, so the running process keeps executing the module it already loaded | **restart the app.** Then confirm with `curl -s -X POST 'http://127.0.0.1:19387/api/prompt-seed/optimize?debug=1' -H 'content-type: application/json' --data '{"text":"hi"}'` and check `_debug.codeVersion` |

That last row is worth internalising, and it was measured rather than assumed:

| what changed | install path | host half picks it up |
|---|---|---|
| reinstall the same package name with new content | unchanged | **no** — the process keeps running the cached module until restart |
| install under a different path (renamed package) | changed | **yes** — the cache misses and the new module loads |

Both cases were observed directly on a running app, and the frozen-at-load `codeVersion` is what
makes them distinguishable: after a same-name upgrade it kept reporting the previous version while
the new one sat on disk, and after the rename it reported the new one immediately. `disable` →
`enable` only re-runs `apply` against the *cached* module, so it does not help either. **Restart the
app after a normal upgrade**, and check `_debug.codeVersion` instead of trusting the tarball you
just installed.


## Development

```sh
npm test        # builds lib/ then runs 127 tests
npm run build   # tools/build.mjs → lib/
```

Source layout:

| Path | Role |
|---|---|
| `src/prompt-templates.js` | the meta-prompt asset, output normalization, input validation |
| `src/host-core.js` | route resolution, `llm.stream` consumption, error normalization, signal/deictic branches |
| `src/signal-inference.js` | deterministic classification, anchor inference, degree checks for signals and short directives |
| `src/session-context.js` | on-demand extraction of recent user turns from the session surface |
| `src/sample-log.js` | the local event log (samples.jsonl) |
| `src/host-plugin.js` | Cordis host plugin → `lib/index.js` |
| `src/client-plugin.js` | browser factory body → wrapped into `lib/client.js` |
| `tools/build.mjs` | copies the host half, wraps the browser half |

`src/` is the tested source of truth; `lib/` is generated and should not be edited by hand.

Test a local checkout without publishing:

```sh
npm pack --pack-destination /tmp
dsh plugin --profile plugin-lab add /tmp/dsh-prompt-seed-0.9.0.tgz
dsh --profile plugin-lab --dump-config
```

## Publishing

```sh
npm run build
npm publish --access public
```

Distribution options, from least to most friction for your users:

| Form | Consumer runs | Notes |
|---|---|---|
| npm package | `dsh plugin add <name>` | prebuilt `lib/` ships in the tarball; no build permission needed |
| tarball | `dsh plugin add ./x.tgz` | immutable, checksummable, good for review before publishing |
| Git dependency | `dsh plugin add github:you/repo` | fetches **source**; needs a self-contained `prepare` **and** explicit `allowBuilds` approval from the user, which executes your code on their host outside the agent sandbox |

Prefer npm or a tarball. Only add the Git path if you also ship a `prepare` that builds from a
clean clone.

## Verification status

| Layer | How | Status |
|---|---|---|
| Prompt asset, normalization, validation, error codes | unit tests | ✅ |
| Contract guard (both historical pathologies absent, counter-example triplets present) | template-content tests | ✅ |
| Rewrite pipeline: elaboration gate, semantic audit, targeted repair, call budget | scripted multi-call `llm` stubs | ✅ |
| Gate credential: `DETAIL` parsing, `gate.verdict` / `rechecked` / `repairs` | unit tests | ✅ |
| Depth: three suffixes, request wiring, invalid-value fallback | unit tests | ✅ |
| On-demand context: anaphora / short-draft / precise-input rules | unit + route tests | ✅ |
| Template overrides: read per request, live edit, fallback, `templates: false` | route test with a temp `$DSH_HOME` | ✅ |
| Self-disable: missing `webServer` / `effect` / `slots` never throws | unit tests | ✅ |
| Host route: loopback guard, method/body rejection, optional services | real `req`/`res` stubs | ✅ |
| Browser bundle: `__ModuleLoader__` shape, slot registration, rendered button props | test materializes the real bundle and renders it | ✅ |
| Cross-artifact route consistency | test compares `lib/client.js` against the host default | ✅ |
| `codeVersion` truthfulness | test rewrites `package.json` after load and asserts the reported version is unchanged | ✅ |
| Bundle manifest, patch, tarball contents | `npm pack` + install into a throwaway profile | ✅ |
| Real-model behaviour (seed unfolded, precise preserved, multilingual, depth) | live-route and direct-model probes against the installed bundle | ✅ |
| Full click-through in a live browser session | not automated — `fetch` → route → refill is exercised in pieces, not end to end | ⛔ |

## Known limitations

1. **Reference chips degrade to plain text.** `@file` / `/command` chips project to `U+FFFC`, and
   both `setDraft` and `insertText` strip that placeholder, so a rewrite cannot keep a chip a chip —
   there is no API to rebuild chip nodes from text. The button stays enabled, the tooltip says so,
   and a conservation guard refuses the write-back if any chip label would be lost. The reference
   itself is never dropped silently; its structure is.
2. UI strings are Chinese-only; the `locale` service is not wired.
3. Non-streaming, and the gate costs a second call: 1 call when the precise-input shortcut applies,
   2 on the happy path, 4 when a repair is needed (the repaired draft is always re-audited).
   Measured 0.9 s (precise input, audit skipped) to ~20 s (worst case, slow provider).
4. `TONE_SHIFTED` and `PADDED` are judgement calls by the audit model, not deterministic checks —
   a misjudgement inside the tolerance band is the residual fidelity risk.
5. The audit judge and the rewriter share the routed model by default; routing the audit to a
   cheaper model would need another config knob.
6. Depth adaptation needs a few runs before it moves (deliberately: two signals minimum, so two
   clicks cannot swing it).

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with, endorsed by, or sponsored by DeepSeek. "DeepSeek Harness" and "DSH" refer to
the open-source host application this plugin targets; this is an independent third-party plugin, and
no license in this repository grants any trademark rights.
