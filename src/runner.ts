import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree, PROCESS_KILL_GRACE_PERIOD_MS } from "./process.js";
import { assertInputBudget, DEFAULT_INPUT_BUDGET_BYTES, InputLimitError } from "./input-budget.js";
import { reviewerControlReserveBytes, REVIEWER_FINALIZATION_CONTROL_ENV } from "./reviewer-control.js";
import {
  REVIEWER_RESULT_TOOLS,
  REVIEWER_RETRY_SUFFIX,
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
/** A protocol correction is safe only while the failed attempt remains semantically short. */
const MAX_PROTOCOL_RETRY_BYTES = 64 * 1024;
const MAX_REVIEW_ATTEMPTS = 2;
/** Do not leave a failed reviewer alive when its close event is lost. */
const TERMINATION_DRAIN_GRACE_PERIOD_MS = 250;
const RETRY_SUFFIX = REVIEWER_RETRY_SUFFIX;
const RETRY_PROMPT_SEPARATOR = "\n\n";
/** Added only after an attempt has actually been admitted by the scheduler. */
const RETRY_BUDGET_FAILURE_KIND: ReviewerFailureKind = "retry-budget";

/** JSON event types emitted by Pi's JSON/print modes. */
const REVIEWER_PROTOCOL_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "compaction_start",
  "compaction_end",
]);

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const RESULT_TOOLS = new Set<string>(Object.values(REVIEWER_RESULT_TOOLS));
const SAFE_TOOLS = new Set<string>([...READ_ONLY_TOOLS, ...RESULT_TOOLS]);

export const reviewerOutputLimits = {
  eventBytes: MAX_REVIEWER_EVENT_BYTES,
  stdoutBytes: MAX_REVIEWER_STDOUT_BYTES,
  stderrBytes: MAX_REVIEWER_STDERR_BYTES,
  attempts: MAX_REVIEW_ATTEMPTS,
  protocolRetryBytes: MAX_PROTOCOL_RETRY_BYTES,
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
  if (kind === RETRY_BUDGET_FAILURE_KIND) {
    return `${role} reviewer retry was denied by the retry budget`;
  }
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
    default:
      return `${role} reviewer failed`;
  }
}

export interface ReviewerRunDiagnostics {
  readonly attempt: number;
  readonly maxTurns: number;
  readonly turns: number;
  readonly resultCount: number;
  readonly finalizationEntered: boolean;
  readonly semanticBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly retryDenial?: string;
}

const EMPTY_DIAGNOSTICS: ReviewerRunDiagnostics = Object.freeze({
  attempt: 0,
  maxTurns: 0,
  turns: 0,
  resultCount: 0,
  finalizationEntered: false,
  semanticBytes: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
});

export class ReviewerRunError extends Error {
  public readonly role: string;
  public readonly kind: ReviewerFailureKind;
  public readonly usage: AgentUsage;
  /** Only short, typed-result protocol misses may be recovered once. */
  public readonly retryableProtocol: boolean;
  /** Bounded machine-readable execution facts. */
  public readonly diagnostics: ReviewerRunDiagnostics;
  /** Exact provider/process diagnostic text, when the failed boundary supplied it. */
  public readonly detail?: string;

  public constructor(
    role: string,
    kind: ReviewerFailureKind,
    usage: AgentUsage,
    retryableProtocol = false,
    diagnostics: ReviewerRunDiagnostics = EMPTY_DIAGNOSTICS,
    detail?: string,
  ) {
    const message = messageForFailure(kind, role);
    super(detail ? `${message}: ${detail}` : message);
    this.name = "ReviewerRunError";
    this.role = role;
    this.kind = kind;
    this.usage = usage;
    this.retryableProtocol = retryableProtocol;
    this.diagnostics = Object.freeze({ ...diagnostics });
    if (detail !== undefined) this.detail = detail;
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

function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
  } catch {
    // JSONL input cannot normally contain cycles. Treat an unexpected value as
    // maximally large so it cannot make a protocol retry look inexpensive.
    return MAX_PROTOCOL_RETRY_BYTES + 1;
  }
}

function diagnosticText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function promptEnvelopeBytes(prompt: string, resultTool: AgentInvocation["resultTool"]): number {
  return Buffer.byteLength(prompt, "utf8")
    + Buffer.byteLength(RETRY_PROMPT_SEPARATOR + RETRY_SUFFIX, "utf8")
    + reviewerControlReserveBytes(resultTool);
}

