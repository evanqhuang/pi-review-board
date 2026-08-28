import type { ReviewContextDepth } from "./effort.js";
import type { PullRequestMetadata, ReviewCandidate, ReviewSnapshot } from "./types.js";
import { formatGuidance, type GuidanceFile } from "./guidance.js";

export interface FinderLens {
  readonly name: string;
  readonly description: string;
}

export const FINDER_LENSES: readonly FinderLens[] = [
  { name: "guidance", description: "Check changed behavior against applicable repository guidance." },
  { name: "diff-correctness", description: "Scan changed lines for concrete runtime correctness defects." },
  { name: "removed-behavior", description: "Audit removed behavior and invariants against history and surrounding code." },
  { name: "reuse", description: "Find duplicated helpers, missed existing abstractions, or inconsistent implementations." },
  { name: "simplification", description: "Look for unnecessary complexity that creates a concrete maintenance or runtime defect." },
  { name: "efficiency", description: "Check changed operations for concrete performance, resource, or concurrency regressions." },
  { name: "altitude", description: "Check whether the change is made at the correct abstraction boundary." },
  { name: "conventions", description: "Check repository conventions, comments, and explicit local contracts." },
  { name: "cross-file", description: "Trace callers, consumers, and cross-file integration behavior around the change." },
  { name: "framework-pitfalls", description: "Check language and framework-specific pitfalls around the change." },
  { name: "delegation", description: "Check wrapper, proxy, adapter, and delegation behavior at the changed boundary." },
];

export const GAP_SWEEP_LENS: FinderLens = {
  name: "gap-sweep",
  description: "Perform a fresh gap sweep for distinct concrete defects missed by the preceding review passes.",
};

export interface EligibilityOutput {
  readonly proceed: boolean;
  readonly reason: string;
}

export interface SummaryOutput {
  readonly summary: string;
}

export interface FinderCandidate {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly summary: string;
  readonly failureScenario: string;
  readonly evidence: string;
  readonly category: ReviewCandidate["category"];
  readonly severity: ReviewCandidate["severity"];
}

export interface FinderOutput {
  readonly candidates: readonly FinderCandidate[];
}

export type VerificationDisposition = "CONFIRMED" | "PLAUSIBLE" | "REFUTED";

export interface VerifierOutput {
  readonly candidateId: string;
  readonly confidence: number;
  readonly verification: string;
  readonly file?: string;
  readonly line?: number;
  readonly confirmed: boolean;
  readonly disposition: VerificationDisposition;
}

export interface BatchVerifierOutput {
  readonly verifications: readonly VerifierOutput[];
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
const severities = new Set<ReviewCandidate["severity"]>(["critical", "high", "medium", "low"]);

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
  const candidates = raw.candidates.map((candidate, index) => {
    const item = object(candidate);
    const category = string(item.category, `candidates[${index}].category`) as ReviewCandidate["category"];
    const severity = string(item.severity, `candidates[${index}].severity`) as ReviewCandidate["severity"];
    if (!categories.has(category)) throw new Error(`Unknown candidate category: ${category}`);
    if (!severities.has(severity)) throw new Error(`Unknown candidate severity: ${severity}`);
    return {
      id: string(item.id, `candidates[${index}].id`),
      file: string(item.file, `candidates[${index}].file`),
      line: integer(item.line, `candidates[${index}].line`),
      summary: string(item.summary, `candidates[${index}].summary`),
      failureScenario: string(item.failureScenario, `candidates[${index}].failureScenario`),
      evidence: string(item.evidence, `candidates[${index}].evidence`),
      category,
      severity,
    } satisfies FinderCandidate;
  });
  return { candidates };
}

export function validateVerifier(value: unknown): VerifierOutput {
  const raw = object(value);
  const confidence = raw.confidence;
  if (!Number.isInteger(confidence) || (confidence as number) < 0 || (confidence as number) > 100) {
    throw new Error("Verifier confidence must be an integer from 0 to 100");
  }
  const dispositionValue = raw.disposition === undefined
    ? raw.confirmed === true
      ? "CONFIRMED"
      : "REFUTED"
    : string(raw.disposition, "disposition");
  if (dispositionValue !== "CONFIRMED" && dispositionValue !== "PLAUSIBLE" && dispositionValue !== "REFUTED") {
    throw new Error(`Unknown verification disposition: ${dispositionValue}`);
  }
  return {
    candidateId: string(raw.candidateId, "candidateId"),
    confidence: confidence as number,
    verification: string(raw.verification, "verification"),
    confirmed: dispositionValue === "CONFIRMED",
    disposition: dispositionValue,
    ...(raw.file !== undefined ? { file: string(raw.file, "file") } : {}),
    ...(raw.line !== undefined ? { line: integer(raw.line, "line") } : {}),
  };
}

export function validateBatchVerifier(value: unknown, candidateIds?: ReadonlySet<string>): BatchVerifierOutput {
  const raw = object(value);
  if (!Array.isArray(raw.verifications)) throw new Error("Batch verifier response must contain verifications array");
  const seen = new Set<string>();
  const verifications = raw.verifications.map((item, index) => {
    const verification = validateVerifier(item);
    if (seen.has(verification.candidateId)) throw new Error(`Duplicate batch verification candidateId: ${verification.candidateId}`);
    if (candidateIds && !candidateIds.has(verification.candidateId)) throw new Error(`Unknown batch verification candidateId: ${verification.candidateId}`);
    seen.add(verification.candidateId);
    return verification;
  });
  if (candidateIds && (verifications.length !== candidateIds.size || [...candidateIds].some((candidateId) => !seen.has(candidateId)))) {
    throw new Error("Batch verifier response must contain exactly one verdict for every candidate");
  }
  return { verifications };
}

