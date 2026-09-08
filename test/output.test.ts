import { describe, expect, it } from "vitest";
import { collectChangedLocations, deduplicateCandidates, filterCandidatesToChangedLines, filterVerifiedFindings, formatReviewReport, normalizeReviewPath } from "../src/output.js";
import type { ReviewCandidate, ReviewCoverage, ReviewSnapshot, VerifiedFinding } from "../src/types.js";

const snapshot: ReviewSnapshot = {
  target: { kind: "branch", ref: "topic" },
  cwd: "/repo",
  changedPaths: ["src/a.ts"],
  diff: "diff",
  snapshotHash: "hash",
};

function candidate(overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    id: "finder:one:0",
    rootCauseKey: "cache:stale-value",
    file: "src/a.ts",
    line: 12,
    summary: "Uses stale value",
    failureScenario: "When the cache is cold, the result is wrong",
    evidence: "The changed branch skips refresh",
    category: "correctness",
    severity: "high",
    needsContext: false,
    finder: "diff-correctness",
    ...overrides,
  };
}

describe("review output", () => {
  it("deduplicates one explicit root cause across wording and locations while retaining distinct roots", () => {
    const first = candidate();
    const sameRootDifferentLocation = candidate({
      id: "finder:two:0",
      finder: "history",
      file: "src/other.ts",
      line: 44,
      summary: "Cold startup bypasses cache population",
      failureScenario: "The first read observes stale state",
    });
    const sameObservation = candidate({
      id: "finder:three:0",
      needsContext: true,
      summary: "Uses an old cache value",
      failureScenario: "When the cache is cold, the result is wrong",
    });
    const distinctScenario = candidate({
      id: "finder:four:0",
      rootCauseKey: "cache:warm-invalid-value",
      failureScenario: "A warm cache returns an invalid value",
    });
    const distinct = candidate({ id: "finder:five:0", rootCauseKey: "errors:dropped-state", summary: "Drops error state" });
    const result = deduplicateCandidates([first, sameRootDifferentLocation, sameObservation, distinctScenario, distinct]);
    expect(result.map((item) => item.id)).toEqual([first.id, distinctScenario.id, distinct.id]);
    expect(result[0]?.needsContext).toBe(true);
  });

  it("keeps separate nearby failures in one file even when their wording overlaps", () => {
    const migrationFilename = candidate({
      rootCauseKey: "migration:stale-filename",
      file: "src/migrate.ts",
      line: 36,
      summary: "Uses the old migration filename",
      failureScenario: "A migration lookup fails after the file is renamed",
    });
    const sameMigrationFilename = candidate({
      id: "finder:migration:45",
      rootCauseKey: "migration:stale-filename",
      file: "src/migrate.ts",
      line: 45,
      summary: "References the legacy migration name",
      failureScenario: "The renamed migration cannot be found",
    });
    const sameMigrationFilenameAgain = candidate({
      id: "finder:migration:48",
      rootCauseKey: "migration:stale-filename",
      file: "src/migrate.ts",
      line: 48,
      summary: "Points at a migration filename that no longer exists",
      failureScenario: "Startup cannot load the renamed migration",
    });
    const differentFailureNearby = candidate({
      id: "finder:migration:47",
      rootCauseKey: "migration:invalid-order",
      file: "src/migrate.ts",
      line: 47,
      summary: "Runs migrations in the wrong order",
      failureScenario: "A dependent migration executes before its prerequisite",
    });
    const result = deduplicateCandidates([
      migrationFilename,
      sameMigrationFilename,
      differentFailureNearby,
      sameMigrationFilenameAgain,
    ]);
    expect(result.map((item) => item.id)).toEqual([migrationFilename.id, differentFailureNearby.id]);
  });

  it("preserves the category namespace for otherwise identical root identities", () => {
    const correctness = candidate({ rootCauseKey: "shared:contract-break", category: "correctness" });
    const integration = candidate({
      id: "finder:integration:0",
      rootCauseKey: "shared:contract-break",
      category: "integration",
      summary: "Breaks an integration boundary",
    });
    expect(deduplicateCandidates([correctness, integration])).toEqual([correctness, integration]);
  });

  it("accepts only changed locations and rejects verifier corrections outside them", () => {
    const item = candidate();
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,3 @@",
      " context",
      "+changed",
    ].join("\n");
    const changed = collectChangedLocations(diff);
    expect(changed).toEqual(new Set(["src/a.ts:11"]));
    expect(filterCandidatesToChangedLines([item], new Set(["src/a.ts:12"]))).toHaveLength(1);
    expect(filterCandidatesToChangedLines([candidate({ file: "a/src/a.ts", needsContext: true, line: 11 })], changed)[0]?.needsContext).toBe(true);
    expect(filterCandidatesToChangedLines([candidate({ file: "src/other.ts" })], new Set(["src/a.ts:12"]))).toHaveLength(0);
    expect(filterVerifiedFindings([item], [{ candidateId: item.id, confidence: 100, verification: "wrong location", disposition: "CONFIRMED" }], { changedLocations: changed })).toEqual([]);
  });

  it("tracks added lines whose content starts with diff marker characters", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      "++++counter",
      "---counter",
      "+after",
    ].join("\n");
    expect(collectChangedLocations(diff)).toEqual(new Set(["src/a.ts:1", "src/a.ts:2"]));
  });

  it("preserves legitimate top-level a and b directory names", () => {
    const diff = [
      "diff --git a/a/file.ts b/a/file.ts",
      "--- a/a/file.ts",
      "+++ b/a/file.ts",
      "@@ -1 +1,2 @@",
      " context",
      "+changed",
    ].join("\n");
    expect(collectChangedLocations(diff)).toEqual(new Set(["a/file.ts:2"]));
    expect(filterCandidatesToChangedLines([candidate({ file: "a/file.ts", line: 2 })], collectChangedLocations(diff))).toHaveLength(1);
  });

  it("keeps deletion-only changes eligible for removed-behavior findings", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,2 +3,0 @@",
      "-removed",
      "-also removed",
    ].join("\n");
    const changed = collectChangedLocations(diff);
    expect(changed).toEqual(new Set(["src/a.ts:3", "src/a.ts:4"]));
    expect(filterCandidatesToChangedLines([candidate({ line: 3 })], changed)).toHaveLength(1);
  });

  it("attributes deleted rename lines to the old path", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1 @@",
      "-removed behavior",
      "+replacement behavior",
    ].join("\n");
    expect(collectChangedLocations(diff)).toEqual(new Set(["old.ts:1", "new.ts:1"]));
    expect(filterCandidatesToChangedLines([candidate({ file: "old.ts", line: 1 })], collectChangedLocations(diff))).toHaveLength(1);
    const report = formatReviewReport({
      ...snapshot,
      diff,
      baseSha: "base-sha",
      headSha: "head-sha",
      pullRequest: {
        number: 7,
        title: "Rename",
        body: "",
        state: "OPEN",
        isDraft: false,
        authorLogin: "author",
        url: "https://github.com/acme/repo/pull/7",
        baseSha: "base-sha",
        headSha: "head-sha",
        repository: "acme/repo",
        changedPaths: ["old.ts", "new.ts"],
        comments: [],
        reviewerIdentityAvailable: true,
      },
    }, "complete", "", [{
      ...candidate({ file: "old.ts", line: 1 }),
      confidence: 100,
      verification: "verified",
    } satisfies VerifiedFinding], []);
    expect(report).toContain("**Target:** [acme/repo#7](https://github.com/acme/repo/pull/7)");
    expect(report).toContain("/blob/base-sha/old.ts#L1");

    const deletedReport = formatReviewReport({
      ...snapshot,
      diff: [
        "diff --git a/first.ts b/first.ts",
        "--- a/first.ts",
        "+++ b/first.ts",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "diff --git a/removed.ts b/removed.ts",
        "deleted file mode 100644",
        "--- a/removed.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-removed",
      ].join("\n"),
      baseSha: "base-sha",
      headSha: "head-sha",
      pullRequest: {
        number: 7,
        title: "Delete",
        body: "",
        state: "OPEN",
        isDraft: false,
        authorLogin: "author",
        url: "https://github.com/acme/repo/pull/7",
        baseSha: "base-sha",
        headSha: "head-sha",
        repository: "acme/repo",
        changedPaths: ["first.ts", "removed.ts"],
        comments: [],
        reviewerIdentityAvailable: true,
      },
    }, "complete", "", [{
      ...candidate({ file: "removed.ts", line: 1 }),
      confidence: 100,
      verification: "verified",
    } satisfies VerifiedFinding], []);
    expect(deletedReport).toContain("/blob/base-sha/removed.ts#L1");
  });

  it("accepts Git-prefixed and quoted reviewer paths without losing real directories", () => {
    const changed = collectChangedLocations([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3 +3,5 @@",
      " context",
      "+one",
      " context",
      "+two",
      " context",
    ].join("\n"));
    expect(filterCandidatesToChangedLines([candidate({ file: "b/src/a.ts", line: 4 })], changed)).toHaveLength(1);

    const diff = [
      "diff --git a/src/space file.ts b/src/space file.ts",
      "--- \"a/src/space file.ts\"",
      "+++ \"b/src/space file.ts\"",
      "@@ -1 +1,2 @@",
      " context",
      "+changed",
    ].join("\n");
    expect(collectChangedLocations(diff)).toEqual(new Set(["src/space file.ts:2"]));
    expect(filterCandidatesToChangedLines([candidate({ file: '\"b/src/space file.ts\"', line: 2 })], collectChangedLocations(diff))).toHaveLength(1);
  });

  it("preserves POSIX backslashes and surrounding filename spaces", () => {
    expect(normalizeReviewPath('"b/dir\\\\name.ts"')).toBe(String.raw`b/dir\name.ts`);
    expect(normalizeReviewPath(" b/file.ts ")).toBe(" b/file.ts ");
  });

  it("decodes Git quoted control-character escapes", () => {
    expect(normalizeReviewPath('"b/src/with\\t-tab.ts"')).toBe("b/src/with\t-tab.ts");
  });

  it("keeps only confirmed scores at or above 85", () => {
    const item = candidate();
    expect(filterVerifiedFindings([item], [
      { candidateId: item.id, confidence: 84, verification: "weak", disposition: "CONFIRMED" },
    ])).toEqual([]);
    expect(filterVerifiedFindings([item], [
      { candidateId: item.id, confidence: 85, verification: "reproduced", disposition: "CONFIRMED" },
    ])[0]?.confidence).toBe(85);
  });

  it("never reports plausible or refuted candidates, even when recall is requested", () => {
    const item = candidate();
    for (const disposition of ["PLAUSIBLE", "REFUTED"] as const) {
      expect(filterVerifiedFindings([item], [{ candidateId: item.id, confidence: 100, verification: "not confirmed", disposition }], { retainPlausible: true })).toEqual([]);
    }
  });

  it("renders incomplete coverage without clean wording and bounds grouped gap detail", () => {
    const uncoveredRanges = Array.from({ length: 20 }, (_, index) => ({
      unitId: `hash:work:diff:unit-${index}`,
      shardId: `shard-${index}`,
      role: "diff",
      fileIdentity: `src/file-${index}.ts`,
      newRange: { start: index + 1, count: 1 },
      reason: "review work limit leaves unit uncovered",
    }));
    const coverage: ReviewCoverage = {
      snapshotHash: snapshot.snapshotHash,
      state: "unknown",
      plannedUnitIds: uncoveredRanges.map((range) => range.unitId),
      coveredUnitIds: [],
      uncoveredUnitIds: uncoveredRanges.map((range) => range.unitId),
      plannedUnits: uncoveredRanges.map((range) => range.unitId),
      coveredUnits: [],
      uncoveredUnits: uncoveredRanges.map((range) => range.unitId),
      uncoveredRanges,
      uncoveredCandidates: [],
      unvalidatedCandidates: [{ id: "candidate-1", unitId: uncoveredRanges[0]!.unitId, reason: "validator not scheduled" }],
      plannedShardIds: uncoveredRanges.map((range) => range.shardId),
      coveredShardIds: ["shard-covered"],
      uncoveredShardIds: uncoveredRanges.map((range) => range.shardId),
      budgetMaxWeight: 8,
      budgetReservedWeight: 4,
      budgetSpentWeight: 3,
    };
    const report = formatReviewReport(snapshot, "complete", "No issues found.", [], [], coverage);
    expect(report).toContain("INCOMPLETE REVIEW — Covered 0/20 shards");
    expect(report).toContain("role diff");
    expect(report).toContain("reason: review work limit leaves unit uncovered");
    expect(report).toContain("Budget: spent 3 · reserved 4 · max 8 weighted units");
    expect(report).toContain("Unvalidated candidates: 1");
    expect(report).not.toContain("No issues found");
    expect(report).not.toMatch(/\b(?:clean|pass|approved?)\b/iu);
    expect(report).not.toContain("shard-19");
  });

  it("does not trust legacy or stale full-shard success counts", () => {
    const coverage: ReviewCoverage = {
      snapshotHash: snapshot.snapshotHash, state: "complete",
      plannedUnitIds: ["diff", "contextual"], plannedUnits: ["diff", "contextual"],
      coveredUnitIds: ["diff"], coveredUnits: ["diff"], uncoveredUnitIds: [], uncoveredUnits: [],
      uncoveredRanges: [], uncoveredCandidates: [], plannedShardIds: ["shard-0"],
      coveredShardIds: ["shard-0"], coveredShardCount: 1,
    };
    for (const evidence of [coverage, { ...coverage, requiredShardUnitIds: { "shard-0": ["diff", "contextual"] } }]) {
      const report = formatReviewReport(snapshot, "complete", "No issues found.", [], [], evidence);
      expect(report).toContain("INCOMPLETE REVIEW — Covered 0/1 shards");
      expect(report).not.toContain("No issues found");
    }
    const complete = { ...coverage, coveredUnitIds: ["diff", "contextual"], coveredUnits: ["diff", "contextual"], requiredShardUnitIds: { "shard-0": ["diff", "contextual"] } };
    expect(formatReviewReport(snapshot, "complete", "Finished", [], [], complete)).not.toContain("INCOMPLETE REVIEW");
  });

  it("does not claim a clean review when a required stage failed", () => {
    const report = formatReviewReport(snapshot, "incomplete", "Summary", [], [
      { stage: "finders", message: "one pass failed" },
    ]);
    expect(report).toContain("Review incomplete");
    expect(report).not.toContain("No issues found");
  });
});
