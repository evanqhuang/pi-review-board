import { describe, expect, it } from "vitest";
import { runCodeReview } from "../src/pipeline.js";
import type { AgentInvocation, AgentResult, AgentUsage, CommandResult, CommandRunner, ReviewAgentRunner, ReviewerProgressEvent } from "../src/types.js";

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n context\n context\n context\n+changed\n";

class FakeCommands implements CommandRunner {
  public readonly calls: string[][] = [];
  public commentCount = 0;
  public rejectComment = false;
  public failIdentity = false;
  public changeBeforePublish = false;
  private prDiffCount = 0;
  public run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (command === "gh" && args[0] === "pr" && args[1] === "view") return Promise.resolve({ stdout: JSON.stringify({
      number: 7,
      title: "Fix cache",
      body: "body",
      state: "OPEN",
      isDraft: false,
      author: { login: "human" },
      url: "https://github.com/acme/repo/pull/7",
      baseRefOid: "base",
      headRefOid: "head",
      repository: { nameWithOwner: "acme/repo" },
      files: [{ path: "src/a.ts" }],
      comments: [],
    }), stderr: "", exitCode: 0 });
    if (command === "gh" && args[0] === "api" && args[1] === "user") {
      if (this.failIdentity) return Promise.resolve({ stdout: "", stderr: "identity unavailable", exitCode: 1 });
      return Promise.resolve({ stdout: "reviewer\n", stderr: "", exitCode: 0 });
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "diff") {
      this.prDiffCount += 1;
      const output = this.changeBeforePublish && this.prDiffCount >= 3 ? `${patch}\n+changed-again\n` : patch;
      return Promise.resolve({ stdout: output, stderr: "", exitCode: 0 });
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "comment") {
      if (this.rejectComment) return Promise.reject(new Error("comment transport failed"));
      this.commentCount += 1;
      return Promise.resolve({ stdout: "commented", stderr: "", exitCode: 0 });
    }
    if (command !== "git") return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    if (args[0] === "rev-parse" && args[1] === "HEAD") return Promise.resolve({ stdout: "head\n", stderr: "", exitCode: 0 });
    if (args[0] === "rev-parse" && args[1] === "topic") return Promise.resolve({ stdout: "topic\n", stderr: "", exitCode: 0 });
    if (args[0] === "diff" && args[1] === "--name-only") return Promise.resolve({ stdout: "src/a.ts\n", stderr: "", exitCode: 0 });
    if (args[0] === "diff") return Promise.resolve({ stdout: patch, stderr: "", exitCode: 0 });
    return Promise.resolve({ stdout: "", stderr: "missing", exitCode: 1 });
  }
}

