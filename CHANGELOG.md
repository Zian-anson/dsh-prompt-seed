# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

During `0.x`, **minor version bumps may contain breaking changes** (SemVer §4) — the host is in
developer preview and moves quickly. Patch bumps will not break anything.

## [Unreleased]

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
