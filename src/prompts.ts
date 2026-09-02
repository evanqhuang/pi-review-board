import type { PullRequestMetadata, ReviewCandidate, ReviewSnapshot } from "./types.js";
import { formatGuidance, type GuidanceFile } from "./guidance.js";
import { REVIEWER_RESULT_TOOLS } from "./reviewer-protocol.js";

export interface EligibilityOutput {
  readonly proceed: boolean;
  readonly reason: string;
}

export interface SummaryOutput {
  readonly summary: string;
}

export interface FinderCandidate {
  readonly id: string;
  readonly rootCauseKey: string;
  readonly file: string;
  readonly line: number;
  readonly summary: string;
  readonly failureScenario: string;
  readonly evidence: string;
  readonly category: ReviewCandidate["category"];
  readonly severity: ReviewCandidate["severity"];
  /** Internal escalation request; it is never a finding by itself. */
  readonly needsContext: boolean;
}

export interface FinderOutput {
  readonly candidates: readonly FinderCandidate[];
}

export type VerificationDisposition = "CONFIRMED" | "PLAUSIBLE" | "REFUTED";

/** The result of validating exactly one candidate. */
export interface VerifierOutput {
  readonly candidateId: string;
  readonly confidence: number;
  readonly verification: string;
  readonly disposition: VerificationDisposition;
}


