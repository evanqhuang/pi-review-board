import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeCommandRunner } from "../src/commands.js";
import { getReviewStatus, recordReviewDispositions, runManagedReview, withLedgerLock } from "../src/lifecycle.js";
import type { AgentInvocation, AgentResult, ReviewAgentRunner } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture(): Promise<{ repo: string; plan: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-code-review-lifecycle-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  git(root, "init", "-b", "main", repo);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "src", "a.ts"), "export const value = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "checkout", "-b", "feature");
  await writeFile(join(repo, "src", "a.ts"), "export const value = 2;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "implementation");
  const plan = join(root, "plan.md");
  await writeFile(plan, [
    "# Plan", "", "## Review contract", "", "### Guarantees", "- The exported value changes safely.", "",
    "### Non-goals", "- Unrelated refactors.", "", "### Risk areas", "- Runtime correctness.", "",
    "### Required checks", "- `npm test`", "",
  ].join("\n"));
  return { repo, plan };
}

class FakeAgents implements ReviewAgentRunner {
  public candidates = true;
  public invalidCategory = false;
  public candidateSummary = "Exports the wrong value";
  public calls = 0;
  public readonly invocations: AgentInvocation[] = [];
  public onRun: (() => void) | undefined;

  public run<T>(invocation: AgentInvocation, validate: (value: unknown) => T): Promise<AgentResult<T>> {
    this.calls += 1;
    this.invocations.push(invocation);
    const onRun = this.onRun;
    this.onRun = undefined;
    onRun?.();
    let value: unknown;
    if (invocation.role === "summary") value = { summary: "Changes one exported value" };
    else if (invocation.role === "validator") {
      const candidateId = /"id":"([^"]+)"/u.exec(invocation.prompt)?.[1] ?? "missing";
      value = { candidateId, confidence: 95, verification: "The changed line deterministically returns the wrong value", disposition: "CONFIRMED" };
    } else value = this.candidates ? {
      candidates: [{
        id: "candidate-1", rootCauseKey: "exports:wrong-value", file: "src/a.ts", line: 1,
        summary: this.candidateSummary, failureScenario: "Importing the module returns the wrong value",
        evidence: "The changed line sets the incorrect constant", category: this.invalidCategory ? "" : "correctness", severity: "high", needsContext: false,
      }],
    } : { candidates: [] };
    return Promise.resolve({ data: validate(value), usage: { role: invocation.role, turns: 1, inputTokens: 1, outputTokens: 1, contextTokens: 2 } });
  }
}

