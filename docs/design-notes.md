# Design notes

Internal engineering notes for `dsh-prompt-seed`. These record **what was measured and what
failed**, including the iterations that were wrong — they are the reason the current contract looks
the way it does. Kept out of the README because a user deciding whether to install the plugin needs
the behaviour, not the archaeology.

## Design notes

**Elaborate, never distort (v0.6, current contract).** The product is the detail the user cannot
write themselves. A prompt like "帮我做个图片压缩的功能" is a *seed*: the user knows what they
want built but not the intermediate technical layer (what goes in and out, which parts exist,
which edge cases bite, how to verify). Filling that layer in **is** the feature; a seed handed
back nearly unchanged means the button did nothing.

The earlier contracts got this wrong in both directions and the history is worth keeping:

- **v0.1** let the rewriter *invent* — it changed goals, picked categories the user left open
  ("any problems?" → "security problems") and appended deliverables (comparison tables, fix
  plans). That is **distortion**, and it is what the user actually complained about.
- **v0.2** over-corrected to "zero new commitments".
- **v0.3–v0.5** drew the line at *entailment*: unfold what the request entails, invent nothing
  else. Correct as far as it went, but it made "adding detail" the enemy — so seeds came back
  thin, and the gate rejected good elaboration as invention. Over-conservative, and the gate's
  false positives read to the user as "the feature is broken".

v0.6 keeps the red line where it belongs — **core semantics and tone must not change** — and moves
detail-filling to the product side of the line:

| | Allowed (the product) | Forbidden (distortion) |
|---|---|---|
| Goal | state it first, in the user's own terms | change it or the direction |
| Detail | sub-parts, in/out, steps, edge cases, failure modes, verification | unrelated deliverables, business goals, metrics, deadlines, rankings |
| Open choices | make a concrete decision and write it into the task | leave a menu of options to weigh |
| User's choices | respect every technology, path, name, number, constraint | override, replace, or drop one |
| Scope | keep the breadth the user set | close an open question into one category |
| Tone | keep the user's voice | upgrade a casual message into a formal spec |
| Depth | scale with what was left unsaid | pad an already-precise instruction |

The audit judge therefore no longer reports "added detail" at all. It reports exactly four kinds of
distortion — `DISTORTED`, `SCOPE_ADDED`, `CONTRADICTED`, `TONE_SHIFTED` — plus `THIN` when the
rewrite failed to do its job. On a distortion the pipeline no longer falls back to a conservative
rewrite (that would delete the very thing the feature exists to provide): it runs a **targeted
repair** that keeps the added detail and removes only the offending clause. The length ratio
(`assessInflation`) is no longer a gate at all — under this contract a 10-character seed growing
into a paragraph is the expected outcome, so length only feeds logs.

**Four v0.7.0 additions, each from a measured defect.**

*No-content floor.* `hi` spent 5.4 s going rewrite → audit → repair and came back unchanged;
`你好` spent 8.5 s and was rejected, because the model had to invent an intent for a greeting
("introduce yourself and your capabilities"). `isContentFree` now short-circuits before any model
call: strip whitespace, punctuation and emoji — nothing left, or a pure greeting/filler word, and
the route answers `nothing_to_optimize` in ~0 ms with a neutral (not red) message. The threshold is
deliberately minimal: `登录` (two characters) produces a good elaboration and must not be caught.

*Feedback loop.* Until now only `fidelity_rejected` was logged, which after the v0.6 gate became
rare — three hours of real use produced one record, and it came from a probe. Every optimization is
now appended as `{event:"optimize", code, tier, mode, inputChars, outputChars, ms, input:<400-char
preview>}`, and the browser half reports three implicit, zero-friction labels through the same route
(`{feedback:{kind, tier, charsDelta, elapsedMs}}`): `reverted` (undo within 30 s = too much),
`retried` (edited and re-ran = too little), `submitted` (the draft left `plain` = adopted, the
strongest positive). Without this distribution, every later tuning decision is a guess.
`samples: false` disables all of it.

*Audit skip, with a hole closed.* A precise-mode rewrite that is near-identical now skips the audit
call (measured: 1.7 s → 0.9–1.4 s). The first version of the condition used only the edit-distance
tolerance — and that tolerance is 6 characters on a 45-character input, so
`…改成用 dayjs 实现` → `…改成用 moment 实现` (a swapped library) counted as "unchanged" and was let
through. `preservesAnchors` now also requires every identifier, path fragment and number from the
input to survive verbatim; any lexical change falls back to the full audit.

