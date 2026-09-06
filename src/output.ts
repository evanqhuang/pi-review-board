import type {
  ReviewCandidate,
  ReviewCoverage,
  ReviewCoverageRange,
  ReviewSnapshot,
  StageFailure,
  VerifiedFinding,
} from "./types.js";
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
  // A reviewer may include Git's a/ or b/ prefix. Strip it only as a
  // fallback, so a real top-level directory named a or b remains intact.
  const diffNormalized = normalizeDiffPath(normalized);
  const diffLocation = `${diffNormalized}:${line}`;
  if (changedLocations.has(diffLocation)) return diffNormalized;
  const aliases = (changedLocations as Partial<ChangedLocations>).gitAliases;
  const canonical = aliases?.get(location) ?? aliases?.get(diffLocation);
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

function normalizedCandidatePath(value: string): string {
  // Filtering normally canonicalizes Git prefixes first. Do not strip a
  // leading a/ or b/ here: those can be legitimate repository directories.
  return normalizeReviewPath(value).trim();
}

function candidateKey(candidate: ReviewCandidate): string {
  // A root cause can legitimately occur at multiple changed locations or have
  // multiple failure modes. Only collapse an observation when all three
  // identifying dimensions overlap.
  return [
    normalize(candidate.rootCauseKey),
    `${normalizedCandidatePath(candidate.file)}:${candidate.line}`,
    normalize(candidate.failureScenario),
  ].join("|");
}

export function deduplicateCandidates(candidates: readonly ReviewCandidate[]): ReviewCandidate[] {
  const byObservation = new Map<string, ReviewCandidate>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const existing = byObservation.get(key);
    if (!existing) {
      // Map insertion order is the finder order and candidate IDs are supplied
      // by the caller, so retaining the first observation keeps both stable.
      byObservation.set(key, candidate);
      continue;
    }
    // needsContext is an escalation request, so losing it during a merge would
    // silently discard a request for the nearest follow-up context.
    if (existing.needsContext || candidate.needsContext) {
      byObservation.set(key, { ...existing, needsContext: true });
    }
  }
  return [...byObservation.values()];
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
  // Verification is intentionally strict regardless of the caller's effort
  // mode: plausible and refuted observations are never reportable, and a
  // confirmed result needs at least 85% confidence.
  const minimumConfidence = Math.max(85, options.minimumConfidence ?? 85);
  const findings: VerifiedFinding[] = [];
  for (const verification of verifications) {
    const candidate = byId.get(verification.candidateId);
    if (!candidate || verification.disposition !== "CONFIRMED" || verification.confidence < minimumConfidence) continue;
    const file = candidate.file;
    const line = candidate.line;
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
  return findings.sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || right.confidence - left.confidence || left.file.localeCompare(right.file) || left.line - right.line || left.id.localeCompare(right.id));
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

const MAX_COVERAGE_GROUPS = 12;
const MAX_RANGES_PER_COVERAGE_GROUP = 4;
const MAX_COVERAGE_TEXT = 160;

function boundedCoverageText(value: string, limit = MAX_COVERAGE_TEXT): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function coverageRoleFromUnit(unitId: string | undefined): string | undefined {
  if (unitId === undefined) return undefined;
  const marker = ":work:";
  const markerIndex = unitId.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const role = unitId.slice(markerIndex + marker.length).split(":", 1)[0];
  return role || undefined;
}

function coverageRangeText(range: ReviewCoverageRange): string {
  const file = range.fileIdentity === undefined ? "diff" : boundedCoverageText(range.fileIdentity, 80);
  const sides: string[] = [];
  const formatSide = (label: string, value: { readonly start: number; readonly count: number }): string => {
    const end = value.count > 0 ? value.start + value.count - 1 : value.start;
    return `${label} ${value.start}-${end}`;
  };
  if (range.oldRange !== undefined) sides.push(formatSide("old", range.oldRange));
  if (range.newRange !== undefined) sides.push(formatSide("new", range.newRange));
  return `${file}${sides.length > 0 ? ` (${sides.join(", ")})` : ""}`;
}

