import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { killProcessTree, PROCESS_KILL_GRACE_PERIOD_MS } from "./process.js";
import type { CommandResult, CommandRunner, ReviewSnapshot } from "./types.js";

/** The immutable source tree made available to review tools. */
export interface ReviewSourceView {
  readonly root: string;
  readonly revision?: string;
  dispose(): Promise<void>;
}

/** Resource limits for a pull-request source view. Values are byte/file counts. */
export interface SourceViewLimits {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxListingBytes?: number;
}

const DEFAULT_LIMITS: Required<SourceViewLimits> = Object.freeze({
  maxFiles: 10_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxListingBytes: 16 * 1024 * 1024,
});
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const LISTING_ENTRY = /^(?<mode>[0-7]{6}) (?<type>\S+) (?<object>[0-9a-f]{40}|[0-9a-f]{64})\s+(?<size>\d+|-)$/iu;
const MAX_ERROR_OUTPUT_BYTES = 64 * 1024;

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly object: string;
  readonly size: number;
  readonly path: string;
}

interface OccupiedPath {
  readonly spelling: string;
  readonly kind: "file" | "directory";
}

interface TreeManifest {
  readonly entries: readonly TreeEntry[];
  readonly byPath: ReadonlyMap<string, TreeEntry>;
  readonly directories: ReadonlySet<string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canceled(stage: string): Error {
  return new Error(`Source view materialization canceled during ${stage}`);
}

function validateLimits(limits: SourceViewLimits): Required<SourceViewLimits> {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid source-view limit ${name}: expected a positive safe integer`);
    }
  }
  return merged;
}

function checkCanceled(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) throw canceled(stage);
}

async function checkedRun(
  commands: CommandRunner,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  stage: string,
): Promise<CommandResult> {
  checkCanceled(signal, stage);
  let result: CommandResult;
  try {
    result = await commands.run("git", args, { cwd, signal, env: { GIT_NO_LAZY_FETCH: "1" } });
  } catch (error) {
    if (signal?.aborted) throw canceled(stage);
    throw new Error(`Unable to ${stage}: ${errorMessage(error)}`);
  }
  if (result.canceled || signal?.aborted) throw canceled(stage);
  return result;
}

function ensureSuccessful(result: CommandResult, stage: string): void {
  if (result.truncated) throw new Error(`Unable to ${stage}: Git output exceeded the source-view limit`);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`Unable to ${stage}: ${detail}`);
  }
}

function validateHead(snapshot: ReviewSnapshot): string {
  const snapshotHead = snapshot.headSha;
  const metadataHeads = [snapshot.pullRequest?.headSha, snapshot.target.kind === "pull-request" ? snapshot.target.metadata?.headSha : undefined]
    .filter((head): head is string => head !== undefined);
  const metadataBases = [snapshot.pullRequest?.baseSha, snapshot.target.kind === "pull-request" ? snapshot.target.metadata?.baseSha : undefined]
    .filter((base): base is string => base !== undefined);
  if (!snapshotHead || metadataHeads.length === 0) {
    throw new Error("Cannot materialize pull-request source: captured headSha and pull-request metadata headSha are required");
  }
  if (!FULL_OBJECT_ID.test(snapshotHead) || metadataHeads.some((head) => !FULL_OBJECT_ID.test(head))) {
    throw new Error("Cannot materialize pull-request source: headSha values must be full 40- or 64-character commit IDs");
  }
  if (metadataHeads.some((metadataHead) => snapshotHead.toLowerCase() !== metadataHead.toLowerCase())) {
    throw new Error(`Cannot materialize pull-request source: snapshot head ${snapshotHead} does not match pull-request head ${metadataHeads[0]}`);
  }
  if (metadataBases.length > 1 && metadataBases.some((metadataBase) => metadataBase.toLowerCase() !== metadataBases[0]?.toLowerCase())) {
    throw new Error("Cannot materialize pull-request source: pull-request metadata baseSha values conflict");
  }
  if (snapshot.baseSha !== undefined && metadataBases.some((metadataBase) => snapshot.baseSha?.toLowerCase() !== metadataBase.toLowerCase())) {
    throw new Error(`Cannot materialize pull-request source: snapshot base ${snapshot.baseSha} does not match pull-request base ${metadataBases[0]}`);
  }
  return snapshotHead;
}

function validatePath(path: string): string[] {
  if (!path || path.startsWith("/") || path.includes("\\") || /^[a-z]:/iu.test(path)) {
    throw new Error(`Cannot materialize pull-request source: unsafe tracked path ${JSON.stringify(path)}`);
  }
  if (path.includes("\0") || path.includes("\uFFFD") || [...path].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw new Error(`Cannot materialize pull-request source: unsupported tracked path ${JSON.stringify(path)}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" "))) {
    throw new Error(`Cannot materialize pull-request source: unsafe tracked path ${JSON.stringify(path)}`);
  }
  // These names and separators are harmless on POSIX but can escape or alias a
  // source view when it is consumed on a case-insensitive Windows filesystem.
  if (parts.some((part) => part.includes(":") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error(`Cannot materialize pull-request source: unsupported platform path ${JSON.stringify(path)}`);
  }
  return parts;
}

