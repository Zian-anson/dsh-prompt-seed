## What changed

<!-- One paragraph. What behaviour is different after this PR? -->

## Why

<!-- The failure you observed, or the case the current code gets wrong. -->

## Checklist

- [ ] `npm test` passes (it builds `lib/` first)
- [ ] `lib/` is committed and in sync with `src/` (CI runs `npm run build && git diff --exit-code lib/`)
- [ ] A test fails without this change
- [ ] If a deterministic gate changed: the new rule is pure code and covered by a test
- [ ] If a check is now skipped anywhere: the credential reports it as skipped rather than as passed