function assertReviewerInputEnvelope(
  prompt: string,
  resultTool: AgentInvocation["resultTool"],
  inputBudgetBytes: number,
): void {
  // Reuse the shared validator for the budget's type/range contract without
  // allocating a synthetic string proportional to an attacker-controlled
  // prompt.
  assertInputBudget("", inputBudgetBytes);
  const envelopeBytes = promptEnvelopeBytes(prompt, resultTool);
  if (envelopeBytes > inputBudgetBytes) {
    throw new InputLimitError("Reviewer prompt and bounded recovery/finalization envelope exceed the input budget", {
      inputBudgetBytes,
      promptBytes: envelopeBytes,
    });
  }
}

function invocationDiagnostics(
  invocation: AgentInvocation,
  attempt: number,
  usage: AgentUsage,
  retryDenial?: string,
): ReviewerRunDiagnostics {
  const diagnostics: ReviewerRunDiagnostics = {
    attempt,
    maxTurns: invocation.maxTurns,
    turns: usage.turns,
    resultCount: 0,
    finalizationEntered: usage.turns >= invocation.maxTurns,
    semanticBytes: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    ...(retryDenial === undefined ? {} : { retryDenial }),
  };
  return Object.freeze(diagnostics);
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
    const inputBudgetBytes = invocation.inputBudgetBytes ?? DEFAULT_INPUT_BUDGET_BYTES;
    for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) {
        const canceled = new ReviewerRunError(
          invocation.role,
          "canceled",
          aggregateUsage,
          false,
          invocationDiagnostics(invocation, attempt, aggregateUsage),
        );
        onProgress?.({ type: "reviewer-failed", role: invocation.role, attempt, kind: canceled.kind, usage: aggregateUsage });
        throw canceled;
      }

      const prompt = attempt === 1 ? invocation.prompt : `${invocation.prompt}${RETRY_PROMPT_SEPARATOR}${RETRY_SUFFIX}`;
      try {
        // Reserve enough room for both a possible protocol correction and the
        // exact finalization context message. This check is against the
        // original invocation ceiling and happens before any spawn/charge.
        assertReviewerInputEnvelope(invocation.prompt, invocation.resultTool, inputBudgetBytes);
      } catch (error) {
        // Prompt limits are checked before reviewer-start and, importantly,
        // before spawn. This path has no process and therefore no usage.
        if (!(error instanceof InputLimitError)) throw error;
        const limit = new ReviewerRunError(
          invocation.role,
          "input-limit",
          aggregateUsage,
          false,
          invocationDiagnostics(invocation, attempt, aggregateUsage),
        );
        onProgress?.({ type: "reviewer-failed", role: invocation.role, attempt, kind: limit.kind, usage: aggregateUsage });
        throw limit;
      }
      onProgress?.({
        type: "reviewer-start",
        role: invocation.role,
        resultTool: invocation.resultTool,
        attempt,
        ...(invocation.model === undefined ? {} : { model: invocation.model }),
        thinking: invocation.thinking,
      });
      try {
        const result = await this.runAttempt(invocation, prompt, validate, signal, attempt, onProgress);
        aggregateUsage = addUsage(aggregateUsage, result.usage);
        onProgress?.({ type: "reviewer-complete", role: invocation.role, attempt, usage: aggregateUsage });
        return { data: result.data, usage: aggregateUsage };
      } catch (error) {
        const attemptError = error instanceof ReviewerRunError
          ? error
          : new ReviewerRunError(
            invocation.role,
            "transport",
            emptyUsage(invocation.role),
            false,
            invocationDiagnostics(invocation, attempt, emptyUsage(invocation.role)),
          );
        aggregateUsage = addUsage(aggregateUsage, attemptError.usage);
        const canRetry = attempt < MAX_REVIEW_ATTEMPTS
          && attemptError.retryableProtocol
          && (attemptError.kind === "missing-result" || attemptError.kind === "malformed-result" || attemptError.kind === "provider")
          && !signal?.aborted;
        if (canRetry) {
          let retryAdmitted = true;
          if (invocation.retryAdmission !== undefined) {
            try {
              retryAdmitted = await invocation.retryAdmission();
            } catch {
              retryAdmitted = false;
            }
          }
          if (!retryAdmitted) {
            const kind = signal?.aborted ? "canceled" : RETRY_BUDGET_FAILURE_KIND;
            const deniedDiagnostics: ReviewerRunDiagnostics = {
              ...attemptError.diagnostics,
              retryDenial: signal?.aborted ? "canceled" : "scheduler-admission-denied",
            };
            const denied = new ReviewerRunError(
              invocation.role,
              kind,
              aggregateUsage,
              false,
              deniedDiagnostics,
              attemptError.detail,
            );
            onProgress?.({ type: "reviewer-failed", role: invocation.role, attempt, kind: denied.kind, usage: aggregateUsage });
            throw denied;
          }
          onProgress?.({ type: "reviewer-retry", role: invocation.role, attempt: attempt + 1, usage: aggregateUsage });
          continue;
        }
        const terminal = new ReviewerRunError(
          invocation.role,
          attemptError.kind,
          aggregateUsage,
          false,
          attemptError.diagnostics,
          attemptError.detail,
        );
        onProgress?.({ type: "reviewer-failed", role: invocation.role, attempt, kind: terminal.kind, usage: aggregateUsage });
        throw terminal;
      }
    }
    throw new ReviewerRunError(
      invocation.role,
      "transport",
      aggregateUsage,
      false,
      invocationDiagnostics(invocation, MAX_REVIEW_ATTEMPTS, aggregateUsage),
    );
  }

  private runAttempt<T>(
    invocation: AgentInvocation,
    prompt: string,
    validate: (value: unknown) => T,
    signal: AbortSignal | undefined,
    attempt: number,
    onProgress: ((event: ReviewerProgressEvent) => void) | undefined,
  ): Promise<AttemptResult<T>> {
    if (signal?.aborted) {
      const usage = emptyUsage(invocation.role);
      return Promise.reject(new ReviewerRunError(
        invocation.role,
        "canceled",
        usage,
        false,
        invocationDiagnostics(invocation, attempt, usage),
      ));
    }

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.executable, buildReviewAgentArgs(invocation), {
          cwd: invocation.cwd,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            [REVIEWER_FINALIZATION_CONTROL_ENV]: JSON.stringify({
              resultTool: invocation.resultTool,
              maxTurns: invocation.maxTurns,
            }),
          },
        });
      } catch (error) {
        const usage = emptyUsage(invocation.role);
        reject(new ReviewerRunError(
          invocation.role,
          "spawn",
          usage,
          false,
          invocationDiagnostics(invocation, attempt, usage),
          error instanceof Error ? error.message : String(error),
        ));
        return;
      }

      let buffer = "";
      const stdoutDecoder = new StringDecoder("utf8");
      let stdoutBytes = 0;
      let stderrBytes = 0;
      // Retry safety is based on completed semantic content, not transport
      // snapshots. Malformed/non-protocol stdout is tracked separately so a
      // noisy or hostile process cannot obtain a cheap correction attempt.
      let semanticBytes = 0;
      let malformedOutputBytes = 0;
      let outputLimitExceeded = false;
      let terminationRequested = false;
      let terminalFailureKind: ReviewerFailureKind | undefined;
      let terminalFailureDetail: string | undefined;
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
      const countSemantic = (value: unknown): void => {
        semanticBytes += serializedBytes(value);
      };
      const countMalformed = (line: string): void => {
        // Include the line separator conservatively; it is part of the JSONL
        // transport even when the split line no longer contains it.
        malformedOutputBytes += Buffer.byteLength(line, "utf8") + 1;
      };
      const retryWithinSemanticBudget = (): boolean =>
        semanticBytes + stderrBytes + malformedOutputBytes <= MAX_PROTOCOL_RETRY_BYTES;
      const diagnostics = (): ReviewerRunDiagnostics => Object.freeze({
        attempt,
        maxTurns: invocation.maxTurns,
        turns: usage.turns,
        resultCount: expectedResultCount,
        finalizationEntered: usage.turns >= invocation.maxTurns,
        semanticBytes,
        stdoutBytes,
        stderrBytes,
      });
      const failureError = (kind: ReviewerFailureKind): ReviewerRunError => {
        const retryableProtocol = (kind === "missing-result" || kind === "malformed-result" || kind === "provider")
          && retryWithinSemanticBudget();
        return new ReviewerRunError(invocation.role, kind, usage, retryableProtocol, diagnostics(), terminalFailureDetail);
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
      const requestFailure = (kind: ReviewerFailureKind, detail?: string): void => {
        // The first terminal cause is authoritative. In particular, a bound or
        // provider failure must not be replaced by cancellation, close, or a
        // result that was already in flight when termination began.
        if (terminalFailureKind || settled) return;
        terminalFailureKind = kind;
        terminalFailureDetail = detail;
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
        if (terminalFailureKind) return;
        if (!line.trim()) {
          countMalformed(line);
          return;
        }
        let event: unknown;
        try {
          event = JSON.parse(line) as unknown;
        } catch {
          countMalformed(line);
          return;
        }
        if (!event || typeof event !== "object" || Array.isArray(event)) {
          countMalformed(line);
          return;
        }
        const record = event as Record<string, unknown>;
        if (typeof record.type !== "string" || !REVIEWER_PROTOCOL_EVENT_TYPES.has(record.type)) {
          countMalformed(line);
          return;
        }
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
          if (typeof record.toolName !== "string") countMalformed(line);
          emitTool(record.toolName, "started");
          return;
        }
        if (record.type === "tool_execution_update") {
          if (typeof record.toolName !== "string") countMalformed(line);
          emitTool(record.toolName, "updated");
          return;
        }
        if (record.type === "tool_execution_end") {
          const toolName = record.toolName;
          if (typeof toolName !== "string" || !Object.prototype.hasOwnProperty.call(record, "result")) {
            countMalformed(line);
          }
          // Tool result details can be the malformed part of the protocol. It
          // is therefore counted even though ordinary streaming tool updates
          // are intentionally ignored as cumulative transport snapshots.
          if (Object.prototype.hasOwnProperty.call(record, "result")) countSemantic(record.result);
          if (toolName === invocation.resultTool) {
            expectedResultCount += 1;
            if (expectedResultCount > 1) {
              requestFailure("duplicate-result");
            } else if (record.isError === true) {
              requestFailure("result-tool-error", diagnosticText(record.result));
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
          if (!record.usage || typeof record.usage !== "object") {
            countMalformed(line);
            return;
          }
          liveUsage = usageSnapshot(record.usage);
          currentContextUsage = Math.max(currentContextUsage, liveUsage.context);
          refreshUsage();
          if (currentContextUsage > invocation.contextBudget) requestFailure("context-limit");
          report({ type: "reviewer-turn", role: invocation.role, attempt, usage });
          return;
        }
        if (record.type === "message_end" && (!record.message || typeof record.message !== "object" || Array.isArray(record.message))) {
          countMalformed(line);
          return;
        }
        const message = isAssistantMessage(record);
        if (!message) return;
        if (!Object.prototype.hasOwnProperty.call(message, "content")) {
          countMalformed(line);
        } else {
          // message_end is the sole authoritative completed snapshot. This
          // includes text, reasoning, and tool-call arguments in content while
          // avoiding repeated message_update deltas and echoed input.
          countSemantic(message.content);
        }
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
          requestFailure(
            contextError(message) ? "context-limit" : "provider",
            typeof message.errorMessage === "string" ? message.errorMessage : undefined,
          );
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
      let stderr = "";
      const stderrDecoder = new StringDecoder("utf8");
      const consumeStderrChunk = (chunk: Buffer | string): void => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        stderrBytes += bytes.byteLength;
        if (stderrBytes > MAX_REVIEWER_STDERR_BYTES) {
          outputLimitExceeded = true;
          requestFailure("output-limit");
          return;
        }
        stderr += stderrDecoder.write(bytes);
      };
      const onStdinError = (error: Error): void => requestFailure("transport", error.message);
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
      const onStdoutError = (error: Error): void => requestFailure("transport", error.message);
      const onStderrError = (error: Error): void => requestFailure("transport", error.message);
      const onChildError = (error: Error): void => requestFailure("spawn", error.message);
      const onClose = (code: number | null): void => {
        if (settled) return;
        stderr += stderrDecoder.end();
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
          finish(() => reject(new ReviewerRunError(invocation.role, "output-limit", usage, false, diagnostics())));
          return;
        }
        if (code !== 0) {
          finish(() => reject(new ReviewerRunError(invocation.role, "process", usage, false, diagnostics(), stderr)));
          return;
        }
        const retryableProtocol = retryWithinSemanticBudget();
        if (expectedResultCount !== 1) {
          finish(() => reject(new ReviewerRunError(invocation.role, "missing-result", usage, retryableProtocol, diagnostics())));
          return;
        }
        if (!expectedDetailsPresent) {
          finish(() => reject(new ReviewerRunError(invocation.role, "malformed-result", usage, retryableProtocol, diagnostics())));
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
        } catch (error) {
          finish(() => reject(new ReviewerRunError(invocation.role, "validation", usage, false, diagnostics(), diagnosticText(error))));
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
