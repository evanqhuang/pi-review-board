import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReviewTarget, captureReviewSnapshot, hasExistingReview, hasSnapshotDrift } from "../src/targets.js";
import type { CommandResult, CommandRunner } from "../src/types.js";

class FakeCommands implements CommandRunner {
  public readonly calls: string[][] = [];
  public readonly cwds: string[] = [];
  public constructor(private readonly handler: (command: string, args: readonly string[]) => CommandResult) {}
  public run(command: string, args: readonly string[], options: { cwd: string }): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    this.cwds.push(options.cwd);
    return Promise.resolve(this.handler(command, args));
  }
}

const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr = "not found"): CommandResult => ({ stdout: "", stderr, exitCode: 1 });
const fileDiff = (path: string): string => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`;

describe("review targets", () => {
  it("resolves pull requests, paths, and branches without shell interpolation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-target-"));
    await writeFile(join(cwd, "file.ts"), "export const value = 1;");
    const commands = new FakeCommands((command, args) => command === "git" && args[0] === "rev-parse" && args.includes("topic^{commit}") ? ok("branch-sha\n") : fail());

    await expect(resolveReviewTarget("123", cwd, commands)).resolves.toEqual({ kind: "pull-request", value: "123" });
    await expect(resolveReviewTarget("https://github.com/acme/repo/pull/123?diff=split#files", cwd, commands)).resolves.toEqual({ kind: "pull-request", value: "https://github.com/acme/repo/pull/123?diff=split#files" });
    await expect(resolveReviewTarget("file.ts", cwd, commands)).resolves.toEqual({ kind: "path", path: "file.ts" });
    await expect(resolveReviewTarget("topic", cwd, commands)).resolves.toEqual({ kind: "branch", ref: "topic" });
    expect(commands.calls.every((call) => call[0] === "git")).toBe(true);

    await writeFile(join(cwd, "topic"), "path");
    await expect(resolveReviewTarget("topic", cwd, commands)).rejects.toThrow("Ambiguous review target");
  });

  it("resolves a Git worktree root separately from an ordinary directory path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-target-"));
    const worktreePath = join(cwd, ".worktrees", "topic");
    await mkdir(worktreePath, { recursive: true });
    const commands = new FakeCommands((command, args) => {
      if (command === "git" && args[0] === "-C" && args[1] === worktreePath && args[2] === "rev-parse" && args[3] === "--show-toplevel") {
        return ok(`${worktreePath}\n`);
      }
      return fail();
    });

    await expect(resolveReviewTarget(".worktrees/topic", cwd, commands)).resolves.toEqual({ kind: "worktree", path: worktreePath });
    expect(commands.calls).toContainEqual(["git", "-C", worktreePath, "rev-parse", "--show-toplevel"]);

    await mkdir(join(cwd, "src"));
    await expect(resolveReviewTarget("src", cwd, commands)).resolves.toEqual({ kind: "path", path: "src" });
  });

  it("captures and detects branch snapshot drift", async () => {
    let version = 1;
    const commands = new FakeCommands((command, args) => {
      if (command !== "git") return fail();
      if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("head-sha\n");
      if (args[0] === "rev-parse" && args[1] === "topic") return ok("topic-sha\n");
      if (args[0] === "diff" && args[1] === "--name-only") return ok("src/a.ts\n");
      if (args[0] === "diff") return ok(`diff-v${version}`);
      return fail();
    });
    const target = { kind: "branch", ref: "topic" } as const;
    const snapshot = await captureReviewSnapshot(target, "/repo", commands);
    expect(snapshot.changedPaths).toEqual(["src/a.ts"]);
    expect(await hasSnapshotDrift(snapshot, commands)).toBe(false);
    version = 2;
    expect(await hasSnapshotDrift(snapshot, commands)).toBe(true);
  });

  it("captures committed and working changes from a worktree root", async () => {
    const cwd = "/repo";
    const worktreePath = "/repo/.worktrees/topic";
    const commands = new FakeCommands((command, args) => {
      if (command !== "git") return fail();
      if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("head-sha\n");
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "@{upstream}") return ok("origin/topic\n");
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/topic^{commit}") return ok("base-sha\n");
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "origin/topic...HEAD") return ok("src/committed.ts\n");
      if (args[0] === "diff" && args[1] === "origin/topic...HEAD") return ok("committed diff");
      if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "HEAD") return ok("src/working.ts\n");
      if (args[0] === "diff" && args[1] === "HEAD") return ok("working diff");
      return fail();
    });

    const snapshot = await captureReviewSnapshot({ kind: "worktree", path: worktreePath }, cwd, commands);
    expect(snapshot.cwd).toBe(worktreePath);
    expect(snapshot.changedPaths).toEqual(["src/committed.ts", "src/working.ts"]);
    expect(snapshot.diff).toBe("committed diff\nworking diff");
    expect(snapshot.baseSha).toBe("base-sha");
    expect(commands.cwds.every((commandCwd) => commandCwd === worktreePath)).toBe(true);
  });

  it("ignores mutable pull request metadata during drift detection", async () => {
    let title = "Initial title";
    let comments: { body: string; author: { login: string } }[] = [];
    let headSha = "head-sha";
    let identityAvailable = true;
    const commands = new FakeCommands((command, args) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return ok(JSON.stringify({
          number: 7,
          title,
          body: "body",
          state: "OPEN",
          isDraft: false,
          author: { login: "human" },
          url: "https://github.com/acme/repo/pull/7",
          baseRefOid: "base-sha",
          headRefOid: headSha,
          files: [{ path: "src/a.ts" }],
          comments,
        }));
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "diff") return ok(fileDiff("src/a.ts"));
      if (command === "gh" && args[0] === "api" && args[1] === "user") return identityAvailable ? ok("reviewer\n") : fail("temporary auth failure");
      return fail();
    });
    const snapshot = await captureReviewSnapshot({ kind: "pull-request", value: "7" }, "/repo", commands);

    title = "Edited while reviewing";
    comments = [{ body: "unrelated comment", author: { login: "someone" } }];
    identityAvailable = false;
    expect(await hasSnapshotDrift(snapshot, commands)).toBe(false);

    headSha = "new-head-sha";
    expect(await hasSnapshotDrift(snapshot, commands)).toBe(true);
  });

  it.each(["headRefOid", "baseRefOid", "files"])("rejects %s drift between metadata and diff capture", async (field) => {
    let changed = false;
    const before = { number: 7, url: "https://github.com/acme/repo/pull/7", baseRefOid: "base-a", headRefOid: "head-a", files: [{ path: "src/a.ts" }] };
    const after = { ...before, [field]: field === "files" ? [{ path: "src/b.ts" }] : "revision-b" };
    const commands = new FakeCommands((command, args) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "view") return ok(JSON.stringify(changed ? after : before));
      if (command === "gh" && args[0] === "pr" && args[1] === "diff") { changed = true; return ok(fileDiff("src/a.ts")); }
      if (command === "gh" && args[0] === "api") return ok("reviewer");
      return fail();
    });
    await expect(captureReviewSnapshot({ kind: "pull-request", value: "7" }, "/repo", commands)).rejects.toThrow("changed while capturing its diff");
  });

  it("rejects a stable metadata scope when the captured diff names different paths", async () => {
    const payload = JSON.stringify({
      number: 7,
      url: "https://github.com/acme/repo/pull/7",
      baseRefOid: "base-a",
      headRefOid: "head-a",
      files: [{ path: "src/a.ts" }],
    });
    const commands = new FakeCommands((command, args) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "view") return ok(payload);
      if (command === "gh" && args[0] === "pr" && args[1] === "diff") return ok(fileDiff("src/b.ts"));
      if (command === "gh" && args[0] === "api") return ok("reviewer");
      return fail();
    });
    await expect(captureReviewSnapshot({ kind: "pull-request", value: "7" }, "/repo", commands)).rejects.toThrow(/diff changed-path scope/u);
  });

  it("rejects malformed diff text instead of accepting metadata-only scope", async () => {
    const payload = JSON.stringify({
      number: 7,
      url: "https://github.com/acme/repo/pull/7",
      baseRefOid: "base-a",
      headRefOid: "head-a",
      files: [{ path: "src/a.ts" }],
    });
    const commands = new FakeCommands((command, args) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "view") return ok(payload);
      if (command === "gh" && args[0] === "pr" && args[1] === "diff") return ok("diff");
      if (command === "gh" && args[0] === "api") return ok("reviewer");
      return fail();
    });
    await expect(captureReviewSnapshot({ kind: "pull-request", value: "7" }, "/repo", commands)).rejects.toThrow(/malformed or unsupported/u);
  });

  it("accepts the parser's effective paths for empty, rename, deletion, binary, and quoted diffs", async () => {
    const fixtures = [
      { files: [], diff: "" },
      {
        files: [{ path: "new-name.ts" }],
        diff: "diff --git a/old-name.ts b/new-name.ts\nsimilarity index 100%\nrename from old-name.ts\nrename to new-name.ts",
      },
      {
        files: [{ path: "removed.ts" }],
        diff: "diff --git a/removed.ts b/removed.ts\ndeleted file mode 100644\n--- a/removed.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed",
      },
      {
        files: [{ path: "image.bin" }],
        diff: "diff --git a/image.bin b/image.bin\nindex 1111111..2222222 100644\nBinary files a/image.bin and b/image.bin differ",
      },
      {
        files: [{ path: "docs/naïve file.txt" }],
        diff: String.raw`diff --git "a/docs/na\303\257ve file.txt" "b/docs/na\303\257ve file.txt"
