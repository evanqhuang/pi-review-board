import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree, PROCESS_KILL_GRACE_PERIOD_MS } from "./process.js";
import { assertInputBudget, DEFAULT_INPUT_BUDGET_BYTES, InputLimitError } from "./input-budget.js";
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
/** Do not leave a failed reviewer alive when its close event is lost. */
const TERMINATION_DRAIN_GRACE_PERIOD_MS = 250;
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

interface UsageSnapshot {
  readonly input: number;
  readonly output: number;
  readonly context: number;
}

/** Normalize one provider usage snapshot without counting reasoning tokens. */
function usageSnapshot(rawUsage: unknown): UsageSnapshot {
  const values = rawUsage && typeof rawUsage === "object"
    ? rawUsage as {
      readonly input?: unknown;
      readonly output?: unknown;
      readonly cacheRead?: unknown;
      readonly cacheWrite?: unknown;
      readonly totalTokens?: unknown;
    }
    : {};
  const input = usageNumber(values.input);
  const output = usageNumber(values.output);
  const cacheRead = usageNumber(values.cacheRead);
  const cacheWrite = usageNumber(values.cacheWrite);
  const total = reportedUsageNumber(values.totalTokens);
  // Some providers leave totalTokens at zero or omit it altogether while
  // reporting the component counts. Cache tokens belong in context usage, but
  // not in the input/output counters exposed to review callers.
  const context = total !== undefined && total > 0
    ? total
    : input + output + cacheRead + cacheWrite;
  return { input, output, context };
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
    case "input-limit":
      return `${role} reviewer input exceeded the review limit`;
    case "result-tool-error":
      return `${role} reviewer result tool failed`;
    case "provider":
      return `${role} reviewer provider request failed`;
    case "length":
      return `${role} reviewer response reached its length limit`;
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
      try {
        assertInputBudget(prompt, invocation.inputBudgetBytes ?? DEFAULT_INPUT_BUDGET_BYTES);
      } catch (error) {
        // Prompt limits are checked before reviewer-start and, importantly,
        // before spawn. This path has no process and therefore no usage. The
        // shared error is deliberately converted to the runner's typed failure
        // so callers do not need to know the budget helper's implementation.
        if (!(error instanceof InputLimitError)) throw error;
        const limit = new ReviewerRunError(invocation.role, "input-limit", aggregateUsage);
        onProgress?.({ type: "reviewer-failed", role: invocation.role, attempt, kind: limit.kind, usage: aggregateUsage });
        throw limit;
      }
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
          // A recovery prompt is a new bounded input. Do not spawn a second
          // process when the correction suffix would exceed the same bound.
          try {
            assertInputBudget(`${invocation.prompt}\n\n${RETRY_SUFFIX}`, invocation.inputBudgetBytes ?? DEFAULT_INPUT_BUDGET_BYTES);
          } catch {
            const limit = new ReviewerRunError(invocation.role, "input-limit", aggregateUsage);
            onProgress?.({ type: "reviewer-failed", role: invocation.role, attempt, kind: limit.kind, usage: aggregateUsage });
            throw limit;
          }
          let retryAdmitted = true;
          if (invocation.retryAdmission !== undefined) {
            try {
              retryAdmitted = await invocation.retryAdmission();
            } catch {
              retryAdmitted = false;
            }
          }
          if (!retryAdmitted) {
            const kind = signal?.aborted ? "canceled" : "input-limit";
            const denied = new ReviewerRunError(invocation.role, kind, aggregateUsage);
            onProgress?.({ type: "reviewer-failed", role: invocation.role, attempt, kind: denied.kind, usage: aggregateUsage });
            throw denied;
          }
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
      let terminationRequested = false;
      let terminalFailureKind: ReviewerFailureKind | undefined;
      let usage = emptyUsage(invocation.role);
      let authoritativeInput = 0;
      let authoritativeOutput = 0;
      let authoritativeContext = 0;
      let liveUsage: UsageSnapshot | undefined;
      let currentContextUsage = 0;
      let expectedResultCount = 0;
      let expectedDetails: unknown;
      let expectedDetailsPresent = false;
      let settled = false;
      let cleanedUp = false;
      let escalationTimer: NodeJS.Timeout | undefined;
      let drainTimer: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;

      const removeAbortListener = (): void => {
        if (abortListener && signal) signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      };
      const clearTimers = (): void => {
        if (escalationTimer) clearTimeout(escalationTimer);
        if (drainTimer) clearTimeout(drainTimer);
        escalationTimer = undefined;
        drainTimer = undefined;
      };
      const report = (event: ReviewerProgressEvent): void => {
        try {
          onProgress?.(event);
        } catch {
          // A progress consumer must not strand a reviewer process.
          if (!terminalFailureKind) {
            terminalFailureKind = "transport";
            terminateProcess();
          }
        }
      };
      const refreshUsage = (): void => {
        usage = {
          ...usage,
          inputTokens: authoritativeInput + (liveUsage?.input ?? 0),
          outputTokens: authoritativeOutput + (liveUsage?.output ?? 0),
          contextTokens: Math.max(authoritativeContext, liveUsage?.context ?? 0),
        };
      };
      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        removeAbortListener();
        clearTimers();
        child.stdin?.removeListener("error", onStdinError);
        child.stdout?.removeListener("data", onStdoutData);
        child.stdout?.removeListener("error", onStdoutError);
        child.stderr?.removeListener("data", onStderrData);
        child.stderr?.removeListener("error", onStderrError);
        child.removeListener("error", onChildError);
        child.removeListener("close", onClose);
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const failureError = (kind: ReviewerFailureKind): ReviewerRunError => {
        const retryableProtocol = (kind === "missing-result" || kind === "malformed-result")
          && stdoutBytes + stderrBytes <= MAX_PROTOCOL_RETRY_BYTES;
        return new ReviewerRunError(invocation.role, kind, usage, retryableProtocol);
      };
      const forceTerminate = (): void => {
        try {
          killProcessTree(child, "SIGKILL");
        } catch {
          // The close/error handlers below still provide a bounded result.
        }
      };
      const terminateProcess = (): void => {
        if (terminationRequested || settled) return;
        terminationRequested = true;
        // Arm the bounded cleanup before signalling: a mocked or already-dead
        // child may synchronously emit close/error from killProcessTree.
        escalationTimer = setTimeout(() => {
          escalationTimer = undefined;
          forceTerminate();
        }, PROCESS_KILL_GRACE_PERIOD_MS);
        drainTimer = setTimeout(() => {
          drainTimer = undefined;
          forceTerminate();
          const kind = terminalFailureKind ?? "transport";
          finish(() => reject(failureError(kind)));
        }, TERMINATION_DRAIN_GRACE_PERIOD_MS);
        try {
          killProcessTree(child, "SIGTERM");
        } catch {
          forceTerminate();
        }
      };
      const requestFailure = (kind: ReviewerFailureKind): void => {
        // The first terminal cause is authoritative. In particular, a bound or
        // provider failure must not be replaced by cancellation, close, or a
        // result that was already in flight when termination began.
        if (terminalFailureKind || settled) return;
        terminalFailureKind = kind;
        terminateProcess();
      };
      const emitTool = (tool: unknown, status: "started" | "updated" | "completed"): void => {
        report({ type: "reviewer-tool", role: invocation.role, attempt, tool: safeToolName(tool), status });
      };
      const contextError = (message: Record<string, unknown>): boolean => {
        const errorMessage = message.errorMessage;
        if (typeof errorMessage !== "string") return false;
        // Only inspect a small, generic provider vocabulary. The original
        // provider text is never copied into a failure or progress event.
        return /context(?:[_ -]?length| window)|maximum context|prompt too long|input too long|too many tokens|context_length_exceeded|exceed(?:ed|s)?[^\n]{0,80}(?:context|token)/iu.test(errorMessage);
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
          const toolName = record.toolName;
          if (toolName === invocation.resultTool) {
            expectedResultCount += 1;
            if (expectedResultCount > 1) {
              requestFailure("duplicate-result");
            } else if (record.isError === true) {
              requestFailure("result-tool-error");
            } else {
              const details = resultDetails(record.result);
              if (!details.hasDetails) {
                requestFailure("malformed-result");
              } else {
                expectedDetailsPresent = true;
                expectedDetails = details.details;
                if (!expectedDetails || typeof expectedDetails !== "object" || Array.isArray(expectedDetails)) {
                  requestFailure("malformed-result");
                }
              }
            }
          } else if (typeof toolName === "string" && RESULT_TOOLS.has(toolName)) {
            requestFailure("wrong-result");
          }
          // Record-level failures are selected before a progress callback gets
          // an opportunity to cancel the attempt, while tool names remain safe
          // and useful for ordinary progress reporting.
          emitTool(toolName, "completed");
          return;
        }
        if (record.type === "message_update") {
          // JSON mode supplies the latest cumulative snapshot at the top level.
          // Keep only this message's latest live snapshot; message_end below is
          // authoritative and replaces it rather than adding it again.
          if (!record.usage || typeof record.usage !== "object") return;
          liveUsage = usageSnapshot(record.usage);
          currentContextUsage = Math.max(currentContextUsage, liveUsage.context);
          refreshUsage();
          if (currentContextUsage > invocation.contextBudget) requestFailure("context-limit");
          report({ type: "reviewer-turn", role: invocation.role, attempt, usage });
          return;
        }
        const message = isAssistantMessage(record);
        if (!message) return;
        const snapshot = usageSnapshot(message.usage);
        authoritativeInput += snapshot.input;
        authoritativeOutput += snapshot.output;
        authoritativeContext = Math.max(authoritativeContext, snapshot.context);
        liveUsage = undefined;
        currentContextUsage = Math.max(currentContextUsage, snapshot.context);
        refreshUsage();
        const stopReason = message.stopReason;
        if (stopReason === "aborted") {
          requestFailure("canceled");
        } else if (stopReason === "length") {
          requestFailure("length");
        } else if (stopReason === "error" || typeof message.errorMessage === "string") {
          requestFailure(contextError(message) ? "context-limit" : "provider");
        } else if (currentContextUsage > invocation.contextBudget) {
          requestFailure("context-limit");
        }
        report({ type: "reviewer-turn", role: invocation.role, attempt, usage });
      };
      const consumeStdout = (text: string): void => {
        if (outputLimitExceeded || terminalFailureKind || !text) return;
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
          if (terminalFailureKind) return;
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
      const onStdinError = (): void => requestFailure("transport");
      const onStdoutData = (chunk: Buffer | string): void => {
        try {
          consumeStdoutChunk(chunk);
        } catch {
          requestFailure("transport");
        }
      };
      const onStderrData = (chunk: Buffer | string): void => {
        try {
          consumeStderrChunk(chunk);
        } catch {
          requestFailure("transport");
        }
      };
      const onStdoutError = (): void => requestFailure("transport");
      const onStderrError = (): void => requestFailure("transport");
      const onChildError = (): void => requestFailure("spawn");
      const onClose = (code: number | null): void => {
        if (settled) return;
        try {
          const stdoutTail = stdoutDecoder.end();
          if (!outputLimitExceeded && !terminalFailureKind) consumeStdout(stdoutTail);
          if (!outputLimitExceeded && !terminalFailureKind && buffer.trim()) processLine(buffer);
        } catch {
          requestFailure("transport");
        }
        if (terminalFailureKind) {
          const kind = terminalFailureKind;
          finish(() => reject(failureError(kind)));
          return;
        }
        if (outputLimitExceeded) {
          finish(() => reject(new ReviewerRunError(invocation.role, "output-limit", usage)));
          return;
        }
        if (code !== 0) {
          finish(() => reject(new ReviewerRunError(invocation.role, "process", usage)));
          return;
        }
        const retryableProtocol = stdoutBytes + stderrBytes <= MAX_PROTOCOL_RETRY_BYTES;
        if (expectedResultCount !== 1) {
          finish(() => reject(new ReviewerRunError(invocation.role, "missing-result", usage, retryableProtocol)));
          return;
        }
        if (!expectedDetailsPresent) {
          finish(() => reject(new ReviewerRunError(invocation.role, "malformed-result", usage, retryableProtocol)));
          return;
        }
        try {
          const data = validate(expectedDetails);
          if (terminalFailureKind) {
            const kind = terminalFailureKind;
            finish(() => reject(failureError(kind)));
          } else {
            finish(() => resolve({ data, usage }));
          }
        } catch {
          finish(() => reject(new ReviewerRunError(invocation.role, "validation", usage)));
        }
      };

      child.stdin?.on("error", onStdinError);
      child.stdout?.on("data", onStdoutData);
      child.stdout?.on("error", onStdoutError);
      child.stderr?.on("data", onStderrData);
      child.stderr?.on("error", onStderrError);
      child.on("error", onChildError);
      child.on("close", onClose);
      try {
        // The scheduler uses this narrow hook to charge only attempts whose
        // subprocess was actually created; legacy callers simply omit it.
        invocation.onAttemptStart?.(attempt);
      } catch {
        requestFailure("transport");
      }

      const abort = (): void => requestFailure("canceled");
      abortListener = abort;
      if (signal?.aborted) abort();
      else {
        signal?.addEventListener("abort", abort, { once: true });
        try {
          child.stdin?.end(prompt);
        } catch {
          requestFailure("transport");
        }
      }
    });
  }
}

export const reviewAgentConfiguration = {
  supportsInvocationThinking: true,
  supportsStructuredResultTools: true,
  maxProtocolRecoveryAttempts: MAX_REVIEW_ATTEMPTS,
} as const;
