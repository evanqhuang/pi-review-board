---
name: code-review
description: Run the deterministic code-review extension for a pull request, branch, path, or worktree target.
compatibility: Requires the installed pi-code-review package and gh for pull-request targets.
---

# Code review

Use the `code_review` tool exactly once for a review request. Do not recreate the
reviewer's fan-out, verification, or result-collection workflow in the parent
conversation.

The tool's output is candidate evidence, not authorization to change code. After
the tool returns, the primary agent owns the validity decision. Before fixing a
finding or delegating it to an editor, independently inspect the exact changed
lines, applicable repository guidance, history, tests, and current intent. Keep
only findings the primary agent can establish as introduced by the target diff
and causing a reachable concrete failure (wrong output, crash, security
exposure, or data loss). Reject style preferences, speculative improvements,
intentional behavior, pre-existing issues, and failures already guaranteed to be
caught by an established check. Do not ask another reviewer, verifier, advisor,
or editor to perform this gate. Record why rejected or unconfirmed candidates
were not acted on, and pass only primary-agent-confirmed findings to any fix
workflow.

Command form:

```text
/code-review [low|medium|high|xhigh|max|ultra] [--model provider/id] [--comment] [target]
```

Review stages use routed models by default; an explicit `--model provider/id` hard-pins that model for every stage of one review.

Default routing:

| Effort | Finder route | Batched verifier route |
| --- | --- | --- |
| `low` | 1 × GPT-5.6 Luna `xhigh` | GPT-5.6 Luna `max` |
| `medium` | 8 × GPT-5.6 Luna `xhigh` | GPT-5.6 Sol `medium` |
| `high` | 8 × GPT-5.6 Luna `xhigh` | GPT-5.6 Sol `high` |
| `xhigh` | 10 × GPT-5.6 Luna `xhigh` plus gap sweep | GPT-5.6 Sol `xhigh` |
| `max` / `ultra` | 10 × GPT-5.6 Luna `max` plus gap sweep | GPT-5.6 Sol `max` |

Verifiers receive the complete deduplicated candidate batch in one reviewer invocation. `ultra` runs a second independent batch verification. Use `--model provider/id` to override the routed model for every stage of one review; the effort-specific thinking level remains in effect.

The effort level defaults to `medium`. It controls review depth, fan-out,
verification tolerance, and the maximum number of reported findings:

- `low`: one changed-diff pass plus one batched verifier, up to 8 findings.
- `medium`: eight finder passes plus verification, up to 8 findings.
- `high`: eight finder passes with recall-biased verification, up to 10 findings.
- `xhigh`: ten deep finder passes, gap sweep, and up to 15 findings.
- `max`: xhigh with full surrounding-context analysis, up to 15 findings.
- `ultra`: max plus an independent final verification pass.

Tool parameters:

- `effort`: `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`; defaults to
  `medium`.
- `target`: omit for the current diff; otherwise use a pull-request number or URL,
  branch name, existing file/directory path, or the root of a Git worktree.
  Worktree targets review the worktree branch against its upstream (when available)
  plus tracked working-tree changes.
- `comment`: omit or set false for report-only behavior. Set true only when the
  target is a pull request and the user explicitly authorizes publishing.
- `model`: optional `provider/id` override; defaults to the effort-routed model above.

The tool owns target resolution, repository guidance discovery, effort-specific
review passes, preliminary candidate verification, deduplication, stale-target
checks, and concise report formatting. Its verification is not the primary
agent's validity decision. A failed review stage is reported as incomplete
rather than as an all-clear result.
