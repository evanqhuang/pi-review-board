import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree, PROCESS_KILL_GRACE_PERIOD_MS } from "./process.js";
import {
  REVIEWER_RESULT_TOOLS,
  type ReviewerSafeToolName,
} from "./reviewer-protocol.js";
import type {
  AgentInvocation,
  AgentResult,
  AgentUsage,
  ReviewerFailureKind,
  ReviewerProgressEvent,
  ReviewAgentRunner,
} from "./types.js";

const MAX_REVIEWER_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_REVIEWER_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_REVIEWER_STDERR_BYTES = 8 * 1024 * 1024;
/** A protocol correction is safe only while the failed attempt remains short. */
const MAX_PROTOCOL_RETRY_BYTES = 64 * 1024;
const MAX_REVIEW_ATTEMPTS = 2;
const RETRY_SUFFIX = [
  "Protocol correction: submit exactly one final result with the required terminating tool.",
  "Do not return assistant JSON; use the required result tool even when the result is empty.",
].join(" ");

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const RESULT_TOOLS = new Set<string>(Object.values(REVIEWER_RESULT_TOOLS));
const SAFE_TOOLS = new Set<string>([...READ_ONLY_TOOLS, ...RESULT_TOOLS]);

export const reviewerOutputLimits = {
  eventBytes: MAX_REVIEWER_EVENT_BYTES,
  stdoutBytes: MAX_REVIEWER_STDOUT_BYTES,
  stderrBytes: MAX_REVIEWER_STDERR_BYTES,
  attempts: MAX_REVIEW_ATTEMPTS,
} as const;

function emptyUsage(role: string): AgentUsage {
  return { role, turns: 0, inputTokens: 0, outputTokens: 0, contextTokens: 0 };
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function reportedUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function addUsage(first: AgentUsage, second: AgentUsage): AgentUsage {
  return {
    role: first.role,
    turns: first.turns + second.turns,
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    contextTokens: Math.max(first.contextTokens, second.contextTokens),
  };
}

function updateAssistantUsage(current: AgentUsage, rawUsage: unknown): AgentUsage {
  const values = rawUsage && typeof rawUsage === "object"
    ? rawUsage as { readonly input?: unknown; readonly output?: unknown; readonly totalTokens?: unknown }
    : {};
  const contextTokens = usageNumber(values.totalTokens);
  return {
    role: current.role,
    // Turn count comes from turn_start events, not from message shape or usage.
    turns: current.turns,
    inputTokens: current.inputTokens + usageNumber(values.input),
    outputTokens: current.outputTokens + usageNumber(values.output),
    // totalTokens is the provider-reported usage for this assistant response.
    // Never derive context from cumulative input/output across turns.
    contextTokens: Math.max(current.contextTokens, contextTokens),
  };
}

function updateContextUsage(current: AgentUsage, contextTokens: number): AgentUsage {
  return { ...current, contextTokens: Math.max(current.contextTokens, contextTokens) };
}

function incrementTurn(current: AgentUsage): AgentUsage {
  return { ...current, turns: current.turns + 1 };
}

function extensionCandidates(): string[] {
  return [
    fileURLToPath(new URL("../extensions/reviewer-output.ts", import.meta.url)),
    fileURLToPath(new URL("../extensions/reviewer-output.js", import.meta.url)),
    fileURLToPath(new URL("../dist/extensions/reviewer-output.js", import.meta.url)),
  ];
}

export function resolveReviewerOutputExtension(): string {
  const path = extensionCandidates().find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Reviewer output extension is not available");
  return path;
}

function permittedTools(invocation: AgentInvocation): string[] {
  const tools = invocation.tools.filter((tool) => SAFE_TOOLS.has(tool));
  return [...new Set([...tools, invocation.resultTool])];
}

export function buildReviewAgentArgs(invocation: AgentInvocation): string[] {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "-e",
    resolveReviewerOutputExtension(),
  ];
  if (invocation.model) args.push("--model", invocation.model);
  args.push("--thinking", invocation.thinking);
  const tools = permittedTools(invocation);
  if (tools.length > 0) args.push("--tools", tools.join(","));
  return args;
}

function safeToolName(value: unknown): ReviewerSafeToolName | "other" {
  return typeof value === "string" && SAFE_TOOLS.has(value) ? value as ReviewerSafeToolName : "other";
}

