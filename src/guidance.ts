import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const GUIDANCE_NAMES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"] as const;
const MAX_GUIDANCE_BYTES = 64 * 1024;

export interface GuidanceFile {
  readonly path: string;
  readonly content: string;
}

export interface GuidanceDiscoveryResult {
  readonly files: readonly GuidanceFile[];
  readonly failures: readonly string[];
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

export function discoverApplicableGuidance(cwd: string, changedPaths: readonly string[]): GuidanceDiscoveryResult {
  const root = resolve(cwd);
  const directories = new Set<string>([root]);
  for (const changedPath of changedPaths) {
    const directory = fileDirectory(root, changedPath);
    for (const ancestor of ancestorDirectories(directory, root)) directories.add(ancestor);
  }

  const paths = [...directories]
    .sort((left, right) => left.split(sep).length - right.split(sep).length || left.localeCompare(right))
    .flatMap((directory) => GUIDANCE_NAMES.map((name) => join(directory, name)))
    .filter((path) => existsSync(path));

  const files: GuidanceFile[] = [];
  const failures: string[] = [];
  for (const path of paths) {
    try {
      const content = readFileSync(path).subarray(0, MAX_GUIDANCE_BYTES).toString("utf8");
      files.push({ path, content });
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { files, failures };
}

export function formatGuidance(files: readonly GuidanceFile[], cwd: string): string {
  if (files.length === 0) return "No applicable repository guidance files were found.";
  return files
    .map((file) => `### ${relative(cwd, file.path) || file.path}\n${file.content}`)
    .join("\n\n");
}
