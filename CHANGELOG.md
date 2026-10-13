# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

During `0.x`, **minor version bumps may contain breaking changes** (SemVer §4) — the host is in
developer preview and moves quickly. Patch bumps will not break anything.

## [Unreleased]

## [0.12.0] - 2026-10-12

Architecture change: **the rewrite and the audit are now one model call** (`pipeline: "unified"`,
the new default). The audit keeps binding force — merging the calls did not merge the
discipline.

### Added

- **Unified pipeline (DRAFT → AUDIT → FINAL).** One request produces the rewrite, a self-audit
  on the distortion scale, and the corrected deliverable. Binding force comes from four layers:
  ① the model must commit DRAFT before auditing it (and never edit it after); ② FINAL must fix
  every self-reported violation, changing nothing else; ③ the deliverable still passes every
  deterministic check (clarify budget, anchor preservation, seed band, unchanged detection);
  ④ a reported violation with a verbatim-unchanged FINAL is rejected with those violations —
  a sham fix never ships. Malformed protocol output degrades to the split path automatically,
  so **split is the quality floor**. Precise inputs that drifted are exempt from self-audit
  trust and still go to the independent audit call (measured self-flattery on that class).
  A THIN self-report still enters the elaboration chain, whose output is re-audited
  independently. `pipeline: "split"` restores the classic two-call path; `body.pipeline`
  overrides per request (loopback A/B and debugging).
- **A/B benchmark tooling** (`tools/eval-unified.mjs`): same corpus through both pipelines,
  judged by the identical independent audit (the judge cannot tell which pipeline produced a
  draft). Measured on glm-5.2, 8 real-use cases, two runs: average latency **−11~18%**
  (seed class −35~79%), success 8/8 = 8/8, cross-audit clean **8/8 vs 7/8 in favor of
  unified** in both runs.

### Fixed

- Post-hoc calls (seed tighten, unfold retry) now strip any drifted unified-protocol sections
  from their outputs before use — no path can write `DRAFT:`/`AUDIT:`/`FINAL:` markers into
  the composer.
- A self-audit-repaired final no longer re-enters the unfold gate (a repair that lands near
  the original is the correct outcome of fixing scope-added, not a "did nothing" draft), and
  a THIN self-report no longer double-elaborates (one chain, one audit).
- The unified parser accepts single-line protocol output (all four sections on one line — a
  real drift shape observed on glm-5.2).

### Changed

- Violation normalization (`VIOLATION_KINDS` / `VIOLATION_LABELS` / `parseAuditVerdict`)
  moved to `prompt-templates.js` so the unified parser shares the exact same normalization;
  `host-core.js` re-exports them (import surface unchanged).
- The audit-OK outcome handling was extracted into `resolveAuditedOutcome`, shared by both
  pipelines.

## [0.11.0] - 2026-10-12

Iteration round from the roadmap (P0-2 / P0-3 / P1-4 / P1-6 / P1-7). Streaming feedback
(P0-1) was skipped by decision.

### Added

- **`classificationSource` routing attribution in the sample log.** Every optimize row now
  records which rule routed the input (`signal-number`, `conversational-go-ahead`,
  `adaptive-clarify-forced`, `assistant-question`, `content-free`, …) — the denominator for
  every future threshold tune and the English-rules hit-rate check. `npm run stats`
  (`tools/sample-stats.mjs`) prints rule × outcome distribution, UI latency percentiles and
  the runId-joined revert rate in one command.
- **Bilingual classification rules.** The signal-word, deictic-verb, meta/opinion/question/
  continuation/seed-verb and go-ahead tables now carry English alternatives (case-
  insensitive), and the assistant-question boundary recognizes "what should I do next"-shaped
  English. English inputs route to the same one-call conversational branch instead of
  falling into the seed unfold. Seeds are still protected by the SEED_VERB guard.
- **`rewriteReasoningEffort: "inherit"` config.** Forwards the model picker's
  `reasoningEffort` to generative rewrite calls only; audits and seed compression never
  inherit. Default stays off (measured divergence with deep reasoning).
- **Localized client UI (zh/en).** All visible strings moved to a table resolved from the
  host `locale` service (`ctx.get("locale").id`) with `navigator.language` and Chinese
  fallbacks; known server error codes map to client-side localized text. The host-side
  `ERROR_MESSAGES` remain Chinese — noted as a remaining limitation.

### Changed