function messageForFailure(kind: ReviewerFailureKind, role: string): string {
  switch (kind) {
    case "missing-result":
      return `${role} reviewer did not submit the required result`;
    case "malformed-result":
      return `${role} reviewer submitted a malformed result`;
    case "duplicate-result":
      return `${role} reviewer submitted duplicate results`;
    case "wrong-result":
      return `${role} reviewer submitted an unexpected result`;
    case "validation":
      return `${role} reviewer result failed local validation`;
    case "canceled":
      return `${role} reviewer was canceled`;
    case "output-limit":
      return `${role} reviewer output exceeded the review limit`;
    case "turn-limit":
      return `${role} reviewer exceeded its turn limit`;
    case "context-limit":
      return `${role} reviewer exceeded its context budget`;
    case "compaction":
      return `${role} reviewer triggered automatic compaction`;
    case "spawn":
      return `${role} reviewer process could not start`;
    case "transport":
      return `${role} reviewer process failed`;
    case "process":
      return `${role} reviewer process exited unsuccessfully`;
  }
}

export class ReviewerRunError extends Error {
  public readonly role: string;
  public readonly kind: ReviewerFailureKind;
  public readonly usage: AgentUsage;
  /** Only short, typed-result protocol misses may be recovered once. */
  public readonly retryableProtocol: boolean;

  public constructor(role: string, kind: ReviewerFailureKind, usage: AgentUsage, retryableProtocol = false) {
    super(messageForFailure(kind, role));
    this.name = "ReviewerRunError";
    this.role = role;
    this.kind = kind;
    this.usage = usage;
    this.retryableProtocol = retryableProtocol;
  }
}

interface AttemptResult<T> {
  readonly data: T;
  readonly usage: AgentUsage;
}

function isAssistantMessage(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (event.type !== "message_end" || !event.message || typeof event.message !== "object") return undefined;
  const message = event.message as Record<string, unknown>;
  return message.role === "assistant" ? message : undefined;
}

function resultDetails(result: unknown): { readonly hasDetails: boolean; readonly details?: unknown } {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { hasDetails: false };
  const record = result as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, "details")
    ? { hasDetails: true, details: record.details }
    : { hasDetails: false };
}

export class PiReviewAgentRunner implements ReviewAgentRunner {
  public constructor(private readonly executable = process.env.PI_CODE_REVIEW_AGENT_BIN ?? "pi") {}

  public async run<T>(
    invocation: AgentInvocation,
    validate: (value: unknown) => T,
    signal?: AbortSignal,
    onProgress?: (event: ReviewerProgressEvent) => void,
  ): Promise<AgentResult<T>> {
    let aggregateUsage = emptyUsage(invocation.role);
    for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) {
        const canceled = new ReviewerRunError(invocation.role, "canceled", aggregateUsage);
        onProgress?.({ type: "reviewer-failed", role: invocation.role, attempt, kind: canceled.kind, usage: aggregateUsage });
        throw canceled;
      }