class FakeAgents implements ReviewAgentRunner {
  public readonly roles: string[] = [];
  public readonly cwds: string[] = [];
  public readonly prompts: string[] = [];
  public readonly toolsets: string[][] = [];
  public readonly resultTools: string[] = [];
  public readonly models: (string | undefined)[] = [];
  public readonly thinkings: string[] = [];
  private readonly attempts = new Map<string, number>();
  public constructor(
    private readonly failRole?: string,
    private readonly returnFinderArray = false,
    private readonly additionalFailures: readonly string[] = [],
    private readonly retryRole?: string,
  ) {}
  public run<T>(invocation: AgentInvocation, validate: (value: unknown) => T, _signal?: AbortSignal, onProgress?: (event: ReviewerProgressEvent) => void): Promise<AgentResult<T>> {
    this.roles.push(invocation.role);
    this.cwds.push(invocation.cwd);
    this.models.push(invocation.model);
    this.thinkings.push(invocation.thinking);
    this.prompts.push(invocation.prompt);
    this.toolsets.push([...invocation.tools]);
    this.resultTools.push(invocation.resultTool);
    onProgress?.({ type: "reviewer-start", role: invocation.role, resultTool: invocation.resultTool, attempt: 1 });
    const attempt = (this.attempts.get(invocation.role) ?? 0) + 1;
    this.attempts.set(invocation.role, attempt);
    if (invocation.role === this.failRole || this.additionalFailures.includes(invocation.role)) return Promise.reject(new Error("simulated reviewer failure"));
    const simulatedRetry = invocation.role === this.retryRole && attempt === 1;
    if (simulatedRetry) onProgress?.({ type: "reviewer-retry", role: invocation.role, attempt: 2, usage: { role: invocation.role, turns: 2, inputTokens: 14, outputTokens: 6, contextTokens: 9 } });
    let value: unknown;
    if (invocation.role === "summary") value = { summary: "Updates cache refresh behavior" };
    else if (invocation.role.startsWith("finder:")) {
      const candidates = [{
        id: "candidate-1",
        rootCauseKey: "cache:cold-refresh-skipped",
        file: "src/a.ts",
        line: 4,
        summary: "Skips refresh on a cold cache",
        failureScenario: "A cold cache returns stale data",
        evidence: "The changed branch returns before refresh",
        category: "correctness",
        severity: "high",
      }];
      value = this.returnFinderArray ? candidates : { candidates };
    } else if (invocation.role === "verifier" || invocation.role === "independent-verifier") {
      value = { verifications: batchCandidateIds(invocation.prompt).map((candidateId) => ({ candidateId, confidence: 95, verification: "The changed branch reproduces the stale result", confirmed: true, disposition: "CONFIRMED" })) };
    } else value = { proceed: true, reason: "substantive change" };
    const usage: AgentUsage = simulatedRetry
      ? { role: invocation.role, turns: 2, inputTokens: 20, outputTokens: 8, contextTokens: 20 }
      : { role: invocation.role, turns: 1, inputTokens: 10, outputTokens: 5, contextTokens: 20 };
    return Promise.resolve({ data: validate(value), usage });
  }
}

const target = { kind: "branch", ref: "topic" } as const;

function batchCandidateIds(prompt: string): string[] {
  const serialized = prompt.split("\n").at(-1);
  if (!serialized) return [];
  const request = JSON.parse(serialized) as { candidates?: readonly { id?: unknown }[] };
  return request.candidates?.flatMap((candidate) => typeof candidate.id === "string" ? [candidate.id] : []) ?? [];
}

