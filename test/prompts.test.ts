import { describe, expect, it } from "vitest";
import { buildBatchVerifierPrompt, validateBatchVerifier } from "../src/prompts.js";
import type { ReviewCandidate, ReviewSnapshot } from "../src/types.js";

const candidates: readonly ReviewCandidate[] = [
  {
    id: "diff-correctness:first:0",
    file: "src/cache.ts",
    line: 12,
    summary: "Skips cache refresh",
    failureScenario: "A cold cache returns stale data",
    evidence: "The changed branch returns before refresh",
    category: "correctness",
    severity: "high",
    finder: "diff-correctness",
  },
  {
    id: "cross-file:second:0",
    file: "src/client.ts",
    line: 24,
    summary: "Drops the error contract",
    failureScenario: "A failed request is treated as success",
    evidence: "The new adapter swallows the rejection",
    category: "contract",
    severity: "medium",
    finder: "cross-file",
  },
];

const firstCandidate = candidates[0]!;
const secondCandidate = candidates[1]!;

const snapshot: ReviewSnapshot = {
  target: { kind: "current-diff" },
  cwd: "/repo",
  changedPaths: ["src/cache.ts", "src/client.ts"],
  diff: "diff --git a/src/cache.ts b/src/cache.ts",
  snapshotHash: "hash",
};

function verdict(candidateId: string) {
  return {
    candidateId,
    confidence: 95,
    verification: "The failure is reachable from the changed branch",
    confirmed: true,
    disposition: "CONFIRMED" as const,
  };
}

describe("batch verifier contract", () => {
  it("validates one verdict for every candidate and preserves IDs", () => {
    const result = validateBatchVerifier(
      { verifications: [verdict(secondCandidate.id), verdict(firstCandidate.id)] },
      new Set(candidates.map((candidate) => candidate.id)),
    );

    expect(result.verifications.map((item) => item.candidateId)).toEqual([secondCandidate.id, firstCandidate.id]);
  });

  it("rejects duplicate, unknown, and missing candidate IDs", () => {
    const ids = new Set(candidates.map((candidate) => candidate.id));
    expect(() => validateBatchVerifier({ verifications: [verdict(firstCandidate.id), verdict(firstCandidate.id)] }, ids)).toThrow("Duplicate");
    expect(() => validateBatchVerifier({ verifications: [verdict(firstCandidate.id), verdict("unknown")] }, ids)).toThrow("Unknown");
    expect(() => validateBatchVerifier({ verifications: [verdict(firstCandidate.id)] }, ids)).toThrow("exactly one verdict");
  });

  it("includes the complete candidate batch and requires exact correlation", () => {
    const prompt = buildBatchVerifierPrompt(candidates, snapshot, [], "summary", { passLabel: "verifier" });

    expect(prompt).toContain("as one batch (verifier pass)");
    expect(prompt).toContain(firstCandidate.id);
    expect(prompt).toContain(secondCandidate.id);
    expect(prompt).toContain("exactly one verdict for every supplied candidate");
  });
});
