import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree, PROCESS_KILL_GRACE_PERIOD_MS } from "./process.js";
import type { CommandResult, CommandRunner } from "./types.js";

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;

function appendLimited(current: string, chunk: string, limit: number): { value: string; truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: chunk.length > 0 };
  const available = limit - current.length;
  return { value: current + chunk.slice(0, available), truncated: chunk.length > available };
}

export class NodeCommandRunner implements CommandRunner {
  public constructor(private readonly outputLimit = DEFAULT_OUTPUT_LIMIT) {}

  public run(
    command: string,
    args: readonly string[],
    options: { cwd: string; signal?: AbortSignal | undefined },
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let outputTruncated = false;
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let settled = false;
      let aborted = false;
      let terminationRequested = false;
      let escalationTimer: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;

      const removeAbortListener = (): void => {
        if (abortListener && options.signal) options.signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      };
      const clearEscalationTimer = (): void => {
        if (escalationTimer) clearTimeout(escalationTimer);
        escalationTimer = undefined;
      };
      const finish = (result: CommandResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
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

      child.stdout.on("data", (chunk: Buffer | string) => {
        const appended = appendLimited(stdout, stdoutDecoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk), this.outputLimit);
        stdout = appended.value;
        if (appended.truncated) {
          outputTruncated = true;
          terminateProcess();
        }
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const appended = appendLimited(stderr, stderrDecoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk), this.outputLimit);
        stderr = appended.value;
        if (appended.truncated) {
          outputTruncated = true;
          terminateProcess();
        }
      });
      child.on("error", (error) => {
        removeAbortListener();
        if (aborted || terminationRequested) killProcessTree(child, "SIGKILL");
        clearEscalationTimer();
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.on("close", (code) => {
        const stdoutTail = appendLimited(stdout, stdoutDecoder.end(), this.outputLimit);
        const stderrTail = appendLimited(stderr, stderrDecoder.end(), this.outputLimit);
        stdout = stdoutTail.value;
        stderr = stderrTail.value;
        outputTruncated ||= stdoutTail.truncated || stderrTail.truncated;
        removeAbortListener();
        if (aborted || terminationRequested) killProcessTree(child, "SIGKILL");
        clearEscalationTimer();
        finish({ stdout, stderr, exitCode: aborted ? 130 : code ?? 1, ...(aborted ? { canceled: true } : {}), ...(outputTruncated ? { truncated: true } : {}) });
      });

      const abort = (): void => {
        if (aborted) return;
        aborted = true;
        terminateProcess();
      };
      abortListener = abort;
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export async function runChecked(
  commands: CommandRunner,
  command: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await commands.run(command, args, { cwd, signal });
  if (result.canceled || result.truncated || result.exitCode !== 0) {
    const detail = result.canceled ? "canceled" : result.truncated ? "output exceeded the review limit" : result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`${command} ${args.join(" ")}: ${detail}`);
  }
  return result.stdout;
}