describe("managed review lifecycle", () => {
  it("converges from an initial blocker through one remediation delta", async () => {
    const { repo, plan } = await fixture();
    const commands = new NodeCommandRunner();
    const agents = new FakeAgents();
    const dependencies = { commands, agents };
    const initial = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, dependencies);

    expect(initial.decision).toBe("awaiting-adjudication");
    expect(initial.phase).toBe("initial");
    expect(initial.findings[0]?.id).toBe("REV-001");
    expect(initial.reviewedSnapshotHash).toBeTruthy();
    expect(agents.invocations.every((invocation) => invocation.maxTurns > 0 && invocation.contextBudget > 0)).toBe(true);

    const blocked = await recordReviewDispositions({ cwd: repo, sessionId: initial.sessionId!, reviewedSnapshotHash: initial.reviewedSnapshotHash!, dispositions: [{ id: "REV-001", disposition: "confirmed-blocker", parentEvidence: "A focused reproduction returns the wrong value." }] }, dependencies);
    expect(blocked.decision).toBe("request-changes");

    await writeFile(join(repo, "src", "a.ts"), "export const value = 3;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "fix review finding");
    agents.candidates = false;
    const delta = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "deep", planPath: plan }, dependencies);
    expect(delta.phase).toBe("delta");
    expect(delta.decision).toBe("awaiting-adjudication");
    expect(delta.ledger?.remediationBatches).toBe(1);
    const approved = await recordReviewDispositions({ cwd: repo, sessionId: delta.sessionId!, reviewedSnapshotHash: delta.reviewedSnapshotHash!, dispositions: [{ id: "REV-001", disposition: "resolved", parentEvidence: "The remediation commit removes the reproduced behavior." }] }, dependencies);
    expect(approved.decision).toBe("approve");
  });

  it("resolves a relative plan path from the review checkout", async () => {
    const { repo } = await fixture();
    const result = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: "../plan.md" }, { commands: new NodeCommandRunner(), agents: new FakeAgents() });

    expect(result.status).toBe("complete");
    expect(result.sessionId).toBeTruthy();
  });

  it("rejects an unknown session ID instead of silently starting over", async () => {
    const { repo, plan } = await fixture();
    const agents = new FakeAgents();
    const calls = agents.calls;

    await expect(runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan, sessionId: "deadbeefcafe" }, { commands: new NodeCommandRunner(), agents })).rejects.toThrow("Review session not found");
    expect(agents.calls).toBe(calls);
  });

  it("does not let explicit phases repeat the comprehensive initial review", async () => {
    const { repo, plan } = await fixture();
    const commands = new NodeCommandRunner();
    const agents = new FakeAgents();
    agents.candidates = false;
    await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, { commands, agents });
    await writeFile(join(repo, "src", "a.ts"), "export const value = 4;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "follow-up change");
    const calls = agents.calls;

    await expect(runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "initial", effort: "normal", planPath: plan }, { commands, agents })).rejects.toThrow("next permitted phase is delta");
    expect(agents.calls).toBe(calls);
  });

  it("rejects an unknown disposition in the core ledger API", async () => {
    const { repo, plan } = await fixture();
    const dependencies = { commands: new NodeCommandRunner(), agents: new FakeAgents() };
    const initial = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, dependencies);

    await expect(recordReviewDispositions({ cwd: repo, sessionId: initial.sessionId!, reviewedSnapshotHash: initial.reviewedSnapshotHash!, dispositions: [{ id: "REV-001", disposition: "dismissed" as never }] }, dependencies)).rejects.toThrow("Unknown finding disposition");
  });

  it("does not let an initial candidate bypass remediation through resolved", async () => {
    const { repo, plan } = await fixture();
    const dependencies = { commands: new NodeCommandRunner(), agents: new FakeAgents() };
    const initial = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, dependencies);

    await expect(recordReviewDispositions({ cwd: repo, sessionId: initial.sessionId!, reviewedSnapshotHash: initial.reviewedSnapshotHash!, dispositions: [{ id: "REV-001", disposition: "resolved", parentEvidence: "No remediation exists yet." }] }, dependencies)).rejects.toThrow("reviewed remediation");
  });

  it("continues a planned review using only the returned session ID", async () => {
    const { repo, plan } = await fixture();
    const commands = new NodeCommandRunner();
    const agents = new FakeAgents();
    const dependencies = { commands, agents };
    const initial = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, dependencies);
    await recordReviewDispositions({ cwd: repo, sessionId: initial.sessionId!, reviewedSnapshotHash: initial.reviewedSnapshotHash!, dispositions: [{ id: "REV-001", disposition: "confirmed-blocker", parentEvidence: "Focused reproduction." }] }, dependencies);
    await writeFile(join(repo, "src", "a.ts"), "export const value = 5;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "session-only remediation");
    agents.candidates = false;

    const delta = await runManagedReview({ cwd: repo, requestedPhase: "auto", effort: "normal", sessionId: initial.sessionId! }, dependencies);
    expect(delta.phase).toBe("delta");
    expect(delta.sessionId).toBe(initial.sessionId);
    expect(delta.reviewedSnapshotHash).not.toBe(initial.reviewedSnapshotHash);
    expect(delta.ledger?.remediationBatches).toBe(1);
    await expect(getReviewStatus(repo, { commands }, { sessionId: initial.sessionId! })).resolves.toMatchObject({ target: { kind: "current-diff" }, lastReviewedSnapshotHash: delta.reviewedSnapshotHash });
  });

  it("keeps invalid worker output incomplete and never approves it", async () => {
    const { repo, plan } = await fixture();
    const agents = new FakeAgents();
    agents.invalidCategory = true;
    const result = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, { commands: new NodeCommandRunner(), agents });
    expect(result.status).toBe("incomplete");
    expect(result.ledger?.completedPasses).toBe(0);
    expect(result.report).toContain("neither an approval nor a blocker conclusion");
  });

  it("refuses to advance from a dirty worktree", async () => {
    const { repo, plan } = await fixture();
    await writeFile(join(repo, "src", "dirty.ts"), "export {};\n");
    const result = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, { commands: new NodeCommandRunner(), agents: new FakeAgents() });
    expect(result.status).toBe("incomplete");
    expect(result.report).toContain("clean committed worktree");
  });

  it("invalidates a pass when the committed checkout changes during review", async () => {
    const { repo, plan } = await fixture();
    const agents = new FakeAgents();
    agents.onRun = () => {
      writeFileSync(join(repo, "src", "a.ts"), "export const value = 99;\n");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "concurrent local change");
    };
    const result = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, { commands: new NodeCommandRunner(), agents });
    expect(result.status).toBe("incomplete");
    expect(result.ledger?.completedPasses).toBe(0);
    expect(result.report).toMatch(/checkout changed|reviewed head/i);
  });

  it("marks a completed review stale after uncommitted edits", async () => {
    const { repo, plan } = await fixture();
    const commands = new NodeCommandRunner();
    const agents = new FakeAgents();
    agents.candidates = false;
    const approved = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, { commands, agents });
    expect(approved.decision).toBe("approve");
    await writeFile(join(repo, "src", "dirty.ts"), "export {};\n");
    const status = await getReviewStatus(repo, { commands }, { sessionId: approved.sessionId! });
    expect(status?.stale).toBe(true);
    expect(status?.nextAction).toContain("worktree is dirty");
  });

  it("rejects dispositions after the approved plan changes", async () => {
    const { repo, plan } = await fixture();
    const dependencies = { commands: new NodeCommandRunner(), agents: new FakeAgents() };
    const initial = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, dependencies);
    await writeFile(plan, `${await readFile(plan, "utf8")}\n- Changed contract after review.\n`);
    const status = await getReviewStatus(repo, { commands: dependencies.commands }, { sessionId: initial.sessionId! });
    expect(status?.stale).toBe(true);
    await expect(recordReviewDispositions({ cwd: repo, sessionId: initial.sessionId!, reviewedSnapshotHash: initial.reviewedSnapshotHash!, dispositions: [{ id: "REV-001", disposition: "non-blocking" }] }, dependencies)).rejects.toThrow("approved plan changed");
  });

  it("does not permit a fourth bounded review pass", async () => {
    const { repo, plan } = await fixture();
    const commands = new NodeCommandRunner();
    const agents = new FakeAgents();
    const dependencies = { commands, agents };
    let result = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, dependencies);
    for (const [index, expectedPhase] of ["delta", "final"].entries()) {
      await recordReviewDispositions({ cwd: repo, sessionId: result.sessionId!, reviewedSnapshotHash: result.reviewedSnapshotHash!, dispositions: [{ id: "REV-001", disposition: "confirmed-blocker", parentEvidence: "Still reproduced." }] }, dependencies);
      await writeFile(join(repo, "src", "a.ts"), `export const value = ${index + 3};\n`);
      git(repo, "add", ".");
      git(repo, "commit", "-m", `remediation ${index + 1}`);
      result = await runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, dependencies);
      expect(result.phase).toBe(expectedPhase);
    }
    expect(result.ledger?.completedPasses).toBe(3);
    await recordReviewDispositions({ cwd: repo, sessionId: result.sessionId!, reviewedSnapshotHash: result.reviewedSnapshotHash!, dispositions: [{ id: "REV-001", disposition: "confirmed-blocker", parentEvidence: "Still reproduced." }] }, dependencies);
    const calls = agents.calls;
    await expect(runManagedReview({ cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "normal", planPath: plan }, dependencies)).rejects.toThrow(/blocked|fourth/i);
    expect(agents.calls).toBe(calls);
  });

  it("does not delete a live lock owned by another process", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-code-review-lock-"));
    roots.push(root);
    const ledgerPath = join(root, "session.json");
    const lockPath = `${ledgerPath}.lock`;
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    await expect(withLedgerLock(ledgerPath, async () => undefined)).rejects.toThrow("already active");
    await expect(access(lockPath)).resolves.toBeUndefined();
  });
});
