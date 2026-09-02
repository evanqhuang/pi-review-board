---
name: code-review
description: Use the pi-code-review extension for bounded normal or deep reviews.
compatibility: Requires the installed pi-code-review package and gh for pull-request targets.
---

# Code review

Use `code_review` for this request. It captures an immutable target snapshot, applies deterministic eligibility/configuration/routing, and returns report-only results unless publication is explicitly requested.

## Public review depths

The public effort vocabulary is only `normal` and `deep`; omitted effort defaults to `normal`. Legacy effort names are intentionally unsupported and must not be used.

```text
/code-review [normal|deep] <target>
```

The equivalent tool call uses `action=run`. `normal` automatically selects the bounded `tiny`, `small`, or `normal` route from the snapshot. `deep` bypasses that size route and runs the normal review set plus exactly one integration pass. `comment=true` is required to publish a one-shot pull-request review; otherwise results are report-only.

### Eligibility and deterministic routing

A target with no changed files/diff is ineligible. Pull requests must be open, non-draft, non-automated, and not already reviewed by the current reviewer. Configuration is read only from the repository-root `.pi-code-review.json`; malformed, unreadable, unknown, or invalid configuration makes the review incomplete rather than silently falling back.

The root configuration is additive. These arrays accept non-empty strings and add signals to the built-ins; built-in signals cannot be removed:

```json
{
  "highRiskPathGlobs": ["src/payments/**"],
  "publicContractPathGlobs": ["packages/sdk/**"],
  "publicContractMarkers": ["PUBLIC_API"]
}
```

Risk promotes a change to the `normal` route when it touches a built-in or configured high-risk path, an immediate public-contract signal, a public-contract threshold (at least 5 changed lines or at least 2 contract paths), or a binary, rename, or copy change. Without risk promotion, `tiny` means one file, one hunk, at most 10 changed content lines, and no binary/rename/copy; `small` means 1–3 files, at most 150 changed content lines, and no binary/rename/copy. Empty changes remain ineligible.

## Bounded workflow

The route controls a fixed role set; it is not a general exploration framework:

- `tiny`: one diff-only bug pass.
- `small`: one diff-only bug pass and one guidance pass, with at most one candidate-triggered contextual escalation.
- `normal`: one summary, two guidance passes, one diff-only bug pass, and one contextual bug pass.
- `deep`: the normal set plus one integration pass.

Primary role passes run in parallel. They inspect only the supplied change and the nearest permitted context. Each candidate is tied to a changed line, then gets one fresh, single-candidate validator; validator concurrency is bounded (at most four). Only `CONFIRMED` verdicts with confidence `>=85` are reportable. `PLAUSIBLE`, `REFUTED`, and lower-confidence results are not findings.

Do not perform broad exploration, a batch verifier, a gap sweep, independent whole-set verification, or recursive agent delegation. Candidate and output limits are enforced. Reviewer turn/context/output-cap failures and compaction failures make the review incomplete and never publish. A short missing or malformed protocol result may receive one internal retry; a persistent miss is incomplete, never approval.

## Managed implementation review

Managed review is opt-in:

```text
/code-review loop <target>
```

The equivalent tool call uses `action=loop`. Each invocation runs one bounded pass and never edits code or invokes itself recursively. Automatic progression is:

1. one `initial` pass;
2. after adjudication and a committed remediation, one `delta` pass;
3. when needed, at most one `final` confirmation pass.

Use the returned `sessionId` on later calls. `planPath` and `implementationId` can bind the session to an explicit implementation identity. Advanced `phase=initial|delta|final` overrides remain subject to lifecycle ordering. The target must be committed and clean for each managed pass; never request a fourth pass or reset automatically.

A managed result returns stable finding IDs, a session ID, and the exact reviewed snapshot hash. Treat findings as candidate evidence and inspect the changed lines, relevant intent, history, tests, and current behavior before recording a disposition. Record every candidate with `action=record`, the exact session/snapshot values, and one of:

- `confirmed-blocker`
- `non-blocking`
- `accepted-risk`
- `product-decision`
- `follow-up`
- `not-reproducible`
- `resolved`

A `confirmed-blocker` also requires parent evidence. Critical/high findings must meet the confidence gate; a medium finding additionally requires deterministic evidence and an explicit contract basis. Record dispositions before editing. Fix confirmed blockers in one coherent remediation commit, run relevant checks, and call the loop again with the returned `sessionId`. If the final bounded pass still leaves a blocker, stop for architecture or product attention.

Snapshot hashes, repository/target identity, clean-head checks, plan identity, locks, and immediate pre-publication revalidation are lifecycle safeguards. A changed target, stale plan, duplicate existing review, or any incomplete stage prevents publication. Project checks remain caller-owned and are not inferred. `APPROVE` is only the code-review decision; it does not claim project checks ran. Use `action=status` to inspect state without reviewers. Use `action=reset` only with explicit user authorization and `confirmReset=true`.