function caseFoldPath(parts: readonly string[]): string {
  return parts.map((part) => part.normalize("NFKC").toLowerCase()).join("/");
}

function validateEntry(entry: TreeEntry): void {
  validatePath(entry.path);
  if (entry.mode === "120000") {
    if (entry.type !== "blob") {
      throw new Error(`Cannot materialize pull-request source: tracked path ${JSON.stringify(entry.path)} is an unsupported symlink; refusing to follow or expose it`);
    }
  } else if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
    const kind = entry.mode === "160000" ? "submodule" : `${entry.mode} ${entry.type}`;
    throw new Error(`Cannot materialize pull-request source: tracked path ${JSON.stringify(entry.path)} is an unsupported ${kind}; refusing to follow or expose it`);
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error(`Cannot materialize pull-request source: invalid size for tracked path ${JSON.stringify(entry.path)}`);
  }
}

function parseTreeListing(stdout: string, limits: Required<SourceViewLimits>): TreeManifest {
  const entries: TreeEntry[] = [];
  const occupied = new Map<string, OccupiedPath>();
  const directories = new Set<string>();
  const byPath = new Map<string, TreeEntry>();
  let totalBytes = 0;
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab <= 0) throw new Error("Cannot materialize pull-request source: malformed git ls-tree output");
    const match = LISTING_ENTRY.exec(record.slice(0, tab));
    if (!match?.groups) throw new Error("Cannot materialize pull-request source: malformed git ls-tree entry");
    const path = record.slice(tab + 1);
    const parts = validatePath(path);
    const entry: TreeEntry = {
      mode: match.groups.mode ?? "",
      type: match.groups.type ?? "",
      object: (match.groups.object ?? "").toLowerCase(),
      size: match.groups.size === "-" ? Number.NaN : Number(match.groups.size),
      path,
    };
    validateEntry(entry);
    if (entries.length >= limits.maxFiles) {
      throw new Error(`Cannot materialize pull-request source: file count exceeds the limit of ${limits.maxFiles}`);
    }
    if (entry.size > limits.maxFileBytes) {
      throw new Error(`Cannot materialize pull-request source: ${JSON.stringify(path)} exceeds the per-file limit of ${limits.maxFileBytes} bytes`);
    }
    if (entry.size > limits.maxTotalBytes - totalBytes) {
      throw new Error(`Cannot materialize pull-request source: committed file content exceeds the total limit of ${limits.maxTotalBytes} bytes`);
    }
    for (let index = 1; index <= parts.length; index += 1) {
      const originalPrefix = parts.slice(0, index).join("/");
      const prefix = caseFoldPath(parts.slice(0, index));
      const isFile = index === parts.length;
      const previous = occupied.get(prefix);
      if (previous !== undefined) {
        const sameDirectory = !isFile && previous.kind === "directory" && previous.spelling === originalPrefix;
        if (!sameDirectory) {
          throw new Error(`Cannot materialize pull-request source: case-insensitive path collision at ${JSON.stringify(path)}`);
        }
      } else {
        occupied.set(prefix, { spelling: originalPrefix, kind: isFile ? "file" : "directory" });
      }
      if (!isFile) directories.add(originalPrefix);
    }
    entries.push(entry);
    byPath.set(path, entry);
    totalBytes += entry.size;
  }
  return { entries, byPath, directories };
}

interface BinaryCommandResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
  readonly canceled: boolean;
  readonly exceeded: boolean;
}

