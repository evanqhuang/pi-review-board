import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runChecked } from "./commands.js";
import { parseUnifiedDiff } from "./diff-shards.js";
import { normalizeReviewPath } from "./output.js";
import type {
  CommandResult,
  CommandRunner,
  PullRequestMetadata,
  ReviewSnapshot,
  ReviewTarget,
} from "./types.js";

interface RawPullRequest {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly state?: unknown;
  readonly isDraft?: unknown;
  readonly author?: { readonly login?: unknown };
  readonly url?: unknown;
  readonly baseRefOid?: unknown;
  readonly headRefOid?: unknown;
  readonly repository?: { readonly nameWithOwner?: unknown };
  readonly files?: readonly { readonly path?: unknown }[];
  readonly comments?: readonly { readonly body?: unknown; readonly author?: { readonly login?: unknown } }[];
}

interface PullRequestFile {
  readonly filename: string;
  readonly status: string;
  readonly previousFilename?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly patch?: string;
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function throwIfCanceled(result: CommandResult, operation: string): void {
  if (result.canceled) throw new Error(`${operation} canceled`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(value: string, operation: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new Error(`${operation}: ${errorMessage(error)}`);
  }
}

function asPaths(files: RawPullRequest["files"]): readonly string[] {
  if (!Array.isArray(files)) return [];
  return [...new Set(files.map((file) => asString(file?.path)).filter(Boolean))].sort();
}

function normalizedPathSet(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((path) => normalizeReviewPath(path)).filter(Boolean))].sort();
}

function effectiveDiffPaths(diff: string): readonly string[] {
  const parsed = parseUnifiedDiff(diff);
  if (parsed.malformed) {
    throw new Error("Pull request diff is malformed or unsupported; retry the review.");
  }
  const paths = new Set<string>();
  for (const file of parsed.files) {
    // Combined diffs can hide changes from other parents behind one path, so
    // they cannot be checked against the one-dimensional PR file scope.
    if (file.combined) {
      throw new Error("Pull request diff uses an unsupported combined format; retry the review.");
    }
    // Binary diffs and metadata-only renames/deletions are intentionally
    // accepted, but every other unsupported parser result fails closed.
    if (!file.supported && !file.binary && file.unsupportedReason !== "metadata-only diff has no hunks") {
      throw new Error("Pull request diff contains an unsupported file format; retry the review.");
    }
    if (file.oldPath === null && file.newPath === null) {
      throw new Error("Pull request diff contains a file without a usable path; retry the review.");
    }
    // PR file metadata names the destination of a rename, or the old path for a deletion.
    const normalized = normalizeReviewPath(file.newPath ?? file.oldPath!);
    if (!normalized) throw new Error("Pull request diff contains an empty file path; retry the review.");
    paths.add(normalized);
  }
  return [...paths].sort();
}

function repositoryFromPullRequestUrl(value: string): string {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length >= 4 && parts[2] === "pull" ? `${parts[0]}/${parts[1]}` : "";
  } catch {
    return "";
  }
}

function parsePullRequest(value: unknown): PullRequestMetadata {
  if (!value || typeof value !== "object") throw new Error("gh returned an invalid pull request payload");
  const raw = value as RawPullRequest;
  if (typeof raw.number !== "number") throw new Error("gh returned a pull request without a number");
  const comments = Array.isArray(raw.comments)
    ? raw.comments
        .map((comment) => ({
          body: asString(comment?.body),
          authorLogin: asString(comment?.author?.login),
        }))
        .filter((comment) => comment.body.length > 0)
    : [];
  const url = asString(raw.url);
  const repository = asString(raw.repository?.nameWithOwner) || repositoryFromPullRequestUrl(url);
  if (!repository) throw new Error("gh returned a pull request without a repository");

  return {
    number: raw.number,
    title: asString(raw.title),
    body: asString(raw.body),
    state: asString(raw.state, "UNKNOWN"),
    isDraft: raw.isDraft === true,
    authorLogin: asString(raw.author?.login),
    url,
    baseSha: asString(raw.baseRefOid),
    headSha: asString(raw.headRefOid),
    repository,
    changedPaths: asPaths(raw.files),
    comments,
    reviewerIdentityAvailable: false,
  };
}

