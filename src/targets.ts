import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runChecked } from "./commands.js";
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

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function throwIfCanceled(result: CommandResult, operation: string): void {
  if (result.canceled) throw new Error(`${operation} canceled`);
}

function asPaths(files: RawPullRequest["files"]): readonly string[] {
  if (!Array.isArray(files)) return [];
  return [...new Set(files.map((file) => asString(file?.path)).filter(Boolean))].sort();
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

  const localPath = resolve(cwd, value);
  const localExists = existsSync(localPath);
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
  const pullRequest = parsePullRequest(JSON.parse(json) as unknown);
  const identity = await commands.run("gh", ["api", "user", "--jq", ".login"], { cwd, signal });
  throwIfCanceled(identity, "Reviewer identity lookup");
  if (identity.truncated) throw new Error("Reviewer identity lookup output was truncated");
  const reviewerLogin = identity.exitCode === 0 ? identity.stdout.trim() : "";
  return {
    ...pullRequest,
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

async function captureLocalTarget(target: ReviewTarget, cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<{ diff: string; paths: readonly string[]; headSha?: string; baseSha?: string }> {
  if (target.kind === "current-diff" || target.kind === "worktree") return captureCurrentDiff(cwd, commands, signal);
  if (target.kind === "branch") {
    const head = await runChecked(commands, "git", ["rev-parse", "HEAD"], cwd, signal);
    const base = await runChecked(commands, "git", ["rev-parse", target.ref], cwd, signal);
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
    const diff = await runChecked(commands, "gh", ["pr", "diff", String(pullRequest.number), "--repo", pullRequest.repository], cwd, signal);
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

