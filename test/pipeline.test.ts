import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { roleInvocation, runCodeReview } from "../src/pipeline.js";
import { MAX_DIFF_SHARD_BYTES } from "../src/diff-shards.js";
import { DEFAULT_INPUT_BUDGET_BYTES, DEFAULT_RESERVED_TOKENS } from "../src/input-budget.js";
import type { ReviewRoleConfig } from "../src/routing.js";
import type { AgentInvocation, AgentResult, AgentUsage, CommandResult, CommandRunner, PullRequestMetadata, ReviewAgentRunner, ReviewerProgressEvent, ReviewProgressEvent, ReviewSnapshot } from "../src/types.js";

const target = { kind: "branch", ref: "topic" } as const;

function fileDiff(path: string, additions: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${additions.length + 1} @@`,
    " context",
    ...additions.map((line) => `+${line}`),
    "",
  ].join("\n");
}

const tinyDiff = fileDiff("src/a.ts", ["export const value = 2;"]);
const normalDiff = fileDiff("src/auth.ts", [
  "export const token = 1;",
  "export const second = 2;",
  "export const third = 3;",
  "export const fourth = 4;",
  "export const fifth = 5;",
  "export const sixth = 6;",
]);
const smallDiff = `${fileDiff("src/a.ts", ["export const value = 2;"])}${fileDiff("src/b.ts", ["export const other = 3;"])}`;

function largeDiff(path: string, start: number): string {
  return fileDiff(path, Array.from({ length: 100 }, (_, index) => `changed-${start + index}-${"x".repeat(300)}`));
}

function snapshot(diff: string, changedPaths: readonly string[] = ["src/a.ts"]): ReviewSnapshot {
  return { target, cwd: "/repo", changedPaths, diff, snapshotHash: `hash:${diff}` };
}

const pullRequestTarget = { kind: "pull-request", value: "7" } as const;

function pullRequestMetadata(overrides: Partial<PullRequestMetadata> = {}): PullRequestMetadata {
  return {
    number: 7,
    title: "Change",
    body: "",
    state: "OPEN",
    isDraft: false,
    authorLogin: "author",
    url: "https://github.com/acme/repo/pull/7",
    baseSha: "base",
    headSha: "head",
    repository: "acme/repo",
    changedPaths: ["src/a.ts"],
    comments: [],
    reviewerLogin: "reviewer",
    reviewerIdentityAvailable: true,
    ...overrides,
  };
}

function pullRequestSnapshot(overrides: Partial<PullRequestMetadata> = {}, diff = tinyDiff): ReviewSnapshot {
  const pullRequest = pullRequestMetadata(overrides);
  const snapshotHash = createHash("sha256").update(JSON.stringify({
    target: pullRequestTarget,
    diff,
    paths: pullRequest.changedPaths,
    revision: {
      repository: pullRequest.repository,
      number: pullRequest.number,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
    },
  })).digest("hex");
  return { target: pullRequestTarget, cwd: "/repo", changedPaths: pullRequest.changedPaths, diff, snapshotHash, pullRequest };
}

class NoopCommands implements CommandRunner {
  public readonly calls: string[][] = [];
  public async run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

class PullRequestCommands implements CommandRunner {
  public readonly calls: string[][] = [];
  public commentCount = 0;
  public rejectComment = false;
  public unknownComment = false;
  public existingReviewOnPublish = false;
  public changeBeforePublish = false;
  private prViewCount = 0;
  private prDiffCount = 0;

  public async run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      this.prViewCount += 1;
      const comments = this.existingReviewOnPublish && this.prViewCount >= 1
        ? [{ body: "### Code review\n\nAlready reviewed.", author: { login: "reviewer" } }]
        : [];
      return { stdout: JSON.stringify({
        number: 7, title: "Change", body: "", state: "OPEN", isDraft: false,
        author: { login: "author" }, url: "https://github.com/acme/repo/pull/7",
        baseRefOid: "base", headRefOid: "head", repository: { nameWithOwner: "acme/repo" },
        files: [{ path: "src/a.ts" }], comments,
      }), stderr: "", exitCode: 0 };
    }
    if (command === "gh" && args[0] === "api" && args[1] === "user") {
      return { stdout: "reviewer\n", stderr: "", exitCode: 0 };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "diff") {
      this.prDiffCount += 1;
      const diff = this.changeBeforePublish && this.prDiffCount >= 1 ? `${tinyDiff}+changed-again\n` : tinyDiff;
      return { stdout: diff, stderr: "", exitCode: 0 };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "comment") {
      if (this.rejectComment) throw new Error("comment transport failed");
      if (this.unknownComment) return { stdout: "", stderr: "publication canceled", exitCode: 1, canceled: true };
      this.commentCount += 1;
      return { stdout: "commented", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: command === "git" ? 0 : 1 };
  }
}

class RecordingAgents implements ReviewAgentRunner {
  public readonly calls: AgentInvocation[] = [];
  public readonly usages: AgentUsage[] = [];
  public candidateNeedsContext = false;
  public candidateFile = "src/a.ts";
  public candidateCount = 1;
  public summaryText = "A bounded change summary";
  public verdict: { disposition: "CONFIRMED" | "PLAUSIBLE" | "REFUTED"; confidence: number } = { disposition: "CONFIRMED", confidence: 95 };
  public failRoles = new Set<string>();
  public retryRoles = new Set<string>();
  public maxActiveValidators = 0;
  private activeValidators = 0;

  public async run<T>(invocation: AgentInvocation, validate: (value: unknown) => T, _signal?: AbortSignal, onProgress?: (event: ReviewerProgressEvent) => void): Promise<AgentResult<T>> {
    this.calls.push(invocation);
    if (this.failRoles.has(invocation.role)) throw new Error(`${invocation.role} failed`);
    let value: unknown;
    if (invocation.role === "summary") {
      value = { summary: this.summaryText };
    } else if (invocation.role === "validator") {
      this.activeValidators += 1;
      this.maxActiveValidators = Math.max(this.maxActiveValidators, this.activeValidators);
      await new Promise((resolve) => setTimeout(resolve, 0));
      this.activeValidators -= 1;
      const candidateId = /"id":"([^"]+)"/u.exec(invocation.prompt)?.[1] ?? "missing";
      value = { candidateId, ...this.verdict, verification: "The supplied changed hunk establishes the failure." };
    } else {
      const candidates = Array.from({ length: this.candidateCount }, (_, index) => ({
        id: `${invocation.role}-candidate-${index}`,
        rootCauseKey: `${invocation.role}:root:${index}`,
        file: this.candidateFile,
        line: index + 2,
        summary: `${invocation.role} issue ${index}`,
        failureScenario: `The ${invocation.role} issue can fail`,
        evidence: "The changed line establishes the suspicion.",
        category: "correctness",
        severity: "high",
        needsContext: this.candidateNeedsContext && invocation.role === "diff-only-bug",
      }));
      value = { candidates };
    }
    const data = validate(value);
    const retried = this.retryRoles.has(invocation.role);
    if (retried) onProgress?.({ type: "reviewer-retry", role: invocation.role, attempt: 2, usage: { role: invocation.role, turns: 2, inputTokens: 20, outputTokens: 10, contextTokens: 20 } });
    const usage = { role: invocation.role, turns: retried ? 2 : 1, inputTokens: retried ? 20 : 10, outputTokens: retried ? 10 : 5, contextTokens: 20 };
    this.usages.push(usage);
    return { data, usage };
  }
}

class ControlledAgents extends RecordingAgents {
  public activeReviewers = 0;
  public maxActiveReviewers = 0;
  public delayMs = 1;

  public override async run<T>(invocation: AgentInvocation, validate: (value: unknown) => T, signal?: AbortSignal, onProgress?: (event: ReviewerProgressEvent) => void): Promise<AgentResult<T>> {
    if (invocation.role !== "summary") {
      this.activeReviewers += 1;
      this.maxActiveReviewers = Math.max(this.maxActiveReviewers, this.activeReviewers);
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return await super.run(invocation, validate, signal, onProgress);
    } finally {
      if (invocation.role !== "summary") this.activeReviewers -= 1;
    }
  }
}

class RetryAdmissionAgents extends RecordingAgents {
  public readonly admissions: boolean[] = [];

  public override async run<T>(invocation: AgentInvocation, validate: (value: unknown) => T, signal?: AbortSignal, onProgress?: (event: ReviewerProgressEvent) => void): Promise<AgentResult<T>> {
    const result = await super.run(invocation, validate, signal, onProgress);
    if (invocation.role === "diff-only-bug" && invocation.retryAdmission !== undefined) {
      this.admissions.push(await invocation.retryAdmission());
    }
    return result;
  }
}

function dependencies(agents: RecordingAgents, commands = new NoopCommands()) {
  return { commands, agents };
}

describe("runCodeReview deterministic topology", () => {
  it("forwards a role's configured input and reserve budgets to the agent", async () => {
    const agents = new RecordingAgents();
    const rolePlan: ReviewRoleConfig = {
      tools: [],
      maxTurns: 1,
      contextBudget: 100_000,
      inputBudgetBytes: 12_345,
      reservedTokens: 7_000,
      candidateCap: 1,
      modelRoute: { model: "provider/model", thinking: "high" },
    };

    const invocation = roleInvocation(
      "diff-only-bug",
      rolePlan,
      (inputBudgetBytes) => `prompt-${inputBudgetBytes}`,
      "/repo",
      dependencies(agents),
    );
    await agents.run(invocation, (value) => value);

    expect(agents.calls[0]).toMatchObject({
      inputBudgetBytes: 12_345,
      reservedTokens: 7_000,
      contextBudget: 64_000,
      prompt: "prompt-12345",
    });
  });

  it("treats a malformed root routing config as incomplete before invoking agents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-code-review-config-"));
    try {
      await writeFile(join(cwd, ".pi-code-review.json"), "{ malformed");
      const agents = new RecordingAgents();
      const result = await runCodeReview({ cwd, target, comment: false, effort: "normal", snapshot: { ...snapshot(tinyDiff), cwd } }, dependencies(agents));
      expect(result.status).toBe("incomplete");
      expect(result.failures[0]?.stage).toBe("eligibility");
      expect(agents.calls).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("shards oversized immutable diffs without running a summary reviewer", async () => {
    const agents = new RecordingAgents();
    agents.candidateCount = 0;
    const diff = `${largeDiff("src/first.ts", 1)}${largeDiff("src/second.ts", 1000)}`;
    const result = await runCodeReview({
      cwd: "/repo",
      target,
      comment: false,
      effort: "normal",
      snapshot: snapshot(diff, ["src/first.ts", "src/second.ts"]),
    }, dependencies(agents));

    expect(result.status).toBe("complete");
    expect(result.coverage?.mode).toBe("sharded");
    expect(result.coverage?.state).toBe("complete");
    expect(agents.calls.filter((call) => call.role === "summary")).toHaveLength(0);
    expect(agents.calls.filter((call) => call.role === "diff-only-bug").length).toBeGreaterThan(1);
    expect(agents.calls.filter((call) => call.role === "validator")).toHaveLength(0);
  });

  it("uses a stable diff-first subset under a partial sharded work limit", async () => {
    const agents = new RecordingAgents();
    agents.candidateCount = 0;
    const diff = `${largeDiff("src/first.ts", 1)}${largeDiff("src/second.ts", 1000)}`;
    const result = await runCodeReview({
      cwd: "/repo",
      target,
      comment: false,
      effort: "normal",
      maxReviewWorkUnits: 1,
      workLimitPolicy: "partial",
      snapshot: snapshot(diff, ["src/first.ts", "src/second.ts"]),
    }, dependencies(agents));

    expect(result.status).toBe("incomplete");
    expect(result.coverage?.mode).toBe("sharded");
    expect(result.coverage?.uncoveredUnitIds.length).toBeGreaterThan(0);
    expect(agents.calls.filter((call) => call.role === "diff-only-bug")).toHaveLength(1);
    expect(agents.calls.find((call) => call.role === "diff-only-bug")?.prompt).toContain("src/first.ts");
  });

  it("keeps the fitting topology when the diff exceeds the shard target but its exact prompt fits", async () => {
    const agents = new RecordingAgents();
    agents.candidateCount = 0;
    const diff = fileDiff("src/a.ts", ["x".repeat(MAX_DIFF_SHARD_BYTES + 1)]);
    expect(Buffer.byteLength(diff, "utf8")).toBeGreaterThan(MAX_DIFF_SHARD_BYTES);

    const result = await runCodeReview({
      cwd: "/repo",
      target,
      comment: false,
      effort: "normal",
      snapshot: snapshot(diff),
    }, dependencies(agents));

    expect(result.status).toBe("complete");
    expect(result.coverage).toMatchObject({ mode: "single", sharded: false, state: "complete" });
    expect(agents.calls.map((call) => call.role)).toEqual(["diff-only-bug"]);
    const finder = agents.calls[0]!;
    expect(Buffer.byteLength(finder.prompt, "utf8")).toBeLessThanOrEqual(finder.inputBudgetBytes!);
  });

  it("uses only diff-only-bug for tiny changes and leaves summary empty", async () => {
    const agents = new RecordingAgents();
    const result = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(tinyDiff) }, dependencies(agents));

    expect(result.status).toBe("complete");
    expect(result.summary).toBe("");
    expect(result.report).not.toContain("A bounded change summary");
    expect(agents.calls.map((call) => call.role)).toEqual(["diff-only-bug", "validator"]);
    expect(agents.calls[0]).toMatchObject({ tools: [], model: "openai-codex/gpt-5.6-luna", thinking: "high", maxTurns: 4, contextBudget: 64_000, inputBudgetBytes: 64_000, reservedTokens: DEFAULT_RESERVED_TOKENS });
    expect(agents.calls[1]).toMatchObject({ role: "validator", tools: [], model: "openai-codex/gpt-5.6-sol", thinking: "high", maxTurns: 6, contextBudget: 64_000, inputBudgetBytes: 64_000, reservedTokens: DEFAULT_RESERVED_TOKENS });
  });

  it("supplies bounded nearby source to validators without allowing traversal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-code-review-source-"));
    const outsideName = `pi-code-review-outside-${Date.now()}.ts`;
    const outsidePath = join(cwd, "..", outsideName);
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "a.ts"), [
        "const sourceBeforeDiff = true;",
        "export const value = 2;",
        "const sourceAfterDiff = true;",
      ].join("\n"));
      const agents = new RecordingAgents();
      agents.candidateFile = "src/a.ts";
      const safe = await runCodeReview({ cwd, target, comment: false, effort: "normal", snapshot: { ...snapshot(tinyDiff), cwd } }, dependencies(agents));
      expect(safe.status).toBe("complete");
      const safeValidator = agents.calls.find((call) => call.role === "validator")!;
      expect(safeValidator.tools).toEqual([]);
      expect(safeValidator.prompt).toContain("sourceBeforeDiff");
      expect(safeValidator.prompt).toContain("sourceAfterDiff");

      const secret = "must not be read outside the review root";
      await writeFile(outsidePath, secret);
      const traversalPath = `../${outsideName}`;
      const traversalAgents = new RecordingAgents();
      traversalAgents.candidateFile = traversalPath;
      const traversalDiff = fileDiff(traversalPath, ["changed traversal candidate"]);
      const traversal = await runCodeReview({
        cwd,
        target,
        comment: false,
        effort: "normal",
        snapshot: { ...snapshot(traversalDiff, [traversalPath]), cwd },
      }, dependencies(traversalAgents));
      expect(traversal.status).toBe("complete");
      const traversalValidator = traversalAgents.calls.find((call) => call.role === "validator")!;
      expect(traversalValidator.prompt).not.toContain(secret);
      expect(traversalValidator.prompt).toContain("+changed traversal candidate");
    } finally {
      await rm(outsidePath, { force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs every reviewer from the immutable snapshot checkout", async () => {
    const worktree = "/repo/.worktrees/topic";
    const agents = new RecordingAgents();
    const result = await runCodeReview({
      cwd: "/repo",
      target: { kind: "worktree", path: worktree },
      comment: false,
      effort: "normal",
      snapshot: { ...snapshot(tinyDiff), target: { kind: "worktree", path: worktree }, cwd: worktree },
    }, dependencies(agents));

    expect(result.status).toBe("complete");
    expect(agents.calls.length).toBeGreaterThan(0);
    expect(agents.calls.every((call) => call.cwd === worktree)).toBe(true);
  });

  it("uses routed normal-role models and thinking without an override", async () => {
    const agents = new RecordingAgents();
    agents.candidateFile = "src/auth.ts";
    const result = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(normalDiff, ["src/auth.ts"]) }, dependencies(agents));

    expect(result.status).toBe("complete");
    for (const role of ["summary", "guidance-a", "guidance-b"] as const) {
      expect(agents.calls.find((call) => call.role === role)).toMatchObject({ model: "openai-codex/gpt-5.6-luna", thinking: "high" });
    }
    for (const role of ["diff-only-bug", "contextual-bug"] as const) {
      expect(agents.calls.find((call) => call.role === role)).toMatchObject({ model: "openai-codex/gpt-5.6-luna", thinking: role === "contextual-bug" ? "xhigh" : "high" });
    }
    expect(agents.calls.find((call) => call.role === "validator")).toMatchObject({ model: "openai-codex/gpt-5.6-sol", thinking: "high" });
  });

  it("runs one small guidance pass and one contextual escalation without recursion", async () => {
    const agents = new RecordingAgents();
    agents.candidateNeedsContext = true;
    agents.candidateCount = 1;
    const result = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(smallDiff, ["src/a.ts", "src/b.ts"]) }, dependencies(agents));

    expect(result.status).toBe("complete");
    expect(agents.calls.filter((call) => call.role === "guidance-a")).toHaveLength(1);
    expect(agents.calls.filter((call) => call.role === "contextual-bug")).toHaveLength(1);
    expect(agents.calls.filter((call) => call.role === "summary")).toHaveLength(0);
    expect(agents.calls.filter((call) => call.role === "validator")).toHaveLength(3);
    const escalation = agents.calls.find((call) => call.role === "contextual-bug")!;
    expect(escalation.tools).toEqual(["read", "grep"]);
    expect(escalation.prompt).toContain("diff-only-bug:root:0:0");
    expect(escalation.prompt).not.toContain("guidance-a:root:0:0");
  });

  it("runs normal roles after a cheap summary in parallel and deep adds one integration role", async () => {
    const normalAgents = new RecordingAgents();
    normalAgents.candidateCount = 1;
    const normal = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(normalDiff, ["src/auth.ts"]) }, dependencies(normalAgents));
    expect(normal.status).toBe("complete");
    expect(normalAgents.calls.slice(0, 5).map((call) => call.role)).toEqual(["summary", "guidance-a", "guidance-b", "diff-only-bug", "contextual-bug"]);
    expect(normalAgents.calls.find((call) => call.role === "summary")).toMatchObject({ tools: [], maxTurns: 3, contextBudget: 64_000, inputBudgetBytes: 64_000, reservedTokens: DEFAULT_RESERVED_TOKENS });

    const deepAgents = new RecordingAgents();
    const deep = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "deep", snapshot: snapshot(tinyDiff) }, dependencies(deepAgents));
    expect(deep.status).toBe("complete");
    expect(deepAgents.calls.slice(0, 6).map((call) => call.role)).toEqual(["summary", "guidance-a", "guidance-b", "diff-only-bug", "contextual-bug", "integration"]);
    expect(deepAgents.calls.find((call) => call.role === "integration")).toMatchObject({ tools: ["read", "grep"], thinking: "xhigh", maxTurns: 16, contextBudget: 64_000, inputBudgetBytes: 64_000, reservedTokens: DEFAULT_RESERVED_TOKENS });
  });

  it("bounds fitting deep reviewer activity to four concurrent invocations", async () => {
    const agents = new ControlledAgents();
    agents.candidateCount = 0;
    const result = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "deep", snapshot: snapshot(normalDiff, ["src/auth.ts"]) }, dependencies(agents));

    expect(result.status).toBe("complete");
    expect(agents.maxActiveReviewers).toBeLessThanOrEqual(4);
  });

  it("rejects fitting fixed work before launching any reviewer", async () => {
    const agents = new RecordingAgents();
    const result = await runCodeReview({
      cwd: "/repo",
      target: pullRequestTarget,
      comment: true,
      effort: "deep",
      maxReviewWorkUnits: 1,
      workLimitPolicy: "reject",
      snapshot: pullRequestSnapshot(),
    }, dependencies(agents));

    expect(result.status).toBe("incomplete");
    expect(result.commented).toBe(false);
    expect(agents.calls).toEqual([]);
    expect(result.coverage).toMatchObject({ mode: "single", state: "incomplete", workLimitPolicy: "reject", budgetMaxWeight: 1 });
    expect(result.coverage?.uncoveredUnitIds.length).toBeGreaterThan(0);
  });

  it("selects fitting primary diff work first under a partial work limit", async () => {
    const agents = new RecordingAgents();
    agents.candidateCount = 0;
    const result = await runCodeReview({
      cwd: "/repo",
      target,
      comment: false,
      effort: "normal",
      maxReviewWorkUnits: 1,
      workLimitPolicy: "partial",
      snapshot: snapshot(normalDiff, ["src/auth.ts"]),
    }, dependencies(agents));

    expect(result.status).toBe("incomplete");
    expect(agents.calls.map((call) => call.role)).toEqual(["diff-only-bug"]);
    expect(result.coverage).toMatchObject({ mode: "single", state: "incomplete", workLimitPolicy: "partial", budgetMaxWeight: 1, budgetSpentWeight: 1 });
    expect(result.coverage?.coveredUnitIds).toHaveLength(1);
    expect(result.coverage?.uncoveredUnitIds.length).toBeGreaterThan(0);
  });

  it("forwards fitting retry admission and charges both attempts", async () => {
    const agents = new RetryAdmissionAgents();
    agents.candidateCount = 0;
    const result = await runCodeReview({
      cwd: "/repo",
      target,
      comment: false,
      effort: "normal",
      maxReviewWorkUnits: 2,
      workLimitPolicy: "partial",
      snapshot: snapshot(tinyDiff),
    }, dependencies(agents));

    expect(result.status).toBe("complete");
    expect(agents.admissions).toEqual([true]);
    expect(result.coverage?.budget).toEqual({ maxWeight: 2, reservedWeight: 0, spentWeight: 2 });
    const diffUnit = result.coverage?.attempts === undefined ? undefined : Object.entries(result.coverage.attempts).find(([id]) => id.includes(":work:diff:"));
    expect(diffUnit?.[1]).toBe(2);
  });

  it("fails final fitting finder preflight when the summary expands the context", async () => {
    const agents = new RecordingAgents();
    agents.candidateCount = 0;
    agents.summaryText = "summary-context-".repeat(6_000);
    const result = await runCodeReview({
      cwd: "/repo",
      target,
      comment: false,
      effort: "normal",
      snapshot: snapshot(normalDiff, ["src/auth.ts"]),
    }, dependencies(agents));

    expect(result.status).toBe("incomplete");
    expect(agents.calls.map((call) => call.role)).toEqual(["summary"]);
    expect(result.coverage?.state).toBe("incomplete");
    expect(result.failures.filter((failure) => failure.stage === "finders").length).toBeGreaterThan(0);
    expect(result.report).not.toContain("No issues found");
  });

  it("allows only the model override while resolving every routed budget", async () => {
    const agents = new RecordingAgents();
    await runCodeReview({ cwd: "/repo", target, comment: false, effort: "deep", snapshot: snapshot(tinyDiff) }, { ...dependencies(agents), reviewerModel: "provider/override" });
    expect(agents.calls.every((call) => call.model === "provider/override")).toBe(true);
    expect(agents.calls.find((call) => call.role === "contextual-bug")).toMatchObject({ tools: ["read", "grep"], maxTurns: 16, contextBudget: 64_000, inputBudgetBytes: 64_000, reservedTokens: DEFAULT_RESERVED_TOKENS });
    expect(agents.calls.find((call) => call.role === "validator")).toMatchObject({ tools: [], maxTurns: 6, contextBudget: 64_000, inputBudgetBytes: 64_000, reservedTokens: DEFAULT_RESERVED_TOKENS });
  });

  it("resolves known and unknown model windows before forwarding bounded prompts", async () => {
    const knownAgents = new RecordingAgents();
    knownAgents.candidateFile = "src/auth.ts";
    const resolvedModels: string[] = [];
    const known = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(normalDiff, ["src/auth.ts"]) }, {
      ...dependencies(knownAgents),
      resolveModelContextWindow: (model) => {
        resolvedModels.push(model);
        return model === "openai-codex/gpt-5.6-sol" ? 100_000 : 80_000;
      },
    });
    expect(known.status).toBe("complete");
    expect(new Set(resolvedModels)).toEqual(new Set(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"]));
    const knownFinder = knownAgents.calls.find((call) => call.role === "diff-only-bug")!;
    expect(knownFinder).toMatchObject({ contextBudget: 48_000, inputBudgetBytes: 48_000, reservedTokens: DEFAULT_RESERVED_TOKENS });
    expect(Buffer.byteLength(knownFinder.prompt, "utf8")).toBeLessThanOrEqual(knownFinder.inputBudgetBytes!);
    const knownValidator = knownAgents.calls.find((call) => call.role === "validator")!;
    expect(knownValidator).toMatchObject({ contextBudget: 68_000, inputBudgetBytes: DEFAULT_INPUT_BUDGET_BYTES, reservedTokens: DEFAULT_RESERVED_TOKENS });
    expect(Buffer.byteLength(knownValidator.prompt, "utf8")).toBeLessThanOrEqual(knownValidator.inputBudgetBytes!);

    const unknownAgents = new RecordingAgents();
    const unknownModels: string[] = [];
    const unknown = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(tinyDiff) }, {
      ...dependencies(unknownAgents),
      resolveModelContextWindow: (model) => {
        unknownModels.push(model);
        return undefined;
      },
    });
    expect(unknown.status).toBe("complete");
    expect(unknownModels).toEqual(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"]);
    expect(unknownAgents.calls.every((call) => call.contextBudget === 64_000 && call.inputBudgetBytes === 64_000 && call.reservedTokens === DEFAULT_RESERVED_TOKENS)).toBe(true);
  });

  it("fails closed for an insufficient explicit model before spawning any reviewer", async () => {
    const agents = new RecordingAgents();
    const resolvedModels: string[] = [];
    const result = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(normalDiff, ["src/auth.ts"]) }, {
      ...dependencies(agents),
      reviewerModel: "provider/tiny",
      resolveModelContextWindow: (model) => {
        resolvedModels.push(model);
        return DEFAULT_RESERVED_TOKENS;
      },
    });

    expect(result.status).toBe("incomplete");
    expect(new Set(resolvedModels)).toEqual(new Set(["provider/tiny"]));
    expect(result.report).toContain("Review incomplete:");
    expect(result.report).not.toContain("No issues found");
    expect(result.failures.map((failure) => failure.stage)).toEqual([
      "summary",
      "finders",
      "finders",
      "finders",
      "finders",
    ]);
    expect(agents.calls).toEqual([]);
  });

  it("captures prompt input-limit failures as stable finder failures", async () => {
    const agents = new RecordingAgents();
    const result = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(normalDiff, ["src/auth.ts"]) }, {
      ...dependencies(agents),
      resolveModelContextWindow: () => DEFAULT_RESERVED_TOKENS + 1,
    });

    expect(result.status).toBe("incomplete");
    expect(result.failures[0]?.stage).toBe("summary");
    expect(result.failures.filter((failure) => failure.stage === "finders")).toHaveLength(4);
    expect(agents.calls).toEqual([]);
  });

  it("captures summary failures without reporting a clean review", async () => {
    const agents = new RecordingAgents();
    agents.failRoles.add("summary");
    const result = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(normalDiff, ["src/auth.ts"]) }, dependencies(agents));

    expect(result.status).toBe("incomplete");
    expect(result.failures[0]).toEqual({ stage: "summary", message: "summary failed" });
    expect(result.report).not.toContain("No issues found");
  });

  it("captures validator budget failures without invoking the validator", async () => {
    const agents = new RecordingAgents();
    const result = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(tinyDiff) }, {
      ...dependencies(agents),
      resolveModelContextWindow: (model) => model === "openai-codex/gpt-5.6-sol" ? DEFAULT_RESERVED_TOKENS : 100_000,
    });

    expect(result.status).toBe("incomplete");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("verification");
    expect(result.report).not.toContain("No issues found");
    expect(agents.calls.map((call) => call.role)).toEqual(["diff-only-bug"]);
  });

  it("validates each candidate independently with fixed concurrency and strict findings", async () => {
    const agents = new RecordingAgents();
    agents.candidateFile = "src/auth.ts";
    agents.candidateCount = 8;
    agents.verdict = { disposition: "PLAUSIBLE", confidence: 99 };
    const plausible = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(normalDiff, ["src/auth.ts"]) }, dependencies(agents));
    expect(plausible.status).toBe("complete");
    expect(agents.calls.filter((call) => call.role === "validator")).toHaveLength(16);
    expect(agents.maxActiveValidators).toBeLessThanOrEqual(4);
    expect(plausible.findings).toEqual([]);

    agents.verdict = { disposition: "CONFIRMED", confidence: 84 };
    const lowConfidence = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(normalDiff, ["src/auth.ts"]) }, dependencies(agents));
    expect(lowConfidence.findings).toEqual([]);
  });

  it("keeps pull-request reviews report-only unless publication is explicit", async () => {
    const commands = new PullRequestCommands();
    const result = await runCodeReview({ cwd: "/repo", target: pullRequestTarget, comment: false, effort: "normal", snapshot: pullRequestSnapshot() }, { commands, agents: new RecordingAgents() });

    expect(result.status).toBe("complete");
    expect(result.commented).toBe(false);
    expect(commands.commentCount).toBe(0);
    expect(commands.calls).toEqual([]);
  });

  it("publishes a pull-request report only for an explicit comment request", async () => {
    const commands = new PullRequestCommands();
    const result = await runCodeReview({ cwd: "/repo", target: pullRequestTarget, comment: true, effort: "normal", snapshot: pullRequestSnapshot() }, { commands, agents: new RecordingAgents() });

    expect(result.status).toBe("complete");
    expect(result.commented).toBe(true);
    expect(commands.commentCount).toBe(1);
    expect(commands.calls.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "comment" && call.includes("--repo") && call.includes("acme/repo"))).toBe(true);
  });

  it("rejects draft, automated, and already-reviewed pull requests before reviewer work", async () => {
    const cases: readonly [string, Partial<PullRequestMetadata>][] = [
      ["draft", { isDraft: true }],
      ["automated", { authorLogin: "dependabot[bot]" }],
      ["already reviewed", { comments: [{ body: "### Code review\\n\\nAlready reviewed.", authorLogin: "reviewer" }] }],
    ];
    for (const [label, metadata] of cases) {
      const agents = new RecordingAgents();
      const result = await runCodeReview({ cwd: "/repo", target: pullRequestTarget, comment: true, effort: "normal", snapshot: pullRequestSnapshot(metadata) }, dependencies(agents));
      expect(result.status, label).toBe("ineligible");
      expect(agents.calls, label).toEqual([]);
    }
  });

  it("only treats a code review by the current reviewer as an existing review", async () => {
    const agents = new RecordingAgents();
    const result = await runCodeReview({
      cwd: "/repo",
      target: pullRequestTarget,
      comment: false,
      effort: "normal",
      snapshot: pullRequestSnapshot({ comments: [
        { body: "### Code review\\n\\nOther reviewer report.", authorLogin: "someone-else" },
        { body: "General discussion", authorLogin: "reviewer" },
      ] }),
    }, dependencies(agents));

    expect(result.status).toBe("complete");
    expect(agents.calls.length).toBeGreaterThan(0);
  });

  it("does not publish a duplicate when a current-reviewer comment appears during review", async () => {
    const commands = new PullRequestCommands();
    commands.existingReviewOnPublish = true;
    const result = await runCodeReview({ cwd: "/repo", target: pullRequestTarget, comment: true, effort: "normal", snapshot: pullRequestSnapshot() }, { commands, agents: new RecordingAgents() });

    expect(result.status).toBe("incomplete");
    expect(result.commented).toBe(false);
    expect(result.failures.some((failure) => failure.stage === "comment" && failure.message.includes("duplicate"))).toBe(true);
    expect(commands.commentCount).toBe(0);
  });

  it("recaptures the pull request immediately before publication", async () => {
    const commands = new PullRequestCommands();
    commands.changeBeforePublish = true;
    const result = await runCodeReview({ cwd: "/repo", target: pullRequestTarget, comment: true, effort: "normal", snapshot: pullRequestSnapshot() }, { commands, agents: new RecordingAgents() });

    expect(result.status).toBe("incomplete");
    expect(result.commented).toBe(false);
    expect(result.failures.some((failure) => failure.stage === "revalidation")).toBe(true);
    expect(commands.commentCount).toBe(0);
  });

  it.each([
    ["rejected", "rejectComment", "comment transport failed"],
    ["unknown", "unknownComment", "canceled"],
  ] as const)("returns incomplete for %s publication outcomes", async (_label, mode, message) => {
    const commands = new PullRequestCommands();
    commands[mode] = true;
    const result = await runCodeReview({ cwd: "/repo", target: pullRequestTarget, comment: true, effort: "normal", snapshot: pullRequestSnapshot() }, { commands, agents: new RecordingAgents() });
    expect(result.status).toBe("incomplete");
    expect(result.commented).toBe("unknown");
    expect(result.failures.some((failure) => failure.stage === "comment" && failure.message.includes(message))).toBe(true);
  });

  it("does not publish when the current reviewer identity is unavailable", async () => {
    const commands = new PullRequestCommands();
    const result = await runCodeReview({
      cwd: "/repo",
      target: pullRequestTarget,
      comment: true,
      effort: "normal",
      snapshot: pullRequestSnapshot({ reviewerIdentityAvailable: false }),
    }, { commands, agents: new RecordingAgents() });

    expect(result.status).toBe("incomplete");
    expect(result.commented).toBe(false);
    expect(result.failures.some((failure) => failure.stage === "eligibility" && failure.message.includes("reviewer identity"))).toBe(true);
    expect(commands.commentCount).toBe(0);
  });

  it("keeps concurrent finder failures in primary-role order", async () => {
    const agents = new RecordingAgents();
    agents.failRoles.add("guidance-b");
    agents.failRoles.add("diff-only-bug");
    const result = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(normalDiff, ["src/auth.ts"]) }, dependencies(agents));

    expect(result.status).toBe("incomplete");
    expect(result.failures.filter((failure) => failure.stage === "finders").map((failure) => failure.message)).toEqual([
      "guidance-b: guidance-b failed",
      "diff-only-bug: diff-only-bug failed",
    ]);
  });

  it("keeps protocol retry progress and usage visible to the pipeline", async () => {
    const progress: ReviewProgressEvent[] = [];
    const agents = new RecordingAgents();
    agents.retryRoles.add("diff-only-bug");
    const result = await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(tinyDiff) }, { ...dependencies(agents), onProgress: (event) => progress.push(event) });

    expect(result.status).toBe("complete");
    expect(progress.some((event) => event.type === "reviewer-retry" && event.role === "diff-only-bug" && event.attempt === 2)).toBe(true);
    expect(result.usage.find((usage) => usage.role === "diff-only-bug")).toEqual({ role: "diff-only-bug", turns: 2, inputTokens: 20, outputTokens: 10, contextTokens: 20 });
  });

  it("emits candidate verification start and completion progress", async () => {
    const stages: string[] = [];
    await runCodeReview({ cwd: "/repo", target, comment: false, effort: "normal", snapshot: snapshot(tinyDiff) }, { ...dependencies(new RecordingAgents()), onProgress: (event) => { if (event.type === "stage") stages.push(event.message); } });

    expect(stages.some((message) => message.startsWith("Starting candidate validation for 1 finding"))).toBe(true);
    expect(stages.some((message) => message.startsWith("Completed candidate validation with 1 retained finding"))).toBe(true);
  });

  it("blocks publication when a required worker or validator fails", async () => {
    const agents = new RecordingAgents();
    agents.failRoles.add("diff-only-bug");
    const commands = new NoopCommands();
    const pullRequestSnapshot: ReviewSnapshot = {
      ...snapshot(tinyDiff),
      target: { kind: "pull-request", value: "7" },
      pullRequest: {
        number: 7, title: "Change", body: "", state: "OPEN", isDraft: false, authorLogin: "author", url: "https://example.test/7",
        baseSha: "base", headSha: "head", repository: "acme/repo", changedPaths: ["src/a.ts"], comments: [], reviewerIdentityAvailable: true,
      },
    };
    const workerFailure = await runCodeReview({ cwd: "/repo", target: pullRequestSnapshot.target, comment: true, effort: "normal", snapshot: pullRequestSnapshot }, dependencies(agents, commands));
    expect(workerFailure.status).toBe("incomplete");
    expect(workerFailure.commented).toBe(false);
    expect(commands.calls.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "comment")).toBe(false);

    const validatorAgents = new RecordingAgents();
    validatorAgents.failRoles.add("validator");
    const validatorFailure = await runCodeReview({ cwd: "/repo", target: pullRequestSnapshot.target, comment: true, effort: "normal", snapshot: pullRequestSnapshot }, dependencies(validatorAgents, new NoopCommands()));
    expect(validatorFailure.status).toBe("incomplete");
    expect(validatorFailure.commented).toBe(false);
  });
});
