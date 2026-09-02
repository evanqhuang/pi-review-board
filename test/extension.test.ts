import { describe, expect, it, vi } from "vitest";
import registerCodeReviewExtension, {
  buildManagedImplementationId,
  getReviewArgumentCompletions,
  injectReviewResult,
  reviewExecutionSelection,
  validateFindingDispositionInputs,
} from "../extensions/code-review.js";
import type { ReviewResult } from "../src/types.js";

const result: ReviewResult = {
  effort: "normal",
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
    expect(rootCompletions).toContain("normal");
    expect(rootCompletions).toContain("deep");
    expect(rootCompletions).toContain("--effort normal");
    expect(rootCompletions).toContain("--effort deep");
    for (const value of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(rootCompletions).not.toContain(value);
      expect(rootCompletions).not.toContain(`--effort ${value}`);
    }
    expect(rootCompletions).toContain("--phase initial");
    expect(getReviewArgumentCompletions("--e")?.map((item) => item.value)).toContain("--effort normal");
    expect(getReviewArgumentCompletions("--e")?.map((item) => item.value)).toContain("--effort deep");
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

  it("registers the tool and clears progress state when execution fails before target resolution", async () => {
    type RegisteredReviewTool = {
      readonly name: string;
      readonly description: string;
      readonly parameters: unknown;
      readonly execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ readonly isError?: boolean }>;
    };
    type RegisteredReviewCommand = { readonly description: string };
    const registeredTools: RegisteredReviewTool[] = [];
    const registeredCommands: Array<{ readonly name: string; readonly command: RegisteredReviewCommand }> = [];
    const statuses = new Map<string, string | undefined>();
    const widgets = new Map<string, string[] | undefined>();
    const working: (string | undefined)[] = [];
    const ui = {
      notify: vi.fn(),
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      setWidget: (key: string, value: string[] | undefined) => widgets.set(key, value),
      setWorkingMessage: (value: string | undefined) => working.push(value),
      onTerminalInput: vi.fn(),
    };
    const pi = {
      on: vi.fn(),
      registerTool: (tool: RegisteredReviewTool) => registeredTools.push(tool),
      registerCommand: (name: string, command: RegisteredReviewCommand) => registeredCommands.push({ name, command }),
      registerMessageRenderer: vi.fn(),
      registerEntryRenderer: vi.fn(),
    };
    registerCodeReviewExtension(pi as never);
    const tool = registeredTools.find((entry) => entry.name === "code_review");
    expect(tool).toBeDefined();
    expect(registeredCommands.map((entry) => entry.name)).toContain("code-review");
    const commandDescription = registeredCommands.find((entry) => entry.name === "code-review")?.command.description ?? "";
    expect(commandDescription).toContain("default effort: normal");
    for (const value of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(commandDescription).not.toContain(value);
    }
    expect(tool!.description).toContain("Normal auto-routes tiny/small changes; deep adds one integration pass");
    const toolSchema = JSON.stringify(tool!.parameters);
    expect(toolSchema).toContain('"const":"normal"');
    expect(toolSchema).toContain('"const":"deep"');
    for (const value of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(toolSchema).not.toContain(`"const":"${value}"`);
    }
    const result = await tool!.execute(
      "tool-call",
      { action: "not-a-real-action" } as never,
      undefined,
      undefined,
      { cwd: "/repo", ui } as never,
    );

    expect(result.isError).toBe(true);
    expect([...statuses.values()].every((value) => value === undefined)).toBe(true);
    expect([...widgets.values()].every((value) => value === undefined)).toBe(true);
    expect(working.at(-1)).toBeUndefined();
  });
});