describe("runCodeReview", () => {
  it("runs the medium finder set, deduplicates, verifies, and does not comment by default", async () => {
    const commands = new FakeCommands();
    const agents = new FakeAgents();
    const progress: ReviewerProgressEvent[] = [];
    const result = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "medium" }, { commands, agents, reviewerModel: "parent-provider/parent-model", onProgress: (event) => { if (event.type !== "stage") progress.push(event); } });

    expect(result.status).toBe("complete");
    expect(result.findings).toHaveLength(1);
    expect(agents.roles.filter((role) => role.startsWith("finder:")).length).toBe(8);
    expect(agents.roles.filter((role) => role === "verifier").length).toBe(1);
    expect(commands.calls.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "comment")).toBe(false);
    expect(agents.toolsets.every((tools) => !tools.includes("bash"))).toBe(true);
    expect(progress.some((event) => event.type === "reviewer-start" && event.role === "finder:diff-correctness")).toBe(true);
    expect(agents.resultTools.filter((tool) => tool === "review_finder_result").length).toBe(8);
    expect(agents.resultTools.filter((tool) => tool === "review_verifier_result").length).toBe(1);
    expect(agents.models.every((model) => model === "parent-provider/parent-model")).toBe(true);
    expect(agents.thinkings.every((thinking) => thinking === "xhigh" || thinking === "medium")).toBe(true);
  });

  it("accepts a bare array from finder reviewers", async () => {
    const result = await runCodeReview(
      { cwd: "/repo", target, comment: false, effort: "low" },
      { commands: new FakeCommands(), agents: new FakeAgents(undefined, true) },
    );

    expect(result.status).toBe("complete");
    expect(result.findings).toHaveLength(1);
  });

  it("runs review agents from the requested worktree root", async () => {
    const agents = new FakeAgents();
    const result = await runCodeReview(
      { cwd: "/repo", target: { kind: "worktree", path: "/repo/.worktrees/topic" }, comment: false, effort: "low" },
      { commands: new FakeCommands(), agents },
    );

    expect(result.status).toBe("complete");
    expect(result.report).toContain("**Target:** worktree `/repo/.worktrees/topic`");
    expect(agents.cwds.length).toBeGreaterThan(0);
    expect(agents.cwds.every((cwd) => cwd === "/repo/.worktrees/topic")).toBe(true);
  });

  it("uses the routed finder and verifier models when no explicit override is supplied", async () => {
    const agents = new FakeAgents();
    await runCodeReview({ cwd: "/repo", target, comment: false, effort: "medium" }, { commands: new FakeCommands(), agents });

    const finderCalls = agents.roles.map((role, index) => ({ role, model: agents.models[index], thinking: agents.thinkings[index] })).filter(({ role }) => role === "summary" || role.startsWith("finder:"));
    const verifierCalls = agents.roles.map((role, index) => ({ role, model: agents.models[index], thinking: agents.thinkings[index] })).filter(({ role }) => role === "verifier");
    expect(finderCalls.every(({ model, thinking }) => model === "openai-codex/gpt-5.6-luna" && thinking === "xhigh")).toBe(true);
    expect(verifierCalls).toEqual([{ role: "verifier", model: "openai-codex/gpt-5.6-sol", thinking: "medium" }]);
    expect(agents.prompts.find((prompt) => prompt.includes("as one batch"))).toContain("diff-correctness:cache:cold-refresh-skipped:0");
  });

  it("changes execution depth for every effort level", async () => {
    const expected = {
      low: { finders: 1, verifiers: 1 },
      medium: { finders: 8, verifiers: 1 },
      high: { finders: 8, verifiers: 1 },
      xhigh: { finders: 11, verifiers: 1 },
      max: { finders: 11, verifiers: 1 },
      ultra: { finders: 11, verifiers: 2 },
    } as const;
    for (const effort of Object.keys(expected) as (keyof typeof expected)[]) {
      const agents = new FakeAgents();
      const result = await runCodeReview({ cwd: "/repo", target, comment: false, effort }, { commands: new FakeCommands(), agents });
      expect(result.status, effort).toBe("complete");
      expect(agents.roles.filter((role) => role.startsWith("finder:")).length, effort).toBe(expected[effort].finders);
      expect(agents.roles.filter((role) => role === "verifier" || role === "independent-verifier").length, effort).toBe(expected[effort].verifiers);
    }
  });

  it("increases context depth at xhigh and max", async () => {
    const lowAgents = new FakeAgents();
    await runCodeReview({ cwd: "/repo", target, comment: false, effort: "low" }, { commands: new FakeCommands(), agents: lowAgents });
    expect(lowAgents.prompts.some((prompt) => prompt.includes("skip test and fixture hunks"))).toBe(true);

    const xhighAgents = new FakeAgents();
    await runCodeReview({ cwd: "/repo", target, comment: false, effort: "xhigh" }, { commands: new FakeCommands(), agents: xhighAgents });
    expect(xhighAgents.prompts.some((prompt) => prompt.includes("deeply before deciding"))).toBe(true);

    const maxAgents = new FakeAgents();
    await runCodeReview({ cwd: "/repo", target, comment: false, effort: "max" }, { commands: new FakeCommands(), agents: maxAgents });
    expect(maxAgents.prompts.some((prompt) => prompt.includes("exhaustively before deciding"))).toBe(true);
  });

  it("keeps pull-request reviews report-only unless comment is explicit", async () => {
    const commands = new FakeCommands();
    const result = await runCodeReview({ cwd: "/repo", target: { kind: "pull-request", value: "7" }, comment: false, effort: "medium" }, { commands, agents: new FakeAgents() });
    expect(result.status).toBe("complete");
    expect(result.commented).toBe(false);
    expect(commands.commentCount).toBe(0);
  });

  it("publishes only for an explicit pull-request comment request", async () => {
    const commands = new FakeCommands();
    const result = await runCodeReview({ cwd: "/repo", target: { kind: "pull-request", value: "7" }, comment: true, effort: "medium" }, { commands, agents: new FakeAgents() });
    expect(result.status).toBe("complete");
    expect(result.commented).toBe(true);
    expect(commands.commentCount).toBe(1);
    expect(commands.calls.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "comment" && call.includes("--repo") && call.includes("acme/repo"))).toBe(true);
  });

  it("rechecks the pull request immediately before publication", async () => {
    const commands = new FakeCommands();
    commands.changeBeforePublish = true;
    const result = await runCodeReview({ cwd: "/repo", target: { kind: "pull-request", value: "7" }, comment: true, effort: "medium" }, { commands, agents: new FakeAgents() });
    expect(result.status).toBe("incomplete");
    expect(result.commented).toBe(false);
    expect(commands.commentCount).toBe(0);
    expect(result.failures.some((failure) => failure.stage === "revalidation")).toBe(true);
  });

  it("returns structured incomplete output when comment publishing rejects", async () => {
    const commands = new FakeCommands();
    commands.rejectComment = true;
    const result = await runCodeReview({ cwd: "/repo", target: { kind: "pull-request", value: "7" }, comment: true, effort: "medium" }, { commands, agents: new FakeAgents() });
    expect(result.status).toBe("incomplete");
    expect(result.commented).toBe("unknown");
    expect(result.failures.some((failure) => failure.stage === "comment")).toBe(true);
  });

  it("blocks explicit publication when reviewer identity cannot be verified", async () => {
    const commands = new FakeCommands();
    commands.failIdentity = true;
    const result = await runCodeReview({ cwd: "/repo", target: { kind: "pull-request", value: "7" }, comment: true, effort: "medium" }, { commands, agents: new FakeAgents() });
    expect(result.status).toBe("incomplete");
    expect(result.commented).toBe(false);
    expect(commands.commentCount).toBe(0);
  });

  it("merges concurrent finder failures in configured lens order", async () => {
    const agents = new FakeAgents("finder:cross-file", false, ["finder:diff-correctness"]);
    const result = await runCodeReview(
      { cwd: "/repo", target, comment: false, effort: "medium" },
      { commands: new FakeCommands(), agents },
    );

    expect(result.status).toBe("incomplete");
    expect(result.failures.filter((failure) => failure.stage === "finders").map((failure) => failure.message)).toEqual([
      "diff-correctness: simulated reviewer failure",
      "cross-file: simulated reviewer failure",
    ]);
  });

  it("keeps a successful protocol retry complete and visible in progress usage", async () => {
    const progress: ReviewerProgressEvent[] = [];
    const agents = new FakeAgents(undefined, false, [], "finder:diff-correctness");
    const result = await runCodeReview(
      { cwd: "/repo", target, comment: false, effort: "low" },
      { commands: new FakeCommands(), agents, onProgress: (event) => { if (event.type !== "stage") progress.push(event); } },
    );

    expect(result.status).toBe("complete");
    expect(result.findings).toHaveLength(1);
    expect(progress.some((event) => event.type === "reviewer-retry" && event.role === "finder:diff-correctness")).toBe(true);
    expect(result.usage.find((usage) => usage.role === "finder:diff-correctness")).toEqual({
      role: "finder:diff-correctness",
      turns: 2,
      inputTokens: 20,
      outputTokens: 8,
      contextTokens: 20,
    });
  });

  it("emits verifier stage start and completion progress", async () => {
    const stages: string[] = [];
    await runCodeReview(
      { cwd: "/repo", target, comment: false, effort: "low" },
      { commands: new FakeCommands(), agents: new FakeAgents(), onProgress: (event) => { if (event.type === "stage") stages.push(event.message); } },
    );

    expect(stages.some((message) => message.startsWith("Starting verifier verification"))).toBe(true);
    expect(stages.some((message) => message.startsWith("Completed verifier verification"))).toBe(true);
  });

  it("reports incomplete when a required finder fails", async () => {
    const result = await runCodeReview(
      { cwd: "/repo", target, comment: false, effort: "medium" },
      { commands: new FakeCommands(), agents: new FakeAgents("finder:removed-behavior") },
    );
    expect(result.status).toBe("incomplete");
    expect(result.report).toContain("Review incomplete");
  });
});
