import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import reviewerOutputExtension, { reviewerOutputSchemas, reviewerOutputTools, reviewerOutputToolNames, reviewerOutputProtocolVersion } from "../extensions/reviewer-output.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REVIEWER_RESULT_TOOLS } from "../src/reviewer-protocol.js";
import { REVIEWER_FINALIZATION_CONTROL_ENV } from "../src/reviewer-control.js";

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
    needsContext: false,
  }],
  coverageComplete: true,
} as const;

function extensionApiMock(): {
  readonly pi: ExtensionAPI;
  readonly registered: string[];
  readonly handlers: Map<string, unknown[]>;
  readonly activeTools: string[][];
} {
  const registered: string[] = [];
  const handlers = new Map<string, unknown[]>();
  const activeTools: string[][] = [];
  const pi = {
    registerTool(tool: { readonly name: string }) { registered.push(tool.name); },
    on(event: string, handler: unknown) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    setActiveTools(names: string[]) { activeTools.push([...names]); },
  } as unknown as ExtensionAPI;
  return { pi, registered, handlers, activeTools };
}

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

    const finderProperties = reviewerOutputSchemas.finder.properties as unknown as { readonly candidates: { readonly maxItems?: number; readonly items: { readonly additionalProperties?: unknown } }; readonly coverageComplete: unknown; readonly incompleteReason?: unknown };
    expect(finderProperties.candidates.maxItems).toBe(8);
    expect(finderProperties).toHaveProperty("coverageComplete");
    expect(finderProperties).toHaveProperty("incompleteReason");
    expect(finderProperties.candidates.items.additionalProperties).toBe(false);
    const verifierProperties = reviewerOutputSchemas.verifier.properties as unknown as Record<string, unknown>;
    expect(verifierProperties).toHaveProperty("candidateId");
    expect(verifierProperties).toHaveProperty("disposition");
    expect(verifierProperties).toHaveProperty("confidence");
    expect(verifierProperties).toHaveProperty("verification");
    expect(verifierProperties).not.toHaveProperty("verifications");
  });

  it("requires explicit finder coverage and a reason for incomplete discovery", () => {
    const complete = validFinderResult;
    expect(Value.Check(reviewerOutputSchemas.finder, complete)).toBe(true);
    // The structural schema keeps the reason optional; validateFinder applies
    // the conditional requirement for an incomplete runtime result.
    expect(Value.Check(reviewerOutputSchemas.finder, { ...complete, coverageComplete: false })).toBe(true);
    expect(Value.Check(reviewerOutputSchemas.finder, {
      ...complete,
      coverageComplete: false,
      incompleteReason: "The bounded turn ended before all assigned files were inspected",
    })).toBe(true);
    expect(Value.Check(reviewerOutputSchemas.finder, {
      ...complete,
      coverageComplete: "yes",
      incompleteReason: "unfinished",
    })).toBe(false);
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

  it("rejects the deprecated batch shape for the registered validator tool", () => {
    expect(Value.Check(reviewerOutputSchemas.verifier, { verifications: [] })).toBe(false);
    expect(Value.Check(reviewerOutputSchemas.verifier, {
      candidateId: "candidate-1",
      disposition: "PLAUSIBLE",
      confidence: 50,
      verification: "Needs a nearby-context check",
    })).toBe(true);
  });

  it("registers standalone tools without unconfigured bounded hooks", () => {
    const previous = process.env[REVIEWER_FINALIZATION_CONTROL_ENV];
    try {
      delete process.env[REVIEWER_FINALIZATION_CONTROL_ENV];
      const runtime = extensionApiMock();
      reviewerOutputExtension(runtime.pi);
      expect(runtime.registered).toEqual([
        REVIEWER_RESULT_TOOLS.summary,
        REVIEWER_RESULT_TOOLS.finder,
        REVIEWER_RESULT_TOOLS.verifier,
      ]);
      expect(runtime.handlers.size).toBe(0);
    } finally {
      if (previous === undefined) delete process.env[REVIEWER_FINALIZATION_CONTROL_ENV];
      else process.env[REVIEWER_FINALIZATION_CONTROL_ENV] = previous;
    }
  });

  it("installs the four bounded hooks only for validated invocation control", async () => {
    const previous = process.env[REVIEWER_FINALIZATION_CONTROL_ENV];
    try {
      process.env[REVIEWER_FINALIZATION_CONTROL_ENV] = JSON.stringify({
        maxTurns: 2,
        resultTool: REVIEWER_RESULT_TOOLS.finder,
      });
      const runtime = extensionApiMock();
      reviewerOutputExtension(runtime.pi);
      expect([...runtime.handlers.keys()]).toEqual(["session_start", "turn_start", "turn_end", "context"]);
      const sessionStart = runtime.handlers.get("session_start")?.[0] as (() => unknown) | undefined;
      sessionStart?.();
      expect(runtime.activeTools).toEqual([]);
      const turnStart = runtime.handlers.get("turn_start")?.[0] as (() => unknown) | undefined;
      const turnEnd = runtime.handlers.get("turn_end")?.[0] as (() => unknown) | undefined;
      await turnStart?.();
      await turnEnd?.();
      await turnStart?.();
      await turnEnd?.();
      expect(runtime.activeTools).toEqual([[REVIEWER_RESULT_TOOLS.finder]]);
    } finally {
      if (previous === undefined) delete process.env[REVIEWER_FINALIZATION_CONTROL_ENV];
      else process.env[REVIEWER_FINALIZATION_CONTROL_ENV] = previous;
    }
  });

  it("fails closed when supplied invocation control is invalid", () => {
    const previous = process.env[REVIEWER_FINALIZATION_CONTROL_ENV];
    try {
      process.env[REVIEWER_FINALIZATION_CONTROL_ENV] = JSON.stringify({ maxTurns: 0, resultTool: "not-a-review-tool" });
      const runtime = extensionApiMock();
      expect(() => reviewerOutputExtension(runtime.pi)).toThrow(/Invalid reviewer finalization control/u);
      expect(runtime.handlers.size).toBe(0);
    } finally {
      if (previous === undefined) delete process.env[REVIEWER_FINALIZATION_CONTROL_ENV];
      else process.env[REVIEWER_FINALIZATION_CONTROL_ENV] = previous;
    }
  });

  it("returns exact typed details and a terminating result without sensitive echo content", async () => {
    const result = await reviewerOutputTools[1].execute("tool-call", validFinderResult, undefined, undefined, {} as never);
    expect(result.details).toEqual(validFinderResult);
    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Review finder result submitted." }]);
    expect(JSON.stringify(result.content)).not.toContain("cache:cold-refresh-skipped");
  });
});
