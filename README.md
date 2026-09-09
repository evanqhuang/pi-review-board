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

## Publishing

CI checks pull requests and pushes to `main`. Pushing a stable `vX.Y.Z` tag
publishes that tagged commit to npm after typechecking and tests pass.
The tag must exactly match `package.json`. Prerelease tags are rejected.

### One-time maintainer setup

1. Create a GitHub environment named `npm` in this repository's Settings →
   Environments. Configure required reviewers and restrict deployments to release
   tags as appropriate. The publishing job uses this environment.
2. Claim/bootstrap `pi-review-board` from a clean, reviewed checkout using an npm
   account authorized to publish the name (availability is not guaranteed until
   publication). Use Node 24 and current npm 11:

   ```sh
   npm login
   npm ci
   npm run check
   npm pack --dry-run
   npm publish --access public
   ```

   This publishes the initial `0.1.0` version. Do not push `v0.1.0` afterward:
   npm versions are immutable and the workflow would try to publish it again.
3. On npmjs.com, open the package's Settings → Trusted Publisher and configure:

   | Field | Value |
   | --- | --- |
   | Provider | GitHub Actions |
   | Organization or user | `evanqhuang` |
   | Repository | `pi-review-board` |
   | Workflow filename | `publish.yml` |
   | Environment | `npm` |
   | Allowed action | `npm publish` |

   No `NPM_TOKEN` repository secret is needed. GitHub-hosted runners use OIDC
   with provenance. Keep npm account 2FA enabled; restrict token publishing after
   confirming trusted publishing works.

### Subsequent releases

From a clean `main` checkout after CI passes:

```sh
git pull --ff-only
npm version patch  # updates both manifests, commits, and creates vX.Y.Z
git push origin main
git push origin "v$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')"
```

Watch the **Publish to npm** action and approve the `npm` environment deployment if
required. Authentication failures require checking the exact npm trusted
publisher fields above; rerun the failed job once corrected. Never move a tag
or reuse a version that has already been published.

### Pi package gallery

The [Pi package gallery](https://pi.dev/packages) displays npm packages with the
`pi-package` keyword. This package already includes that keyword and the `pi`
extension/skill manifest; no separate marketplace upload workflow is required.
After npm publication, verify discovery in the gallery (indexing may lag) and
test installation with `pi install npm:pi-review-board`.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
and [Pi packages](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md).
