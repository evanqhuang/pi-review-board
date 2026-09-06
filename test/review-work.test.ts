import { describe, expect, it } from "vitest";
import { applyReviewWorkCoverage, planReviewWork, updateReviewCoverage } from "../src/review-work.js";
import { DEFAULT_MAX_REVIEW_WORK_UNITS, MAX_REVIEW_WORK_UNITS, REVIEW_WORK_UNIT_WEIGHTS } from "../src/types.js";

const snapshot = {
  snapshotHash: "work-snapshot",
  diff: [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n"),
} as const;

describe("deterministic review work and coverage", () => {
  it("exposes bounded role weights and plans against an immutable snapshot", () => {
    expect(DEFAULT_MAX_REVIEW_WORK_UNITS).toBe(32);
    expect(MAX_REVIEW_WORK_UNITS).toBe(128);
    expect(REVIEW_WORK_UNIT_WEIGHTS).toEqual({ summary: 1, diff: 1, guidance: 1, contextual: 2, integration: 2, validator: 1 });
    const first = planReviewWork(snapshot, { roles: ["summary", "diff", "validator"], maxReviewWorkUnits: 8 });
    const second = planReviewWork(snapshot, { roles: ["summary", "diff", "validator"], maxReviewWorkUnits: 8 });
    expect(first).toEqual(second);
    expect(first.snapshotHash).toBe(snapshot.snapshotHash);
    expect(first.units.every((unit) => unit.snapshotHash === snapshot.snapshotHash)).toBe(true);
    expect(first.coverage.state).toBe("unknown");
    expect(first.coverage.plannedUnits).toEqual(first.units.map((unit) => unit.id));
    expect(first.coverage.coveredUnits).toEqual([]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("rejects or partially records deterministic work-limit coverage", () => {
    const roles = ["summary", "diff", "contextual", "integration", "validator"] as const;
    const rejected = planReviewWork(snapshot, { roles, maxReviewWorkUnits: 1, workLimitPolicy: "reject" });
    expect(rejected.selectedUnitIds).toEqual([]);
    expect(rejected.coverage.state).toBe("incomplete");
    expect(rejected.coverage.uncoveredUnits).toHaveLength(rejected.units.length);
    expect(rejected.coverage.reason).toContain("rejected");

    const partial = planReviewWork(snapshot, { roles, maxReviewWorkUnits: 3, workLimitPolicy: "partial" });
    expect(partial.selectedWeight).toBe(2);
    expect(partial.selectedUnitIds).toHaveLength(2);
    expect(partial.coverage.uncoveredUnits.length).toBeGreaterThan(0);
    expect(partial.coverage.uncoveredRanges.every((range) => range.reason.length > 0)).toBe(true);
  });

  it("defaults to supported-shard diff obligations and accepts selective agent-facing manifests", () => {
    const conservative = planReviewWork(snapshot);
    expect(conservative.units.map((unit) => unit.role)).toEqual(["diff"]);
    const selective = planReviewWork(snapshot, {
      manifest: [
        { role: "integration", applicable: false },
        { role: "guidance-b", trigger: "risk" },
        { role: "guidance-a", applicable: false },
        { role: "contextual-bug", trigger: "candidate", applicable: false },
      ],
    });
    expect(selective.units.map((unit) => [unit.role, unit.agentRole, unit.trigger])).toEqual([
      ["diff", undefined, undefined],
      ["guidance", "guidance-b", "risk"],
    ]);
  });

  it("puts primary diff first regardless of manifest order and never gates it on model work", () => {
    const plan = planReviewWork(snapshot, {
      manifest: [
        { role: "validator" },
        { role: "integration" },
        { role: "summary" },
        { role: "guidance-a" },
      ],
      maxReviewWorkUnits: 2,
      workLimitPolicy: "partial",
    });
    expect(plan.units[0]?.role).toBe("diff");
    expect(plan.units[0]?.dependencies).toEqual([]);
    expect(plan.selectedUnitIds).toContain(plan.units[0]?.id);
    expect(plan.selectedWeight).toBe(2);
    expect(plan.units.find((unit) => unit.role === "integration")?.dependencies).toContain(plan.units[0]?.id);
  });

  it("records policy, shard, budget and unvalidated evidence without hiding omitted units", () => {
    const plan = planReviewWork(snapshot, { roles: ["diff", "summary"], maxReviewWorkUnits: 8 });
    const diffUnit = plan.units.find((unit) => unit.role === "diff");
    const summaryUnit = plan.units.find((unit) => unit.role === "summary");
    expect(diffUnit).toBeDefined();
    expect(summaryUnit).toBeDefined();
    if (diffUnit === undefined || summaryUnit === undefined) return;
    const updated = applyReviewWorkCoverage(plan, {
      attemptedUnitIds: [diffUnit.id],
      coveredUnitIds: [diffUnit.id],
      uncoveredRangeEvidence: [{ unitId: summaryUnit.id, reason: "summary omitted" }],
      unvalidatedCandidates: [{ id: "candidate-2", unitId: diffUnit.id, reason: "awaiting validator" }],
    });
    expect(updated.coverage.policyVersion).toBe(1);
    expect(updated.coverage.mode).toBe("single");
    expect(updated.coverage.plannedShardCount).toBe(1);
    expect(updated.coverage.coveredShardCount).toBe(1);
    expect(updated.coverage.budget).toEqual({ maxWeight: 8, reservedWeight: 2, spentWeight: 1 });
    expect(updated.coverage.attemptedUnitIds).toEqual([diffUnit.id]);
    expect(updated.coverage.attempts?.[diffUnit.id]).toBe(1);
    expect(updated.coverage.unvalidatedCandidates).toEqual([{ id: "candidate-2", unitId: diffUnit.id, reason: "awaiting validator" }]);
    expect(updated.coverage.uncoveredRangeEvidence).toContainEqual({ unitId: summaryUnit.id, reason: "summary omitted" });
    expect(updated.coverage.state).toBe("incomplete");
    expect(updated.coverage.uncoveredUnits).toContain(summaryUnit.id);
    const complete = applyReviewWorkCoverage(updated, { coveredUnitIds: [summaryUnit.id], attemptedUnitIds: [summaryUnit.id] });
    expect(complete.coverage.state).toBe("complete");
    expect(complete.coverage.budget?.spentWeight).toBe(2);
  });

  it("keeps rejected and unsupported preflight plans incomplete", () => {
    const rejected = planReviewWork(snapshot, {
      manifest: [{ role: "summary" }, { role: "contextual-bug" }],
      maxReviewWorkUnits: 1,
      workLimitPolicy: "reject",
    });
    expect(rejected.selectedUnitIds).toEqual([]);
    const first = rejected.units[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      const partial = applyReviewWorkCoverage(rejected, { coveredUnitIds: [first.id] });
      expect(partial.coverage.state).toBe("incomplete");
      expect(partial.coverage.uncoveredUnits.length).toBeGreaterThan(0);
    }
    const unsupported = planReviewWork({ snapshotHash: "unsupported", diff: [
      'diff --git "a/old name.txt" "b/new name.txt"',
      "similarity index 95%",
      "rename from old name.txt",
      "rename to new name.txt",
    ].join("\\n") });
    expect(unsupported.coverage.state).toBe("incomplete");
    expect(unsupported.coverage.uncoveredShardCount).toBe(1);
  });

  it("records attempts, covered units, uncovered ranges and candidates without mutation", () => {
    const plan = planReviewWork(snapshot, { roles: ["summary", "diff"], maxReviewWorkUnits: 8 });
    const diffUnit = plan.units.find((unit) => unit.role === "diff");
    expect(diffUnit).toBeDefined();
    if (diffUnit === undefined) return;
    const candidate = { id: "candidate-1", unitId: diffUnit.id, file: "a.ts", line: 1, reason: "not verified" };
    const shardId = diffUnit.shardIds[0];
    if (shardId === undefined) return;
    const range = { unitId: diffUnit.id, shardId, fileIdentity: "a.ts", reason: "range uncovered" };
    const updated = applyReviewWorkCoverage(plan, {
      attemptedUnitIds: [diffUnit.id],
      coveredUnitIds: [diffUnit.id],
      uncoveredRanges: [range],
      uncoveredCandidates: [candidate],
    });
    expect(updated.units.find((unit) => unit.id === diffUnit.id)?.attempts).toBe(1);
    expect(updated.coverage.coveredUnits).toContain(diffUnit.id);
    expect(updated.coverage.uncoveredCandidates).toEqual([candidate]);
    expect(plan.units.find((unit) => unit.id === diffUnit.id)?.attempts).toBe(0);
    const complete = updateReviewCoverage(updated.coverage, { coveredUnitIds: [plan.units.find((unit) => unit.role === "summary")?.id ?? ""] });
    expect(complete.state).toBe("complete");
  });
});