--- "a/docs/na\303\257ve file.txt"
+++ "b/docs/na\303\257ve file.txt"
@@ -1 +1 @@
-old
+new`,
      },
    ] as const;

    for (const fixture of fixtures) {
      const payload = JSON.stringify({
        number: 7,
        url: "https://github.com/acme/repo/pull/7",
        baseRefOid: "base-a",
        headRefOid: "head-a",
        files: fixture.files,
      });
      const commands = new FakeCommands((command, args) => {
        if (command === "gh" && args[0] === "pr" && args[1] === "view") return ok(payload);
        if (command === "gh" && args[0] === "pr" && args[1] === "diff") return ok(fixture.diff);
        if (command === "gh" && args[0] === "api") return ok("reviewer");
        return fail();
      });
      const expectedPaths = fixture.files.map((file) => file.path).sort();
      await expect(captureReviewSnapshot({ kind: "pull-request", value: "7" }, "/repo", commands)).resolves.toMatchObject({ changedPaths: expectedPaths });
    }
  });

  it("only treats the current reviewer's prior comment as already reviewed", () => {
    const base = {
      number: 7,
      title: "Fix cache",
      body: "body",
      state: "OPEN",
      isDraft: false,
      authorLogin: "human",
      url: "https://github.com/acme/repo/pull/7",
      baseSha: "base",
      headSha: "head",
      repository: "acme/repo",
      changedPaths: ["src/a.ts"],
      comments: [{ body: "### Code review\\n\\nFound 1 issue.", authorLogin: "reviewer" }],
      reviewerIdentityAvailable: true,
    } as const;
    expect(hasExistingReview({ ...base, reviewerLogin: "reviewer" })).toBe(true);
    expect(hasExistingReview({ ...base, reviewerLogin: "someone-else" })).toBe(false);
    expect(hasExistingReview(base)).toBe(false);
  });

  it("parses pull request metadata and immutable file paths", async () => {
    const payload = JSON.stringify({
      number: 7,
      title: "Fix cache",
      body: "body",
      state: "OPEN",
      isDraft: false,
      author: { login: "human" },
      url: "https://github.com/acme/repo/pull/7",
      baseRefOid: "base-sha",
      headRefOid: "head-sha",
      files: [{ path: "src/a.ts" }],
      comments: [],
    });
    const commands = new FakeCommands((command, args) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "view") return ok(payload);
      if (command === "gh" && args[0] === "pr" && args[1] === "diff") return ok(fileDiff("src/a.ts"));
      return fail();
    });
    const snapshot = await captureReviewSnapshot({ kind: "pull-request", value: "7" }, "/repo", commands);
    expect(snapshot.pullRequest?.headSha).toBe("head-sha");
    expect(snapshot.changedPaths).toEqual(["src/a.ts"]);
    expect(commands.calls).toContainEqual(["gh", "pr", "diff", "7", "--repo", "acme/repo"]);
  });
});
