import { describe, expect, it } from "vitest";
import {
  buildContextualBugPrompt,
  buildDiffOnlyBugPrompt,
  buildGuidancePrompt,
  buildIntegrationPrompt,
  buildSummaryPrompt,
  buildValidatorPrompt,
  validateFinder,
  validateVerifier,
} from "../src/prompts.js";
import { InputLimitError } from "../src/input-budget.js";
import type { ReviewCandidate, ReviewSnapshot } from "../src/types.js";

const candidates: readonly ReviewCandidate[] = [
  {
    id: "diff-correctness:cache:cold-refresh-skipped:0",
    rootCauseKey: "cache:cold-refresh-skipped",
    file: "src/cache.ts",
    line: 12,
    summary: "Skips cache refresh",
    failureScenario: "A cold cache returns stale data",
    evidence: "The changed branch returns before refresh",
    category: "correctness",
    severity: "high",
    needsContext: false,
    finder: "diff-correctness",
  },
  {
    id: "cross-file:client:error-contract-dropped:0",
    rootCauseKey: "client:error-contract-dropped",
    file: "src/client.ts",
    line: 24,
    summary: "Drops the error contract",
    failureScenario: "A failed request is treated as success",
    evidence: "The new adapter swallows the rejection",
    category: "contract",
    severity: "medium",
    needsContext: true,
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

describe("bounded role prompt and result contracts", () => {
  it("requires a semantic root-cause key, changed line, suspicion, and context flag", () => {
    expect(() => validateFinder({ candidates: [{
      id: "candidate-1",
      file: "src/cache.ts",
      line: 12,
      summary: "Skips cache refresh",
      failureScenario: "A cold cache returns stale data",
      evidence: "The changed branch returns before refresh",
      category: "correctness",
      severity: "high",
      needsContext: false,
    }] })).toThrow("rootCauseKey");
    expect(() => validateFinder({ candidates: [{
      id: "candidate-1",
      rootCauseKey: "cache:cold-refresh-skipped",
      file: "src/cache.ts",
      line: 12,
      summary: "Skips cache refresh",
      failureScenario: "A cold cache returns stale data",
      evidence: "The changed branch returns before refresh",
      category: "correctness",
      severity: "low",
      needsContext: false,
    }] })).toThrow("severity");
    expect(validateFinder({ candidates: [{
      id: "candidate-1",
      rootCauseKey: "cache:cold-refresh-skipped",
      file: "src/cache.ts",
      line: 12,
      summary: "Skips cache refresh",
      failureScenario: "A cold cache returns stale data",
      evidence: "The changed branch returns before refresh",
      category: "correctness",
      severity: "high",
      needsContext: true,
    }] }).candidates[0]?.needsContext).toBe(true);
  });

  it("uses one-candidate validation instead of a batch contract", () => {
    expect(validateVerifier({
      candidateId: firstCandidate.id,
      confidence: 95,
      verification: "The failure is reachable from the changed branch",
      disposition: "CONFIRMED",
    })).toEqual({
      candidateId: firstCandidate.id,
      confidence: 95,
      verification: "The failure is reachable from the changed branch",
      disposition: "CONFIRMED",
    });
    expect(() => validateVerifier({
      candidateId: secondCandidate.id,
      confidence: 95,
      verification: "wrong candidate",
      disposition: "CONFIRMED",
    }, firstCandidate.id)).toThrow("candidateId");
  });

  it("bounds every role and gives each role only its required payload", () => {
    const summaryPrompt = buildSummaryPrompt({
      ...snapshot,
      pullRequest: { title: "Cache refresh", body: "Keep cold reads fresh", number: 1, state: "OPEN", isDraft: false, authorLogin: "a", url: "", baseSha: "", headSha: "", repository: "acme/repo", changedPaths: snapshot.changedPaths, comments: [], reviewerIdentityAvailable: true },
    }, []);
    expect(summaryPrompt).toContain("\"title\":\"Cache refresh\"");
    expect(summaryPrompt).toContain("\"paths\":[\"src/cache.ts\",\"src/client.ts\"]");
    expect(summaryPrompt).toContain("Tools already work");
    expect(summaryPrompt).toContain("exactly one terminating result tool");

    const guidancePrompt = buildGuidancePrompt(snapshot, [
      { path: "src/cache.ts", guidance: [{ path: "/repo/AGENTS.md", content: "Avoid stale cache state." }] },
      { path: "src/client.ts", guidance: [{ path: "/repo/AGENTS.md", content: "Avoid stale cache state." }] },
    ], "summary");
    expect(guidancePrompt).toContain("Avoid stale cache state.");
    expect(guidancePrompt).toContain("changedCode");
    expect(guidancePrompt).toContain("summary");

    const diffPrompt = buildDiffOnlyBugPrompt(snapshot);
    expect(diffPrompt).toContain("Reason from the diff alone");
    expect(diffPrompt).toContain("Do not assume unseen context");
    expect(diffPrompt).toContain("title");
    expect(diffPrompt).toContain("body");

    for (const prompt of [buildContextualBugPrompt(snapshot), buildIntegrationPrompt(snapshot)]) {
      expect(prompt).toContain("changedPaths");
      expect(prompt).toContain("followUpConstraints");
      expect(prompt).toContain("nearest");
    }
  });

  it("scopes nested guidance to its covered changed file while repeating root guidance", () => {
    const guidancePrompt = buildGuidancePrompt(snapshot, [
      {
        path: "src/cache.ts",
        guidance: [
          { path: "/repo/AGENTS.md", content: "root rule" },
          { path: "/repo/src/AGENTS.md", content: "cache-only rule" },
        ],
      },
      {
        path: "src/client.ts",
        guidance: [
          { path: "/repo/AGENTS.md", content: "root rule" },
          { path: "/repo/src/client/AGENTS.md", content: "client-only rule" },
        ],
      },
    ]);
    const payload = JSON.parse(guidancePrompt.split("<review-input>\n")[1]!.split("\n</review-input>")[0]!) as {
      guidance: {
        files: readonly { path: string; content: string }[];
        pathToFiles: readonly { path: string; files: readonly string[] }[];
      };
    };
    expect(payload.guidance.files).toEqual([
      { path: "AGENTS.md", content: "root rule" },
      { path: "src/AGENTS.md", content: "cache-only rule" },
      { path: "src/client/AGENTS.md", content: "client-only rule" },
    ]);
    expect(payload.guidance.pathToFiles).toEqual([
      { path: "src/cache.ts", files: ["AGENTS.md", "src/AGENTS.md"] },
      { path: "src/client.ts", files: ["AGENTS.md", "src/client/AGENTS.md"] },
    ]);
    expect(payload.guidance.pathToFiles[0]?.files).not.toContain("src/client/AGENTS.md");
    expect(payload.guidance.pathToFiles[1]?.files).not.toContain("src/AGENTS.md");
  });

  it("gives the validator one candidate, hunk, nearby context, and optional guidance", () => {
    const validatorPrompt = buildValidatorPrompt(firstCandidate, {
      ...snapshot,
      diff: [
        "diff --git a/src/cache.ts b/src/cache.ts",
        "--- a/src/cache.ts",
        "+++ b/src/cache.ts",
        "@@ -11,2 +11,3 @@",
        " context",
        "+changed cache branch",
        " context",
      ].join("\n"),
    }, [], "");
    expect(validatorPrompt).toContain(firstCandidate.id);
    expect(validatorPrompt).toContain("exactChangedHunk");
    expect(validatorPrompt).toContain("+changed cache branch");
    expect(validatorPrompt).toContain("nearbyContext");
    expect(validatorPrompt).not.toContain(secondCandidate.id);
    expect(validatorPrompt).not.toContain("optional summary supplied by another reviewer");
  });

  it("bounds UTF-8 prompts by omitting metadata before changed content", () => {
    const metadataSnapshot: ReviewSnapshot = {
      ...snapshot,
      pullRequest: {
        title: "title-😀".repeat(5000),
        body: "body-é".repeat(5000),
        number: 1,
        state: "OPEN",
        isDraft: false,
        authorLogin: "a",
        url: "",
        baseSha: "",
        headSha: "",
        repository: "acme/repo",
        changedPaths: snapshot.changedPaths,
        comments: [],
        reviewerIdentityAvailable: true,
      },
    };
    const prompt = buildSummaryPrompt({
      ...metadataSnapshot,
      diff: [
        "diff --git a/src/cache.ts b/src/cache.ts",
        "--- a/src/cache.ts",
        "+++ b/src/cache.ts",
        "@@ -11,1 +11,1 @@",
        "+changed cache branch",
      ].join("\n"),
    }, [], 8_000);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(8_000);
    expect(prompt).toContain("omitted optional pull-request metadata");
    expect(prompt).toContain("+changed cache branch");
  });

  it("compacts unchanged context with hunk locations but never drops changes", () => {
    const manyHunks = [
      "diff --git a/src/cache.ts b/src/cache.ts",
      "--- a/src/cache.ts",
      "+++ b/src/cache.ts",
      ...Array.from({ length: 40 }, (_, index) => [
        `@@ -${index * 100 + 1},80 +${index * 100 + 1},80 @@`,
        ...Array.from({ length: 70 }, () => " unchanged context"),
        `+changed-${index}-😀`,
        " unchanged context",
      ].join("\n")),
    ].join("\n");
    const prompt = buildDiffOnlyBugPrompt({ ...snapshot, diff: manyHunks }, [], "", 8_000);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(8_000);
    expect(prompt).toContain("omitted unchanged context: old=");
    for (let index = 0; index < 40; index += 1) expect(prompt).toContain(`+changed-${index}-😀`);
  });

  it("fails closed when one changed line cannot fit", () => {
    const hugeLine = `+${"x".repeat(20_000)}`;
    expect(() => buildDiffOnlyBugPrompt({ ...snapshot, diff: [
      "diff --git a/src/cache.ts b/src/cache.ts",
      "--- a/src/cache.ts",
      "+++ b/src/cache.ts",
      "@@ -11,1 +11,1 @@",
      hugeLine,
    ].join("\n") }, [], "", 4_000)).toThrow(InputLimitError);
  });

  it("isolates validator input to the candidate hunk and bounds optional source", () => {
    const diff = [
      "diff --git a/src/cache.ts b/src/cache.ts",
      "--- a/src/cache.ts",
      "+++ b/src/cache.ts",
      "@@ -12,1 +12,1 @@",
      "+first candidate",
      "@@ -80,1 +80,1 @@",
      "+other candidate hunk",
    ].join("\n");
    const prompt = buildValidatorPrompt(firstCandidate, { ...snapshot, diff }, [], "summary", {
      source: "source-😀".repeat(10_000),
      inputBudgetBytes: 8_000,
    });
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(8_000);
    expect(prompt).toContain("+first candidate");
    expect(prompt).not.toContain("+other candidate hunk");
    expect(prompt).toContain("omitted optional nearby source");
  });
});