      const prompt = attempt === 1 ? invocation.prompt : `${invocation.prompt}\n\n${RETRY_SUFFIX}`;
      onProgress?.({ type: "reviewer-start", role: invocation.role, resultTool: invocation.resultTool, attempt });
      try {
        const result = await this.runAttempt(invocation, prompt, validate, signal, attempt, onProgress);
        aggregateUsage = addUsage(aggregateUsage, result.usage);
        onProgress?.({ type: "reviewer-complete", role: invocation.role, attempt, usage: aggregateUsage });
        return { data: result.data, usage: aggregateUsage };
      } catch (error) {
        const attemptError = error instanceof ReviewerRunError
          ? error
          : new ReviewerRunError(invocation.role, "transport", emptyUsage(invocation.role));
        aggregateUsage = addUsage(aggregateUsage, attemptError.usage);
        const canRetry = attempt < MAX_REVIEW_ATTEMPTS
          && attemptError.retryableProtocol
          && (attemptError.kind === "missing-result" || attemptError.kind === "malformed-result")
          && !signal?.aborted;
        if (canRetry) {
          onProgress?.({ type: "reviewer-retry", role: invocation.role, attempt: attempt + 1, usage: aggregateUsage });
          continue;
        }
        const terminal = new ReviewerRunError(invocation.role, attemptError.kind, aggregateUsage);
        onProgress?.({ type: "reviewer-failed", role: invocation.role, attempt, kind: terminal.kind, usage: aggregateUsage });
        throw terminal;
      }
    }
    throw new ReviewerRunError(invocation.role, "transport", aggregateUsage);
  }

  private runAttempt<T>(
    invocation: AgentInvocation,
    prompt: string,
    validate: (value: unknown) => T,
    signal: AbortSignal | undefined,
    attempt: number,
    onProgress: ((event: ReviewerProgressEvent) => void) | undefined,
  ): Promise<AttemptResult<T>> {
    if (signal?.aborted) return Promise.reject(new ReviewerRunError(invocation.role, "canceled", emptyUsage(invocation.role)));

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.executable, buildReviewAgentArgs(invocation), {
          cwd: invocation.cwd,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        reject(new ReviewerRunError(invocation.role, "spawn", emptyUsage(invocation.role)));
        return;
      }

      let buffer = "";
      const stdoutDecoder = new StringDecoder("utf8");
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputLimitExceeded = false;
      let aborted = false;
      let terminationRequested = false;
      let terminalFailureKind: ReviewerFailureKind | undefined;
      let currentContextUsage = 0;
      let usage = emptyUsage(invocation.role);
      let expectedResultCount = 0;
      let expectedDetails: unknown;
      let expectedDetailsPresent = false;
      let expectedCallErrored = false;
      let duplicateResult = false;
      let wrongResult = false;
      let settled = false;
      let escalationTimer: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;

      const removeAbortListener = (): void => {
        if (abortListener && signal) signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      };
      const clearEscalationTimer = (): void => {
        if (escalationTimer) clearTimeout(escalationTimer);
        escalationTimer = undefined;
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        callback();
      };
      const terminateProcess = (): void => {
        if (terminationRequested) return;
        terminationRequested = true;
        killProcessTree(child, "SIGTERM");
        escalationTimer = setTimeout(() => {
          escalationTimer = undefined;
          killProcessTree(child, "SIGKILL");
        }, PROCESS_KILL_GRACE_PERIOD_MS);
      };
      const requestFailure = (kind: ReviewerFailureKind): void => {
        // The first bounded failure is authoritative. In particular, do not let
        // a later nonzero close code turn a useful limit diagnosis into process.
        if (terminalFailureKind || aborted) return;
        terminalFailureKind = kind;
        terminateProcess();
      };
      const emitTool = (tool: unknown, status: "started" | "updated" | "completed"): void => {
        onProgress?.({ type: "reviewer-tool", role: invocation.role, attempt, tool: safeToolName(tool), status });
      };
      const processLine = (line: string): void => {
        if (terminalFailureKind || !line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line) as unknown;
        } catch {
          return;
        }
        if (!event || typeof event !== "object") return;
        const record = event as Record<string, unknown>;
        if (record.type === "compaction_start" && (record.reason === "threshold" || record.reason === "overflow")) {
          requestFailure("compaction");
          return;
        }
        // Keep this fallback so a complete event captured immediately before
        // termination is still authoritative if compaction_start was omitted.
        if (record.type === "compaction_end" && (record.reason === "threshold" || record.reason === "overflow")) {
          requestFailure("compaction");
          return;
        }
        if (record.type === "turn_start") {
          usage = incrementTurn(usage);
          if (usage.turns > invocation.maxTurns) requestFailure("turn-limit");
          return;
        }
        if (record.type === "tool_execution_start") {
          emitTool(record.toolName, "started");
          return;
        }
        if (record.type === "tool_execution_update") {
          emitTool(record.toolName, "updated");
          return;
        }
        if (record.type === "tool_execution_end") {
          emitTool(record.toolName, "completed");
          const toolName = record.toolName;
          if (toolName === invocation.resultTool) {
            expectedResultCount += 1;
            if (expectedResultCount > 1) duplicateResult = true;
            if (record.isError === true) {
              expectedCallErrored = true;
              return;
            }
            const details = resultDetails(record.result);
            if (!details.hasDetails) return;
            expectedDetailsPresent = true;
            expectedDetails = details.details;
          } else if (typeof toolName === "string" && RESULT_TOOLS.has(toolName)) {
            wrongResult = true;
          }
          return;
        }
        if (record.type === "message_update") {
          // JSON mode puts the latest cumulative provider usage directly on
          // message_update. It is a live signal only: never add it to the
          // authoritative message_end input/output accounting.
          const rawUsage = record.usage && typeof record.usage === "object"
            ? record.usage as { readonly totalTokens?: unknown }
            : {};
          const reportedContextUsage = reportedUsageNumber(rawUsage.totalTokens);
          if (reportedContextUsage === undefined) return;
          currentContextUsage = Math.max(currentContextUsage, reportedContextUsage);
          usage = updateContextUsage(usage, reportedContextUsage);
          onProgress?.({ type: "reviewer-turn", role: invocation.role, attempt, usage });
          if (currentContextUsage > invocation.contextBudget) requestFailure("context-limit");
          return;
        }
        const message = isAssistantMessage(record);
        if (!message) return;
        usage = updateAssistantUsage(usage, message.usage);
        const rawUsage = message.usage && typeof message.usage === "object"
          ? message.usage as { readonly totalTokens?: unknown }
          : {};
        const reportedContextUsage = reportedUsageNumber(rawUsage.totalTokens);
        if (reportedContextUsage !== undefined) currentContextUsage = Math.max(currentContextUsage, reportedContextUsage);
        onProgress?.({ type: "reviewer-turn", role: invocation.role, attempt, usage });
        if (currentContextUsage > invocation.contextBudget) requestFailure("context-limit");
      };
      const consumeStdout = (text: string): void => {
        if (outputLimitExceeded) return;
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (Buffer.byteLength(line, "utf8") > MAX_REVIEWER_EVENT_BYTES) {
            outputLimitExceeded = true;
            requestFailure("output-limit");
            return;
          }
          processLine(line);
        }
        if (Buffer.byteLength(buffer, "utf8") > MAX_REVIEWER_EVENT_BYTES) {
          outputLimitExceeded = true;
          requestFailure("output-limit");
        }
      };
      const consumeStdoutChunk = (chunk: Buffer | string): void => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        stdoutBytes += bytes.byteLength;
        if (stdoutBytes > MAX_REVIEWER_STDOUT_BYTES) {
          outputLimitExceeded = true;
          requestFailure("output-limit");
          return;
        }
        consumeStdout(stdoutDecoder.write(bytes));
      };
      const consumeStderrChunk = (chunk: Buffer | string): void => {
        stderrBytes += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
        if (stderrBytes > MAX_REVIEWER_STDERR_BYTES) {
          outputLimitExceeded = true;
          requestFailure("output-limit");
        }
      };

      child.stdin?.on("error", () => requestFailure("transport"));
      child.stdout?.on("data", (chunk: Buffer | string) => consumeStdoutChunk(chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => consumeStderrChunk(chunk));
      child.on("error", () => {
        removeAbortListener();
        clearEscalationTimer();
        const kind = terminalFailureKind ?? (aborted ? "canceled" : "spawn");
        finish(() => reject(new ReviewerRunError(invocation.role, kind, usage)));
      });
      child.on("close", (code) => {
        const stdoutTail = stdoutDecoder.end();
        if (!outputLimitExceeded) consumeStdout(stdoutTail);
        removeAbortListener();
        if (aborted || terminationRequested) killProcessTree(child, "SIGKILL");
        clearEscalationTimer();
        if (!outputLimitExceeded && buffer.trim()) processLine(buffer);
        finish(() => {
          if (aborted) {
            reject(new ReviewerRunError(invocation.role, "canceled", usage));
            return;
          }
          if (terminalFailureKind) {
            reject(new ReviewerRunError(invocation.role, terminalFailureKind, usage));
            return;
          }
          if (outputLimitExceeded) {
            reject(new ReviewerRunError(invocation.role, "output-limit", usage));
            return;
          }
          if (code !== 0) {
            reject(new ReviewerRunError(invocation.role, "process", usage));
            return;
          }
          if (duplicateResult) {
            reject(new ReviewerRunError(invocation.role, "duplicate-result", usage));
            return;
          }
          if (wrongResult) {
            reject(new ReviewerRunError(invocation.role, "wrong-result", usage));
            return;
          }
          const retryableProtocol = stdoutBytes + stderrBytes <= MAX_PROTOCOL_RETRY_BYTES;
          if (expectedResultCount !== 1 || expectedCallErrored || !expectedDetailsPresent) {
            reject(new ReviewerRunError(invocation.role, "missing-result", usage, retryableProtocol));
            return;
          }
          if (!expectedDetails || typeof expectedDetails !== "object" || Array.isArray(expectedDetails)) {
            reject(new ReviewerRunError(invocation.role, "malformed-result", usage, retryableProtocol));
            return;
          }
          try {
            resolve({ data: validate(expectedDetails), usage });
          } catch {
            reject(new ReviewerRunError(invocation.role, "validation", usage));
          }
        });
      });

      const abort = (): void => {
        // Preserve a bound failure observed before cancellation as the
        // authoritative diagnosis for this attempt.
        if (aborted || terminalFailureKind) return;
        aborted = true;
        terminateProcess();
      };
      abortListener = abort;
      if (signal?.aborted) abort();
      else {
        signal?.addEventListener("abort", abort, { once: true });
        child.stdin?.end(prompt);
      }
    });
  }
}

export const reviewAgentConfiguration = {
  supportsInvocationThinking: true,
  supportsStructuredResultTools: true,
  maxProtocolRecoveryAttempts: MAX_REVIEW_ATTEMPTS,
} as const;