function isOversizedPullRequestDiffError(error: unknown): boolean {
  return /(?:HTTP 406|PullRequest\.diff\s+too_large|diff exceeded the maximum number of lines)/iu.test(errorMessage(error));
}

function parsePullRequestFiles(value: unknown): readonly PullRequestFile[] {
  if (!Array.isArray(value)) throw new Error("gh returned an invalid pull request file list");
  // `gh api --paginate --slurp` returns one array per page. Accepting a
  // single page as well keeps this parser useful with command fakes.
  const pages = value.length === 0 || Array.isArray(value[0]) ? value : [value];
  const files: PullRequestFile[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) throw new Error("gh returned an invalid pull request file page");
    for (const raw of page) {
      if (!raw || typeof raw !== "object") throw new Error("gh returned an invalid pull request file");
      const record = raw as Record<string, unknown>;
      const filename = asString(record.filename);
      if (!filename) throw new Error("gh returned a pull request file without a filename");
      const previousFilename = asString(record.previous_filename);
      const patch = typeof record.patch === "string" ? record.patch : undefined;
      const additions = asNonNegativeInteger(record.additions);
      const deletions = asNonNegativeInteger(record.deletions);
      files.push({
        filename,
        status: asString(record.status, "modified"),
        ...(previousFilename ? { previousFilename } : {}),
        ...(additions === undefined ? {} : { additions }),
        ...(deletions === undefined ? {} : { deletions }),
        ...(patch === undefined ? {} : { patch }),
      });
    }
  }
  return files;
}

