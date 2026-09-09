# Pi Review Board

Claude Code-style, multi-pass code review for the Pi coding agent.

Pi Review Board runs bounded reviewer passes over diffs, branches, worktrees,
paths, and GitHub pull requests. It validates candidate findings with a fresh
single-candidate reviewer instead of presenting every model suggestion as a
bug. Reviews are report-only by default; one-shot pull-request comments are an
explicit opt-in.

Inspired by Claude Code's review workflow. This is an independent community
extension and is not affiliated with or endorsed by Anthropic.

## Install

From GitHub:

```sh
pi install git:github.com/evanqhuang/pi-review-board
```

After an npm release:

```sh
pi install npm:pi-review-board
```

The package requires Pi and a configured model/provider. The `gh` CLI is also
required when reviewing GitHub pull-request targets.

## Use

```text
/code-review [normal|deep] [target]
```

With no target, the extension reviews the current diff. Targets can also be a
pull request, branch, worktree, or path.

The equivalent model tool is `code_review`. It supports:

- automatic bounded routing for tiny, small, and normal changes;
- `deep` reviews with one additional integration pass;
- candidate-specific validation before findings are reported;
- managed review loops for committed implementations;
- optional `--comment` publication for one-shot GitHub pull-request reviews.

Managed loops use `/code-review loop <target>`. They return a session ID and
stable finding IDs; record a disposition for every finding before remediation,
then run the next bounded pass against the new commit.

## Safety and scope

- Reviewer subprocesses receive only read-oriented tools and the required
  result tool.
- Work, input, output, retries, and reviewer concurrency are bounded.
- Pull-request reviews use an immutable captured snapshot and revalidate the
  target before publication.
- Incomplete or under-validated reviews never claim a clean result or publish.
- Project checks remain caller-owned; `APPROVE` is only the review decision.

## Development

```sh
npm ci
npm run typecheck
npm test
npm audit --omit=dev
```

Tests use offline reviewer fixtures and an in-memory Pi provider. They do not
start live reviews.

After changing an installed copy, use `/reload` or start a new Pi session.
