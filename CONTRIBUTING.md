# Contributing

Thanks for considering a contribution. This is a small, dependency-free plugin; the bar is mostly
"explain the failure you observed".

## Development setup

```sh
git clone https://github.com/Zian-anson/dsh-prompt-seed
cd dsh-prompt-seed
npm test        # builds lib/ from src/, then runs the test suite
```

There are **no dependencies to install** — the package ships six host modules plus the plugin entry
and one browser bundle, all using Node built-ins.

## Ground rules

1. **`src/` is the source of truth; `lib/` is generated.** Run `npm run build` after changing `src/`
   and commit the result. CI fails if `lib/` drifts from `src/` (`git diff --exit-code lib/`).
2. **Every behaviour change needs a test that would fail without it.** Bugs in this project have been
   caught by tests asserting on *effects* (what reached the model, what the rendered button looks
   like), not on internals. Several tests exist specifically because a previous refactor silently
   deleted a code path that the build and syntax check were happy with.
3. **Deterministic gates stay deterministic.** Anything that decides *whether* to spend a model call
   (content floor, precise-input detection, anchor preservation, structural-vs-semantic violation
   classification) must be pure code with a test — not a model judgement.
4. **A skipped check must not claim to have passed.** If the audit is short-circuited, the credential
   says `unverified`; if a repair is accepted without re-auditing, `gate.rechecked` is `false`.
5. **Failures must look like failures of the feature, never of the app.** The plugin never throws out
   of `apply`, never leaves a route behind on dispose, and never writes to the composer unless the
   write is safe.

## Reporting bugs

Please include:

- the host version (`dsh --version`) and the plugin version,
- what you typed, and what came back,
- the row's `_debug.codeVersion` from
  `curl -s -X POST 'http://127.0.0.1:19387/api/prompt-seed/optimize?debug=1' -H 'content-type: application/json' --data '{"text":"hi"}'`,
- and, if the button misbehaved, anything the browser console printed.

The most common false alarm: **host-half changes need an app restart.** `disable` → `enable` re-runs
`apply` against the cached module, so a change can appear to have no effect until the process is
restarted. Check `_debug.codeVersion` first.

## Releasing

1. Move the Unreleased section in CHANGELOG.md into a new version section, and bump package.json.
2. Update the test count wherever it is written — both READMEs and docs/FEATURES.md.
   `npm run check:docs` is part of the gate and fails otherwise.
3. `npm test` — builds `lib/` from `src/`, checks the counts, runs the suite.
4. `npm pack`, then create a GitHub release tagged `v<version>` with the tarball attached.
5. `node tools/verify-release.mjs v<version>` — the `Release verification` workflow now runs this
   automatically on every published release, so this step is for checking *before* you trust CI.
   It downloads the **published** asset and compares
   its `lib/` byte-for-byte against the local build, plus the version and every entry point
   the manifest declares. It fails on any difference, so run it *after* the release, not
   before: it is the only check that proves users are getting what the repository says.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) are welcome but not enforced:
`fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` / `!` → major.