function quoteGitPath(path: string): string {
  if (!/[\s"\\\x00-\x1f\x7f]|[^\x20-\x7e]/u.test(path)) return path;
  let quoted = '"';
  for (const byte of Buffer.from(path, "utf8")) {
    if (byte === 0x22) quoted += '\\\"';
    else if (byte === 0x5c) quoted += "\\\\";
    else if (byte === 0x09) quoted += "\\t";
    else if (byte === 0x0a) quoted += "\\n";
    else if (byte === 0x0d) quoted += "\\r";
    else if (byte >= 0x20 && byte <= 0x7e) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return `${quoted}"`;
}

function pullRequestFilePaths(file: PullRequestFile): { readonly oldPath: string | null; readonly newPath: string | null } {
  const status = file.status.toLowerCase();
  return {
    oldPath: status === "added" ? null : file.previousFilename ?? file.filename,
    newPath: status === "removed" ? null : file.filename,
  };
}

function patchLineCounts(patch: string): { readonly additions: number; readonly deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function formatPullRequestFile(file: PullRequestFile): string {
  const paths = pullRequestFilePaths(file);
  const oldHeaderPath = paths.oldPath === null ? "/dev/null" : `a/${paths.oldPath}`;
  const newHeaderPath = paths.newPath === null ? "/dev/null" : `b/${paths.newPath}`;
  const lines = [`diff --git ${quoteGitPath(oldHeaderPath)} ${quoteGitPath(newHeaderPath)}`];
  const status = file.status.toLowerCase();
  if (status === "added") lines.push("new file mode 100644");
  if (status === "removed") lines.push("deleted file mode 100644");
  if (status === "renamed" && paths.oldPath !== null && paths.newPath !== null && file.patch === undefined) {
    lines.push("similarity index 100%", `rename from ${quoteGitPath(paths.oldPath)}`, `rename to ${quoteGitPath(paths.newPath)}`);
    return lines.join("\n");
  }
  if (paths.oldPath !== null || paths.newPath !== null) {
    lines.push(`--- ${quoteGitPath(oldHeaderPath)}`, `+++ ${quoteGitPath(newHeaderPath)}`);
  }
  if (file.patch !== undefined && file.patch.length > 0) {
    const patch = file.patch.replace(/\r\n?/gu, "\n");
    const counts = patchLineCounts(patch);
    if (file.additions !== undefined && file.deletions !== undefined
      && (counts.additions !== file.additions || counts.deletions !== file.deletions)) {
      throw new Error(`GitHub returned an incomplete patch for ${file.filename}; retry the review from a local checkout.`);
    }
    lines.push(patch.replace(/\n$/u, ""));
  } else if ((file.additions ?? 0) + (file.deletions ?? 0) > 0) {
    throw new Error(`GitHub did not return a patch for changed file ${file.filename}; retry the review from a local checkout.`);
  }
  return lines.join("\n");
}

async function readPullRequestFilesDiff(
  pullRequest: PullRequestMetadata,
  cwd: string,
  commands: CommandRunner,
  signal?: AbortSignal,
): Promise<string> {
  const files = await readPullRequestFiles(pullRequest, cwd, commands, signal);
  return files.map(formatPullRequestFile).join("\n");
}

async function readPullRequestFiles(
  pullRequest: PullRequestMetadata,
  cwd: string,
  commands: CommandRunner,
  signal?: AbortSignal,
): Promise<readonly PullRequestFile[]> {
  const json = await runChecked(
    commands,
    "gh",
    [
      "api",
      "--paginate",
      "--slurp",
      "--header",
      "Accept: application/vnd.github+json",
      `repos/${pullRequest.repository}/pulls/${pullRequest.number}/files?per_page=100`,
    ],
    cwd,
    signal,
  );
  return parsePullRequestFiles(parseJson(json, "GitHub returned invalid pull request file JSON"));
}

async function readPullRequestGitDiff(
  pullRequest: PullRequestMetadata,
  cwd: string,
  commands: CommandRunner,
  signal?: AbortSignal,
): Promise<string> {
  if (!pullRequest.baseSha || !pullRequest.headSha) {
    throw new Error("Pull request metadata did not include immutable base and head SHAs");
  }
  const remote = `https://github.com/${pullRequest.repository}.git`;
  const hasObject = async (sha: string): Promise<boolean> => {
    const result = await commands.run("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, signal });
    throwIfCanceled(result, "Pull request commit lookup");
    return result.exitCode === 0 && !result.truncated;
  };
  if (!(await hasObject(pullRequest.headSha))) {
    await runChecked(commands, "git", ["fetch", "--no-tags", "--no-write-fetch-head", "--depth=1", remote, `refs/pull/${pullRequest.number}/head`], cwd, signal);
  }
  if (!(await hasObject(pullRequest.baseSha))) {
    await runChecked(commands, "git", ["fetch", "--no-tags", "--no-write-fetch-head", "--depth=1", remote, pullRequest.baseSha], cwd, signal);
  }
  const diffArgs = ["diff", "--no-ext-diff", "--binary", "--find-renames", "--find-copies", `${pullRequest.baseSha}...${pullRequest.headSha}`];
  try {
    return await runChecked(commands, "git", diffArgs, cwd, signal);
  } catch (diffError) {
    // A shallow checkout can contain both immutable commits while lacking
    // their merge base. Deepen it without checking out or moving a branch,
    // then retry the same immutable revision diff once.
    const shallow = await commands.run("git", ["rev-parse", "--is-shallow-repository"], { cwd, signal });
    throwIfCanceled(shallow, "Pull request repository depth lookup");
    if (shallow.exitCode !== 0 || shallow.truncated || shallow.stdout.trim() !== "true") throw diffError;
    await runChecked(
      commands,
      "git",
      ["fetch", "--no-tags", "--no-write-fetch-head", "--unshallow", remote, `refs/pull/${pullRequest.number}/head`, pullRequest.baseSha],
      cwd,
      signal,
    );
    return runChecked(commands, "git", diffArgs, cwd, signal);
  }
}

async function resolveWorktreeTarget(localPath: string, cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<ReviewTarget | undefined> {
  try {
    if (!statSync(localPath).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const root = await commands.run("git", ["-C", localPath, "rev-parse", "--show-toplevel"], { cwd, signal });
  throwIfCanceled(root, "Worktree lookup");
  if (root.exitCode !== 0 || root.truncated) return undefined;
  const repositoryRoot = root.stdout.trim();
  if (!repositoryRoot || resolve(cwd, repositoryRoot) !== localPath) return undefined;
  return { kind: "worktree", path: localPath };
}

async function resolveRepositoryRelativePath(value: string, cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<string | undefined> {
  const commonDir = await commands.run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, signal });
  throwIfCanceled(commonDir, "Repository path lookup");
  if (commonDir.exitCode !== 0 || commonDir.truncated) return undefined;
  const path = commonDir.stdout.trim();
  if (!path) return undefined;
  const candidate = resolve(dirname(path), value);
  return existsSync(candidate) ? candidate : undefined;
}

export async function resolveReviewTarget(rawTarget: string | undefined, cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<ReviewTarget> {
  const value = rawTarget?.trim();
  if (!value) return { kind: "current-diff" };
  let isPullRequestUrl = false;
  try {
    const url = new URL(value);
    isPullRequestUrl = /\/pull\/\d+(?:\/|$)/u.test(url.pathname);
  } catch {
    isPullRequestUrl = false;
  }
  if (/^\d+$/u.test(value) || isPullRequestUrl) {
    return { kind: "pull-request", value };
  }

  let localPath = resolve(cwd, value);
  let localExists = existsSync(localPath);
  if (!localExists) {
    const repositoryRelativePath = await resolveRepositoryRelativePath(value, cwd, commands, signal);
    if (repositoryRelativePath) {
      localPath = repositoryRelativePath;
      localExists = true;
    }
  }
  const ref = await commands.run("git", ["rev-parse", "--verify", `${value}^{commit}`], { cwd, signal });
  if (ref.canceled) throw new Error("Review target resolution canceled");
  if (localExists && ref.exitCode === 0) throw new Error(`Ambiguous review target: ${value} is both a path and a revision`);
  if (localExists) return (await resolveWorktreeTarget(localPath, cwd, commands, signal)) ?? { kind: "path", path: value };
  if (ref.exitCode === 0) return { kind: "branch", ref: value };
  throw new Error(`Could not resolve review target: ${value}`);
}

async function readPullRequest(target: Extract<ReviewTarget, { kind: "pull-request" }>, cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<PullRequestMetadata> {
  const json = await runChecked(
    commands,
    "gh",
    [
      "pr",
      "view",
      target.value,
      "--json",
      "number,title,body,state,isDraft,author,url,baseRefOid,headRefOid,files,comments",
    ],
    cwd,
    signal,
  );
  const pullRequest = parsePullRequest(parseJson(json, "gh returned invalid pull request JSON"));
  const identity = await commands.run("gh", ["api", "user", "--jq", ".login"], { cwd, signal });
  throwIfCanceled(identity, "Reviewer identity lookup");
  if (identity.truncated) throw new Error("Reviewer identity lookup output was truncated");
  const reviewerLogin = identity.exitCode === 0 ? identity.stdout.trim() : "";
  let changedPaths = pullRequest.changedPaths;
  // GitHub's GraphQL-backed `gh pr view --json files` response is capped at
  // 100 files. Replace that truncated scope with the paginated REST file list
  // before validating either the normal or oversized diff.
  if (changedPaths.length >= 100) {
    const files = await readPullRequestFiles(pullRequest, cwd, commands, signal);
    changedPaths = [...new Set(files.map((file) => file.filename))].sort();
  }
  return {
    ...pullRequest,
    changedPaths,
    reviewerIdentityAvailable: identity.exitCode === 0 && reviewerLogin.length > 0,
    ...(reviewerLogin ? { reviewerLogin } : {}),
  };
}

async function readDiff(commands: CommandRunner, cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return runChecked(commands, "git", ["diff", ...args], cwd, signal);
}

async function readNames(commands: CommandRunner, cwd: string, args: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
  const output = await runChecked(commands, "git", ["diff", "--name-only", ...args], cwd, signal);
  return [...new Set(output.split("\n").map((line) => normalizeReviewPath(line)).filter(Boolean))].sort();
}

async function captureCurrentDiff(cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<{ diff: string; paths: readonly string[]; headSha?: string; baseSha?: string }> {
  const head = await commands.run("git", ["rev-parse", "HEAD"], { cwd, signal });
  throwIfCanceled(head, "HEAD lookup");
  const headSha = head.exitCode === 0 ? head.stdout.trim() : undefined;
  let committedDiff = "";
  let committedPaths: readonly string[] = [];
  const upstream = await commands.run("git", ["rev-parse", "--verify", "@{upstream}"], { cwd, signal });
  throwIfCanceled(upstream, "Upstream lookup");
  const bases = upstream.exitCode === 0 ? [upstream.stdout.trim()] : ["main", "origin/main"];
  for (const base of bases) {
    const candidate = await commands.run("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd, signal });
    throwIfCanceled(candidate, `${base} lookup`);
    if (candidate.exitCode !== 0) continue;
    committedDiff = await readDiff(commands, cwd, [`${base}...HEAD`], signal);
    committedPaths = await readNames(commands, cwd, [`${base}...HEAD`], signal);
    const baseSha = candidate.stdout.trim();
    const workingDiff = await readDiff(commands, cwd, ["HEAD"], signal);
    const workingPaths = await readNames(commands, cwd, ["HEAD"], signal);
    return {
      diff: [committedDiff, workingDiff].filter(Boolean).join("\n"),
      paths: [...new Set([...committedPaths, ...workingPaths])].sort(),
      ...(headSha ? { headSha } : {}),
      baseSha,
    };
  }
  const workingDiff = await readDiff(commands, cwd, ["HEAD"], signal);
  const workingPaths = await readNames(commands, cwd, ["HEAD"], signal);
  return { diff: workingDiff, paths: workingPaths, ...(headSha ? { headSha } : {}) };
}

async function captureWorktreeDiff(cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<{ diff: string; paths: readonly string[]; headSha?: string; baseSha?: string }> {
  const head = await runChecked(commands, "git", ["rev-parse", "HEAD"], cwd, signal);
  const remoteHead = await commands.run("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd, signal });
  throwIfCanceled(remoteHead, "Default branch lookup");
  const upstream = await commands.run("git", ["rev-parse", "--verify", "@{upstream}"], { cwd, signal });
  throwIfCanceled(upstream, "Upstream lookup");
  const bases = [
    ...(remoteHead.exitCode === 0 ? [remoteHead.stdout.trim()] : []),
    "main",
    "origin/main",
    ...(upstream.exitCode === 0 ? [upstream.stdout.trim()] : []),
  ].filter(Boolean);
  for (const base of [...new Set(bases)]) {
    const candidate = await commands.run("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd, signal });
    throwIfCanceled(candidate, `${base} lookup`);
    if (candidate.exitCode !== 0 || candidate.stdout.trim() === head.trim()) continue;
    const committedDiff = await readDiff(commands, cwd, [`${base}...HEAD`], signal);
    const committedPaths = await readNames(commands, cwd, [`${base}...HEAD`], signal);
    const workingDiff = await readDiff(commands, cwd, ["HEAD"], signal);
    const workingPaths = await readNames(commands, cwd, ["HEAD"], signal);
    return {
      diff: [committedDiff, workingDiff].filter(Boolean).join("\n"),
      paths: [...new Set([...committedPaths, ...workingPaths])].sort(),
      headSha: head.trim(),
      baseSha: candidate.stdout.trim(),
    };
  }
  return captureCurrentDiff(cwd, commands, signal);
}

async function captureLocalTarget(target: ReviewTarget, cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<{ diff: string; paths: readonly string[]; headSha?: string; baseSha?: string }> {
  if (target.kind === "current-diff") return captureCurrentDiff(cwd, commands, signal);
  if (target.kind === "worktree") return captureWorktreeDiff(cwd, commands, signal);
  if (target.kind === "branch") {
    const head = await runChecked(commands, "git", ["rev-parse", "HEAD"], cwd, signal);
    const base = await runChecked(commands, "git", ["rev-parse", target.ref], cwd, signal);
    if (head.trim() === base.trim()) return captureWorktreeDiff(cwd, commands, signal);
    const range = `HEAD...${target.ref}`;
    return {
      diff: await readDiff(commands, cwd, [range], signal),
      paths: await readNames(commands, cwd, [range], signal),
      headSha: head.trim(),
      baseSha: base.trim(),
    };
  }
  if (target.kind === "path") {
    const pathValue = target.path;
    const head = await commands.run("git", ["rev-parse", "HEAD"], { cwd, signal });
    throwIfCanceled(head, "HEAD lookup");
    const diff = await readDiff(commands, cwd, ["HEAD", "--", pathValue], signal);
    const paths = await readNames(commands, cwd, ["HEAD", "--", pathValue], signal);
    return { diff, paths, ...(head.exitCode === 0 ? { headSha: head.stdout.trim() } : {}) };
  }
  throw new Error("Expected a local review target");
}

function hashSnapshot(target: ReviewTarget, diff: string, paths: readonly string[], metadata?: PullRequestMetadata): string {
  const targetIdentity = target.kind === "pull-request"
    ? { kind: target.kind, value: target.value }
    : target;
  const revision = metadata
    ? {
        repository: metadata.repository,
        number: metadata.number,
        baseSha: metadata.baseSha,
        headSha: metadata.headSha,
      }
    : undefined;
  const payload = JSON.stringify({ target: targetIdentity, diff, paths, revision });
  return createHash("sha256").update(payload).digest("hex");
}

export async function captureReviewSnapshot(target: ReviewTarget, cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<ReviewSnapshot> {
  if (target.kind === "pull-request") {
    const pullRequest = await readPullRequest(target, cwd, commands, signal);
    let diff: string;
    try {
      diff = await runChecked(commands, "gh", ["pr", "diff", String(pullRequest.number), "--repo", pullRequest.repository], cwd, signal);
    } catch (error) {
      if (!isOversizedPullRequestDiffError(error)) throw error;
      let filesError: unknown;
      try {
        // The per-file endpoint does not apply the aggregate 20,000-line
        // limit used by the PR diff endpoint. Prefer it because it avoids
        // changing the caller's checkout; fall back to immutable Git refs if
        // GitHub omits a patch for an individual large file.
        diff = await readPullRequestFilesDiff(pullRequest, cwd, commands, signal);
      } catch (fallbackError) {
        filesError = fallbackError;
        try {
          diff = await readPullRequestGitDiff(pullRequest, cwd, commands, signal);
        } catch (gitError) {
          throw new Error(`${errorMessage(error)}; per-file fallback failed: ${errorMessage(filesError)}; local Git fallback failed: ${errorMessage(gitError)}`);
        }
      }
    }
    const diffPaths = effectiveDiffPaths(diff);
    if (JSON.stringify(diffPaths) !== JSON.stringify(normalizedPathSet(pullRequest.changedPaths))) {
      throw new Error("Pull request diff changed-path scope does not match captured metadata; retry the review.");
    }
    const afterDiff = await readPullRequest(target, cwd, commands, signal);
    if (afterDiff.repository !== pullRequest.repository || afterDiff.number !== pullRequest.number
      || afterDiff.baseSha !== pullRequest.baseSha || afterDiff.headSha !== pullRequest.headSha
      || JSON.stringify(afterDiff.changedPaths) !== JSON.stringify(pullRequest.changedPaths)) {
      throw new Error("Pull request revision or changed-path scope changed while capturing its diff; retry the review.");
    }
    const paths = pullRequest.changedPaths;
    return {
      target: { ...target, metadata: pullRequest },
      cwd,
      changedPaths: paths,
      diff,
      snapshotHash: hashSnapshot(target, diff, paths, pullRequest),
      headSha: pullRequest.headSha,
      baseSha: pullRequest.baseSha,
      pullRequest,
    };
  }

  const normalizedTarget = target.kind === "worktree" ? { ...target, path: resolve(cwd, target.path) } : target;
  const reviewCwd = normalizedTarget.kind === "worktree" ? normalizedTarget.path : cwd;
  const local = await captureLocalTarget(normalizedTarget, reviewCwd, commands, signal);
  return {
    target: normalizedTarget,
    cwd: reviewCwd,
    changedPaths: local.paths,
    diff: local.diff,
    snapshotHash: hashSnapshot(normalizedTarget, local.diff, local.paths),
    ...(local.headSha ? { headSha: local.headSha } : {}),
    ...(local.baseSha ? { baseSha: local.baseSha } : {}),
  };
}

export async function hasSnapshotDrift(snapshot: ReviewSnapshot, commands: CommandRunner, signal?: AbortSignal): Promise<boolean> {
  const fresh = await captureReviewSnapshot(snapshot.target, snapshot.cwd, commands, signal);
  return fresh.snapshotHash !== snapshot.snapshotHash;
}

export function isLikelyAutomatedPullRequest(pullRequest: PullRequestMetadata): boolean {
  return /\[bot\]$/iu.test(pullRequest.authorLogin) || /dependabot|renovate|release-please/iu.test(`${pullRequest.authorLogin} ${pullRequest.title}`);
}

export function hasExistingReview(pullRequest: PullRequestMetadata): boolean {
  if (!pullRequest.reviewerLogin) return false;
  return pullRequest.comments.some(
    (comment) => comment.authorLogin === pullRequest.reviewerLogin && /###\s*code review/iu.test(comment.body),
  );
}