interface CoverageDetailGroup {
  readonly shard: string;
  readonly role: string;
  readonly reason: string;
  readonly ranges: string[];
  readonly units: string[];
}

function coverageDetailGroups(coverage: ReviewCoverage): CoverageDetailGroup[] {
  const groups = new Map<string, CoverageDetailGroup>();
  const ranges = coverage.uncoveredRanges.length > 0
    ? coverage.uncoveredRanges
    : coverage.uncoveredRangeEvidence ?? [];
  const add = (shard: string, role: string, reason: string, range?: string, unit?: string): void => {
    const boundedShard = boundedCoverageText(shard, 100) || "unknown";
    const boundedRole = boundedCoverageText(role, 100) || "unknown";
    const boundedReason = boundedCoverageText(reason) || "coverage is unavailable";
    const key = `${boundedShard}\u0000${boundedRole}\u0000${boundedReason}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        shard: boundedShard,
        role: boundedRole,
        reason: boundedReason,
        ranges: range === undefined ? [] : [range],
        units: unit === undefined ? [] : [unit],
      });
      return;
    }
    if (range !== undefined && !existing.ranges.includes(range)) existing.ranges.push(range);
    if (unit !== undefined && !existing.units.includes(unit)) existing.units.push(unit);
  };

  const representedUnits = new Set<string>();
  const representedShards = new Set<string>();
  for (const range of ranges) {
    if (range.unitId !== undefined) representedUnits.add(range.unitId);
    if (range.shardId !== undefined) representedShards.add(range.shardId);
    add(
      range.shardId ?? "unknown",
      range.role ?? coverageRoleFromUnit(range.unitId) ?? "unknown",
      range.reason || coverage.reason || "coverage is unavailable",
      coverageRangeText(range),
      range.unitId,
    );
  }
  for (const unitId of coverage.uncoveredUnitIds) {
    if (representedUnits.has(unitId)) continue;
    add("unknown", coverageRoleFromUnit(unitId) ?? "unknown", coverage.reason ?? "work unit is uncovered", undefined, unitId);
  }
  const uncoveredShardIds = coverage.uncoveredShardIds && coverage.uncoveredShardIds.length > 0
    ? coverage.uncoveredShardIds
    : coverage.uncoveredShards ?? coverage.uncoveredShardIds ?? [];
  for (const shardId of uncoveredShardIds) {
    if (representedShards.has(shardId)) continue;
    add(shardId, "unknown", coverage.reason ?? "shard is uncovered");
  }
  return [...groups.values()];
}

function coverageShardCount(coverage: ReviewCoverage, kind: "planned" | "covered"): number {
  const count = kind === "planned"
    ? coverage.plannedShardCount ?? coverage.plannedShardIds?.length ?? coverage.plannedShards?.length
    : coverage.coveredShardCount ?? coverage.coveredShardIds?.length ?? coverage.coveredShards?.length;
  return count ?? 0;
}

function coverageIsIncomplete(coverage: ReviewCoverage | undefined): boolean {
  if (coverage === undefined) return false;
  return coverage.state !== "complete"
    || coverage.uncoveredUnitIds.length > 0
    || coverage.uncoveredRanges.length > 0
    || (coverage.uncoveredRangeEvidence?.length ?? 0) > 0
    || (coverage.uncoveredShardIds?.length ?? 0) > 0
    || (coverage.uncoveredShards?.length ?? 0) > 0
    || (coverage.unvalidatedCandidates !== undefined && coverage.unvalidatedCandidates.length > 0)
    || coverage.uncoveredCandidates.length > 0;
}

function formatCoverageDetails(coverage: ReviewCoverage): string[] {
  const groups = coverageDetailGroups(coverage);
  const lines = ["Coverage gaps (bounded):"];
  if (groups.length === 0) {
    lines.push("- No uncovered range, shard, or work-unit detail was supplied.");
  } else {
    for (const group of groups.slice(0, MAX_COVERAGE_GROUPS)) {
      const ranges = group.ranges.slice(0, MAX_RANGES_PER_COVERAGE_GROUP);
      const rangeText = ranges.length > 0 ? ` · ranges ${ranges.join(", ")}` : "";
      const units = group.units.slice(0, MAX_RANGES_PER_COVERAGE_GROUP);
      const unitText = units.length > 0
        ? ` · units ${units.map((unit) => boundedCoverageText(unit, 100)).join(", ")}`
        : "";
      const omittedRanges = group.ranges.length - ranges.length;
      const omittedUnits = group.units.length - units.length;
      const omitted = [
        omittedRanges > 0 ? `+${omittedRanges} more ranges` : undefined,
        omittedUnits > 0 ? `+${omittedUnits} more units` : undefined,
      ].filter((value): value is string => value !== undefined);
      lines.push(`- shard ${group.shard} · role ${group.role}${rangeText}${unitText} · reason: ${group.reason}${omitted.length > 0 ? ` · ${omitted.join(" · ")}` : ""}`);
    }
    if (groups.length > MAX_COVERAGE_GROUPS) lines.push(`- +${groups.length - MAX_COVERAGE_GROUPS} more coverage groups`);
  }
  const budget = coverage.budget ?? {
    maxWeight: coverage.budgetMaxWeight ?? coverage.maxWeight ?? 0,
    reservedWeight: coverage.budgetReservedWeight ?? coverage.reservedWeight ?? 0,
    spentWeight: coverage.budgetSpentWeight ?? coverage.spentWeight ?? 0,
  };
  const unvalidated = coverage.unvalidatedCandidates && coverage.unvalidatedCandidates.length > 0
    ? coverage.unvalidatedCandidates
    : coverage.uncoveredCandidates;
  lines.push(
    `Budget: spent ${budget.spentWeight} · reserved ${budget.reservedWeight} · max ${budget.maxWeight} weighted units`,
    `Unvalidated candidates: ${unvalidated?.length ?? 0}`,
  );
  return lines;
}

export function formatReviewReport(
  snapshot: ReviewSnapshot,
  status: "complete" | "ineligible" | "incomplete",
  summary: string,
  findings: readonly VerifiedFinding[],
  failures: readonly StageFailure[],
  coverage?: ReviewCoverage,
): string {
  const target = formatReviewTarget(snapshot);
  const cleanSummary = summary.trim();
  const incompleteCoverage = coverageIsIncomplete(coverage);
  const reportIsIncomplete = status !== "complete" || incompleteCoverage;
  // Summaries originate in the review pipeline and may say "No issues found"
  // even when a later coverage record proves that the review was partial.
  // Never repeat clean/approval language in that case.
  const reportSummary = reportIsIncomplete && /(?:no\s+issues?|no\s+findings?|clean|pass(?:ed)?|approval|approved|all\s+clear)/iu.test(cleanSummary)
    ? ""
    : cleanSummary;
  if (status === "ineligible" && coverage === undefined) {
    return `### Code review\n\n${target}\n\nNot reviewed${reportSummary ? `: ${reportSummary}` : ""}`;
  }
  const title = findings.length > 0
    ? `Found ${findings.length} issue${findings.length === 1 ? "" : "s"}`
    : status === "complete" && incompleteCoverage
      ? "Review incomplete"
      : status === "complete"
        ? "No issues found"
        : "No verified findings";
  const lines = [`### Code review`, "", target];
  if (incompleteCoverage && coverage !== undefined) {
    lines.push("", `INCOMPLETE REVIEW — Covered ${coverageShardCount(coverage, "covered")}/${coverageShardCount(coverage, "planned")} shards`);
  }
  if (status === "ineligible") {
    lines.push("", `Not reviewed${reportSummary ? `: ${reportSummary}` : ""}`);
    if (incompleteCoverage && coverage !== undefined) lines.push("", ...formatCoverageDetails(coverage));
    return lines.join("\n");
  }
  lines.push("", title + ".");
  if (reportSummary) lines.push("", reportSummary);
  if (incompleteCoverage && coverage !== undefined) lines.push("", ...formatCoverageDetails(coverage));
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
  coverage?: ReviewCoverage,
): string {
  return formatReviewReport(snapshot, status, summary, findings, failures, coverage);
}