- **The route handler is now a slim dispatcher** over three named channels
  (`handleFeedback` / `handlePredict` / `handleOptimize`) — the structural prerequisite for
  any per-channel extension (streaming included).
- `isConversationalMessage` is now a boolean projection of `conversationalRuleOf`, so the
  decision and its attribution share one source of truth.
- The startup banner additionally reports `predict`, `requestTimeoutMs` and
  `rewriteReasoningEffort`.

## [0.10.0] - 2026-10-12

Optimization round driven by the real usage distribution in `samples.jsonl` (170 rows,
37 UI optimize clicks, 69 feedback signals). Every change below traces to a measured pain:
the six reverted runs were all micro-inputs massively expanded; UI click latency p50 was
7.6 s; and the duplicated helpers had already drifted once.

### Fixed

- **Multi-pick number signals (`1，2` / `1、2` / `1 2` / `1,2,3`) fell into the seed branch.**
  In the real data `1，2` was unfolded twice (35× and 19×) and reverted both times. They are
  now classified as number signals: every picked number must match an assistant option
  (anchor joins all matched options) — a partial match refuses to guess, same invariant as
  the single-number path.
- **Go-ahead confirmations were unfolded as seeds.** 「好，按照这个路线继续。」(18×) and
  「可以，你按这个去做吧。」(27×) were both reverted. A confirmation opener (好/可以/行/对…)
  followed by a go-ahead/continuation phrase (≤40 chars, no task verb) now routes to the
  conversational branch: 1.0× light touch-up, one model call, never rejected.

### Changed

- **Clarify drafts inside the deterministic band skip the audit call.** Past the 1.5×
  budget, anchor preservation and a new 0.7× lower bound, the residual semantic risk equals
  the `unverified` tier the conversational branch already ships (its 0.94–1.06× outputs were
  all accepted in real use). A clarify click drops from ~8 s to ~4 s. Side benefit: an
  in-band near-identical clarify draft no longer enters the THIN→elaborate chain — that
  chain expanded complete check-shaped requests into checklists, the exact shape of the
  real reverts. Out-of-band drafts (content lost) still go through the audit.
- The gate credential for unaudited drafts now reads 「未审判（确定性校验通过）」 —
  accurate for both sources (precise skip and the clarify short-circuit).

### Refactored (no behavior change)

- `lastSentence` / `lastMatchingSentence` / `cjkChars` / `latinWords` were duplicated
  byte-for-byte across `signal-inference.js` and `prediction.js`; they now live in
  `message-text.js` (`lastSentenceOf` / `lastMatchingSentenceOf` / `cjkCharSet` /
  `latinWordSet`) with the sentence-boundary regex shared.
- The seed tighten band and the unfold-retry gate moved out of `optimizePromptText` into
  module-level `tightenSeedDraft` / `unfoldRetryIfNeeded` (semantics preserved verbatim,
  including keeping the last elaboration attempt).
- Client: gate-credential and delta formatting extracted into pure functions
  (`formatGateCredential` / `formatDelta`); the duplicated `?debug=1` URL check in the host
  route collapsed into `wantsDebugFlag`.

## [0.9.7] - 2026-10-12

Team debug round: one static pass and one runtime pass over the whole tree, every finding
reproduced before fixing and covered by a regression test (202 → 216 tests).

### Fixed

- **Hollow rewrites could bypass the fidelity gate in precise mode.** `isSubstantivelyUnchanged`
  only guarded the input side of the skeleton comparison, so a precise-declared rewrite that
  deleted everything (`登录` → `。`) fell inside the edit-distance tolerance, tripped the
  audit-skipping shortcut, and was written back as `ok` with an "unverified" credential. The
  rewrite side is now guarded too — an emptied skeleton is never "unchanged", the audit always
  runs.
- **Deictic directives with a demonstrative were rejected for doing their job.** The degree
  check demanded verbatim preservation of 这/那/它 while the contract *requires* resolving
  them — the template's own sample output failed its own check. Demonstratives are now
  stripped like softeners before the verbatim check; the verb itself must still survive.
- **`"要不要继续？1. … 2. …"` anchors were missed** by both the prediction classifier and the
  word-signal path: the offer sits in the second-to-last sentence, and both only looked at the
  last one — the plugin's own template example was unrecognizable. Prediction now treats
  offer+numbered-options as a `choice` anchor; the signal path scans for the offer sentence
  when options are present.
