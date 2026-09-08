# Code review extension

## Work budgets

Reviews default to **128 weighted work units**, with a hard maximum of 128.
`--max-work-units <1..128>` (tool option `maxReviewWorkUnits`) can set a lower
per-review limit. The limit covers discovery, follow-ups, validation, and retries;
it is not a file, line, or concurrent-worker limit. At most four reviewer attempts
run concurrently.

Diff, guidance, summary, and validation tasks cost one unit per attempt.
Contextual and integration tasks cost two. The default `reject` work-limit policy
refuses an over-budget discovery plan before launching reviewers. `partial` is an
explicit opt-in and never turns missing coverage into a complete review.

After admitting discovery, half its spare capacity, capped at ten units, is kept
for validation. The rest remains available for retries and follow-ups. Summary
retries cannot consume capacity needed by subsequent discovery tasks. Once
candidates are known, follow-ups also leave capacity for their validation.
Unused headroom is not charged. This reserve is not a guarantee that arbitrarily
many candidates or retries will fit: uncovered work and unvalidated candidates
still make the review incomplete.

Preflight failures report the required discovery weight, configured limit, and
whether work was unsupported. Reports include coverage and budget details rather
than presenting an unstarted review as a clean result.

## Prompt-aware sharding

The pipeline first checks whether the complete review prompts fit. If not, it
sizes shards using the resolved reviewer input budget and checks the **complete
serialized prompts** for each required role. These checks include applicable
repository guidance, changed paths, review context, metadata, JSON escaping, and
UTF-8 byte lengths. Existing structured prompt compaction remains available;
changed lines are never truncated to make a prompt fit.

Files are packed in diff order. Oversized files split at hunk and line boundaries,
with deterministic shard IDs and source-line ownership. A larger usable prompt
budget can admit payloads above 40 KiB; smaller windows or additional guidance can
require smaller shards. Every final invocation is preflighted again before launch.
Indivisible lines or required guidance that cannot fit remain explicitly
unsupported rather than being dropped.

Candidate follow-ups budget the serialized candidate details before constructing
their prompts. Follow-ups and validators try the full supplied diff/hunk first,
then progressively smaller, explicitly labeled candidate excerpts if necessary.
Excerpts retain correct source ranges and every requested candidate line; they do
not replace mandatory discovery coverage. Validators are instructed not to
confirm a finding when the reduced evidence is insufficient.

Standalone `shardDiff` callers still default to a 40 KiB payload target. They may
supply a resolved `maxBytes` and a `fitsPrompt` predicate to check complete prompts.
Explicit work manifests retain the standalone layout so existing shard references
do not change unexpectedly.

## Bounded reviewer completion

The last allowed provider call receives only the expected result tool and an
explicit finalization instruction. The turn allowance is unchanged; the parent
still enforces the hard ceiling. Finder results must declare `coverageComplete`.
An exhausted investigation can retain candidates, but cannot count as clean
coverage merely by returning an empty list. Candidate `category` + `rootCauseKey`
values are stable semantic identities: the same identity is coalesced across
changed locations and wording, while distinct identities remain separate even
in the same file.

A short missing or malformed result may receive one scheduler-admitted correction
attempt. Retry eligibility counts semantic output rather than repeated transport
events; raw output ceilings still apply. Prompt fitting reserves correction and
finalization overhead inside the original input ceiling. Failure reports expose
bounded counters, finalization state, and retry denial—not tool or model content.

## Snapshot evidence and scope

PR capture checks repository, PR number, base/head revisions, and changed paths
again after reading the diff. Review tools, repository guidance, and validator
source reads use a temporary read-only tree from the captured head commit, not the
caller's checkout. The original repository remains the publication identity.
Missing local objects, materialization failures, or unexpected validator source-read
failures make the review incomplete; there is no checkout or diff-only fallback
for failed PR source reads, and no implicit object fetch. Intentional file deletions
use explicit captured-diff evidence rather than requiring a nonexistent head file.

Materialization is bounded to 10,000 entries, 32 MiB per file, 256 MiB total content,
and a 16 MiB tree listing (the command runner can impose a lower output ceiling).
Safe relative in-tree symlinks are supported; escaping, dangling, cyclic links,
submodules, and ambiguous paths are rejected. Temporary trees are disposed after
success, failure, or cancellation. Current-diff and explicit worktree reviews
retain their existing working-tree evidence, including local modifications.

Every review prompt distinguishes the evidence assigned to its unit from the
full global changed-path scope. `assignedScopeComplete` governs finder coverage
and remains true when a complete shard is supplied; `globalScopeComplete` only
reports whether the full changed-path manifest is visible. If that manifest
cannot fit, it is explicitly marked unknown and cannot justify global absence
claims about consumers or documentation.

A shard is covered only when every applicable required obligation is covered,
including guidance, contextual work, and candidate follow-ups/validation. Later
successful waves cannot erase earlier gaps. Legacy persisted records without
required-obligation evidence cannot authorize completion.

## Development

```sh
npm run typecheck
npm test
```

Tests use stub reviewer runners, offline subprocess fixtures, and the installed
SDK lifecycle with an in-memory provider; they do not start live reviews. Coverage
includes PR-sized diffs, smaller context windows, prompt/control ceilings, exact
final-call timing, semantic retry accounting, pinned Git evidence and cleanup,
global scope preservation, partial finder results, and required-role coverage.
Passing these checks does not establish that a particular live PR will complete.

After changing the installed extension, use `/reload` in the active session or
start a new session to load the changes.
