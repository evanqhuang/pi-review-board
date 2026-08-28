import type { ReviewCandidate, ReviewSnapshot, StageFailure, VerifiedFinding } from "./types.js";
import type { VerifierOutput } from "./prompts.js";

const severityRank: Record<ReviewCandidate["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function decodeGitPath(value: string): string {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return value;
  const encoded = trimmed.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length;) {
    if (encoded[index] === "\\" && /^[0-7]{3}/u.test(encoded.slice(index + 1, index + 4))) {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 4), 8));
      index += 4;
      continue;
    }
    if (encoded[index] === "\\" && index + 1 < encoded.length) {
      const escaped = encoded[index + 1] as string;
      const escapedCharacters: Readonly<Record<string, string>> = {
        a: "\u0007",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\u000b",
        "\\": "\\",
        '"': '"',
      };
      const replacement = escapedCharacters[escaped];
      if (replacement !== undefined) {
        for (const byte of Buffer.from(replacement)) bytes.push(byte);
        index += 2;
        continue;
      }
    }
    const codePoint = encoded.codePointAt(index);
    const character = String.fromCodePoint(codePoint ?? 0);
    for (const byte of Buffer.from(character)) bytes.push(byte);
    index += character.length;
  }
  return Buffer.from(bytes).toString("utf8");
}

