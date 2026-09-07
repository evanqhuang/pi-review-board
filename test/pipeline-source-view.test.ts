import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeCommandRunner } from "../src/commands.js";
import { collectValidatorSource, runCodeReview } from "../src/pipeline.js";
import { prepareReviewSourceView } from "../src/source-view.js";
import type { AgentInvocation, AgentResult, ReviewAgentRunner, ReviewSnapshot } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(deleted = false): Promise<{ repo: string; snapshot: ReviewSnapshot }> {
  const repo = await mkdtemp(join(tmpdir(), "review-source-integration-"));
  roots.push(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src/api.ts"), "export const legacy = 1;\n");
  await writeFile(join(repo, "src/consumer.ts"), "import { legacy } from './api';\n");
  await writeFile(join(repo, "AGENTS.md"), "MAIN_ONLY_GUIDANCE\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-b", "topic");
  if (deleted) await unlink(join(repo, "src/api.ts"));
  else await writeFile(join(repo, "src/api.ts"), "export const current = 2;\n");
  await writeFile(join(repo, "src/consumer.ts"), deleted ? "export const fallback = 2;\n" : "import { current } from './api';\n");
  await writeFile(join(repo, "AGENTS.md"), "HEAD_ONLY_GUIDANCE: Check the current consumer before asserting a missing export.\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "migrate export and consumer");
  const headSha = git(repo, "rev-parse", "HEAD");
  const diff = git(repo, "diff", `${baseSha}...${headSha}`);
  const changedPaths = git(repo, "diff", "--name-only", `${baseSha}...${headSha}`).split("\n");
  git(repo, "checkout", "main");
  await writeFile(join(repo, "untracked.txt"), "local only");
  return { repo, snapshot: {
    target: { kind: "pull-request", value: "7" }, cwd: repo, headSha, baseSha,
    snapshotHash: headSha, changedPaths, diff,
    pullRequest: { number: 7, title: "Migrate export", body: "", state: "OPEN", isDraft: false,
      authorLogin: "author", url: "https://github.com/acme/repo/pull/7", repository: "acme/repo",
      headSha, baseSha, changedPaths, comments: [], reviewerIdentityAvailable: false },
  } };
}

class PinnedAgents implements ReviewAgentRunner {
  public readonly calls: AgentInvocation[] = [];
  public constructor(private readonly originalRoot: string, private readonly mode: "success" | "error" | "cancel", private readonly abort: AbortController, private readonly deleted = false) {}

  public async run<T>(invocation: AgentInvocation, validate: (value: unknown) => T): Promise<AgentResult<T>> {
    this.calls.push(invocation);
    expect(invocation.cwd).not.toBe(this.originalRoot);
    expect(await readFile(join(invocation.cwd, "src/consumer.ts"), "utf8")).toContain(this.deleted ? "export const fallback" : "import { current }");
    expect(await readFile(join(invocation.cwd, "AGENTS.md"), "utf8")).toContain("HEAD_ONLY_GUIDANCE");
    await expect(access(join(invocation.cwd, "untracked.txt"))).rejects.toThrow();
    if (this.mode === "cancel") this.abort.abort();
    if (this.mode !== "success") throw new Error("fixture reviewer stopped");
    let value: unknown;
    if (invocation.role === "summary") value = { summary: "Export and consumer migrated together." };
    else if (invocation.role === "validator") {
      expect(invocation.prompt).toContain(this.deleted ? "File intentionally deleted at the captured revision" : "export const current = 2");
      const candidateId = /"id":"([^"]+)"/u.exec(invocation.prompt)?.[1];
      value = { candidateId, disposition: "REFUTED", confidence: 100, verification: "The captured consumer was migrated with the export." };
    } else {
      if (invocation.role.startsWith("guidance")) {
        const payload = JSON.parse(invocation.prompt.split("<review-input>\n")[1]!.split("\n</review-input>")[0]!);
        expect(JSON.stringify(payload.guidance)).toContain("HEAD_ONLY_GUIDANCE");
        expect(JSON.stringify(payload.guidance)).not.toContain("MAIN_ONLY_GUIDANCE");
      }
      value = { coverageComplete: true, candidates: invocation.role === "diff-only-bug" ? [{
        id: "export-change", rootCauseKey: "export-migration", file: "src/api.ts", line: 1,
        summary: "Check whether the removed export still has a consumer", failureScenario: "An unmigrated consumer imports the removed name",
        evidence: "The export name changes", category: "contract", severity: "high", needsContext: false,
      }] : [] };
    }
    return { data: validate(value), usage: { role: invocation.role, turns: 1, inputTokens: 1, outputTokens: 1, contextTokens: 2 } };
  }
}