- **Unrecognized `MODE:` headers leaked into the composer.** Only `seed|clarify|precise` were
  stripped; `MODE: expand`, `MODE: Seed:` and bare `MODE:` passed through verbatim. Any
  `MODE:`-shaped leading line is now stripped (declared only when the value is recognized),
  and the three bypass paths that never parsed (unfold retry, THIN elaboration, conversational
  touch-up) now run the same parser.
- **Surrogate pairs could be sliced in half** at every fixed-length truncation (context
  windows, prediction budget, log previews), leaving lone surrogates in prompts and even in
  the written-back draft. All truncation sites now use a surrogate-safe slice.
- **Bracketed option lists without whitespace merged options** (`（1）方案A（2）方案B` gave
  option 1 both texts); the option-boundary split now recognizes bracketed markers.
- **Trailing-punctuation signals and 5-digit numbers fell into the adaptive pipeline**
  (`继续。`, `ok!`, `10000`) — exactly the inputs the signal branch exists to catch. Trailing
  punctuation is stripped before classification and the number width raised to 6.
- **Deictic directives never saw the assistant tail**: the branch only accepted user turns,
  so `改一下` after the assistant just delivered something was always `cannot_infer`. The
  assistant tail is now wired through and rendered as the most recent context entry.

### Changed

- **`context: false` no longer disables next-input prediction.** The prediction channel has
  its own `predict` switch (default on); `context` keeps governing rewrite/audit context
  injection. Previously the crystal ball rendered but refused every click with
  `cannot_predict`, silently.
- **Every route request now has a hard wall-clock ceiling** (`requestTimeoutMs`, default
  120 s). `deadlineMs` intentionally budgets only the optional calls; a hung provider on a
  mandatory call used to hang the request (and the client fetch) forever. The route now races
  the task against the ceiling, returns a structured `request_timeout` result, and forwards an
  AbortSignal into `llm.stream` so well-behaved providers stop early; a client disconnect
  aborts too.
- **Model output has a hard size cap** (4× the input limit). A runaway provider that streams
  1 MB with `finish=stop` is now rejected with `output_too_large` instead of being pasted
  into the composer.

## [0.9.6] - 2026-10-12

The composer's empty state was carrying a dead control: a half-transparent star that did nothing until
you typed, in sessions where there was nothing to optimize. That slot now has two identities, and the
second one earns its place.

### Added

- **Next-input prediction.** When the draft is empty and the conversation has had at least one full
  exchange (a user turn, an assistant turn, and no turn currently running), the **✦** slot becomes a
  **crystal ball**. Clicking it reads the conversation tail and writes the message you are most likely
  to send next straight into the message box — one model call, no dialog. Typing anything returns the
  star immediately.
- **Anchor-shaped predictions instead of a fixed length.** The anchor type is decided by deterministic
  rules with zero extra model calls, and each type carries its own character budget: numbered options
  → restate the likely pick (≤ 20); a pending question → answer it (≤ 40); "shall I continue?" →
  confirm, at most one short condition (≤ 20); freshly delivered work (tool activity in this turn, or
  delivery wording) → one concrete next action (≤ 40); a failure → one fix or retry (≤ 40). Over
  budget → one tightened retry → deterministic trim at the last sentence boundary. One message, never
  a list, enforced in code rather than trusted to the prompt.
- **`cannot_predict`.** When the tail holds no anchor (the assistant merely stated something), the
  click spends zero model calls and writes nothing: the icon goes neutral and says so next to itself.
  Same invariant as `cannot_infer` for bare signals — the system declines to guess rather than
  inventing a "continue" the context never offered.
- A `predict` row in the local sample log: kind, anchor source, window size, whether this turn had
  tool activity, latency, outcome code — joinable by `runId` like every other event.

### Changed

