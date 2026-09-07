import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_INPUT_BUDGET_BYTES } from "../src/input-budget.js";
import { REVIEWER_RESULT_TOOLS } from "../src/reviewer-protocol.js";
import { reviewerControlReserveBytes } from "../src/reviewer-control.js";
import { buildReviewAgentArgs, PiReviewAgentRunner, ReviewerRunError, reviewAgentConfiguration, reviewerOutputLimits } from "../src/runner.js";
import { validateFinder } from "../src/prompts.js";
import type { AgentInvocation, ReviewerProgressEvent } from "../src/types.js";

const candidate = {
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
} as const;

function invocation(cwd: string, resultTool = REVIEWER_RESULT_TOOLS.finder): AgentInvocation {
  return {
    role: "finder:diff-correctness",
    prompt: "Inspect the supplied change and submit the result.",
    cwd,
    tools: ["read", "grep", "find", "ls"],
    resultTool,
    maxTurns: 4,
    contextBudget: 12_000,
    thinking: "high",
  };
}

function turnStart(): object {
  return { type: "turn_start" };
}

function messageEnd(input: number, output: number, context: number, text = "assistant text that must not be parsed"): object {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input, output, totalTokens: context },
    },
  };
}

function messageUpdate(input: number, output: number, context: number, delta = "partial assistant text"): object {
  return {
    type: "message_update",
    usage: { input, output, totalTokens: context },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
  };
}

function toolEnd(toolName: string, details: unknown, isError = false): object {
  const normalizedDetails = toolName === REVIEWER_RESULT_TOOLS.finder
    && details !== null
    && typeof details === "object"
    && !Array.isArray(details)
    && Object.prototype.hasOwnProperty.call(details, "candidates")
    && !Object.prototype.hasOwnProperty.call(details, "coverageComplete")
    ? { ...(details as Record<string, unknown>), coverageComplete: true }
    : details;
  return {
    type: "tool_execution_end",
    toolCallId: "tool-call-id",
    toolName,
    result: isError ? { content: [{ type: "text", text: "schema rejected sensitive details" }] } : { content: [{ type: "text", text: "generic result" }], details: normalizedDetails },
    isError,
  };
}

async function nodeScript(directory: string, body: string): Promise<string> {
  const executable = join(directory, "reviewer.js");
  await writeFile(executable, `#!/usr/bin/env node\n${body}\n`);
  await chmod(executable, 0o755);
  return executable;
}

async function emitScript(directory: string, events: readonly object[]): Promise<string> {
  return nodeScript(directory, `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`);
}

async function countScript(directory: string, first: readonly object[], second: readonly object[]): Promise<string> {
  const countPath = JSON.stringify(join(directory, "attempt-count"));
  return nodeScript(directory, `
const fs = require("node:fs");
const countPath = ${countPath};
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : "0") + 1;
fs.writeFileSync(countPath, String(count));
const events = count === 1 ? ${JSON.stringify(first)} : ${JSON.stringify(second)};
for (const event of events) console.log(JSON.stringify(event));
`);
}

describe("review agent configuration", () => {
  it("uses the private result extension and isolated, role-specific tools", () => {
    expect(reviewAgentConfiguration).toEqual({ supportsInvocationThinking: true, supportsStructuredResultTools: true, maxProtocolRecoveryAttempts: 2 });

    const args = buildReviewAgentArgs(invocation("/repo"));
    expect(args).toContain("--no-session");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-prompt-templates");
    expect(args).toContain("--no-context-files");
    const extensionIndex = args.indexOf("-e");
    expect(extensionIndex).toBeGreaterThanOrEqual(0);
    expect(args[extensionIndex + 1]).toMatch(/reviewer-output\.(ts|js)$/u);
    const toolsIndex = args.indexOf("--tools");
    expect(args[toolsIndex + 1]).toBe("read,grep,find,ls,review_finder_result");
    expect(args).not.toContain("Inspect the supplied change and submit the result.");
    expect(args).not.toContain("--max-turns");
  });
});