function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Expected non-empty ${field}`);
  return value.trim();
}

function integer(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`Expected positive integer ${field}`);
  return value as number;
}

const categories = new Set<ReviewCandidate["category"]>(["correctness", "guidance", "history", "integration", "contract"]);
/** Low-severity noise is deliberately not accepted from a finder. */
const severities = new Set<Exclude<ReviewCandidate["severity"], "low">>(["critical", "high", "medium"]);

export function validateEligibility(value: unknown): EligibilityOutput {
  const raw = object(value);
  if (typeof raw.proceed !== "boolean") throw new Error("Eligibility response must contain boolean proceed");
  return { proceed: raw.proceed, reason: string(raw.reason, "reason") };
}

export function validateSummary(value: unknown): SummaryOutput {
  const raw = object(value);
  return { summary: string(raw.summary, "summary") };
}

export function validateFinder(value: unknown): FinderOutput {
  const raw = object(value);
  if (!Array.isArray(raw.candidates)) throw new Error("Finder response must contain candidates array");
  if (raw.candidates.length > 8) throw new Error("Finder response contains too many candidates");
  const candidates = raw.candidates.map((candidate, index) => {
    const item = object(candidate);
    const category = string(item.category, `candidates[${index}].category`) as ReviewCandidate["category"];
    const severity = string(item.severity, `candidates[${index}].severity`) as ReviewCandidate["severity"];
    if (!categories.has(category)) throw new Error(`Unknown candidate category: ${category}`);
    if (!severities.has(severity as Exclude<ReviewCandidate["severity"], "low">)) {
      throw new Error(`Unknown or unsupported candidate severity: ${severity}`);
    }
    if (typeof item.needsContext !== "boolean") throw new Error(`Expected boolean candidates[${index}].needsContext`);
    return {
      id: string(item.id, `candidates[${index}].id`),
      rootCauseKey: string(item.rootCauseKey, `candidates[${index}].rootCauseKey`),
      file: string(item.file, `candidates[${index}].file`),
      line: integer(item.line, `candidates[${index}].line`),
      summary: string(item.summary, `candidates[${index}].summary`),
      failureScenario: string(item.failureScenario, `candidates[${index}].failureScenario`),
      evidence: string(item.evidence, `candidates[${index}].evidence`),
      category,
      severity: severity as ReviewCandidate["severity"],
      needsContext: item.needsContext,
    } satisfies FinderCandidate;
  });
  return { candidates };
}

/** Validate one candidate verdict, optionally enforcing its correlation ID. */
export function validateVerifier(value: unknown, expectedCandidateId?: string): VerifierOutput {
  const raw = object(value);
  const confidence = raw.confidence;
  if (!Number.isInteger(confidence) || (confidence as number) < 0 || (confidence as number) > 100) {
    throw new Error("Verifier confidence must be an integer from 0 to 100");
  }
  const disposition = string(raw.disposition, "disposition");
  if (disposition !== "CONFIRMED" && disposition !== "PLAUSIBLE" && disposition !== "REFUTED") {
    throw new Error(`Unknown verification disposition: ${disposition}`);
  }
  const candidateId = string(raw.candidateId, "candidateId");
  if (expectedCandidateId !== undefined && candidateId !== expectedCandidateId) {
    throw new Error(`Verifier candidateId must be ${expectedCandidateId}`);
  }
  return {
    candidateId,
    confidence: confidence as number,
    verification: string(raw.verification, "verification"),
    disposition,
  };
}

/** Explicit name for the one-candidate validator contract. */
export const validateCandidate = validateVerifier;
export const validateCandidateValidator = validateVerifier;

/** Role-specific finders share the strict finder result contract. */
export const validateGuidance = validateFinder;
export const validateDiffOnlyBug = validateFinder;
export const validateContextualBug = validateFinder;
export const validateIntegration = validateFinder;
export const validateGuidanceOutput = validateFinder;
export const validateDiffOnlyBugOutput = validateFinder;
export const validateContextualBugOutput = validateFinder;
export const validateIntegrationOutput = validateFinder;
export const validateCandidateVerification = validateVerifier;

/** Shared instructions deliberately bound every worker, including summarizers. */
export const BOUNDED_WORKER_INSTRUCTIONS = [
  "Tools already work; do not troubleshoot tool availability.",
  "Perform the minimum investigation needed to support the result.",
  "Do not explore broadly, delegate, run tests, or run builds.",
  "For finding roles, report only introduced, high-signal defects with a concrete changed line and suspicion.",
  "Omit uncertainty: do not report concerns that cannot be concretely established from the supplied change.",
  "Use exactly one terminating result tool, once, as the final action; do not emit another response afterward.",
].join("\n");

function pullRequest(snapshot: ReviewSnapshot): PullRequestMetadata | undefined {
  if (snapshot.pullRequest) return snapshot.pullRequest;
  return snapshot.target.kind === "pull-request" ? snapshot.target.metadata : undefined;
}

function changeMetadata(snapshot: ReviewSnapshot): { readonly title: string; readonly body: string } {
  const metadata = pullRequest(snapshot);
  return { title: metadata?.title ?? "", body: metadata?.body ?? "" };
}

function reviewInput(payload: unknown): string {
  return ["<review-input>", JSON.stringify(payload), "</review-input>"].join("\n");
}

function finderResultInstructions(): string {
  return [
    `Call ${REVIEWER_RESULT_TOOLS.finder} exactly once as the final action.`,
    "Return candidates: [] when no introduced high-signal defect is concretely established.",
    "Every candidate must identify a concrete changed file and positive changed line, a suspicion, rootCauseKey, failureScenario, evidence, category, severity (critical, high, or medium), and needsContext.",
    "needsContext is only an escalation request for the nearest follow-up context; it is never reportable by itself. Guidance candidates should normally set needsContext to false.",
  ].join("\n");
}

function rolePrompt(role: string, focus: string, payload: unknown): string {
  return [
    `You are the bounded ${role} reviewer. ${focus}`,
    BOUNDED_WORKER_INSTRUCTIONS,
    finderResultInstructions(),
    reviewInput(payload),
  ].join("\n");
}

export function buildEligibilityPrompt(pullRequest: PullRequestMetadata): string {
  return [
    "Decide whether this open pull request needs a substantive code review.",
    "Return JSON only: {\"proceed\":true|false,\"reason\":\"...\"}.",
    "Reject automated, trivial, already-reviewed, closed, or draft changes. Do not reject a real change merely because tests are absent.",
    JSON.stringify(pullRequest),
  ].join("\n");
}

export function buildSummaryPrompt(snapshot: ReviewSnapshot, _guidance: readonly GuidanceFile[] = []): string {
  const { title, body } = changeMetadata(snapshot);
  return [
    "Summarize only the supplied change for the other bounded reviewers.",
    BOUNDED_WORKER_INSTRUCTIONS,
    `Call ${REVIEWER_RESULT_TOOLS.summary} exactly once as the final action with a concise summary string.`,
    reviewInput({ title, body, paths: snapshot.changedPaths, diff: snapshot.diff }),
  ].join("\n");
}

function guidanceIntent(snapshot: ReviewSnapshot, summary: string): string {
  const trimmedSummary = summary.trim();
  if (trimmedSummary) return trimmedSummary;
  const { title, body } = changeMetadata(snapshot);
  return [title, body].filter((part) => part.trim().length > 0).join("\n\n") || "No summary or pull-request intent supplied.";
}

export interface GuidanceScope {
  readonly path: string;
  readonly guidance: readonly GuidanceFile[];
}

export function buildGuidancePrompt(
  snapshot: ReviewSnapshot,
  guidanceByPath: readonly GuidanceScope[],
  summary = "",
): string {
  const changedFiles = [...guidanceByPath]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path, guidance }) => ({ path, guidance: formatGuidance(guidance, snapshot.cwd) }));
  return rolePrompt(
    "guidance",
    "Check only the changed code against the applicable repository guidance. Do not invent guidance or report a rule that does not apply to a changed line.",
    {
      summary: guidanceIntent(snapshot, summary),
      guidance: changedFiles,
      changedCode: { paths: snapshot.changedPaths, diff: snapshot.diff },
    },
  );
}

export function buildDiffOnlyBugPrompt(
  snapshot: ReviewSnapshot,
  _guidanceOrTitle: readonly GuidanceFile[] | string = [],
  _body = "",
): string {
  const { title, body } = changeMetadata(snapshot);
  return rolePrompt(
    "diff-only bug",
    "Reason from the diff alone. Do not assume unseen context, callers, repository conventions, or intended behavior; do not request context for a vague concern.",
    { title, body, diff: snapshot.diff },
  );
}

export function buildContextualBugPrompt(
  snapshot: ReviewSnapshot,
  _guidance: readonly GuidanceFile[] | string = [],
  _summary = "",
): string {
  return rolePrompt(
    "contextual bug",
    "Inspect only the nearest direct context needed to establish an introduced defect. Follow up through direct callers or consumers only; stop once the changed-line suspicion is established.",
    { changedPaths: snapshot.changedPaths, diff: snapshot.diff, followUpConstraints: "Nearest direct callers, consumers, and definitions only; no unrelated files or broad repository exploration." },
  );
}

export function buildIntegrationPrompt(
  snapshot: ReviewSnapshot,
  _guidance: readonly GuidanceFile[] | string = [],
  _summary = "",
): string {
  return rolePrompt(
    "integration",
    "Check only direct integration boundaries touched by the change. Follow up to the immediate consumer or contract boundary, and report only a concrete introduced failure.",
    { changedPaths: snapshot.changedPaths, diff: snapshot.diff, followUpConstraints: "Immediate callers, consumers, adapters, and public boundaries only; do not inspect unrelated subsystems." },
  );
}

function promptPath(value: string): string {
  let path = value.trim().split("\t", 1)[0] ?? "";
  if (path.startsWith("\"") && path.endsWith("\"")) path = path.slice(1, -1);
  path = path.replace(/^([ab])\//u, "");
  return path;
}

interface DiffHunk {
  readonly paths: readonly string[];
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly string[];
}

function candidateHunk(diff: string, candidate: ReviewCandidate): { readonly hunk: string; readonly nearby: string } {
  const hunks: DiffHunk[] = [];
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let current: { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[]; paths: string[] } | undefined;
  const finish = (): void => {
    if (current) hunks.push({ ...current, lines: [...current.lines], paths: [...current.paths] });
    current = undefined;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      oldPath = undefined;
      newPath = undefined;
    } else if (!current && line.startsWith("--- ")) {
      const path = promptPath(line.slice(4));
      oldPath = path === "/dev/null" ? undefined : path;
    } else if (!current && line.startsWith("+++ ")) {
      const path = promptPath(line.slice(4));
      newPath = path === "/dev/null" ? undefined : path;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header) {
      finish();
      current = {
        oldStart: Number(header[1]),
        oldCount: Number(header[2] ?? 1),
        newStart: Number(header[3]),
        newCount: Number(header[4] ?? 1),
        lines: [line],
        paths: [oldPath, newPath].filter((path): path is string => path !== undefined),
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  finish();

  const targetPath = promptPath(candidate.file);
  const selected = hunks.find((hunk) => {
    if (!hunk.paths.some((path) => promptPath(path) === targetPath)) return false;
    const inOldRange = candidate.line >= hunk.oldStart && candidate.line < hunk.oldStart + hunk.oldCount;
    const inNewRange = candidate.line >= hunk.newStart && candidate.line < hunk.newStart + hunk.newCount;
    return inOldRange || inNewRange;
  })
    ?? hunks.find((hunk) => hunk.paths.some((path) => promptPath(path) === targetPath))
    // A focused caller may supply a single hunk without file headers.
    ?? (hunks.length === 1 ? hunks[0] : undefined);

  if (!selected) return { hunk: "No matching changed hunk was supplied.", nearby: "No nearby context was supplied." };
  let oldLine = selected.oldStart;
  let newLine = selected.newStart;
  let candidateIndex = 1;
  for (const line of selected.lines.slice(1)) {
    const matches = line.startsWith("+")
      ? newLine === candidate.line
      : line.startsWith("-")
        ? oldLine === candidate.line
        : !line.startsWith("\\") && (oldLine === candidate.line || newLine === candidate.line);
    if (matches) break;
    if (line.startsWith("+")) newLine += 1;
    else if (line.startsWith("-")) oldLine += 1;
    else if (!line.startsWith("\\")) {
      oldLine += 1;
      newLine += 1;
    }
    candidateIndex += 1;
  }
  const nearbyStart = Math.max(1, candidateIndex - 2);
  const nearbyEnd = Math.min(selected.lines.length, candidateIndex + 3);
  return {
    hunk: selected.lines.join("\n"),
    nearby: selected.lines.slice(nearbyStart, nearbyEnd).join("\n") || selected.lines[0]!,
  };
}

export function buildValidatorPrompt(
  candidate: ReviewCandidate,
  snapshot: ReviewSnapshot,
  guidance: readonly GuidanceFile[],
  summary = "",
  options: { readonly passLabel?: string; readonly source?: string | undefined } = {},
): string {
  const selected = candidateHunk(snapshot.diff, candidate);
  const payload = {
    candidate,
    exactChangedHunk: selected.hunk,
    nearbyContext: selected.nearby,
    nearbySource: options.source?.trim() || selected.nearby,
    relevantGuidance: formatGuidance(guidance, snapshot.cwd),
    ...(summary.trim() ? { summary: summary.trim() } : {}),
  };
  return [
    `You are the single-candidate validator (${options.passLabel ?? "primary"} pass).`,
    BOUNDED_WORKER_INSTRUCTIONS,
    "Validate only this candidate. Check the exact changed hunk, nearby diff context, and bounded nearby source supplied below; use relevant guidance and the optional summary only to establish this candidate's stated failure scenario.",
    "Do not invent, merge, or validate any other candidate. PLAUSIBLE and REFUTED results are never reportable; CONFIRMED requires concrete evidence.",
    `Call ${REVIEWER_RESULT_TOOLS.verifier} exactly once as the final action with candidateId, disposition (CONFIRMED, PLAUSIBLE, or REFUTED), confidence from 0 to 100, and verification.`,
    reviewInput(payload),
  ].join("\n");
}

/** The protocol name remains verifier while the role is a candidate validator. */
export const buildVerifierPrompt = buildValidatorPrompt;