function inputBlock(snapshot: ReviewSnapshot, guidance: readonly GuidanceFile[], summary = ""): string {
  return [
    "<review-input>",
    JSON.stringify({
      target: snapshot.target,
      changedPaths: snapshot.changedPaths,
      diff: snapshot.diff,
      summary,
      guidance: formatGuidance(guidance, snapshot.cwd),
    }),
    "</review-input>",
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

export function buildSummaryPrompt(snapshot: ReviewSnapshot, guidance: readonly GuidanceFile[]): string {
  return [
    "Summarize the reviewed change for independent reviewers.",
    "Return JSON only: {\"summary\":\"...\"}.",
    inputBlock(snapshot, guidance),
  ].join("\n");
}

function contextInstruction(depth: ReviewContextDepth | undefined, fullContext: boolean | undefined, kind: "finder" | "verifier"): string {
  const effectiveDepth = depth ?? (fullContext ? "deep" : "nearby");
  if (effectiveDepth === "hunk") return kind === "finder"
    ? "Read only the supplied changed hunk and nearest context; skip test and fixture hunks."
    : "Check the exact changed line and only the nearest context needed to establish the failure.";
  if (effectiveDepth === "exhaustive") return kind === "finder"
    ? "Trace all relevant callers and consumers, and read surrounding files, comments, history, guidance, and neighboring abstractions exhaustively before deciding."
    : "Trace relevant callers and consumers, and read surrounding files, comments, history, guidance, and neighboring abstractions exhaustively before deciding.";
  if (effectiveDepth === "deep") return kind === "finder"
    ? "Read relevant surrounding files, callers, comments, history, and neighboring abstractions deeply before deciding."
    : "Read relevant callers, comments, history, and neighboring abstractions deeply before deciding.";
  return kind === "finder"
    ? "Prefer the changed hunk and the nearest relevant context needed to establish a concrete defect."
    : "Check the exact changed line and only the context needed to establish the failure.";
}

export function buildFinderPrompt(
  lens: FinderLens,
  snapshot: ReviewSnapshot,
  guidance: readonly GuidanceFile[],
  summary: string,
  options: { readonly contextDepth?: ReviewContextDepth; readonly fullContext?: boolean } = {},
): string {
  return [
    `You are the ${lens.name} review pass. ${lens.description}`,
    "Inspect only the supplied change and relevant repository context.",
    contextInstruction(options.contextDepth, options.fullContext, "finder"),
    "Report only concrete defects on changed lines. Do not report style, missing tests, compiler-detectable issues, pre-existing problems, intentional behavior, or speculative concerns.",
    "Return JSON only with this shape: {\"candidates\":[{\"id\":\"stable-id\",\"file\":\"path\",\"line\":1,\"summary\":\"defect\",\"failureScenario\":\"input/state -> wrong output/crash\",\"evidence\":\"why\",\"category\":\"correctness|guidance|history|integration|contract\",\"severity\":\"critical|high|medium|low\"}]}.",
    "If no concrete defect exists, return {\"candidates\":[]}.",
    inputBlock(snapshot, guidance, summary),
  ].join("\n");
}

export function buildBatchVerifierPrompt(
  candidates: readonly ReviewCandidate[],
  snapshot: ReviewSnapshot,
  guidance: readonly GuidanceFile[],
  summary: string,
  options: { readonly contextDepth?: ReviewContextDepth; readonly fullContext?: boolean; readonly passLabel?: string } = {},
): string {
  return [
    `Verify the proposed code-review findings as one batch (${options.passLabel ?? "primary"} pass).`,
    contextInstruction(options.contextDepth, options.fullContext, "verifier"),
    "Check every candidate against the exact changed line, surrounding code, repository guidance, and its stated failure scenario.",
    "Return JSON only with exactly one verdict for every supplied candidate: {\"verifications\":[{\"candidateId\":\"...\",\"confidence\":0,\"verification\":\"...\",\"confirmed\":true|false,\"disposition\":\"CONFIRMED|PLAUSIBLE|REFUTED\",\"file\":\"optional corrected path\",\"line\":1}]}.",
    "Do not invent candidates or omit any candidate ID. Confidence rubric: 0 false/pre-existing; 25 unverified or stylistic; 50 real but minor/uncommon; 75 very likely and important; 100 certain and frequent.",
    JSON.stringify({ candidates, review: inputBlock(snapshot, guidance, summary) }),
  ].join("\n");
}

export function buildVerifierPrompt(
  candidate: ReviewCandidate,
  snapshot: ReviewSnapshot,
  guidance: readonly GuidanceFile[],
  summary: string,
  options: { readonly contextDepth?: ReviewContextDepth; readonly fullContext?: boolean; readonly passLabel?: string } = {},
): string {
  return [
    `Verify one proposed code-review finding against the change (${options.passLabel ?? "primary"} pass).`,
    contextInstruction(options.contextDepth, options.fullContext, "verifier"),
    "Check the exact changed line, surrounding code, repository guidance, and the stated failure scenario.",
    "Return JSON only: {\"candidateId\":\"...\",\"confidence\":0,\"verification\":\"...\",\"confirmed\":true|false,\"disposition\":\"CONFIRMED|PLAUSIBLE|REFUTED\",\"file\":\"optional corrected path\",\"line\":1}.",
    "Confidence rubric: 0 false/pre-existing; 25 unverified or stylistic; 50 real but minor/uncommon; 75 very likely and important; 100 certain and frequent.",
    JSON.stringify({ candidate, review: inputBlock(snapshot, guidance, summary) }),
  ].join("\n");
}