describe("pipeline snapshot-pinned source boundary", () => {
  it.each(["success", "error", "cancel"] as const)("uses the PR head and cleans the source view after %s", async (mode) => {
    const { repo, snapshot } = await fixture();
    const before = git(repo, "status", "--porcelain");
    const abort = new AbortController();
    const agents = new PinnedAgents(repo, mode, abort);
    const result = await runCodeReview({ cwd: repo, target: snapshot.target, snapshot, comment: false, effort: "deep" },
      { commands: new NodeCommandRunner(), agents }, abort.signal);
    expect(agents.calls.length, result.report).toBeGreaterThan(0);
    for (const root of new Set(agents.calls.map((call) => call.cwd))) await expect(access(root)).rejects.toThrow();
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(git(repo, "status", "--porcelain")).toBe(before);
    expect(await readFile(join(repo, "src/consumer.ts"), "utf8")).toContain("import { legacy }");
    expect(result.status, result.report).toBe(mode === "success" ? "complete" : "incomplete");
    if (mode === "success") {
      expect(agents.calls.some((call) => call.role === "contextual-bug")).toBe(true);
      expect(agents.calls.some((call) => call.role === "validator")).toBe(true);
      expect(result.findings).toEqual([]);
    }
  });

  it("leaves validation uncovered when captured source disappears instead of falling back to the diff", async () => {
    const { repo, snapshot } = await fixture();
    const commands = new NodeCommandRunner();
    const agents = new PinnedAgents(repo, "success", new AbortController());
    const result = await runCodeReview({ cwd: repo, target: snapshot.target, snapshot, comment: false, effort: "deep" }, {
      commands, agents, prepareSourceView: async (captured, signal) => {
        const view = await prepareReviewSourceView(captured, commands, signal);
        await chmod(join(view.root, "src"), 0o755);
        await unlink(join(view.root, "src/api.ts"));
        return view;
      },
    });
    expect(result.status, result.report).toBe("incomplete");
    expect(result.report).toContain("Captured revision source could not be read");
    expect(agents.calls.some((call) => call.role === "validator")).toBe(false);
    expect(result.coverage?.uncoveredCandidates.length).toBeGreaterThan(0);
    await expect(access(agents.calls[0]!.cwd)).rejects.toThrow();
  });

  it("uses explicit deletion evidence rather than treating a deliberately absent file as a read failure", async () => {
    const { repo, snapshot } = await fixture(true);
    const agents = new PinnedAgents(repo, "success", new AbortController(), true);
    const result = await runCodeReview({ cwd: repo, target: snapshot.target, snapshot, comment: false, effort: "deep" },
      { commands: new NodeCommandRunner(), agents });
    expect(result.status, result.report).toBe("complete");
    expect(agents.calls.some((call) => call.role === "validator")).toBe(true);
  });

  it("fails closed for required source reads but preserves optional local source semantics", async () => {
    const { repo } = await fixture();
    expect(collectValidatorSource(repo, { file: "missing.ts", line: 1 })).toBeUndefined();
    for (const file of ["missing.ts", "src", "../outside.ts"]) {
      expect(() => collectValidatorSource(repo, { file, line: 1 }, { required: true })).toThrow("source could not be read");
    }
    expect(collectValidatorSource(repo, { file: "src/api.ts", line: 1 }, { required: true })).toContain("export const legacy");
  });

  it("fails before any reviewer when the pinned commit is unavailable", async () => {
    const { repo, snapshot } = await fixture();
    const headSha = "f".repeat(40);
    const missing = { ...snapshot, headSha, pullRequest: { ...snapshot.pullRequest!, headSha } };
    const agents = new PinnedAgents(repo, "success", new AbortController());
    const result = await runCodeReview({ cwd: repo, target: missing.target, snapshot: missing, comment: false, effort: "normal" },
      { commands: new NodeCommandRunner(), agents });
    expect(result.status).toBe("incomplete");
    expect(result.report).toContain("missing");
    expect(agents.calls).toHaveLength(0);
  });
});
