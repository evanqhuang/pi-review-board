---
name: code-review
description: Use the pi-code-review extension for one-shot reviews or its bounded managed review loop.
compatibility: Requires the installed pi-code-review package and gh for pull-request targets.
---

# Code review

Use `code_review` as the review engine for this code-review request. Do not recreate its finder fan-out or batched candidate verification in the parent conversation.

This skill does not replace or disable `pi-plan-mode` orchestration, PREWALK, `LunaCompliance`, or `LunaTestVerifier`. Those existing workflows remain independent.

## One-shot review

For a normal report-only review, use:

```text
/code-review <target>
```

The equivalent agent-tool call is `code_review` with `action=run` and the requested target. The default effort is `low`; use a higher effort only when the user explicitly requests it. Publishing requires explicit user authorization through `comment=true`.

## Managed implementation review

Managed review is opt-in. Start or continue it with:

```text
/code-review loop <target>
```

The equivalent agent-tool call uses `action=loop`. Each invocation runs exactly one pass; it does not edit code or repeatedly invoke itself. The extension automatically selects the next permitted phase:

- first invocation: `initial`;
- after adjudication and a committed remediation: `delta`;
- after another adjudication and committed remediation, when needed: `final`.

Use the returned `sessionId` on later loop calls when available. `planPath` and `implementationId` can bind the loop to an explicit implementation identity. The extension does not discover `pi-plan-mode` state or infer an approved plan from session context. Explicit `phase=initial|delta|final` remains available only as an advanced override and cannot bypass lifecycle ordering.

The lifecycle is fixed:

1. one comprehensive initial review;
2. one focused remediation-delta review;
3. at most one focused final confirmation review.

The implementation must be committed and the worktree clean before each managed pass. Never request a fourth pass or reset automatically.

A managed run returns stable finding IDs, a session ID, and an exact reviewed snapshot hash. Treat findings as candidate evidence only. The primary agent must inspect changed lines, guidance, history, tests, and current intent and establish that a candidate is introduced, reachable, impactful, contract-violating, and evidenced before it can block.

Record every candidate with `action=record`, the exact session/snapshot values, and one disposition:

- `confirmed-blocker`
- `non-blocking`
- `accepted-risk`
- `product-decision`
- `follow-up`
- `not-reproducible`
- `resolved`

A confirmed blocker requires concise parent evidence. Critical/high findings with high confidence may block. Medium findings block only when deterministic and explicitly contract-based. Low, plausible, medium/low-confidence, stylistic, speculative, intentional, pre-existing, and check-caught concerns do not block.

Record dispositions before editing. Fix confirmed blockers in one coherent remediation commit, run relevant checks, and call `code_review` again with `action=loop` and the returned `sessionId`. If the final pass still has a blocker, stop for architecture or product attention.

`APPROVE` is a code-review decision only. It does not claim that required project checks ran or replace the parent or existing plan-mode verifier workflows. Use `action=status` to inspect the lifecycle without running reviewers. Use `action=reset` only with explicit user authorization and `confirmReset=true`.
