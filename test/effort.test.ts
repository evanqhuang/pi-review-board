import { describe, expect, it } from "vitest";
import { getReviewEffortConfig, parseReviewEffort, REVIEW_EFFORTS } from "../src/effort.js";

describe("review effort levels", () => {
  it("supports every documented effort level", () => {
    expect(REVIEW_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    for (const effort of REVIEW_EFFORTS) expect(parseReviewEffort(effort)).toBe(effort);
  });

  it("maps effort to the intended depth and tolerance", () => {
    const low = getReviewEffortConfig("low");
    expect(low.finderLensNames).toEqual(["diff-correctness"]);
    expect(low.verifyCandidates).toBe(true);
    expect(low.maxFindings).toBe(8);

    const medium = getReviewEffortConfig("medium");
    expect(medium.finderLensNames).toEqual(["diff-correctness", "removed-behavior", "cross-file", "reuse", "simplification", "efficiency", "altitude", "conventions"]);
    expect(medium.maxFindings).toBe(8);
    expect(medium.retainPlausible).toBe(false);

    const high = getReviewEffortConfig("high");
    expect(high.finderLensNames).toHaveLength(8);
    expect(high.maxFindings).toBe(10);
    expect(high.retainPlausible).toBe(true);

    const xhigh = getReviewEffortConfig("xhigh");
    expect(xhigh.finderLensNames).toEqual(["diff-correctness", "removed-behavior", "cross-file", "framework-pitfalls", "delegation", "reuse", "simplification", "efficiency", "altitude", "conventions"]);
    expect(xhigh.gapSweep).toBe(true);
    expect(xhigh.fullContext).toBe(true);
    expect(xhigh.contextDepth).toBe("deep");

    expect(getReviewEffortConfig("max")).toMatchObject({ contextDepth: "exhaustive", gapSweep: true, independentVerification: false });
    expect(getReviewEffortConfig("ultra")).toMatchObject({ contextDepth: "exhaustive", gapSweep: true, independentVerification: true });
  });

  it("routes each effort level to the approved finder and verifier models", () => {
    const expected = {
      low: { finder: ["openai-codex/gpt-5.6-luna", "xhigh"], verifier: ["openai-codex/gpt-5.6-luna", "max"] },
      medium: { finder: ["openai-codex/gpt-5.6-luna", "xhigh"], verifier: ["openai-codex/gpt-5.6-sol", "medium"] },
      high: { finder: ["openai-codex/gpt-5.6-luna", "xhigh"], verifier: ["openai-codex/gpt-5.6-sol", "high"] },
      xhigh: { finder: ["openai-codex/gpt-5.6-luna", "xhigh"], verifier: ["openai-codex/gpt-5.6-sol", "xhigh"] },
      max: { finder: ["openai-codex/gpt-5.6-luna", "max"], verifier: ["openai-codex/gpt-5.6-sol", "max"] },
      ultra: { finder: ["openai-codex/gpt-5.6-luna", "max"], verifier: ["openai-codex/gpt-5.6-sol", "max"] },
    } as const;
    for (const effort of REVIEW_EFFORTS) {
      const config = getReviewEffortConfig(effort);
      expect([config.finderRoute.model, config.finderRoute.thinking], effort).toEqual(expected[effort].finder);
      expect([config.verifierRoute.model, config.verifierRoute.thinking], effort).toEqual(expected[effort].verifier);
    }
  });
});
