import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { NodeCommandRunner } from "../src/commands.js";
import { prepareReviewSourceView } from "../src/source-view.js";
import type { CommandResult, CommandRunner, ReviewSnapshot } from "../src/types.js";

const execFileAsync = promisify(execFile);
const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", exitCode: 0 });
const fullObject = "a".repeat(40);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, encoding: "utf8" });
  return String(result.stdout).trim();
}

async function gitFixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-source-fixture-"));
  await git(cwd, ["init", "-q", "-b", "main"]);
  await git(cwd, ["config", "user.email", "review@example.test"]);
  await git(cwd, ["config", "user.name", "Review Test"]);
  return cwd;
}

async function commitFixture(cwd: string, message = "captured"): Promise<string> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-qm", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function snapshot(cwd: string, headSha: string): ReviewSnapshot {
  const pullRequest = {
    number: 7,
    title: "source view",
    body: "",
    state: "OPEN",
    isDraft: false,
    authorLogin: "author",
    url: "https://github.com/acme/project/pull/7",
    baseSha: fullObject,
    headSha,
    repository: "acme/project",
    changedPaths: ["AGENTS.md", "src/data.bin"],
    comments: [],
    reviewerIdentityAvailable: false,
  } as const;
  return {
    target: { kind: "pull-request", value: "7" },
    cwd,
    changedPaths: pullRequest.changedPaths,
    diff: "captured diff",
    snapshotHash: "snapshot-hash",
    headSha,
    pullRequest,
  };
}

class ListedTreeCommands implements CommandRunner {
  public readonly calls: string[][] = [];
  public constructor(private readonly listing: string, private readonly commitResult: CommandResult = ok()) {}
  public run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args[0] === "cat-file") return Promise.resolve(this.commitResult);
    if (args[0] === "ls-tree") return Promise.resolve(ok(this.listing));
    return Promise.resolve({ stdout: "", stderr: "unexpected command", exitCode: 1 });
  }
}

function abortOnThirdListener(): AbortSignal {
  let isAborted = false;
  let registrations = 0;
  const callbacks = new Map<unknown, () => void>();
  const signal = {
    get aborted(): boolean {
      return isAborted;
    },
    addEventListener(type: string, listener: unknown): void {
      if (type !== "abort") return;
      const callback = (): void => {
        if (typeof listener === "function") listener(new Event("abort"));
        else if (listener !== null && typeof listener === "object" && "handleEvent" in listener && typeof listener.handleEvent === "function") listener.handleEvent(new Event("abort"));
      };
      callbacks.set(listener, callback);
      registrations += 1;
      if (registrations === 3) queueMicrotask(() => {
        isAborted = true;
        for (const registered of callbacks.values()) registered();
      });
    },
    removeEventListener(_type: string, listener: unknown): void {
      callbacks.delete(listener);
    },
  };
  return signal as unknown as AbortSignal;
}

