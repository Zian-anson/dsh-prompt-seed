# 0.19.1 Quality and C-Acceptance Report

## Quality pre-screen

- 30 real cases across task / question / statement / meta / precise / long / context / English / security / a11y.
- All 30: exactly one model call, no failures, no anchor loss.
- p50 5.2s, p95 7.6s, max 11.1s (real provider, single run).
- Model-based blind pre-screen (not human sign-off):
  - fidelity 4.73/5
  - clarity 4.90/5
  - restraint 4.73/5
  - usability 5.00/5
  - verdicts: 10 better, 19 same, 1 worse.
- The one worse case: a complaint was rewritten with a causal "导致" that the input did not assert.
- This is a **model blind pre-screen**, not the user's human sign-off. The full output file is local-only
  (bench/quality-latest.json, ignored by git).

## C-plan code-contract checks

The following are verified statically or by host tests:

1. First optimize in a blank/no-session composer calls sessions.create and opens the new session.
2. A deterministic title is generated and written with binding.session.rename.
3. No message is sent automatically; only the composer draft is handed off.
4. Job remains bound to sessionId and status can be queried after switching.
5. Pending draft/first-optimize marker is stored and restored on mount.
6. Existing sessions do not trigger session creation; only blank/no-session does.

**Caveat:** the actual six-click UI acceptance was not executable in this environment because the DSH
web GUI requires the desktop session's authentication URL. The code paths are covered by static
bundle checks and host job tests, but this is not a substitute for a live click-through.

## Auto-reload

The Host self-reload watcher is present in the bundle. A live install of 0.19.1 while 0.19.0 was
running did not switch the live version within the observation window. Treat self-reload as
best-effort; a manual plugin reload may still be required until the watcher's Cordis fiber access is
verified on a running version that contains it.

## Release gate

- Tests: 15 passed.
- Wire: 13 passed.
- Docs/install guards: passed.
- Live: 0.19.0 before release; 0.19.1 installed in the profile.
- Release only with the caveat above; no further behavior changes in this batch.
