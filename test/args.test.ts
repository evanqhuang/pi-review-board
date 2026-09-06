import { describe, expect, it } from "vitest";
import { parseReviewArgs } from "../src/args.js";

describe("parseReviewArgs", () => {
  it("defaults to one-shot current diff review", () => {
    expect(parseReviewArgs("")).toEqual({
      action: "run",
      comment: false,
      effort: "normal",
      effortProvided: false,
      phase: "auto",
      confirmReset: false,
    });
  });

  it("accepts normal and deep effort forms without changing target/comment parsing", () => {
    expect(parseReviewArgs("normal --comment 123")).toMatchObject({ action: "run", target: "123", comment: true, effort: "normal", effortProvided: true });
    expect(parseReviewArgs("--effort=deep --comment 123")).toMatchObject({ action: "run", target: "123", comment: true, effort: "deep", effortProvided: true });
  });

  it("rejects retired effort values with a clear error", () => {
    for (const value of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(() => parseReviewArgs(value)).toThrow(`Unknown effort level: ${value}. Expected normal or deep.`);
      expect(() => parseReviewArgs(`--effort=${value}`)).toThrow(`Unknown effort level: ${value}. Expected normal or deep.`);
    }
  });

  it("keeps ordinary reviews one-shot and parses managed loop arguments", () => {
    expect(parseReviewArgs("main")).toMatchObject({ action: "run", target: "main", phase: "auto" });
    expect(parseReviewArgs("loop main")).toMatchObject({ action: "loop", target: "main", phase: "auto" });
    expect(parseReviewArgs("loop --phase delta --implementation impl --plan plan.md")).toMatchObject({
      action: "loop",
      phase: "delta",
      implementationId: "impl",
      planPath: "plan.md",
    });
  });

  it("parses status, reset, and advanced managed-review identity flags", () => {
    expect(parseReviewArgs("status --plan '/tmp/plan.md'")).toMatchObject({ action: "status", planPath: "/tmp/plan.md" });
    expect(parseReviewArgs("reset --session abc --confirm")).toMatchObject({ action: "reset", sessionId: "abc", confirmReset: true });
    expect(parseReviewArgs("--phase delta --implementation impl --plan plan.md")).toMatchObject({ phase: "delta", implementationId: "impl", planPath: "plan.md" });
  });

  it("accepts an optional reviewer model override", () => {
    expect(parseReviewArgs("normal --model openai-codex/gpt-5.6-luna 123")).toMatchObject({ target: "123", effort: "normal", model: "openai-codex/gpt-5.6-luna" });
    expect(() => parseReviewArgs("--model")).toThrow("--model requires a value");
    expect(() => parseReviewArgs("--model one --model two")).toThrow("Model may be provided only once");
  });

  it("parses bounded sharding policies in both separated and equals forms", () => {
    expect(parseReviewArgs("--max-work-units 7 --work-limit-policy partial")).toMatchObject({
      maxReviewWorkUnits: 7,
      workLimitPolicy: "partial",
    });
    expect(parseReviewArgs("--max-work-units=8 --work-limit-policy=reject")).toMatchObject({
      maxReviewWorkUnits: 8,
      workLimitPolicy: "reject",
    });
    expect(() => parseReviewArgs("--max-work-units 4 --max-work-units=5")).toThrow("--max-work-units may be provided only once");
    expect(() => parseReviewArgs("--work-limit-policy reject --work-limit-policy=partial")).toThrow("--work-limit-policy may be provided only once");
  });

  it("rejects invalid sharding policy values and work-unit limits clearly", () => {
    for (const value of ["0", "129", "1.5", "not-a-number", "1e309"]) {
      expect(() => parseReviewArgs(`--max-work-units=${value}`)).toThrow("--max-work-units");
    }
    expect(() => parseReviewArgs("--work-limit-policy maybe")).toThrow("--work-limit-policy must be reject or partial");
    expect(() => parseReviewArgs("--max-work-units")).toThrow("--max-work-units requires a value");
    expect(() => parseReviewArgs("--work-limit-policy")).toThrow("--work-limit-policy requires a value");
  });

  it("rejects unknown flags, phases, and multiple targets", () => {
    expect(() => parseReviewArgs("--fix")).toThrow("Unknown option");
    expect(() => parseReviewArgs("--phase endless")).toThrow("Unknown review phase");
    expect(() => parseReviewArgs("--phase audit")).toThrow("Unknown review phase");
    expect(() => parseReviewArgs("main feature")).toThrow("Ambiguous review target");
  });
});