describe("review source view", () => {
  it("materializes the exact PR commit, including binary content and tracked guidance only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-source-fixture-"));
    try {
      await git(cwd, ["init", "-q", "-b", "main"]);
      await git(cwd, ["config", "user.email", "review@example.test"]);
      await git(cwd, ["config", "user.name", "Review Test"]);
      const binary = Buffer.from([0, 255, 1, 2, 128, 13, 10]);
      await writeFile(join(cwd, "AGENTS.md"), "main guidance\n");
      await mkdir(join(cwd, "src"));
      await writeFile(join(cwd, "src/data.bin"), binary);
      await git(cwd, ["add", "."]);
      await git(cwd, ["commit", "-qm", "base"]);
      await git(cwd, ["checkout", "-qb", "pr"]);
      await writeFile(join(cwd, "AGENTS.md"), "captured PR guidance\n");
      await writeFile(join(cwd, "src/data.bin"), Buffer.from([0, 255, 9, 8, 128]));
      await git(cwd, ["add", "."]);
      await git(cwd, ["commit", "-qm", "pr"]);
      const head = await git(cwd, ["rev-parse", "HEAD"]);
      const expectedBinary = Buffer.from([0, 255, 9, 8, 128]);
      await writeFile(join(cwd, "AGENTS.md"), "dirty worktree guidance\n");
      await writeFile(join(cwd, "dirty.txt"), "dirty\n");
      await writeFile(join(cwd, "untracked.txt"), "untracked\n");
      const branchBefore = await git(cwd, ["branch", "--show-current"]);
      const statusBefore = await git(cwd, ["status", "--porcelain"]);

      const view = await prepareReviewSourceView(snapshot(cwd, head), new NodeCommandRunner());
      expect(view.root).not.toBe(cwd);
      expect(view.revision).toBe(head);
      await expect(readFile(join(view.root, "AGENTS.md"), "utf8")).resolves.toBe("captured PR guidance\n");
      await expect(readFile(join(view.root, "src/data.bin"))).resolves.toEqual(expectedBinary);
      await expect(stat(join(view.root, "dirty.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(view.root, "untracked.txt"))).rejects.toMatchObject({ code: "ENOENT" });

      await Promise.all([view.dispose(), view.dispose(), view.dispose()]);
      await expect(stat(view.root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await git(cwd, ["branch", "--show-current"])).toBe(branchBefore);
      expect(await git(cwd, ["status", "--porcelain"])).toBe(statusBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("materializes safe file and directory symlinks from the pinned tree", async () => {
    const cwd = await gitFixture();
    try {
      await mkdir(join(cwd, ".agents/skills/ship-and-verify-pr"), { recursive: true });
      await mkdir(join(cwd, ".claude/skills"), { recursive: true });
      await mkdir(join(cwd, "src/a/nested"), { recursive: true });
      await mkdir(join(cwd, "src/b"), { recursive: true });
      await writeFile(join(cwd, ".agents/file.txt"), "pinned file\n");
      await writeFile(join(cwd, ".agents/skills/ship-and-verify-pr/SKILL.md"), "pinned guidance\n");
      await writeFile(join(cwd, "src/a.ts"), "a\n");
      await writeFile(join(cwd, "src/b.ts"), "b\n");
      await writeFile(join(cwd, "src/a/nested/one.txt"), "one\n");
      await writeFile(join(cwd, "src/b/two.txt"), "two\n");
      await symlink(".agents/file.txt", join(cwd, "file-link"));
      await symlink("file-link", join(cwd, "file-chain"));
      await symlink("../../.agents/skills/ship-and-verify-pr", join(cwd, ".claude/skills/ship-and-verify-pr"));
      const head = await commitFixture(cwd);
      await writeFile(join(cwd, ".agents/file.txt"), "dirty caller file\n");
      await writeFile(join(cwd, ".agents/skills/ship-and-verify-pr/SKILL.md"), "dirty caller guidance\n");
      const statusBefore = await git(cwd, ["status", "--porcelain"]);

      const view = await prepareReviewSourceView(snapshot(cwd, head), new NodeCommandRunner());
      await expect(readFile(join(view.root, "file-link"), "utf8")).resolves.toBe("pinned file\n");
      await expect(readFile(join(view.root, "file-chain"), "utf8")).resolves.toBe("pinned file\n");
      await expect(readFile(join(view.root, ".claude/skills/ship-and-verify-pr/SKILL.md"), "utf8")).resolves.toBe("pinned guidance\n");
      await expect(lstat(join(view.root, "file-link"))).resolves.toSatisfy((value) => value.isSymbolicLink());
      await expect(readlink(join(view.root, ".claude/skills/ship-and-verify-pr"))).resolves.toBe("../../.agents/skills/ship-and-verify-pr");
      await expect(readFile(join(view.root, "src/a.ts"), "utf8")).resolves.toBe("a\n");
      await expect(readFile(join(view.root, "src/b.ts"), "utf8")).resolves.toBe("b\n");
      await expect(readFile(join(view.root, "src/a/nested/one.txt"), "utf8")).resolves.toBe("one\n");
      await expect(readFile(join(view.root, "src/b/two.txt"), "utf8")).resolves.toBe("two\n");
      await view.dispose();
      expect(await git(cwd, ["status", "--porcelain"])).toBe(statusBefore);
      await expect(lstat(join(cwd, ".claude/skills/ship-and-verify-pr"))).resolves.toSatisfy((value) => value.isSymbolicLink());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    ["escaping", "../outside", /escapes the source root/u],
    ["absolute", "/outside", /unsafe symlink target/u],
    ["backslash", "..\\outside", /unsafe symlink target/u],
    ["dangling", "missing.txt", /dangling symlink target/u],
  ])("rejects %s symlink targets", async (_name, target, message) => {
    const cwd = await gitFixture();
    try {
      await symlink(target, join(cwd, "link"));
      const head = await commitFixture(cwd);
      await expect(prepareReviewSourceView(snapshot(cwd, head), new NodeCommandRunner())).rejects.toThrow(message);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a symlink to an untracked caller file and symlink cycles", async () => {
    const cwd = await gitFixture();
    try {
      await writeFile(join(cwd, "untracked.txt"), "caller data\n");
      await symlink("untracked.txt", join(cwd, "untracked-link"));
      await git(cwd, ["add", "untracked-link"]);
      await git(cwd, ["commit", "-qm", "untracked link"]);
      const untrackedHead = await git(cwd, ["rev-parse", "HEAD"]);
      await expect(prepareReviewSourceView(snapshot(cwd, untrackedHead), new NodeCommandRunner())).rejects.toThrow(/dangling symlink target/u);

      await rm(join(cwd, "untracked-link"));
      await rm(join(cwd, "untracked.txt"));
      await symlink("cycle-b", join(cwd, "cycle-a"));
      await symlink("cycle-a", join(cwd, "cycle-b"));
      const cycleHead = await commitFixture(cwd, "cycle");
      await expect(prepareReviewSourceView(snapshot(cwd, cycleHead), new NodeCommandRunner())).rejects.toThrow(/symlink cycle/u);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns the live cwd for non-PR targets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-source-live-"));
    try {
      const view = await prepareReviewSourceView({
        target: { kind: "current-diff" },
        cwd,
        changedPaths: [],
        diff: "",
        snapshotHash: "hash",
      }, new NodeCommandRunner());
      expect(view.root).toBe(cwd);
      await view.dispose();
      await expect(stat(cwd)).resolves.toBeDefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects missing or mismatched captured heads before creating a source root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-source-head-"));
    try {
      const missing = new ListedTreeCommands("", { stdout: "", stderr: "not found", exitCode: 1 });
      await expect(prepareReviewSourceView(snapshot(cwd, fullObject), missing)).rejects.toThrow(/head commit .*missing.*no network fetch/u);
      const mismatch = snapshot(cwd, fullObject);
      const other = { ...mismatch, headSha: "b".repeat(40) };
      await expect(prepareReviewSourceView(other, new ListedTreeCommands(""))).rejects.toThrow(/does not match/u);

      const baseMismatch = { ...mismatch, baseSha: "b".repeat(40) };
      await expect(prepareReviewSourceView(baseMismatch, new ListedTreeCommands(""))).rejects.toThrow(/snapshot base .*does not match/u);

      const targetMetadataMismatch = {
        ...mismatch,
        target: { ...mismatch.target, metadata: { ...mismatch.pullRequest!, baseSha: "b".repeat(40) } },
      };
      await expect(prepareReviewSourceView(targetMetadataMismatch, new ListedTreeCommands(""))).rejects.toThrow(/metadata baseSha values conflict/u);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    ["unsafe path", "100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\t../outside\0", /unsafe tracked path/u],
    ["submodule", "160000 commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -\tmodule\0", /unsupported submodule/u],
    ["case collision", `100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\tReadme\0${"100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1\tREADME\0"}`, /case-insensitive path collision/u],
    ["Unicode-fold collision", `100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\tcafé.txt\0${"100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1\tcafe\u0301.txt\0"}`, /case-insensitive path collision/u],
    ["case-conflicting directories",  `100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\tSrc/A\0${"100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1\tsrc/B\0"}`, /case-insensitive path collision/u],
    ["file-directory conflict", `100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\tsrc\0${"100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1\tsrc/file\0"}`, /case-insensitive path collision/u],
    ["duplicate file", `100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\tdup\0${"100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1\tdup\0"}`, /case-insensitive path collision/u],
  ])("rejects %s entries", async (_name, listing, message) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-source-unsafe-"));
    try {
      await expect(prepareReviewSourceView(snapshot(cwd, fullObject), new ListedTreeCommands(listing))).rejects.toThrow(message);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("cleans a partially materialized root when blob reading is canceled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-source-cancel-"));
    try {
      await git(cwd, ["init", "-q"]);
      await git(cwd, ["config", "user.email", "review@example.test"]);
      await git(cwd, ["config", "user.name", "Review Test"]);
      await writeFile(join(cwd, "file.txt"), "captured\n");
      await git(cwd, ["add", "file.txt"]);
      await git(cwd, ["commit", "-qm", "captured"]);
      const head = await git(cwd, ["rev-parse", "HEAD"]);
      const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-review-source-")));
      await expect(prepareReviewSourceView(snapshot(cwd, head), new NodeCommandRunner(), abortOnThirdListener())).rejects.toThrow(/canceled/u);
      const after = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-review-source-")));
      expect(after).toEqual(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("enforces bounded listing and content limits and propagates cancellation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-source-limits-"));
    try {
      const listing = "100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 8\tfile.txt\0";
      await expect(prepareReviewSourceView(snapshot(cwd, fullObject), new ListedTreeCommands(listing), undefined, { maxFiles: 1, maxFileBytes: 4 })).rejects.toThrow(/per-file limit/u);
      await expect(prepareReviewSourceView(snapshot(cwd, fullObject), new ListedTreeCommands(listing), undefined, { maxFiles: 0 })).rejects.toThrow(/positive safe integer/u);
      const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-review-source-")));
      const missingBlob = "100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 8\tfile.txt\0";
      await expect(prepareReviewSourceView(snapshot(cwd, fullObject), new ListedTreeCommands(missingBlob))).rejects.toThrow(/unable to read committed blob/u);
      const after = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-review-source-")));
      expect(after).toEqual(before);
      const canceled = new ListedTreeCommands("", { stdout: "", stderr: "", exitCode: 130, canceled: true });
      const controller = new AbortController();
      controller.abort();
      await expect(prepareReviewSourceView(snapshot(cwd, fullObject), canceled, controller.signal)).rejects.toThrow(/canceled/u);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
