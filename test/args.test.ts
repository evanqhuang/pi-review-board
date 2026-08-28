import { describe, expect, it } from "vitest";
import { parseReviewArgs } from "../src/args.js";

describe("parseReviewArgs", () => {
  it("defaults to the current diff, medium effort, without publishing", () => {
    expect(parseReviewArgs("")).toEqual({ comment: false, effort: "medium" });
  });

  it("accepts positional and named effort levels", () => {
    expect(parseReviewArgs("high --comment 123")).toEqual({ target: "123", comment: true, effort: "high" });
    expect(parseReviewArgs("--effort=ultra --comment 123")).toEqual({ target: "123", comment: true, effort: "ultra" });
    expect(parseReviewArgs("--effort max")).toEqual({ comment: false, effort: "max" });
  });

  it("accepts an optional reviewer model override", () => {
    expect(parseReviewArgs("low --model openai-codex/gpt-5.6-luna 123")).toEqual({ target: "123", comment: false, effort: "low", model: "openai-codex/gpt-5.6-luna" });
    expect(parseReviewArgs("--model=qwen38-main/qwen3.8-27b")).toEqual({ comment: false, effort: "medium", model: "qwen38-main/qwen3.8-27b" });
    expect(() => parseReviewArgs("--model")).toThrow("--model requires a provider/id");
    expect(() => parseReviewArgs("--model one --model two")).toThrow("Model may be provided only once");
  });

  it("rejects unknown effort levels and duplicate effort options", () => {
    expect(parseReviewArgs("extreme")).toEqual({ target: "extreme", comment: false, effort: "medium" });
    expect(() => parseReviewArgs("--effort extreme")).toThrow("Unknown effort level");
    expect(() => parseReviewArgs("--effort=")).toThrow("Unknown effort level");
    expect(() => parseReviewArgs("high --effort low")).toThrow("Effort level may be provided only once");
  });

  it("preserves quoted paths with spaces and Windows separators", () => {
    expect(parseReviewArgs("'path with spaces.ts'")).toEqual({ target: "path with spaces.ts", comment: false, effort: "medium" });
    expect(parseReviewArgs("src\\feature\\file.ts")).toEqual({ target: "src\\feature\\file.ts", comment: false, effort: "medium" });
    expect(() => parseReviewArgs("'unterminated")).toThrow("Unclosed quote");
  });

  it("rejects unknown flags and multiple targets", () => {
    expect(() => parseReviewArgs("--fix")).toThrow("Unknown option");
    expect(() => parseReviewArgs("main feature")).toThrow("Ambiguous review target");
  });
});