*Reference chips.* `@file` / `/command` chips used to disable the button. The platform cannot
rebuild a chip node from text (`setDraft` and `insertText` both strip `U+FFFC`), so a rewrite can
only degrade a chip to its plain-text form. The button is now enabled, the tooltip says so
explicitly, and a deterministic **conservation guard** refuses the write-back if any chip label is
missing from the rewrite — the reference is never dropped silently.

**v0.8.0 — the gate becomes visible, and the loop closes.**

*A gate credential (A).* The strongest thing this plugin does had no UI at all: the audit's five
violation classes (`PADDED` and `TONE_SHIFTED` have no counterpart anywhere in the ecosystem) were
invisible, and the only badge was `+150` — a length figure every competitor also shows. The audit
call already reads both texts, so it now also emits one `DETAIL:` line naming what was filled in,
at zero extra cost. The button carries `✓` (audited clean) / `⟳` (converged) plus the delta, and the
tooltip reads `保真 ✓ · 增加 150 字 · 补全：边界情况、失败处理 · 点击恢复原文`. `unverified` is shown
honestly as `未审判（输入已精确）` — the precise-mode shortcut must not masquerade as a passed audit.

*Regenerate (B).* The same input produced 125–264 characters across runs, and the only remedy was
revert-then-click-again. The revert state now offers `✦` (re-run from the original, keeping up to
three versions) and `‹` (step back to the previous version). No competitor has this.

*Fewer calls on the common repair path (C).* A real run took 14 s through four calls
(rewrite → audit → repair → re-audit). Structural violations (`padded` / `scope_added` /
`tone_shifted`) are fixed by deleting or rewording a named sentence, so the repair is now accepted
without re-auditing — three calls. Semantic violations (`distorted` / `contradicted`) still get the
second audit, because a wrong meaning must never be handed over on trust.

*Adaptive depth (D).* The feedback pipeline built in v0.7.0 now feeds back into behaviour: local
counts of `reverted` (undone = too much) and `retried` (re-asked = too little) pick the depth, with
a conservative cold start that needs two signals before moving. Nothing leaves the machine.

*On-demand context (E).* Session context used to be injected whenever a `sessionId` existed,
regardless of need — burning tokens and occasionally pulling irrelevant turns into the rewrite. It
is now read only when the draft is short (≤12 chars) or contains an anaphor, and never for a
precise instruction that already names its files and functions. Depth is switchable by
right-clicking the star (`auto / light / standard / deep`), remembered locally.

*Overridable prompts (F).* Drop `system.md` / `user.md` / `audit.md` into
`$DSH_HOME/prompt-seed/prompts/` to replace the contract. Files are re-read **per request**, so
an edit takes effect on the next click — no app restart, which matters because host-half code
cannot be hot-swapped. Also: the rejected draft is returned under `rejected` (never `text`) and
shown only when the user clicks the eye button; the star stays put when the draft is empty instead
of vanishing; and a rejected gate no longer hides its own evidence.

**Precise-input mode (v0.6.1).** The elaboration contract has one harmful case: an instruction
that already names the target, the action, and how to check the result. Measured live on v0.6.0,
`删除 src/utils/legacy.js 里未被引用的 export，跑一遍测试确认没破坏` came back at 187–369
characters (4–8×) with a "具体做法" paragraph and a failure-rollback clause bolted on. The user
wrote a complete instruction because they know how to do it; teaching it back is padding, not
help. Because "depth scales with what was left unsaid" was only the last bullet of the
`ELABORATE` section, it could not outweigh the unconditional mandate above it — so the mode is now
selected **deterministically** (`isPreciseInstruction`: anchor + explicit action verb + not a
question, length ≥ 16) and the whole contract is swapped rather than hinted at: `PRECISE_SUFFIX`
in the system prompt plus a short dedicated user prompt. The audit gained a matching `PADDED`
violation, and the repair suffix now handles both directions (drop the offending clause, keep the
unflagged detail). Measured after the fix, same input and model: 48 characters, 1.02×, no added
procedure — while seeds were unaffected (21–22×).