- **Empty sessions render no icon at all.** Previously the star stayed resident at 45% opacity even
  with nothing to optimize (#the old rationale was positional stability and discoverability). It is
  gone: an empty conversation shows nothing, and the star appears with your first characters. The
  prediction icon takes the position once there is a conversation to predict from.
- **Prediction reads the *tail* of the assistant's last message** (800 chars), where anchors actually
  live — the existing context extractor kept the first 300, which cut off exactly the questions,
  offers and option lists a prediction needs.

### Fixed

- **The assistant's own words were being read from the wrong place, everywhere.** A real
  `assistant/message` event nests its payload — `data.message.{role,content}` — while a
  `user/message` event is flat (`data.{role,content,source}`). Both the session-context extractor
  and the signal branch's assistant-tail reader assumed the flat shape, so on this host the assistant
  tail was **always empty, silently**: prediction refused every single time with a neutral "no
  predictable next step", and the signal branch's anchors could only ever come from the user's own
  turns. Confirmed by decoding a live session log rather than by reasoning about it. Shapes are now
  normalised in one place, and the tests + the real-socket checks use the nested shape the host
  actually emits.
- **The assistant tail kept the first 300 characters — exactly the wrong end.** Pending questions,
  "shall I continue?", and numbered option lists all live at the end of the message, so the anchors
  the signal branch keys on were being truncated away. The tail is now taken from the end (and the
  prediction window keeps 800 characters of it).
- **Failures are visible, not silent.** A failed prediction turns the icon to its warning colour and
  renders "prediction failed, click to retry" beside it; a neutral refusal renders its reason the same
  way. Both collapse as soon as you start typing. Previously such a state would have been reachable
  only through a hover tooltip.
- **The prediction result never overwrites typing.** The response is dropped when the draft revision
  moved while the request was in flight (the same draftRev CAS the optimizer uses).

## [0.9.5] - 2026-10-11

Three of these were found by pointing the plugin's own live route at itself from outside the
browser — `Origin`, `Host`, request-body size and the sample log were all exercised over a real
socket instead of through the unit-test doubles, which is how the two masking bugs below survived
a green suite.

### Fixed

- **A web page you visit could drive this route.** The loopback guard checked the peer address and
  the `Host` header, but never `Origin` — and `Origin` is the only one of the three that
  distinguishes "this app's page" from "some other page". Because the route never looked at
  `content-type` either, `content-type: text/plain` made the call a CORS *simple request*: no
  preflight, so any page could blind-fire it. Measured before the fix:
  `Origin: https://evil.example` + `text/plain` returned `200` and spent a real model call. An
  `Origin`, when present, must now itself be loopback; requests with no `Origin` (scripts, curl)
  are unaffected. The response still carries no CORS headers, so the exposure was never
  disclosure — it was token spend and attacker-chosen rows in the local sample log.
- **`Host: 127.0.0.1.evil.example` was accepted.** The check was `startsWith("127.")`, and a
  domain whose A record points at `127.0.0.1` satisfies *both* the peer check (it really is
  loopback) and that prefix test. Measured before the fix: `200`. Loopback hosts are now matched
  by full shape (`127.a.b.c`), not by prefix.
- **An oversized request body produced a connection reset, not an error.** `readJsonBody`
  rejected and then called `req.destroy()` — tearing down the socket before the handler could
  write its response. Measured before the fix: an 80 KB body returned `ECONNRESET` / "Empty reply
  from server", with no status and no error code, contradicting the "every code has a
  user-facing message" invariant. The body is now drained (bounded by a hard cap of 8x the limit,
  past which the socket is still cut) and answered with `413 payload_too_large`. The test double
  was `req.destroy = () => {}`, which is exactly why a green suite never noticed.
- **The sample log recorded a mode that never ran.** When a result carried no `mode` — every
  failure path, since none of them reach mode selection — the host half fell back to a heuristic
  re-guess and wrote `elaborate` (or `precise`). Measured before the fix: `empty_input`, a bare
  `hi`, an over-length draft and a rejected draft were all logged as `elaborate`, a mode this
  pipeline has never had. The field that exists to attribute outcomes by mode was fabricating
  them. Failures now log `mode: null`, and modes are attached where the pipeline really decides
  them, so a rejection is attributed to the branch that actually ran.
- **`ACTION_PATTERN` was missing `换` / `换成`.** The lexicon had `替换` but not the far more
  common short form, so `把 X 换成 Y` was not recognised as an already-precise instruction while
  `把 X 替换为 Y` was — a one-word gap that decides session-context reads and telemetry labels.

### Added

- **`codeVersion` and `runId` in the sample log.** The log spans releases and carried neither, so
  attributing a row to the code that produced it meant comparing commit timestamps by hand.
  `runId` is minted per run by the browser half and echoed on the implicit-feedback request,
  which turns "this input was reverted immediately" into a record that can be joined instead of
  inferred from adjacent timestamps.
- **`auditProvider` / `auditModel`.** The audit judge and the rewriter shared one route
  (documented as a known limitation). The two audit calls are the lightest of the four in the
  worst path, so moving them to a cheaper model is the most direct lever on worst-case latency.
  Unset, behaviour is unchanged.