function runGitBinary(args: readonly string[], cwd: string, maxBytes: number, signal?: AbortSignal): Promise<BinaryCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(canceled("reading a committed blob"));
      return;
    }
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    let aborted = false;
    let exceeded = false;
    let terminationRequested = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const removeAbortListener = (): void => {
      if (abortListener && signal) signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    };
    const clearTimer = (): void => {
      if (escalationTimer) clearTimeout(escalationTimer);
      escalationTimer = undefined;
    };
    const terminate = (): void => {
      if (terminationRequested) return;
      terminationRequested = true;
      killProcessTree(child, "SIGTERM");
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        killProcessTree(child, "SIGKILL");
      }, PROCESS_KILL_GRACE_PERIOD_MS);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (stdoutBytes + bytes.length > maxBytes) {
        exceeded = true;
        child.stdout.pause();
        terminate();
        return;
      }
      stdoutBytes += bytes.length;
      chunks.push(Buffer.from(bytes));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (Buffer.byteLength(stderr, "utf8") < MAX_ERROR_OUTPUT_BYTES) {
        stderr += bytes.toString("utf8").slice(0, MAX_ERROR_OUTPUT_BYTES - Buffer.byteLength(stderr, "utf8"));
      } else {
        terminate();
      }
    });
    child.once("error", (error) => {
      removeAbortListener();
      clearTimer();
      rejectOnce(error);
    });
    child.once("close", (code) => {
      removeAbortListener();
      clearTimer();
      if (aborted || terminationRequested) killProcessTree(child, "SIGKILL");
      if (settled) return;
      if (aborted) {
        rejectOnce(canceled("reading a committed blob"));
      } else {
        settled = true;
        resolvePromise({ stdout: Buffer.concat(chunks), stderr, exitCode: code ?? 1, canceled: false, exceeded });
      }
    });
    const abort = (): void => {
      if (aborted) return;
      aborted = true;
      terminate();
    };
    abortListener = abort;
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function readCommittedBlob(entry: TreeEntry, cwd: string, signal?: AbortSignal): Promise<Buffer> {
  checkCanceled(signal, `reading ${entry.path}`);
  const result = await runGitBinary(["cat-file", "blob", entry.object], cwd, entry.size, signal);
  if (result.canceled || signal?.aborted) throw canceled(`reading ${entry.path}`);
  if (result.exceeded) throw new Error(`Cannot materialize pull-request source: committed blob for ${JSON.stringify(entry.path)} exceeded its preflight size`);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
    throw new Error(`Cannot materialize pull-request source: unable to read committed blob for ${JSON.stringify(entry.path)}: ${detail}`);
  }
  if (result.stdout.byteLength !== entry.size) {
    throw new Error(`Cannot materialize pull-request source: committed blob for ${JSON.stringify(entry.path)} changed after preflight`);
  }
  return result.stdout;
}

function safeDestination(root: string, path: string): string {
  const destination = resolve(root, path);
  const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
  if (destination !== root && !destination.startsWith(rootWithSeparator)) {
    throw new Error(`Cannot materialize pull-request source: unsafe destination for ${JSON.stringify(path)}`);
  }
  return destination;
}

async function ensureEntryParents(entry: TreeEntry, root: string): Promise<void> {
  const parts = validatePath(entry.path);
  let directory = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    directory = join(directory, parts[index] ?? "");
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Cannot materialize pull-request source: symlink traversal at ${JSON.stringify(entry.path)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(directory, { mode: 0o700 });
    }
  }
}