**Entailment vs invention (v0.3–v0.5, superseded).** The two failure modes are symmetric. v0.1 let
the rewriter *invent*: it picked categories the user left open ("any problems?" → "security
problems") and added deliverables (comparison tables, fix plans), corrupting the intent. v0.2
over-corrected with a "zero new commitments" contract, which banned *unfolding entailment* too —
and unfolding entailment is the whole point of the button: "any problems?" obviously entails "if
so, tell me what and where", and a vague request handed back unchanged is a failure, not
conservatism. v0.3 drew the line between the two: the rewrite unfolds what the request entails and
stops there.
The few-shot examples teach both borders with TOO PASSIVE / RIGHT / WRONG triplets (the WRONG
side is the old v0.1 output; the TOO PASSIVE side is the old v0.2 behavior), length follows the
entailment instead of hugging the input's length, and the gate was re-calibrated: the audit judge
applies the same entailment yardstick, tolerance widened from 1.3× to 2.5× (normal entailment
unfolding lands in 1.2–2.5×; invention typically 3×+), and the retry mode is a conservative
unfold-only-the-obvious pass rather than grammar-only, so a rejected first draft cannot decay
into a no-op. The audit fails open — the gate is defense-in-depth, not the only mechanism.

**Variance engineering (v0.3.1–v0.3.6).** After the contract was fixed, the residual problem was
variance: the same vague input sometimes unfolded, sometimes came back with a period appended.
Measured causes and countermeasures, in the order they were found: (1) `reasoningEffort` is no
longer passed through to the rewrite — max-effort reasoning made light rewriting diverge and
added seconds; (2) temperature is 0 — though the provider is non-deterministic even then;
(3) an **unfold gate**: a deterministic code check (`isSubstantivelyUnchanged` — skeleton match
with punctuation/courtesy-word/case normalization plus small edit distance — combined with
`looksOpenEnded`) detects a punctuation-level non-improvement and retries with an unfold-emphasis
prompt at 0.4 then 0.7; zero-temperature retries sample the same output as the first draft
(provider prefix caching) and are useless. What cannot be fixed client-side: the provider's
*temporal drift* — the identical prompt went 3/3 unfolds in one ten-minute window and 0/3 in the
next. The button itself is the retry mechanism: every click is a fresh sample, never worse than
the original (the fidelity gate holds at all times), so a flat result simply means click again.
Invention stayed at zero across every sampled window.

**Never lose the user's input.** Any failure leaves the draft byte-for-byte untouched. The route
returns an error code, the browser half simply does not write. `fidelity_rejected` is the same
shape: the original draft stays.

**`draftRev` CAS, not content comparison.** The composer publishes a monotonic `draftRev`. Record
it before the request; discard the result if it moved. Comparing before/after content would also
need a fingerprint to tell a programmatic write's echo apart from real typing.

**Non-streaming.** Writing to the editor per token would bump `draftRev` continuously and destroy
the CAS above.

**Truncation is a failure, not a partial success.** `finish.kind === 'max-tokens'` means the model
wanted to keep going, so the result is half a prompt. Writing that into a message box is worse
than an error: the user may just press Enter.

**Disabled when the draft holds reference chips.** `inputActions.setDraft` replaces the whole
draft, and chips live in the editor rather than in the draft string — replacing would flatten
`@file` / `/command` chips into plain text. The tooltip says so.

**Loopback guard on both signals.** Peer address alone is spoofable via DNS rebinding; the Host
header alone accepts any internal origin. Both are checked.

## Reload semantics (measured, not assumed)

Host-half code changes **require an app restart**. Measured with the running DSH desktop app:

- `plugin_manager` disable → enable rebuilds the Cordis fiber, but the host module instance is
  **cached** (loader resolution table is fixed at boot; Node's ESM cache keys on URL), so the
  new `apply` never runs. Changing the package `main` to a fresh filename does **not** help.
- The `?debug=1` probe reports `codeVersion` read from the installed package, so you can always
  tell which code is actually live: if `codeVersion` is missing or stale, the running module is old.
- Config changes (`route`, `provider`/`model`, `context`, `samples`) *do* apply on reload — they
  are read at `apply` time. Only the module code is cached.
- The browser half is served fresh to the page; a page refresh picks up client changes.

So: install → restart the app → verify with `?debug=1` → then evaluate.

