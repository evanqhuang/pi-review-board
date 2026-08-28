import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export const PROCESS_KILL_GRACE_PERIOD_MS = 5_000;

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    let fallbackUsed = false;
    const fallback = (): void => {
      if (fallbackUsed) return;
      fallbackUsed = true;
      child.kill(signal);
    };
    killer.on("error", fallback);
    killer.on("close", (code) => {
      if (code !== 0) fallback();
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