describe("PiReviewAgentRunner", () => {
  it("streams prompts over stdin instead of placing them in argv", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-stdin-"));
    const executable = await nodeScript(directory, `
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (prompt.length !== 1_500_000) process.exit(2);
  console.log(JSON.stringify(${JSON.stringify(turnStart())}));
  console.log(JSON.stringify(${JSON.stringify(toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] }))}));
});
`);
    try {
      const result = await new PiReviewAgentRunner(executable).run(
        { ...invocation(directory), prompt: "x".repeat(1_500_000), inputBudgetBytes: 2_000_000 },
        validateFinder,
      );
      expect(result.data).toEqual({ candidates: [], coverageComplete: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized prompt before spawn with zero usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-input-limit-"));
    const marker = join(directory, "spawned");
    const executable = await nodeScript(directory, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");`);
    try {
      const error = await new PiReviewAgentRunner(executable).run(
        { ...invocation(directory), prompt: "sensitive prompt ".repeat(DEFAULT_INPUT_BUDGET_BYTES) },
        validateFinder,
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("input-limit");
      expect((error as ReviewerRunError).usage).toEqual({ role: "finder:diff-correctness", turns: 0, inputTokens: 0, outputTokens: 0, contextTokens: 0 });
      expect((error as Error).message).not.toContain("sensitive prompt");
      await expect(readFile(marker, "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not spawn a retry when the correction suffix cannot fit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-retry-input-limit-"));
    const executable = await countScript(directory, [turnStart(), messageEnd(10, 2, 12)], [toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })]);
    try {
      const error = await new PiReviewAgentRunner(executable).run(
        { ...invocation(directory), prompt: "x".repeat(DEFAULT_INPUT_BUDGET_BYTES - 1) },
        validateFinder,
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("input-limit");
      await expect(readFile(join(directory, "attempt-count"), "utf8")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts only the expected typed result details, not misleading assistant JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-result-"));
    const executable = await emitScript(directory, [
      turnStart(),
      messageEnd(1200, 250, 1500, JSON.stringify({ candidates: [{ category: "" }] })),
      { type: "tool_execution_start", toolCallId: "tool-call-id", toolName: REVIEWER_RESULT_TOOLS.finder, args: { secret: "do not forward" } },
      { type: "tool_execution_update", toolCallId: "tool-call-id", toolName: REVIEWER_RESULT_TOOLS.finder, args: { secret: "do not forward" }, partialResult: { secret: "do not forward" } },
      toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [candidate] }),
    ]);
    try {
      const progress: ReviewerProgressEvent[] = [];
      const result = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder, undefined, (event) => progress.push(event));
      expect(result.data.candidates).toEqual([candidate]);
      expect(result.usage).toEqual({ role: "finder:diff-correctness", turns: 1, inputTokens: 1200, outputTokens: 250, contextTokens: 1500 });
      expect(progress.some((event) => event.type === "reviewer-tool" && event.tool === REVIEWER_RESULT_TOOLS.finder && event.status === "completed")).toBe(true);
      expect(JSON.stringify(progress)).not.toContain("do not forward");
      expect(JSON.stringify(progress)).not.toContain("category");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries one missing result in a fresh process and aggregates usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-retry-"));
    const executable = await countScript(directory, [turnStart(), messageEnd(10, 5, 12, JSON.stringify({ candidates: [{ category: "correctness" }] }))], [
      turnStart(),
      messageEnd(20, 6, 30),
      toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [candidate] }),
    ]);
    try {
      const progress: ReviewerProgressEvent[] = [];
      const result = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder, undefined, (event) => progress.push(event));
      expect(result.data.candidates).toHaveLength(1);
      expect(result.usage).toEqual({ role: "finder:diff-correctness", turns: 2, inputTokens: 30, outputTokens: 11, contextTokens: 30 });
      expect(progress.filter((event) => event.type === "reviewer-start")).toHaveLength(2);
      expect(progress.some((event) => event.type === "reviewer-retry" && event.attempt === 2)).toBe(true);
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("denies a retry before spawning its second process when admission is exhausted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-retry-admission-"));
    const executable = await countScript(directory, [turnStart(), messageEnd(10, 1, 11)], [turnStart(), toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })]);
    try {
      const error = await new PiReviewAgentRunner(executable).run(
        { ...invocation(directory), retryAdmission: () => false },
        validateFinder,
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("retry-budget");
      expect((error as ReviewerRunError).message).toContain("retry was denied by the retry budget");
      expect((error as ReviewerRunError).diagnostics.retryDenial).toBe("scheduler-admission-denied");
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries one short malformed typed result exactly once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-malformed-"));
    const executable = await countScript(directory, [turnStart(), toolEnd(REVIEWER_RESULT_TOOLS.finder, "not-an-object")], [turnStart(), toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [candidate] })]);
    try {
      const result = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder);
      expect(result.data.candidates).toEqual([candidate]);
      expect(result.usage.turns).toBe(2);
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not count cumulative streaming snapshots against protocol retry eligibility", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-semantic-stream-") );
    const repeatedSnapshots = Array.from({ length: 160 }, () => messageUpdate(1, 1, 2, "repeated transport snapshot ".repeat(80)));
    const executable = await countScript(directory, [turnStart(), ...repeatedSnapshots, messageEnd(1, 1, 2, "short completed content")], [turnStart(), toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })]);
    try {
      const result = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder);
      expect(result.data).toEqual({ candidates: [], coverageComplete: true });
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("counts completed reasoning and tool-call content for protocol retry eligibility", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-semantic-content-"));
    const assistant = messageEnd(1, 1, 2) as { type: string; message: Record<string, unknown> };
    assistant.message.content = [{ type: "thinking", thinking: "reasoning ".repeat(8 * 1024) }, {
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "x".repeat(8 * 1024) },
    }];
    const executable = await countScript(directory, [turnStart(), assistant], [turnStart(), toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })]);
    try {
      const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("missing-result");
      expect((error as ReviewerRunError).diagnostics.semanticBytes).toBeGreaterThan(reviewerOutputLimits.protocolRetryBytes);
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("counts malformed expected result details before deciding whether recovery is safe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-semantic-details-"));
    const executable = await countScript(directory, [turnStart(), toolEnd(REVIEWER_RESULT_TOOLS.finder, "malformed details ".repeat(8 * 1024))], [turnStart(), toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })]);
    try {
      const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("malformed-result");
      expect((error as ReviewerRunError).diagnostics.semanticBytes).toBeGreaterThan(reviewerOutputLimits.protocolRetryBytes);
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not retry a long protocol miss", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-long-miss-"));
    const executable = await countScript(directory, [turnStart(), messageEnd(1, 1, 2, "x".repeat(64 * 1024 + 1))], [turnStart(), toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [candidate] })]);
    try {
      const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("missing-result");
      expect((error as ReviewerRunError).diagnostics.semanticBytes).toBeGreaterThan(reviewerOutputLimits.protocolRetryBytes);
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a persistent protocol miss incomplete after exactly two attempts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-miss-"));
    const executable = await countScript(directory, [turnStart(), messageEnd(10, 1, 11)], [turnStart(), messageEnd(20, 2, 22)]);
    try {
      const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("missing-result");
      expect((error as ReviewerRunError).usage).toEqual({ role: "finder:diff-correctness", turns: 2, inputTokens: 30, outputTokens: 3, contextTokens: 22 });
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not retry a local semantic validation failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-validation-"));
    const executable = await countScript(directory, [turnStart(), messageEnd(10, 1, 11), toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [{ ...candidate, category: "" }] })], [turnStart(), toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [candidate] })]);
    try {
      const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("validation");
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes result-tool errors from malformed result details", async () => {
    for (const [name, event, expectedKind] of [
      ["tool-error", toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] }, true), "result-tool-error"],
      ["missing-details", { type: "tool_execution_end", toolCallId: "tool-call-id", toolName: REVIEWER_RESULT_TOOLS.finder, result: { content: [] }, isError: false }, "malformed-result"],
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), `pi-review-runner-${name}-`));
      const executable = await countScript(directory, [turnStart(), event], [event]);
      try {
        const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(ReviewerRunError);
        expect((error as ReviewerRunError).kind).toBe(expectedKind);
        expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe(name === "missing-details" ? "2" : "1");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("classifies a provider context error without leaking its message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-provider-context-"));
    const base = messageEnd(10, 2, 12) as { type: string; message: Record<string, unknown> };
    const executable = await emitScript(directory, [
      turnStart(),
      { ...base, message: { ...base.message, stopReason: "error", errorMessage: "secret context_length_exceeded transcript" } },
    ]);
    try {
      const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("context-limit");
      expect((error as Error).message).not.toContain("secret context_length_exceeded transcript");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not retry provider, length, or aborted assistant stops", async () => {
    for (const [name, stopReason, expectedKind] of [
      ["provider", "error", "provider"],
      ["length", "length", "length"],
      ["aborted", "aborted", "canceled"],
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), `pi-review-runner-stop-${name}-`));
      const assistant = { ...messageEnd(10, 2, 12), message: { ...(messageEnd(10, 2, 12) as { message: object }).message, stopReason } };
      const executable = await countScript(directory, [turnStart(), assistant], [toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })]);
      try {
        const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(ReviewerRunError);
        expect((error as ReviewerRunError).kind).toBe(expectedKind);
        expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("1");
        expect((error as Error).message).not.toContain("assistant");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("does not retry duplicate or wrong result tools", async () => {
    for (const [name, events, expectedKind] of [
      ["duplicate", [turnStart(), toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] }), toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })], "duplicate-result"],
      ["wrong", [turnStart(), toolEnd(REVIEWER_RESULT_TOOLS.summary, { summary: "wrong role" })], "wrong-result"],
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), `pi-review-runner-${name}-`));
      const executable = await countScript(directory, events, [toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })]);
      try {
        const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(ReviewerRunError);
        expect((error as ReviewerRunError).kind).toBe(expectedKind);
        expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("1");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("does not spawn a second attempt when cancellation arrives during retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-cancel-"));
    const executable = await countScript(directory, [turnStart(), messageEnd(10, 1, 11)], [turnStart(), toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })]);
    const controller = new AbortController();
    try {
      const progress: ReviewerProgressEvent[] = [];
      const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder, controller.signal, (event) => {
        progress.push(event);
        if (event.type === "reviewer-retry") controller.abort();
      }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("canceled");
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("1");
      expect(progress.some((event) => event.type === "reviewer-failed" && event.kind === "canceled")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps reviewer stderr out of failures and does not retry process errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-stderr-"));
    const executable = await nodeScript(directory, "process.stderr.write(\"sensitive reviewer transcript\"); process.exit(7);");
    try {
      const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("process");
      expect((error as Error).message).not.toContain("sensitive reviewer transcript");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not retry output-limit failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-overflow-"));
    const executable = await nodeScript(directory, `process.stdout.write("x".repeat(${reviewerOutputLimits.stdoutBytes + 1}));`);
    try {
      const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("output-limit");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("counts real turn_start events and terminates authoritatively at the turn ceiling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-turn-limit-"));
    const executable = await countScript(directory, [
      turnStart(),
      messageEnd(10, 2, 12),
      turnStart(),
      messageEnd(20, 3, 22),
    ], [toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })]);
    try {
      const progress: ReviewerProgressEvent[] = [];
      const error = await new PiReviewAgentRunner(executable).run(
        { ...invocation(directory), maxTurns: 1 },
        validateFinder,
        undefined,
        (event) => progress.push(event),
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("turn-limit");
      expect((error as ReviewerRunError).usage).toEqual({ role: "finder:diff-correctness", turns: 2, inputTokens: 10, outputTokens: 2, contextTokens: 12 });
      expect(progress.some((event) => event.type === "reviewer-failed" && event.kind === "turn-limit")).toBe(true);
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses reported assistant context usage rather than cumulative token totals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-context-"));
    const executable = await emitScript(directory, [
      turnStart(),
      messageEnd(100, 100, 150),
      turnStart(),
      messageEnd(100, 100, 150),
      toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] }),
    ]);
    try {
      const result = await new PiReviewAgentRunner(executable).run(
        { ...invocation(directory), maxTurns: 2, contextBudget: 150 },
        validateFinder,
      );
      expect(result.usage).toEqual({ role: "finder:diff-correctness", turns: 2, inputTokens: 200, outputTokens: 200, contextTokens: 150 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates without retry when reported context exceeds the role budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-context-limit-"));
    const executable = await countScript(directory, [turnStart(), messageEnd(10, 2, 21)], [toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })]);
    try {
      const error = await new PiReviewAgentRunner(executable).run(
        { ...invocation(directory), contextBudget: 20 },
        validateFinder,
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("context-limit");
      expect((error as ReviewerRunError).usage.contextTokens).toBe(21);
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates without retry when a real-shape message_update exceeds the context budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-live-context-limit-"));
    const executable = await countScript(directory, [turnStart(), messageUpdate(10, 2, 21)], [toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })]);
    try {
      const error = await new PiReviewAgentRunner(executable).run(
        { ...invocation(directory), contextBudget: 20 },
        validateFinder,
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("context-limit");
      expect((error as ReviewerRunError).usage).toEqual({ role: "finder:diff-correctness", turns: 1, inputTokens: 10, outputTokens: 2, contextTokens: 21 });
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses cumulative live usage and falls back to cache components without double counting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-usage-fallback-"));
    const executable = await emitScript(directory, [
      turnStart(),
      { type: "message_update", usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, totalTokens: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first" } },
      { type: "message_update", usage: { input: 11, output: 5, cacheRead: 4, cacheWrite: 2, totalTokens: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "second" } },
      { type: "message_end", message: { role: "assistant", usage: { input: 11, output: 5, cacheRead: 4, cacheWrite: 2, totalTokens: 0 } } },
      toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] }),
    ]);
    try {
      const progress: ReviewerProgressEvent[] = [];
      const result = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder, undefined, (event) => progress.push(event));
      expect(result.usage).toEqual({ role: "finder:diff-correctness", turns: 1, inputTokens: 11, outputTokens: 5, contextTokens: 22 });
      const liveTurns = progress.filter((event) => event.type === "reviewer-turn");
      expect(liveTurns.at(1)?.usage).toEqual({ role: "finder:diff-correctness", turns: 1, inputTokens: 11, outputTokens: 5, contextTokens: 22 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses only final message_end input/output accounting after repeated cumulative updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-live-context-accounting-"));
    const executable = await emitScript(directory, [
      turnStart(),
      messageUpdate(100, 100, 150),
      messageUpdate(100, 120, 170),
      messageEnd(100, 120, 170),
      toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] }),
    ]);
    try {
      const result = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder);
      expect(result.usage).toEqual({ role: "finder:diff-correctness", turns: 1, inputTokens: 100, outputTokens: 120, contextTokens: 170 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["threshold", "overflow"] as const)("treats automatic %s compaction as incomplete and non-retriable", async (reason) => {
    const directory = await mkdtemp(join(tmpdir(), `pi-review-runner-compaction-${reason}-`));
    const executable = await countScript(directory, [turnStart(), { type: "compaction_start", reason }], [toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] })]);
    try {
      const progress: ReviewerProgressEvent[] = [];
      const error = await new PiReviewAgentRunner(executable).run(invocation(directory), validateFinder, undefined, (event) => progress.push(event)).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("compaction");
      expect(progress.some((event) => event.type === "reviewer-failed" && event.kind === "compaction")).toBe(true);
      expect(await readFile(join(directory, "attempt-count"), "utf8")).toBe("1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a context bound authoritative over a late result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-late-result-"));
    const result = JSON.stringify(toolEnd(REVIEWER_RESULT_TOOLS.finder, { candidates: [] }));
    const executable = await nodeScript(directory, `
const first = ${JSON.stringify(JSON.stringify(turnStart()))};
const bound = ${JSON.stringify(JSON.stringify(messageUpdate(10, 2, 21)))};
console.log(first);
console.log(bound);
process.on("SIGTERM", () => setTimeout(() => { console.log(${JSON.stringify(result)}); process.exit(9); }, 20));
setInterval(() => {}, 1000);
`);
    try {
      const error = await new PiReviewAgentRunner(executable).run(
        { ...invocation(directory), contextBudget: 20 },
        validateFinder,
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("context-limit");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a bound failure authoritative over a later nonzero process close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-authority-"));
    const event = JSON.stringify(messageEnd(10, 2, 21));
    const executable = await nodeScript(directory, `console.log(${JSON.stringify(JSON.stringify(turnStart()))}); console.log(${JSON.stringify(event)}); process.exit(9);`);
    try {
      const error = await new PiReviewAgentRunner(executable).run({ ...invocation(directory), contextBudget: 20 }, validateFinder).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewerRunError);
      expect((error as ReviewerRunError).kind).toBe("context-limit");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