export function normalizeReviewPath(value: string): string {
  const decoded = decodeGitPath(value);
  const platformPath = process.platform === "win32" ? decoded.replaceAll("\\", "/") : decoded;
  return platformPath.replace(/^\.\//u, "");
}

function normalizeDiffPath(value: string): string {
  return normalizeReviewPath(value).replace(/^(?:a|b)\//u, "");
}

type ChangedLocations = Set<string> & { readonly gitAliases: ReadonlyMap<string, string> };

function matchingChangedPath(value: string, line: number, changedLocations: ReadonlySet<string>): string | undefined {
  const normalized = normalizeReviewPath(value);
  const location = `${normalized}:${line}`;
  if (changedLocations.has(location)) return normalized;
  const canonical = (changedLocations as Partial<ChangedLocations>).gitAliases?.get(location);
  return canonical ? canonical.slice(0, canonical.lastIndexOf(":")) : undefined;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

export function collectChangedLocations(diff: string): ReadonlySet<string> {
  const locations = new Set<string>() as ChangedLocations;
  const gitAliases = new Map<string, string>();
  Object.defineProperty(locations, "gitAliases", { value: gitAliases, enumerable: false });
  let currentFile: string | undefined;
  let oldFile: string | undefined;
  let currentGitFile: string | undefined;
  let oldGitFile: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      currentFile = undefined;
      oldFile = undefined;
      currentGitFile = undefined;
      oldGitFile = undefined;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      const gitFile = normalizeReviewPath(line.slice(4));
      oldGitFile = gitFile === "/dev/null" ? undefined : gitFile;
      oldFile = oldGitFile?.replace(/^(?:a|b)\//u, "");
      currentFile = oldFile;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const gitFile = normalizeReviewPath(line.slice(4));
      currentGitFile = gitFile === "/dev/null" ? undefined : gitFile;
      const file = normalizeDiffPath(gitFile);
      currentFile = file === "/dev/null" ? oldFile : file;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = currentFile !== undefined;
      continue;
    }
    if (!inHunk || !currentFile) continue;
    if (line.startsWith("+")) {
      const location = `${currentFile}:${newLine}`;
      locations.add(location);
      if (currentGitFile && currentGitFile !== currentFile) gitAliases.set(`${currentGitFile}:${newLine}`, location);
      newLine += 1;
    } else if (line.startsWith("-")) {
      const deletionFile = oldFile ?? currentFile;
      if (!deletionFile) continue;
      const location = `${deletionFile}:${oldLine}`;
      locations.add(location);
      if (oldGitFile && oldGitFile !== deletionFile) gitAliases.set(`${oldGitFile}:${oldLine}`, location);
      oldLine += 1;
    } else if (!line.startsWith("\\")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return locations;
}

export function filterCandidatesToChangedLines(
  candidates: readonly ReviewCandidate[],
  changedLocations: ReadonlySet<string>,
): ReviewCandidate[] {
  return candidates.flatMap((candidate) => {
    const file = matchingChangedPath(candidate.file, candidate.line, changedLocations);
    return file ? [{ ...candidate, file }] : [];
  });
}

function candidateKey(candidate: ReviewCandidate): string {
  return `${candidate.file}:${candidate.line}:${normalize(candidate.summary)}:${normalize(candidate.failureScenario).slice(0, 160)}`;
}

export function deduplicateCandidates(candidates: readonly ReviewCandidate[]): ReviewCandidate[] {
  const seen = new Set<string>();
  const result: ReviewCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export interface FindingFilterOptions {
  readonly changedLocations?: ReadonlySet<string>;
  readonly minimumConfidence?: number;
  readonly retainPlausible?: boolean;
}

export function filterVerifiedFindings(
  candidates: readonly ReviewCandidate[],
  verifications: readonly VerifierOutput[],
  options: FindingFilterOptions = {},
): VerifiedFinding[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const minimumConfidence = options.minimumConfidence ?? 80;
  const findings: VerifiedFinding[] = [];
  for (const verification of verifications) {
    const candidate = byId.get(verification.candidateId);
    const acceptableDisposition = verification.disposition === "CONFIRMED" || (options.retainPlausible === true && verification.disposition === "PLAUSIBLE");
    if (!candidate || !acceptableDisposition || verification.confidence < minimumConfidence) continue;
    const file = verification.file ?? candidate.file;
    const line = verification.line ?? candidate.line;
    const matchedFile = options.changedLocations ? matchingChangedPath(file, line, options.changedLocations) : normalizeReviewPath(file);
    if (!matchedFile) continue;
    findings.push({
      ...candidate,
      file: matchedFile,
      line,
      confidence: verification.confidence,
      verification: verification.verification,
    });
  }
  return findings.sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || right.confidence - left.confidence || left.file.localeCompare(right.file) || left.line - right.line);
}

export function promoteDirectFindings(candidates: readonly ReviewCandidate[], verification: string): VerifiedFinding[] {
  return candidates.map((candidate) => ({
    ...candidate,
    confidence: 100,
    verification,
  }));
}

function isOldSidePath(snapshot: ReviewSnapshot, file: string): boolean {
  const normalizedFile = normalizeReviewPath(file);
  let oldPath: string | undefined;
  let inHunk = false;
  for (const line of snapshot.diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = undefined;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (inHunk) continue;
    if (line.startsWith("--- ")) {
      const path = normalizeDiffPath(line.slice(4));
      oldPath = path === "/dev/null" ? undefined : path;
      continue;
    }
    if (line.startsWith("+++ ") && oldPath) {
      const newPath = normalizeDiffPath(line.slice(4));
      if (normalizedFile === oldPath && (newPath === "/dev/null" || newPath !== oldPath)) return true;
      oldPath = undefined;
    }
  }
  return false;
}

function githubFileLink(snapshot: ReviewSnapshot, finding: VerifiedFinding): string | undefined {
  const pullRequest = snapshot.pullRequest;
  const oldSide = isOldSidePath(snapshot, finding.file);
  const revision = oldSide ? snapshot.baseSha : pullRequest?.headSha;
  if (!pullRequest?.repository || !revision) return undefined;
  const file = normalizeReviewPath(finding.file).split("/").map((part) => encodeURIComponent(part)).join("/");
  return `https://github.com/${pullRequest.repository}/blob/${revision}/${file}#L${finding.line}`;
}

function findingText(snapshot: ReviewSnapshot, finding: VerifiedFinding): string {
  const link = githubFileLink(snapshot, finding);
  const location = link ? `[${finding.file}:${finding.line}](${link})` : `${finding.file}:${finding.line}`;
  return `- **${finding.severity}** ${finding.summary} — ${location}\n  Failure: ${finding.failureScenario}\n  Verification: ${finding.verification}`;
}

function formatReviewTarget(snapshot: ReviewSnapshot): string {
  if (snapshot.pullRequest) {
    const label = `${snapshot.pullRequest.repository}#${snapshot.pullRequest.number}`;
    return snapshot.pullRequest.url ? `**Target:** [${label}](${snapshot.pullRequest.url})` : `**Target:** \`${label}\``;
  }
  switch (snapshot.target.kind) {
    case "current-diff":
      return "**Target:** current diff";
    case "branch":
      return `**Target:** branch \`${snapshot.target.ref}\``;
    case "path":
      return `**Target:** path \`${snapshot.target.path}\``;
    case "worktree":
      return `**Target:** worktree \`${snapshot.target.path}\``;
    case "pull-request":
      return `**Target:** pull request \`${snapshot.target.value}\``;
  }
}

export function formatReviewReport(
  snapshot: ReviewSnapshot,
  status: "complete" | "ineligible" | "incomplete",
  summary: string,
  findings: readonly VerifiedFinding[],
  failures: readonly StageFailure[],
): string {
  const target = formatReviewTarget(snapshot);
  if (status === "ineligible") return `### Code review\n\n${target}\n\nNot reviewed: ${summary}`;
  const title = findings.length > 0
    ? `Found ${findings.length} issue${findings.length === 1 ? "" : "s"}`
    : status === "complete"
      ? "No issues found"
      : "No verified findings";
  const lines = [`### Code review`, "", target, "", title + "."];
  if (summary) lines.push("", summary);
  if (findings.length > 0) lines.push("", ...findings.map((finding) => findingText(snapshot, finding)));
  if (failures.length > 0) {
    lines.push("", status === "incomplete" ? "Review incomplete:" : "Review warnings:");
    lines.push(...failures.map((failure) => `- ${failure.stage}: ${failure.message}`));
  }
  return lines.join("\n");
}

export function formatPrComment(
  snapshot: ReviewSnapshot,
  status: "complete" | "ineligible" | "incomplete",
  summary: string,
  findings: readonly VerifiedFinding[],
  failures: readonly StageFailure[],
): string {
  return formatReviewReport(snapshot, status, summary, findings, failures);
}