async function materializeDirectories(manifest: TreeManifest, root: string, signal?: AbortSignal): Promise<void> {
  const directories = [...manifest.directories].sort((left, right) => {
    const depthDifference = left.split("/").length - right.split("/").length;
    return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
  });
  for (const path of directories) {
    checkCanceled(signal, "materializing the captured pull-request tree");
    const destination = safeDestination(root, path);
    try {
      const stat = await lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Cannot materialize pull-request source: symlink traversal at ${JSON.stringify(path)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(destination, { mode: 0o700 });
    }
  }
}

async function materializeBlob(entry: TreeEntry, root: string, cwd: string, signal?: AbortSignal): Promise<void> {
  const content = await readCommittedBlob(entry, cwd, signal);
  await ensureEntryParents(entry, root);
  const destination = safeDestination(root, entry.path);
  await writeFile(destination, content, { flag: "wx", mode: 0o600 });
}

function decodeSymlinkTarget(entry: TreeEntry, content: Buffer): { readonly raw: string; readonly parts: readonly string[] } {
  let target: string;
  try {
    target = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`Cannot materialize pull-request source: invalid symlink target for ${JSON.stringify(entry.path)}`);
  }
  if (!target || target.startsWith("/") || target.includes("\\") || /^[a-z]:/iu.test(target)) {
    throw new Error(`Cannot materialize pull-request source: unsafe symlink target for ${JSON.stringify(entry.path)}`);
  }
  if (target.includes("\0") || target.includes("\uFFFD") || [...target].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    throw new Error(`Cannot materialize pull-request source: invalid symlink target for ${JSON.stringify(entry.path)}`);
  }
  const parts = target.split("/");
  if (parts.some((part) => part.length === 0 || (part !== "." && part !== ".." && (part.endsWith(".") || part.endsWith(" ") || part.includes(":") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))))) {
    throw new Error(`Cannot materialize pull-request source: unsafe symlink target for ${JSON.stringify(entry.path)}`);
  }
  return { raw: target, parts };
}

function resolveManifestPath(
  manifest: TreeManifest,
  symlinkTargets: ReadonlyMap<string, { readonly raw: string; readonly parts: readonly string[] }>,
  startingParts: readonly string[],
  targetParts: readonly string[],
  sourcePath: string,
): string {
  const pending = [...startingParts, ...targetParts];
  const resolvedParts: string[] = [];
  const followed = new Set<string>();
  while (pending.length > 0) {
    const part = pending.shift();
    if (part === undefined || part === ".") continue;
    if (part === "..") {
      if (resolvedParts.length === 0) {
        throw new Error(`Cannot materialize pull-request source: symlink target for ${JSON.stringify(sourcePath)} escapes the source root`);
      }
      resolvedParts.pop();
      continue;
    }
    resolvedParts.push(part);
    const currentPath = resolvedParts.join("/");
    const linkedEntry = manifest.byPath.get(currentPath);
    if (linkedEntry?.mode === "120000") {
      if (followed.has(currentPath)) {
        throw new Error(`Cannot materialize pull-request source: symlink cycle involving ${JSON.stringify(sourcePath)}`);
      }
      const linkedTarget = symlinkTargets.get(currentPath);
      if (linkedTarget === undefined) {
        throw new Error(`Cannot materialize pull-request source: missing symlink target for ${JSON.stringify(currentPath)}`);
      }
      followed.add(currentPath);
      resolvedParts.pop();
      pending.unshift(...linkedTarget.parts);
    } else if (pending.length > 0 && !manifest.directories.has(currentPath)) {
      throw new Error(`Cannot materialize pull-request source: dangling symlink target for ${JSON.stringify(sourcePath)}`);
    }
  }
  const resolvedPath = resolvedParts.join("/");
  if (resolvedPath && !manifest.byPath.has(resolvedPath) && !manifest.directories.has(resolvedPath)) {
    throw new Error(`Cannot materialize pull-request source: dangling symlink target for ${JSON.stringify(sourcePath)}`);
  }
  return resolvedPath;
}

async function materializeSymlink(entry: TreeEntry, target: string, root: string, signal?: AbortSignal): Promise<void> {
  checkCanceled(signal, `materializing ${entry.path}`);
  await ensureEntryParents(entry, root);
  const destination = safeDestination(root, entry.path);
  await symlink(target, destination);
}

async function setTreeMode(root: string, directoryMode: number, fileMode: number, signal?: AbortSignal): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    checkCanceled(signal, "finalizing the source view");
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(`Cannot finalize source view: symlink traversal at ${directory}`);
    }
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      checkCanceled(signal, "finalizing the source view");
      const path = join(directory, child.name);
      if (child.isSymbolicLink()) {
        continue;
      }
      if (child.isDirectory()) {
        await walk(path);
        await chmod(path, directoryMode);
      } else if (child.isFile()) {
        await chmod(path, fileMode);
      } else {
        throw new Error(`Cannot finalize source view: unsupported filesystem entry ${path}`);
      }
    }
  };
  await walk(root);
  await chmod(root, directoryMode);
}

