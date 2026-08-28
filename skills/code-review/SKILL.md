---
name: code-review
description: Use the pi-code-review extension for one-shot reviews or its explicit bounded initial/delta/final managed lifecycle.
compatibility: Requires the installed pi-code-review package and gh for pull-request targets.
---

# Code review

Use `code_review` as the review engine for this code-review request. Do not recreate its finder fan-out or batched candidate verification in the parent conversation.

This skill does not replace or disable `pi-plan-mode` orchestration, PREWALK, `LunaCompliance`, or `LunaTestVerifier`. Those existing workflows remain independent.

## One-shot review

For a normal report-only review, call `code_review` once with `action=run` and the requested target. Publishing requires explicit user authorization through `comment=true`.

## Managed implementation review

Managed review is opt-in. Explicitly provide at least one of:

- `phase=initial|delta|final`
- `planPath`
- `implementationId`
- `sessionId`

The extension does not discover `pi-plan-mode` state or infer an approved plan from session context.

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

Record dispositions before editing. Fix confirmed blockers in one coherent remediation commit, run relevant checks, and call `code_review` again with `phase=auto` and the returned `sessionId`. If the final pass still has a blocker, stop for architecture or product attention.

`APPROVE` is a code-review decision only. It does not claim that required project checks ran or replace the parent or existing plan-mode verifier workflows. Use `action=status` to inspect the lifecycle without running reviewers. Use `action=reset` only with explicit user authorization and `confirmReset=true`.
