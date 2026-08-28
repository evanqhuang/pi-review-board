import { describe, expect, it, vi } from "vitest";
import {
  buildManagedImplementationId,
  getReviewArgumentCompletions,
  injectReviewResult,
  reviewExecutionSelection,
  validateFindingDispositionInputs,
} from "../extensions/code-review.js";
import type { ReviewResult } from "../src/types.js";

const result: ReviewResult = {
  effort: "medium",
  status: "complete",
  summary: "No issues found.",
  findings: [],
  failures: [],
  commented: false,
  report: "### Code review\n\nNo issues found.",
  usage: [],
};

describe("review extension helpers", () => {
  it("offers the managed loop prominently while preserving advanced phase completions", () => {
    const rootCompletions = getReviewArgumentCompletions("")?.map((item) => item.value);
    expect(rootCompletions?.[0]).toBe("loop");
    expect(rootCompletions).toContain("--effort low");
    expect(rootCompletions).toContain("--phase initial");
    expect(getReviewArgumentCompletions("--e")?.map((item) => item.value)).toContain("--effort low");
    expect(getReviewArgumentCompletions("status --s")?.map((item) => item.value)).toContain("status --session ");
    expect(getReviewArgumentCompletions("unknown")).toBeNull();
  });

  it("selects managed auto progression for loop without changing one-shot reviews", () => {
    expect(reviewExecutionSelection({ action: "run", phase: "auto" })).toEqual({ managed: false, requestedPhase: "auto" });
    expect(reviewExecutionSelection({ action: "loop", phase: "auto" })).toEqual({ managed: true, requestedPhase: "auto" });
    expect(reviewExecutionSelection({ action: "loop", phase: "delta" })).toEqual({ managed: true, requestedPhase: "delta" });
    expect(reviewExecutionSelection({ action: "run", phase: "initial" })).toEqual({ managed: true, requestedPhase: "initial" });
    expect(reviewExecutionSelection({ action: "run", phase: "auto", sessionId: "session-1" })).toEqual({ managed: true, requestedPhase: "auto" });
  });

  it("injects the complete rendered report as a model-visible custom message", () => {
    const sendMessage = vi.fn();
    injectReviewResult({ sendMessage }, result);
    expect(sendMessage).toHaveBeenCalledWith({
      customType: "code-review-result",
      content: result.report,
      display: true,
      details: result,
    });
  });

  it("binds an explicit managed review identity to checkout, branch, and plan path", () => {
    const first = buildManagedImplementationId("/repo", "feature", "/plans/feature.md");
    expect(buildManagedImplementationId("/repo", "feature", "/plans/feature.md")).toBe(first);
    expect(buildManagedImplementationId("/repo", "other", "/plans/feature.md")).not.toBe(first);
    expect(buildManagedImplementationId("/repo", "feature", "/plans/other.md")).not.toBe(first);
  });

  it("rejects unknown finding dispositions", () => {
    expect(() => validateFindingDispositionInputs([{
      id: "REV-001",
      disposition: "dismissed" as never,
    }])).toThrow("Unknown finding disposition");
  });
});