async function cleanRoot(root: string): Promise<void> {
  try {
    await setTreeMode(root, 0o700, 0o600);
  } catch {
    // rm is still attempted: a partially-created tree must not be abandoned
    // merely because one cleanup chmod failed.
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

function noOpSourceView(cwd: string): ReviewSourceView {
  return { root: cwd, dispose: async (): Promise<void> => undefined };
}

/** Materialize the captured pull-request commit without touching the checkout. */
export async function prepareReviewSourceView(
  snapshot: ReviewSnapshot,
  commands: CommandRunner,
  signal?: AbortSignal,
  providedLimits?: SourceViewLimits,
): Promise<ReviewSourceView> {
  if (snapshot.target.kind !== "pull-request") return noOpSourceView(snapshot.cwd);
  const limits = validateLimits(providedLimits ?? {});
  const headSha = validateHead(snapshot);
  const cwd = snapshot.cwd;
  let root: string | undefined;
  try {
    let objectResult: CommandResult;
    try {
      objectResult = await checkedRun(commands, ["cat-file", "-e", `${headSha}^{commit}`], cwd, signal, "verify the captured pull-request head commit");
    } catch (error) {
      if (signal?.aborted || errorMessage(error).includes("canceled")) throw error;
      throw new Error(`Captured pull-request head commit ${headSha} is missing from ${cwd}; no network fetch was attempted (${errorMessage(error)})`);
    }
    if (objectResult.truncated || objectResult.exitCode !== 0) {
      throw new Error(`Captured pull-request head commit ${headSha} is missing from ${cwd}; no network fetch was attempted`);
    }
    const listingResult = await checkedRun(commands, ["ls-tree", "-r", "-l", "-z", "--full-tree", headSha], cwd, signal, "list the captured pull-request tree");
    ensureSuccessful(listingResult, "list the captured pull-request tree");
    if (Buffer.byteLength(listingResult.stdout, "utf8") > limits.maxListingBytes) {
      throw new Error(`Cannot materialize pull-request source: git tree listing exceeds the limit of ${limits.maxListingBytes} bytes`);
    }
    const manifest = parseTreeListing(listingResult.stdout, limits);
    const symlinkTargets = new Map<string, { readonly raw: string; readonly parts: readonly string[] }>();
    for (const entry of manifest.entries) {
      if (entry.mode !== "120000") continue;
      const target = decodeSymlinkTarget(entry, await readCommittedBlob(entry, cwd, signal));
      symlinkTargets.set(entry.path, target);
    }
    for (const entry of manifest.entries) {
      if (entry.mode !== "120000") continue;
      const target = symlinkTargets.get(entry.path);
      if (target === undefined) throw new Error(`Cannot materialize pull-request source: missing symlink target for ${JSON.stringify(entry.path)}`);
      const parts = validatePath(entry.path);
      resolveManifestPath(manifest, symlinkTargets, parts.slice(0, -1), target.parts, entry.path);
    }
    checkCanceled(signal, "materializing the captured pull-request tree");
    root = await mkdtemp(join(tmpdir(), "pi-review-source-"));
    await chmod(root, 0o700);
    await materializeDirectories(manifest, root, signal);
    for (const entry of manifest.entries) {
      if (entry.mode !== "120000") await materializeBlob(entry, root, cwd, signal);
    }
    for (const entry of manifest.entries) {
      if (entry.mode === "120000") {
        const target = symlinkTargets.get(entry.path);
        if (target === undefined) throw new Error(`Cannot materialize pull-request source: missing symlink target for ${JSON.stringify(entry.path)}`);
        await materializeSymlink(entry, target.raw, root, signal);
      }
    }
    await setTreeMode(root, 0o555, 0o444, signal);
    for (const entry of manifest.entries) {
      checkCanceled(signal, "finalizing the source view");
      if (entry.mode === "100755") await chmod(resolve(root, entry.path), 0o555);
    }
    let disposed = false;
    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      if (disposal) return disposal;
      disposal = (async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        await cleanRoot(root as string);
      })();
      return disposal;
    };
    return { root, revision: headSha, dispose };
  } catch (error) {
    if (root !== undefined) {
      try {
        await cleanRoot(root);
      } catch (cleanupError) {
        throw new Error(`${errorMessage(error)} (additionally, failed to clean temporary source view ${root}: ${errorMessage(cleanupError)})`);
      }
    }
    throw error;
  }
}
