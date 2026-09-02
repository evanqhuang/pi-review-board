import { describe, expect, it } from "vitest";
import type { ReviewResult } from "../src/types.js";

describe("package scaffold", () => {
  it("represents a compact complete review result", () => {
    const result: ReviewResult = {
      effort: "normal",
      status: "complete",
      summary: "One behavior change",
      findings: [],
      failures: [],
      report: "No issues found.",
      commented: false,
      usage: [],
    };

    expect(result.status).toBe("complete");
    expect(result.report).toBe("No issues found.");
  });
});