- **`deadlineMs`.** A wall-clock budget for the *optional* calls (unfold retry, thin-elaboration,
  targeted repair). Past it, the remaining optional calls are skipped and the run returns the
  same honest result it would have returned after a failed repair. The default (20 s) sits above
  every latency measured in real use, so it does not trade repair attempts for speed — it bounds
  runaway providers. Lower it to trade attempts for time.

### Changed

- `payload_too_large` is the first error code not answered with `200`: it is a transport fact,
  not a business outcome, and the client needs to tell "fix your JSON" from "trim your draft".

## [0.9.4] - 2026-10-07

### Added

- **One click picks the operation.** The middle branch ran one adaptive contract: the model
  declares a mode first - `seed` (unfold the implied detail), `clarify` (same meaning, tidied,
  hard 1.5x length cap), `precise` (near-verbatim) - then performs it. This came out of real
  usage data: of 22 actual clicks, most inputs were complete-but-messy drafts that the old
  everything-else-expands default turned into 2-8x rewrites; two were rejected outright and one
  45-character question came back as 339 characters. Verification stays deterministic: clarify
  budgets and anchor conservation are enforced in code, the fidelity audit is unchanged, and
  assistant-question messages (short, no code anchors, asking what to do next) route to the
  conversational branch because the live model insisted on expanding them through three prompt
  variants. Every result now records the chosen mode, so routing quality is measurable.
