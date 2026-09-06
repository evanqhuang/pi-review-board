import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const GUIDANCE_NAMES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"] as const;
export const MAX_GUIDANCE_BYTES = 64 * 1024;
const MAX_GUIDANCE_READ_BYTES = MAX_GUIDANCE_BYTES + 1;

export interface GuidanceFile {
  readonly path: string;
  readonly content: string;
}

/** A guidance file that was excluded because its complete contents exceed the read cap. */
export interface GuidanceTruncation {
  readonly path: string;
  readonly byteLength: number;
  readonly maxBytes: number;
  readonly message: string;
}

export interface GuidanceDiscoveryResult {
  readonly files: readonly GuidanceFile[];
  readonly failures: readonly string[];
  readonly truncations: readonly GuidanceTruncation[];
}

/** Return whether a guidance file's directory governs a repository path. */
export function guidanceCoversPath(cwd: string, guidancePath: string, changedPath: string): boolean {
  const root = resolve(cwd);
  const directory = resolve(dirname(guidancePath));
  const target = resolve(root, changedPath);
  const boundary = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return target === directory || target.startsWith(boundary);
}

/** Restrict guidance to rules applicable to one changed repository path. */
export function guidanceForPath(
  cwd: string,
  files: readonly GuidanceFile[],
  changedPath: string,
): GuidanceFile[] {
  return files.filter((file) => guidanceCoversPath(cwd, file.path, changedPath));
}

function ancestorDirectories(start: string, stop: string): string[] {
  const directories: string[] = [];
  let current = resolve(start);
  const boundary = resolve(stop);
  const boundaryPrefix = boundary.endsWith(sep) ? boundary : `${boundary}${sep}`;
  while (current === boundary || current.startsWith(boundaryPrefix)) {
    directories.push(current);
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories.reverse();
}

function fileDirectory(cwd: string, changedPath: string): string {
  const candidate = resolve(cwd, changedPath);
  try {
    return statSync(candidate).isDirectory() ? candidate : dirname(candidate);
  } catch {
    return dirname(candidate);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function guidanceTruncation(path: string, byteLength: number): GuidanceTruncation {
  return {
    path,
    byteLength,
    maxBytes: MAX_GUIDANCE_BYTES,
    message: `guidance file exceeds ${MAX_GUIDANCE_BYTES} UTF-8-byte limit`,
  };
}

/**
 * Open and inspect one candidate without ever reading more than the bounded
 * guidance window plus one byte used to detect a size race.
 */
function readGuidanceFile(
  path: string,
  root: string,
  files: GuidanceFile[],
  failures: string[],
  truncations: GuidanceTruncation[],
): void {
  let descriptor: number | undefined;
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      failures.push(`${path}: symbolic links are not supported for guidance files`);
      return;
    }

    // Canonicalize the containing directory before opening the file so a
    // nested directory symlink cannot intentionally point guidance outside
    // the repository. The descriptor and O_NOFOLLOW below also narrow the
    // remaining path swap window for the final file component.
    const realRoot = realpathSync(root);
    const realDirectory = realpathSync(dirname(path));
    if (!isWithinRoot(realRoot, realDirectory)) {
      failures.push(`${path}: guidance path resolves outside the repository root`);
      return;
    }

    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error("guidance path is not a regular file");

    if (opened.size > MAX_GUIDANCE_BYTES) {
      const truncation = guidanceTruncation(path, opened.size);
      truncations.push(truncation);
      failures.push(`${path}: ${truncation.message}`);
      return;
    }

    // Reading one extra byte is still bounded and catches a file growing
    // between fstat and read. No partial content is exposed as guidance.
    const buffer = Buffer.allocUnsafe(MAX_GUIDANCE_READ_BYTES);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const afterRead = fstatSync(descriptor);
    const byteLength = Math.max(opened.size, afterRead.size, bytesRead);
    if (byteLength > MAX_GUIDANCE_BYTES || bytesRead > MAX_GUIDANCE_BYTES) {
      const truncation = guidanceTruncation(path, byteLength);
      truncations.push(truncation);
      failures.push(`${path}: ${truncation.message}`);
      return;
    }

    files.push({ path, content: buffer.subarray(0, bytesRead).toString("utf8") });
  } catch (error) {
    failures.push(`${path}: ${errorMessage(error)}`);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The read/stat result is already bounded; there is no safe content
        // to add if descriptor cleanup itself fails.
      }
    }
  }
}

export function discoverApplicableGuidance(cwd: string, changedPaths: readonly string[]): GuidanceDiscoveryResult {
  const root = resolve(cwd);
  const directories = new Set<string>([root]);
  for (const changedPath of changedPaths) {
    const directory = fileDirectory(root, changedPath);
    for (const ancestor of ancestorDirectories(directory, root)) directories.add(ancestor);
  }

  const paths = [...directories]
    .sort((left, right) => left.split(sep).length - right.split(sep).length || left.localeCompare(right))
    .flatMap((directory) => GUIDANCE_NAMES.map((name) => join(directory, name)));

  const files: GuidanceFile[] = [];
  const failures: string[] = [];
  const truncations: GuidanceTruncation[] = [];
  for (const path of paths) {
    try {
      lstatSync(path);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      failures.push(`${path}: ${errorMessage(error)}`);
      continue;
    }
    readGuidanceFile(path, root, files, failures, truncations);
  }
  return { files, failures, truncations };
}

export function formatGuidance(files: readonly GuidanceFile[], cwd: string): string {
  if (files.length === 0) return "No applicable repository guidance files were found.";
  return files
    .map((file) => `### ${relative(cwd, file.path) || file.path}\n${file.content}`)
    .join("\n\n");
}
