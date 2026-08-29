import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { reviewerOutputSchemas, reviewerOutputTools, reviewerOutputToolNames, reviewerOutputProtocolVersion } from "../extensions/reviewer-output.js";
import { REVIEWER_RESULT_TOOLS } from "../src/reviewer-protocol.js";

const validFinderResult = {
  candidates: [{
    id: "candidate-1",
    rootCauseKey: "cache:cold-refresh-skipped",
    file: "src/cache.ts",
    line: 12,
    summary: "Skips cache refresh",
    failureScenario: "A cold cache returns stale data",
    evidence: "The changed branch returns before refresh",
    category: "correctness",
    severity: "high",
  }],
} as const;

describe("private reviewer output tools", () => {
  it("registers the stable role-specific protocol with strict bounded schemas", () => {
    expect(reviewerOutputToolNames).toEqual(REVIEWER_RESULT_TOOLS);
    expect(reviewerOutputProtocolVersion).toBe(1);
    expect(reviewerOutputTools.map((tool) => tool.name)).toEqual([
      REVIEWER_RESULT_TOOLS.summary,
      REVIEWER_RESULT_TOOLS.finder,
      REVIEWER_RESULT_TOOLS.verifier,
    ]);
    for (const schema of Object.values(reviewerOutputSchemas) as readonly { readonly additionalProperties?: unknown }[]) {
      expect(schema.additionalProperties).toBe(false);
    }

    const finderProperties = reviewerOutputSchemas.finder.properties as unknown as { readonly candidates: { readonly maxItems?: number; readonly items: { readonly additionalProperties?: unknown } } };
    expect(finderProperties.candidates.maxItems).toBe(100);
    expect(finderProperties.candidates.items.additionalProperties).toBe(false);
  });

  it("rejects missing, blank, whitespace, and unknown candidate categories before execution", () => {
    const candidateSchema = (reviewerOutputSchemas.finder.properties as unknown as { readonly candidates: { readonly items: object } }).candidates.items;
    for (const category of [undefined, "", "   ", "unknown"]) {
      const candidate = category === undefined
        ? (() => {
            const { category: _category, ...withoutCategory } = validFinderResult.candidates[0];
            return withoutCategory;
          })()
        : { ...validFinderResult.candidates[0], category };
      expect(Value.Check(candidateSchema, candidate)).toBe(false);
    }
    expect(Value.Check(candidateSchema, validFinderResult.candidates[0])).toBe(true);
  });

  it("returns exact typed details and a terminating result without sensitive echo content", async () => {
    const result = await reviewerOutputTools[1].execute("tool-call", validFinderResult, undefined, undefined, {} as never);
    expect(result.details).toEqual(validFinderResult);
    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Review finder result submitted." }]);
    expect(JSON.stringify(result.content)).not.toContain("cache:cold-refresh-skipped");
  });
});
