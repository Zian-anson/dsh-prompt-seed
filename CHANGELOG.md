# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

During `0.x`, **minor version bumps may contain breaking changes** (SemVer §4) — the host is in
developer preview and moves quickly. Patch bumps will not break anything.

## [Unreleased]

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
  delta, and the tooltip reads `保真 ✓ · 增加 150 字 · 补全：边界情况、失败处理`. A skipped audit is
  reported honestly as `未审判（输入已精确）` rather than as a pass.
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

[Unreleased]: https://github.com/REPLACE-WITH-YOUR-GITHUB-USER/dsh-prompt-seed/compare/v0.8.2...HEAD
[0.8.2]: https://github.com/REPLACE-WITH-YOUR-GITHUB-USER/dsh-prompt-seed/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/REPLACE-WITH-YOUR-GITHUB-USER/dsh-prompt-seed/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/REPLACE-WITH-YOUR-GITHUB-USER/dsh-prompt-seed/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/REPLACE-WITH-YOUR-GITHUB-USER/dsh-prompt-seed/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/REPLACE-WITH-YOUR-GITHUB-USER/dsh-prompt-seed/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/REPLACE-WITH-YOUR-GITHUB-USER/dsh-prompt-seed/releases/tag/v0.6.0
