import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReviewAgentArgs, PiReviewAgentRunner, reviewAgentConfiguration } from "../src/runner.js";

describe("review agent configuration", () => {
  it("passes the routed reviewer model and thinking level without a turn cap", () => {
    expect(reviewAgentConfiguration).toEqual({ supportsInvocationThinking: true });
    expect("maxTurns" in reviewAgentConfiguration).toBe(false);

    const args = buildReviewAgentArgs({ role: "finder", prompt: "return JSON", cwd: "/repo", tools: ["read"], model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" });
    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--model",
      "openai-codex/gpt-5.6-luna",
      "--thinking",
      "xhigh",
      "--tools",
      "read",
      "return JSON",
    ]);
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("max_turns");

    expect(buildReviewAgentArgs({ role: "finder", prompt: "return JSON", cwd: "/repo", tools: [], model: "qwen38-main/qwen3.8-27b", thinking: "medium" })).toContain("qwen38-main/qwen3.8-27b");
  });

  it("reports reviewer turns and cumulative token usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-progress-"));
    const executable = join(directory, "reviewer.sh");
    const payload = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "{}" }],
        usage: { input: 1200, output: 250, totalTokens: 1500 },
      },
    });
    await writeFile(executable, `#!/bin/sh\ncat <<'JSON'\n${payload}\nJSON\n`);
    await chmod(executable, 0o755);
    try {
      const progress: string[] = [];
      await new PiReviewAgentRunner(executable).run(
        { role: "finder:diff-correctness", prompt: "return JSON", cwd: directory, tools: [], thinking: "high" },
        (value) => value,
        undefined,
        (message) => progress.push(message),
      );
      expect(progress[0]).toBe("finder:diff-correctness: started");
      expect(progress).toContain("finder:diff-correctness: turn 1 · tokens in 1.2k · out 250 · context 1.5k");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps subprocess diagnostics out of structured failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-review-runner-"));
    const executable = join(directory, "reviewer.sh");
    await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' 'sensitive reviewer transcript' >&2\nexit 7\n");
    await chmod(executable, 0o755);
    try {
      const runner = new PiReviewAgentRunner(executable);
      await expect(runner.run({ role: "finder", prompt: "return JSON", cwd: directory, tools: [], thinking: "high" }, (value) => value)).rejects.toThrow("finder reviewer failed with exit code 7");
      await expect(runner.run({ role: "finder", prompt: "return JSON", cwd: directory, tools: [], thinking: "high" }, (value) => value)).rejects.not.toThrow("sensitive reviewer transcript");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
