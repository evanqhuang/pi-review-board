import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree, PROCESS_KILL_GRACE_PERIOD_MS } from "./process.js";
import type { AgentInvocation, AgentResult, AgentUsage, ReviewAgentRunner } from "./types.js";

const MAX_REVIEWER_EVENT_BYTES = 16 * 1024 * 1024;

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { readonly type: "text"; readonly text: string } => {
      return Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string");
    })
    .map((part) => part.text)
    .join("\n");
}

function parsePayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Reviewer returned no structured output");
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    const firstObject = withoutFence.indexOf("{");
    const lastObject = withoutFence.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      try {
        return JSON.parse(withoutFence.slice(firstObject, lastObject + 1)) as unknown;
      } catch {
        // Fall through to a useful validation error.
      }
    }
    throw new Error("Reviewer returned malformed JSON");
  }
}

function emptyUsage(role: string): AgentUsage {
  return { role, turns: 0, inputTokens: 0, outputTokens: 0, contextTokens: 0 };
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatAgentProgress(usage: AgentUsage): string {
  return `${usage.role}: turn ${usage.turns} · tokens in ${formatTokenCount(usage.inputTokens)} · out ${formatTokenCount(usage.outputTokens)} · context ${formatTokenCount(usage.contextTokens)}`;
}

export function buildReviewAgentArgs(invocation: AgentInvocation): string[] {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
  ];
  if (invocation.model) args.push("--model", invocation.model);
  args.push("--thinking", invocation.thinking);
  if (invocation.tools.length > 0) args.push("--tools", invocation.tools.join(","));
  args.push(invocation.prompt);
  return args;
}

export class PiReviewAgentRunner implements ReviewAgentRunner {
  public constructor(private readonly executable = process.env.PI_CODE_REVIEW_AGENT_BIN ?? "pi") {}

  public run<T>(
    invocation: AgentInvocation,
    validate: (value: unknown) => T,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<AgentResult<T>> {
    return new Promise((resolve, reject) => {
      const args = buildReviewAgentArgs(invocation);
      onProgress?.(`${invocation.role}: started`);

      const child = spawn(this.executable, args, {
        cwd: invocation.cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      const stdoutDecoder = new StringDecoder("utf8");
      let lastAssistantText = "";
      let eventLimitExceeded = false;
      let aborted = false;
      let terminationRequested = false;
      let usage = emptyUsage(invocation.role);
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
      const processLine = (line: string): void => {
        if (!line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line) as unknown;
        } catch {
          return;
        }
        if (!event || typeof event !== "object") return;
        const record = event as { readonly type?: unknown; readonly message?: unknown };
        if (record.type !== "message_end" || !record.message || typeof record.message !== "object") return;
        const message = record.message as { readonly role?: unknown; readonly content?: unknown; readonly usage?: unknown };
        if (message.role !== "assistant") return;
        const text = textFromMessage(message);
        if (text) lastAssistantText = text;
        const rawUsage = message.usage;
        if (rawUsage && typeof rawUsage === "object") {
          const values = rawUsage as { input?: unknown; output?: unknown; totalTokens?: unknown };
          usage = {
            role: invocation.role,
            turns: usage.turns + 1,
            inputTokens: usage.inputTokens + (typeof values.input === "number" ? values.input : 0),
            outputTokens: usage.outputTokens + (typeof values.output === "number" ? values.output : 0),
            contextTokens: typeof values.totalTokens === "number" ? values.totalTokens : usage.contextTokens,
          };
        } else {
          usage = { ...usage, turns: usage.turns + 1 };
        }
        onProgress?.(formatAgentProgress(usage));
      };
      const consumeOutput = (text: string): void => {
        if (eventLimitExceeded) return;
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (Buffer.byteLength(line, "utf8") > MAX_REVIEWER_EVENT_BYTES) {
            eventLimitExceeded = true;
            terminateProcess();
            return;
          }
          processLine(line);
        }
        if (Buffer.byteLength(buffer, "utf8") > MAX_REVIEWER_EVENT_BYTES) {
          eventLimitExceeded = true;
          terminateProcess();
        }
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        consumeOutput(stdoutDecoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
      });
      child.stderr.on("data", () => {
        // Drain process diagnostics without forwarding them to the parent review.
      });
      child.on("error", (error) => {
        removeAbortListener();
        if (aborted || terminationRequested) killProcessTree(child, "SIGKILL");
        clearEscalationTimer();
        finish(() => reject(error));
      });
      child.on("close", (code) => {
        const stdoutTail = stdoutDecoder.end();
        consumeOutput(stdoutTail);
        buffer += stdoutTail;
        removeAbortListener();
        if (aborted || terminationRequested) killProcessTree(child, "SIGKILL");
        clearEscalationTimer();
        if (!eventLimitExceeded && buffer.trim()) processLine(buffer);
        finish(() => {
          if (aborted) {
            reject(new Error(`${invocation.role} reviewer was canceled`));
            return;
          }
          if (eventLimitExceeded) {
            reject(new Error(`${invocation.role} reviewer event exceeded the review limit`));
            return;
          }
          if (code !== 0) {
            reject(new Error(`${invocation.role} reviewer failed with exit code ${code ?? 1}`));
            return;
          }
          try {
            resolve({ data: validate(parsePayload(lastAssistantText)), usage });
          } catch (error) {
            reject(new Error(`${invocation.role} reviewer output invalid: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      });

      const abort = (): void => {
        if (aborted) return;
        aborted = true;
        terminateProcess();
      };
      abortListener = abort;
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export const reviewAgentConfiguration = {
  supportsInvocationThinking: true,
} as const;
