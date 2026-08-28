import { describe, expect, it } from "vitest";
import { parseReviewArgs } from "../src/args.js";

describe("parseReviewArgs", () => {
  it("defaults to one-shot current diff review", () => {
    expect(parseReviewArgs("")).toEqual({
      action: "run",
      comment: false,
      effort: "low",
      effortProvided: false,
      phase: "auto",
      confirmReset: false,
    });
  });

  it("accepts legacy effort and target forms", () => {
    expect(parseReviewArgs("high --comment 123")).toMatchObject({ action: "run", target: "123", comment: true, effort: "high", effortProvided: true });
    expect(parseReviewArgs("--effort=ultra --comment 123")).toMatchObject({ action: "run", target: "123", comment: true, effort: "ultra" });
  });

  it("parses status, audit, reset, and managed-review identity flags", () => {
    expect(parseReviewArgs("status --plan '/tmp/plan.md'")).toMatchObject({ action: "status", planPath: "/tmp/plan.md" });
    expect(parseReviewArgs("audit 123")).toMatchObject({ action: "run", phase: "audit", effort: "low", target: "123" });
    expect(parseReviewArgs("audit --effort high 123")).toMatchObject({ action: "run", phase: "audit", effort: "high", target: "123" });
    expect(parseReviewArgs("reset --session abc --confirm")).toMatchObject({ action: "reset", sessionId: "abc", confirmReset: true });
    expect(parseReviewArgs("--phase delta --implementation impl --plan plan.md")).toMatchObject({ phase: "delta", implementationId: "impl", planPath: "plan.md" });
  });

  it("accepts an optional reviewer model override", () => {
    expect(parseReviewArgs("low --model openai-codex/gpt-5.6-luna 123")).toMatchObject({ target: "123", effort: "low", model: "openai-codex/gpt-5.6-luna" });
    expect(() => parseReviewArgs("--model")).toThrow("--model requires a value");
    expect(() => parseReviewArgs("--model one --model two")).toThrow("Model may be provided only once");
  });

  it("rejects unknown flags, phases, and multiple targets", () => {
    expect(() => parseReviewArgs("--fix")).toThrow("Unknown option");
    expect(() => parseReviewArgs("--phase endless")).toThrow("Unknown review phase");
    expect(() => parseReviewArgs("main feature")).toThrow("Ambiguous review target");
  });
});