- **Post-optimize actions are visible.** The revert button carries a 原文 label and the
  regenerate / step-back buttons carry text instead of bare icons (contributed in #1).

### Fixed

- **Deterministic guards render as refusals, not failures.** `input_too_long` and `empty_input`
  now take the neutral declined state, matching `nothing_to_optimize` - a guard the user can
  act on is not a crash.

### Changed

- The `system.md` override now replaces the adaptive main contract (hard rules still appended,
  per-request language check still added); depth applies to the seed path only.
- Removed the `stale` and `unknown` error codes - declared with messages since 0.8.1, never
  produced by any code path.

## [0.9.3] - 2026-10-05

### Fixed

- **The signal, short-directive and conversational template overrides now load.** The contracts
  have always read `signalSystem` / `deicticSystem` / `conversationalSystem` from the override
  layer, but the host half only loaded `system.md`, `user.md` and `audit.md` — so dropping
  `signal.md`, `deictic.md` or `conversational.md` into `$DSH_HOME/prompt-seed/prompts/` had no
  effect at all. An unreachable configuration path is worse than a missing one: the docs said it
  worked. All six files are read now, re-read per request as before.
- **A refusal to infer no longer looks like a crash.** `cannot_infer` — returned when a bare
  signal (a number, a go-ahead) has no anchor in the conversation — was falling through to the red
  error state. It now shares the neutral declined state with `nothing_to_optimize`, because
  declining to guess an intent is the system working as designed.
- **`?debug=1` works again, and its output is now pinned by a test.** The 0.9.0 context refactor
  renamed a local to a `{ context, assistantTail }` bundle and updated the call into the pipeline,
  but the debug block kept reading the old name — so every request carrying the switch threw a
  `ReferenceError` inside the handler. That is the first command the troubleshooting table tells a
  user to run when an upgrade appears to do nothing, and it is how the loaded `codeVersion` gets
  confirmed. The route test now pins the field set, the version, the shape-only context counts
  (never the draft or the context text) and the switch staying opt-in.

### Changed

- The sample log no longer re-creates its directory on every run (a process-local cache, with a
  single invalidate-and-retry if the directory disappears underneath it). Internal.

## [0.9.2] - 2026-10-05

### Documentation

- **The English README is English again.** Examples, credentials, error messages, and config
  comments had drifted into Chinese (the plugin's UI ships Chinese strings, and sample outputs were
  pasted verbatim). The English README now uses English examples throughout — a seed, the credential
  line, the signal/anchor table, the error-code table — while the Chinese README stays fully
  Chinese; the two cross-link at the top. Where a user-facing message matters, the English table
  states the English meaning and notes that the UI strings themselves are Chinese-only today
  (Known limitation #2). CHANGELOG quotes were translated the same way, keeping the facts
  (call counts, ratios, fallbacks) intact.
- **Install instructions lead with a channel that exists.** The README's first command was
  `dsh plugin add dsh-prompt-seed` — the npm channel, which is not published yet, so the documented
  first step could not work. Both READMEs now lead with the released tarball URL (verified: installs
  in ~6 s) and list the npm form as pending publication.

### Added

- **Community files for a public repository**: `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1,
  with a working enforcement contact), GitHub topics (`dsh-plugin`, `deepseek-harness`, and five
  more — the ecosystem's plugin indexes aggregate from the `dsh-plugin` topic), and refreshed issue
  templates (current version placeholders). Repository community health: 100%.

## [0.9.1] - 2026-10-05

### Added

- **The conversational branch: messages to the assistant are not task seeds.** A live
  regression made it measurable: a question about *where* to publish the plugin
  (roughly: "the question I meant to ask was where to publish this") was rewritten into a task spec for *how* to
  publish — a change of direction the fidelity gate cannot catch, because `SCOPE_ADDED`
  is defined against task seeds. Conversational inputs (meta-talk about the conversation,
  opinions, why/choice questions, continuation directives like "keep going through this project…")
  now get a dedicated light-touch contract: fix typos, punctuation, and grammar only;
  never elaborate, never answer, never turn a question into an instruction. The output is
  capped at input +35% with one tightened retry, and the failure fallback is the
  **original text** — this branch never rejects (better no work than the wrong work). The classifier
  is deliberately conservative: anything with a task verb ("build me an X", "implement an X") still
  goes to the elaboration pipeline, so seeds cannot be swallowed by mistake.
- `mode: "conversational"` in the event log; seven new tests cover the real regression
  inputs, the non-swallowing guarantees, and both fallback paths.

## [0.9.0] - 2026-10-04

### Added

- **Signal inference and the deictic degree contract.** Two input shapes the elaboration
  contract was never designed for now have dedicated semantics, both driven by a new pure
  module (`src/signal-inference.js`) whose classification, anchor inference, and degree
  checks are entirely deterministic — the model is only ever invited into a pen the rules
  built around it.
  - **A bare signal** (a number like `"42"`, or a go-ahead like `"continue"` or `"ok"`) carries no task
    content of its own; its only meaning is "continue with what the conversation left
    pending". The host now also extracts the latest **assistant turn**
    (`extractAssistantTail`) — options, pending questions, and continuation offers live
    there, and a user-turns-only window cannot see them. Inference priority: an option
    list the number matches (`choice`) → a question the assistant left pending
    (`answer`) → the user's own unanswered question (`continue`). If nothing pending
    matches, the result is an explicit `cannot_infer` with **zero model calls** — "42"
    against options 1/2 is a deterministic refusal, never a guess. Model-side refusal
    markers (a literal "[cannot infer]" token) and ungrounded outputs are converted to the same code.
  - **A short directive** (`"fix it"`, `"wrong"`, `"change it"`) has a clear verb and a
    missing object. Expansion runs under a degree contract: the referent must come from
    context; divergence is allowed only inside the natural sub-parts of the user's own
    verb and its implied immediate follow-ups; new goals, tools, numbers, paths, or scope
    are forbidden; the verb must survive verbatim; the output is hard-capped at 180
    characters. One tightened retry, then `fidelity_rejected`. An unresolvable referent
    is reported honestly (an unresolvable-referent token → `cannot_infer`).
  - The event log gains `mode: "signal" | "deictic"`, and context reading now triggers
    for signal/deictic inputs even when the draft is longer than the old 12-char rule.
  - Sixteen new tests cover the classifier, anchor-priority order, both refusal paths,
    the degree cap with a genuine >180-char violation, and the grounding check.

## [0.8.7] - 2026-10-03

### Added

- **The event log records where a call came from** (`from: "ui" | "script"`, derived from whether a
  session id was present). Without it the log cannot tell a real click from a verification probe, and
  the difference turned out to be overwhelming: one full verification pass wrote **159 records of the
  same handful of fixed inputs** into a log that held about **7 records of genuine use**. Every
  question the log exists to answer — is the depth right, is the gate misfiring — is a question about
  a distribution, and that distribution was 96% synthetic. The flooded log is archived beside the new
  one rather than deleted.

## [0.8.6] - 2026-10-03

### Removed

- **The status line above the composer is gone** (added in 0.8.4, removed one release later). It was
  wrong in a way that should have been caught before shipping: it rendered as a **full-width banner
  for a single line of text**, and it appeared for transient states that carry no information at all
  — an "optimizing… (click again to cancel)" line duplicated a spinner the button was already showing, and the
  success credential duplicated the `✓ +131` badge that sits on the button itself. Only a rejected
  run genuinely needs a resident explanation, and that case is rare enough that a banner which shifts
  the composer on every click is not a trade worth making.

  Two things made this hard to get right and easy to get wrong: the dock slot is full-width by
  nature, so anything placed there is visually loud; and the layout cannot be seen from the
  development side, so a visual change ships unverified. Rather than iterate blind a third time, the
  dock registration, its component, its styles and the cross-slot store are all removed. The plugin
  registers exactly one slot again.

### Kept from 0.8.4

- Rejection reasons still lead with the **violation class** ("added requirements that were never there") plus one short
  example, in the button's tooltip. That message rewrite is what actually fixed the original problem
  — the old text pasted the audit model's raw sentences into a 110-character wall. At ~50 characters
  it reads fine as a tooltip.

## [0.8.5] - 2026-10-03

### Fixed

- **A rejected run logged an empty `violations` array.** The event log read the violation classes
  off `result.gate`, but a rejection carries no `gate` object — so the one record that most needs
  attribution ("which class of over-reach did this hit?") was permanently blank. It now falls back
  to the structured violations on the rejection itself, and a test asserts the class reaches the log.

## [0.8.4] - 2026-10-03

### Added

- **A status line above the composer** (`conversation.input.dock`, order 15, `replaceRisk: none`).
  The credential and the rejection reason were only reachable through the `title` attribute — a
  medium that appears after a delay, cannot wrap or be laid out, cannot be dismissed, and vanishes
  when the mouse moves. Both need a resident, readable, closable carrier. It renders nothing when
  there is nothing to say, and closing a message only closes that message.
- **Rejections now report the violation class first** — "added requirements that were never there" — followed by one
  concrete example, instead of pasting the audit model's raw sentences into the interface, which
  read like an internal log and left the user to guess why it counted as a problem. The host sends
  structured `violations: [{kind, label, text}]` for this.

### Changed

- **A rejection is no longer a dead end.** The repair contract now tells the model: if fixing the
  flagged problems would leave nothing worth adding, return a lightly polished version of the
  original instead — same content, same breadth, nothing new — rather than gambling on keeping the
  flagged material. A light rewrite that passes the re-audit is something the user can use; a second
  rejection hands them nothing. Cost: zero extra calls (the instruction rides on the repair call
  that was already being made).

## [0.8.3] - 2026-10-03

### Fixed

- **Over-elaboration was reaching the user unverified.** The 0.8.0 "structural violations skip the
  second audit" shortcut accepted a repaired draft without re-checking it. A live run was flagged
  `scope_added` — the scope had been widened, which is precisely what over-elaboration means — and
  the repaired draft was delivered on trust, where the previous version would have re-audited and
  rejected a draft that was still widening. **Repairs are re-audited again, unconditionally.** The
  saved call landed on the only step that catches "the repair made it wider"; a latency win must not
  eat divergence control. `gate.rechecked` is `true` for every repaired result again.
- **The default depth no longer touches the prompt.** `DEPTH - STANDARD` was the only change 0.8.0
  made to the rewrite prompt, and it read as an affirmative instruction to fill in detail inside a
  contract that already elaborates. The standard depth suffix is now empty, so the default path's
  system prompt, user prompt, temperature and token budgets are **byte-identical to 0.7.1** —
  verified by diffing the built prompts. `light` and `deep` remain explicit deviations.
- The audit prompt now says that naming an addition in `DETAIL` is not a way of excusing it: if what
  it names was not asked for, the rewrite is still `SCOPE_ADDED`.

## [0.8.2] - 2026-10-03

### Changed

- The audit's `DETAIL` line is now an explicit mandatory part of the output format, with both
  accepted shapes spelled out. Live measurement showed the model omitting it on roughly one run in
  five, which left the credential blank; the wording now says a missing line is read as "nothing was
  added". (Adherence after the change is pending a restart — see below.)

### Documentation

- Recorded the measured hot-swap behaviour: a **same-name reinstall does not reach the running
  process** (Node's module cache is keyed by URL, and the path is unchanged), while installing under
  a **different path** does. Verified on a live app in both directions using the frozen
  `codeVersion`. The README's troubleshooting entry now says restart, and says why.

## [0.8.1] - 2026-10-03

### Fixed

- **`codeVersion` reported the version on disk, not the code actually loaded.** It re-read
  `package.json` on every call, so after installing a new build into a running app it announced the
  new version while the old module was still executing. It is now frozen at module load, and a test
  rewrites `package.json` after import to prove the reported value does not move. This value is the
  first thing to check when a change "did not take effect", so it has to be trustworthy.
- Template override reads silently swallowed every error. `readFile` was imported from `node:fs`
  (callback form) and used as a promise, so the override never applied and the failure was caught by
  a bare `catch`. Non-`ENOENT` errors are now logged.
- Bare `OK` audit verdicts were parsed as unparsable, which corrupted the "elaborated but still
  distorted" branch of the pipeline.

## [0.8.0] - 2026-10-03

### Added

- **Gate credential.** The audit call now also emits a `DETAIL:` line naming what the rewrite filled
  in, at no extra call cost. The button shows `✓` (audited clean) or `⟳` (converged) beside the size
  delta, and the tooltip reads fidelity ✓ · +150 chars · filled in: edge cases, failure handling.
  A skipped audit is reported honestly as "not audited (the input was already precise)" rather than
  as a pass.
- **Regenerate and version history.** The revert state offers `✦` (re-run from the original, keeping
  up to three versions) and `‹` (step back one version).
- **Adaptive depth.** Local counts of `reverted` / `retried` / `submitted` choose the depth
  (`light` / `standard` / `deep`), with a two-signal minimum so a couple of clicks cannot swing it.
  Right-clicking the button cycles the setting manually; the choice is remembered.
- **Prompt overrides.** `$DSH_HOME/prompt-seed/prompts/{system,user,audit}.md` replace the built-in
  contract. They are re-read per request, so edits apply on the next click without an app restart.
- **View the rejected draft.** A gate rejection returns the draft under `rejected` (never `text`);
  an eye button writes it into the composer only on explicit request, and it stays undoable.
- The button is always mounted (dimmed when the draft is empty) instead of appearing and
  disappearing, and it breathes softly when there is something to act on.

### Changed

- **Session context is read on demand.** Previously any `sessionId` triggered a read; now it happens
  only for short drafts (≤12 chars) or anaphoric ones, and never for a precise instruction that
  already names its files and functions.
- **Structural violations skip the second audit.** `padded` / `scope_added` / `tone_shifted` are
  repaired by deleting or rewording a named sentence, so the repair is accepted directly — the worst
  case drops from four calls to three. `distorted` / `contradicted` are still re-audited, because a
  wrong meaning must never be handed over on trust. `gate.rechecked` records which path was taken.

### Fixed

- Tests no longer write into the production event log: every `host.apply` call in the suite now
  passes an explicit `samples` value. 127 of 128 records in the live log turned out to be test
  fixtures.
- The `submitted` feedback signal never fired. It was bound to the input phase leaving `plain`, but
  React coalesces `plain → submitting → plain` on a fast submit, so the effect never observed the
  change. It is now also triggered by the draft being cleared, and confirmed in real use.

## [0.7.1] - 2026-10-03

### Fixed

- The client half reported `applied` and `submitted` signals; a missing `applied` signal made it
  impossible to tell from the outside whether the browser was running the current bundle.

## [0.7.0] - 2026-10-03

### Added

- Content floor: a bare greeting or punctuation-only input short-circuits to `nothing_to_optimize`
  in ~0 ms instead of spending 5–8 s on a rewrite that cannot help.
- Full event logging for every optimization, plus three implicit feedback labels (`reverted` /
  `retried` / `submitted`) reported through the same route.
- Precise-input mode, and an audit shortcut for precise input that is substantively unchanged **and**
  preserves every identifier, path and number.
- Reference chips no longer disable the button; the tooltip states that chips become plain text and
  a conservation guard refuses any write-back that would drop a chip label.

## [0.6.0] - 2026-10-03

### Added

- Elaboration contract: unfold the intermediate detail a request entails, invent nothing beyond it.
  Seeds are expanded 10–25×; already-precise instructions are left alone.

[Unreleased]: https://github.com/Zian-anson/dsh-prompt-seed/compare/v0.8.7...HEAD
[0.8.7]: https://github.com/Zian-anson/dsh-prompt-seed/compare/v0.8.6...v0.8.7
[0.8.6]: https://github.com/Zian-anson/dsh-prompt-seed/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/Zian-anson/dsh-prompt-seed/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/Zian-anson/dsh-prompt-seed/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/Zian-anson/dsh-prompt-seed/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/Zian-anson/dsh-prompt-seed/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/Zian-anson/dsh-prompt-seed/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Zian-anson/dsh-prompt-seed/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/Zian-anson/dsh-prompt-seed/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Zian-anson/dsh-prompt-seed/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Zian-anson/dsh-prompt-seed/releases/tag/v0.6.0
