import { describe, expect, it, vi } from "vitest";
import { injectReviewResult } from "../extensions/code-review.js";
import type { ReviewResult } from "../src/types.js";

const result: ReviewResult = {
  status: "complete",
  effort: "low",
  summary: "Direct changed-line pass.",
  findings: [],
  failures: [],
  commented: false,
  report: "### Code review\n\n**Target:** current diff\n\nNo issues found.",
  usage: [],
};

describe("review session context", () => {
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
});
