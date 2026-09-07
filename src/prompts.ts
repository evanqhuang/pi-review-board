import type { PullRequestMetadata, ReviewCandidate, ReviewSnapshot } from "./types.js";
import { formatGuidance, guidanceCoversPath, type GuidanceFile } from "./guidance.js";
import { DEFAULT_INPUT_BUDGET_BYTES, InputLimitError, assertInputBudget } from "./input-budget.js";
import { REVIEWER_RESULT_TOOLS } from "./reviewer-protocol.js";
import { candidateDiffExcerpt } from "./diff-shards.js";

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
  readonly coverageComplete: boolean;
  readonly incompleteReason?: string;
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
  if (typeof raw.coverageComplete !== "boolean") throw new Error("Finder response must declare boolean coverageComplete");
  const incompleteReason = raw.incompleteReason === undefined ? undefined : string(raw.incompleteReason, "incompleteReason");
  if (!raw.coverageComplete && !incompleteReason) throw new Error("Incomplete discovery must include incompleteReason");
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
  return { candidates, coverageComplete: raw.coverageComplete, ...(incompleteReason === undefined ? {} : { incompleteReason }) };
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

const OMITTED_METADATA = "[omitted optional pull-request metadata to fit input budget]";
const OMITTED_SUMMARY = "[omitted optional summary to fit input budget]";
const OMITTED_CONTEXT = "[omitted optional nearby context to fit input budget]";
const OMITTED_SOURCE = "[omitted optional nearby source to fit input budget]";

function pullRequest(snapshot: ReviewSnapshot): PullRequestMetadata | undefined {
  if (snapshot.pullRequest) return snapshot.pullRequest;
  return snapshot.target.kind === "pull-request" ? snapshot.target.metadata : undefined;
}

function changeMetadata(snapshot: ReviewSnapshot): { readonly title: string; readonly body: string } {
  const metadata = pullRequest(snapshot);
  return { title: metadata?.title ?? "", body: metadata?.body ?? "" };
}

function reviewInput(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("Prompt payload must be JSON serializable");
  return ["<review-input>", serialized, "</review-input>"].join("\n");
}

interface ReviewScopePayload {
  readonly fullReviewChangedPaths: readonly string[] | null;
  readonly evidenceChangedPaths: readonly string[];
  readonly scopeComplete: boolean;
  readonly sourceRevision: string;
}

const REVIEW_SCOPE_INSTRUCTIONS = [
  "Treat the required reviewScope object as authoritative.",
  "evidenceChangedPaths is local shard or excerpt evidence, not the full PR scope.",
  "The absence of a consumer, documentation file, or other path from local evidence cannot prove that it is unchanged.",
].join("\n");
const UNKNOWN_REVIEW_SCOPE_INSTRUCTIONS = "reviewScope.scopeComplete is false because the full review manifest was omitted to fit the input budget. Do not make global absence claims or claim that a consumer, documentation file, or other path is absent or unchanged.";

function sourceRevision(snapshot: ReviewSnapshot): string {
  const metadata = pullRequest(snapshot);
  if (snapshot.pullRequest !== undefined || snapshot.target.kind === "pull-request") {
    return snapshot.headSha || metadata?.headSha || "pull-request headSha unavailable";
  }
  return "local working-tree context";
}

function reviewScope(snapshot: ReviewSnapshot, scopeComplete: boolean): ReviewScopePayload {
  return {
    fullReviewChangedPaths: scopeComplete
      ? uniqueSorted(snapshot.reviewChangedPaths ?? snapshot.changedPaths)
      : null,
    evidenceChangedPaths: [...snapshot.changedPaths],
    scopeComplete,
    sourceRevision: sourceRevision(snapshot),
  };
}

/** Add the mandatory scope contract, trying every complete variant before an unknown-scope fallback. */
function withReviewScope(
  snapshot: ReviewSnapshot,
  payloads: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const completeScope = reviewScope(snapshot, true);
  const unknownScope = reviewScope(snapshot, false);
  return [
    ...payloads.map((payload) => ({ ...payload, reviewScope: completeScope })),
    ...payloads.map((payload) => ({ ...payload, reviewScope: unknownScope })),
  ];
}

function finderResultInstructions(): string {
  return [
    `Call ${REVIEWER_RESULT_TOOLS.finder} exactly once as the final action.`,
    "Return candidates: [] when no introduced high-signal defect is concretely established.",
    "Every candidate must identify a concrete changed file and positive changed line, a suspicion, rootCauseKey, failureScenario, evidence, category, severity (critical, high, or medium), and needsContext.",
    "Declare coverageComplete truthfully. If the review or required investigation is incomplete, set coverageComplete:false with a non-empty incompleteReason and preserve every valid candidate.",
    "Never equate an exhausted or bounded investigation with a clean candidates: [] result; an empty result is not proof that the uncovered scope is clean.",
    "needsContext is only an escalation request for the nearest follow-up context; it is never reportable by itself. Guidance candidates should normally set needsContext to false.",
  ].join("\n");
}

function summaryResultInstructions(): string {
  return `Call ${REVIEWER_RESULT_TOOLS.summary} exactly once as the final action with a concise summary string.`;
}

function validatorResultInstructions(): string {
  return [
    `Call ${REVIEWER_RESULT_TOOLS.verifier} exactly once as the final action with candidateId, disposition (CONFIRMED, PLAUSIBLE, or REFUTED), confidence from 0 to 100, and verification.`,
    "Do not return CONFIRMED for an absence-based claim when reviewScope.scopeComplete is false or when the claim is contradicted by fullReviewChangedPaths; local evidence absence cannot prove absence.",
  ].join("\n");
}

function rolePrompt(role: string, focus: string, payload: unknown): string {
  const resultInstructions = role === "summary"
    ? summaryResultInstructions()
    : role.startsWith("validator")
      ? validatorResultInstructions()
      : finderResultInstructions();
  const scope = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as { readonly reviewScope?: unknown }).reviewScope : undefined;
  const scopeComplete = scope !== null && typeof scope === "object"
    ? (scope as { readonly scopeComplete?: unknown }).scopeComplete : undefined;
  return [
    `You are the bounded ${role} reviewer. ${focus}`,
    BOUNDED_WORKER_INSTRUCTIONS,
    REVIEW_SCOPE_INSTRUCTIONS,
    ...(scopeComplete === false ? [UNKNOWN_REVIEW_SCOPE_INSTRUCTIONS] : []),
    resultInstructions,
    reviewInput(payload),
  ].join("\n");
}

/** Try complete structured payloads; never slice an already serialized prompt. */
function boundedRolePrompt(
  role: string,
  focus: string,
  payloads: readonly Record<string, unknown>[],
  inputBudgetBytes: number,
): string {
  let lastPrompt = "";
  for (const payload of payloads) {
    const prompt = rolePrompt(role, focus, payload);
    lastPrompt = prompt;
    try {
      assertInputBudget(prompt, inputBudgetBytes);
      return prompt;
    } catch (error) {
      if (!(error instanceof InputLimitError)) throw error;
    }
  }
  // Preserve the typed error and useful byte details from the least optional
  // representation when no structured representation can fit.
  assertInputBudget(lastPrompt, inputBudgetBytes);
  return lastPrompt;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function metadataVariants(metadata: { readonly title: string; readonly body: string }): Array<{ readonly title: string; readonly body: string }> {
  return [
    metadata,
    { title: metadata.title, body: metadata.body ? OMITTED_METADATA : metadata.body },
    { title: metadata.title ? OMITTED_METADATA : metadata.title, body: metadata.body },
    { title: metadata.title ? OMITTED_METADATA : metadata.title, body: metadata.body ? OMITTED_METADATA : metadata.body },
  ];
}

function diffVariants(diff: string): string[] {
  const compacted = compactDiff(diff);
  return compacted === diff ? [diff] : [diff, compacted];
}

export interface GuidanceScope {
  readonly path: string;
  readonly guidance: readonly GuidanceFile[];
}

interface GuidancePayload {
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly pathToFiles: readonly { readonly path: string; readonly files: readonly string[] }[];
}

/**
 * Serialize repository guidance once and refer to it from each changed path.
 * The references retain nested scope; only duplicate file bodies are removed.
 */
function guidancePayload(scopes: readonly GuidanceScope[], cwd: string): GuidancePayload {
  const sortedScopes = [...scopes].sort((left, right) => left.path.localeCompare(right.path));
  const filesByKey = new Map<string, { readonly path: string; readonly content: string }>();
  const refsByPath = new Map<string, Set<string>>();
  for (const scope of sortedScopes) {
    const refs = refsByPath.get(scope.path) ?? new Set<string>();
    for (const file of scope.guidance) {
      const key = file.path;
      if (!filesByKey.has(key)) {
        filesByKey.set(key, {
          path: relativeGuidancePath(file.path, cwd),
          content: file.content,
        });
      }
      refs.add(key);
    }
    refsByPath.set(scope.path, refs);
  }
  const files = [...filesByKey.entries()]
    .sort((left, right) => left[1].path.localeCompare(right[1].path) || left[0].localeCompare(right[0]))
    .map(([, file]) => file);
  const outputPathByKey = new Map([...filesByKey.keys()].map((key) => [key, filesByKey.get(key)!.path]));
  const pathToFiles = [...refsByPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, refs]) => ({
      path,
      files: [...refs].map((key) => outputPathByKey.get(key)!).filter((value): value is string => value !== undefined).sort(),
    }));
  return { files, pathToFiles };
}

function relativeGuidancePath(path: string, cwd: string): string {
  // Keep the same readable paths used by formatGuidance, while preserving an
  // absolute path when a caller supplies guidance outside the repository.
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (path === cwd) return ".";
  return path.startsWith(root) ? path.slice(root.length) : path;
}

function scopedGuidance(snapshot: ReviewSnapshot, files: readonly GuidanceFile[]): GuidanceScope[] {
  const sourceRoot = snapshot.sourceCwd ?? snapshot.cwd;
  return uniqueSorted(snapshot.changedPaths).map((path) => ({
    path,
    guidance: files.filter((file) => guidanceCoversPath(
      sourceRoot,
      file.path.startsWith("/") ? file.path : `${sourceRoot}/${file.path}`,
      path,
    )),
  }));
}

function guidanceForRole(snapshot: ReviewSnapshot, files: readonly GuidanceFile[]): GuidancePayload {
  return guidancePayload(scopedGuidance(snapshot, files), snapshot.sourceCwd ?? snapshot.cwd);
}

function eligibilityPrompt(pullRequest: PullRequestMetadata): string {
  const serialized = JSON.stringify(pullRequest);
  if (serialized === undefined) throw new Error("Pull-request metadata must be JSON serializable");
  return [
    "Decide whether this open pull request needs a substantive code review.",
    "Return JSON only: {\"proceed\":true|false,\"reason\":\"...\"}.",
    "Reject automated, trivial, already-reviewed, closed, or draft changes. Do not reject a real change merely because tests are absent.",
    serialized,
  ].join("\n");
}

export function buildEligibilityPrompt(
  pullRequest: PullRequestMetadata,
  inputBudgetBytes = DEFAULT_INPUT_BUDGET_BYTES,
): string {
  const variants: PullRequestMetadata[] = [pullRequest];
  if (pullRequest.comments.length > 0) variants.push({ ...pullRequest, comments: [{ authorLogin: OMITTED_METADATA, body: OMITTED_METADATA }] });
  variants.push({
    ...pullRequest,
    title: pullRequest.title ? OMITTED_METADATA : pullRequest.title,
    body: pullRequest.body ? OMITTED_METADATA : pullRequest.body,
    comments: pullRequest.comments.length > 0 ? [{ authorLogin: OMITTED_METADATA, body: OMITTED_METADATA }] : [],
  });
  let lastPrompt = "";
  for (const variant of variants) {
    const prompt = eligibilityPrompt(variant);
    lastPrompt = prompt;
    try {
      assertInputBudget(prompt, inputBudgetBytes);
      return prompt;
    } catch (error) {
      if (!(error instanceof InputLimitError)) throw error;
    }
  }
  assertInputBudget(lastPrompt, inputBudgetBytes);
  return lastPrompt;
}

export function buildSummaryPrompt(
  snapshot: ReviewSnapshot,
  _guidance: readonly GuidanceFile[] = [],
  inputBudgetBytes = DEFAULT_INPUT_BUDGET_BYTES,
): string {
  const metadata = changeMetadata(snapshot);
  const payloads: Record<string, unknown>[] = [];
  const makePayload = (diff: string, optional: { readonly title: string; readonly body: string }): Record<string, unknown> => ({
    title: optional.title,
    body: optional.body,
    paths: uniqueSorted(snapshot.changedPaths),
    diff,
  });
  const variants = metadataVariants(metadata);
  const diffs = diffVariants(snapshot.diff);
  payloads.push(makePayload(diffs[0]!, variants[0]!));
  if (diffs[1] !== undefined) payloads.push(makePayload(diffs[1], variants[0]!));
  for (const variant of variants.slice(1)) {
    payloads.push(makePayload(diffs[1] ?? diffs[0]!, variant));
  }
  if (diffs[1] !== undefined) {
    for (const variant of variants.slice(1)) payloads.push(makePayload(diffs[0]!, variant));
  }
  return boundedRolePrompt(
    "summary",
    "Summarize only the supplied change for the other bounded reviewers.",
    withReviewScope(snapshot, payloads),
    inputBudgetBytes,
  );
}

function guidanceIntent(snapshot: ReviewSnapshot, summary: string): string {
  const trimmedSummary = summary.trim();
  if (trimmedSummary) return trimmedSummary;
  const { title, body } = changeMetadata(snapshot);
  return [title, body].filter((part) => part.trim().length > 0).join("\n\n") || "No summary or pull-request intent supplied.";
}

function guidanceSummaryVariants(snapshot: ReviewSnapshot, summary: string): string[] {
  const intent = guidanceIntent(snapshot, summary);
  return [intent, OMITTED_SUMMARY];
}

export function buildGuidancePrompt(
  snapshot: ReviewSnapshot,
  guidanceByPath: readonly GuidanceScope[],
  summary = "",
  inputBudgetBytes = DEFAULT_INPUT_BUDGET_BYTES,
): string {
  const changedFiles = [...guidanceByPath]
    .sort((left, right) => left.path.localeCompare(right.path));
  const guidance = guidancePayload(changedFiles, snapshot.sourceCwd ?? snapshot.cwd);
  const payloads: Record<string, unknown>[] = [];
  const diffs = diffVariants(snapshot.diff);
  const summaries = guidanceSummaryVariants(snapshot, summary);
  const makePayload = (diff: string, intent: string): Record<string, unknown> => ({
    summary: intent,
    guidance,
    changedCode: { paths: uniqueSorted(snapshot.changedPaths), diff },
  });
  payloads.push(makePayload(diffs[0]!, summaries[0]!));
  if (diffs[1] !== undefined) payloads.push(makePayload(diffs[1], summaries[0]!));
  for (const intent of summaries.slice(1)) payloads.push(makePayload(diffs[1] ?? diffs[0]!, intent));
  if (diffs[1] !== undefined) {
    for (const intent of summaries.slice(1)) payloads.push(makePayload(diffs[0]!, intent));
  }
  return boundedRolePrompt(
    "guidance",
    "Check only the changed code against the applicable repository guidance. Do not invent guidance or report a rule that does not apply to a changed line.",
    withReviewScope(snapshot, payloads),
    inputBudgetBytes,
  );
}

interface DiffRoleArgument {
  readonly guidance: readonly GuidanceFile[] | undefined;
  readonly legacyTitle: string | undefined;
}

function diffRoleArgument(argument: readonly GuidanceFile[] | string): DiffRoleArgument {
  if (typeof argument === "string") return { guidance: undefined, legacyTitle: argument };
  return { guidance: argument, legacyTitle: undefined };
}

function optionalSummary(value: string): { readonly summary?: string } {
  const trimmed = value.trim();
  return trimmed ? { summary: trimmed } : {};
}

export function buildDiffOnlyBugPrompt(
  snapshot: ReviewSnapshot,
  arg: readonly GuidanceFile[] | string = [],
  summary = "",
  inputBudgetBytes = DEFAULT_INPUT_BUDGET_BYTES,
): string {
  const argument = diffRoleArgument(arg);
  const metadata = argument.legacyTitle === undefined
    ? changeMetadata(snapshot)
    : { title: argument.legacyTitle, body: summary };
  const metadataOptions = metadataVariants(metadata);
  const summaryValue = argument.legacyTitle === undefined ? optionalSummary(summary) : {};
  const payloads: Record<string, unknown>[] = [];
  const diffs = diffVariants(snapshot.diff);
  const makePayload = (diff: string, optional: { readonly title: string; readonly body: string }, includeSummary: boolean): Record<string, unknown> => ({
    title: optional.title,
    body: optional.body,
    changedPaths: uniqueSorted(snapshot.changedPaths),
    diff,
    ...(includeSummary && Object.keys(summaryValue).length > 0 ? summaryValue : {}),
  });
  payloads.push(makePayload(diffs[0]!, metadataOptions[0]!, true));
  if (diffs[1] !== undefined) payloads.push(makePayload(diffs[1], metadataOptions[0]!, true));
  for (const option of metadataOptions.slice(1)) payloads.push(makePayload(diffs[1] ?? diffs[0]!, option, true));
  if (summaryValue.summary !== undefined) {
    for (const option of metadataOptions) payloads.push({ ...makePayload(diffs[1] ?? diffs[0]!, option, false), summary: OMITTED_SUMMARY });
  }
  if (diffs[1] !== undefined) {
    for (const option of metadataOptions.slice(1)) payloads.push(makePayload(diffs[0]!, option, true));
    if (summaryValue.summary !== undefined) {
      for (const option of metadataOptions) payloads.push({ ...makePayload(diffs[0]!, option, false), summary: OMITTED_SUMMARY });
    }
  }
  return boundedRolePrompt(
    "diff-only bug",
    "Reason from the diff alone. Do not assume unseen context, callers, repository conventions, or intended behavior; do not request context for a vague concern.",
    withReviewScope(snapshot, payloads),
    inputBudgetBytes,
  );
}

function finderPayloadGuidance(snapshot: ReviewSnapshot, argument: readonly GuidanceFile[] | string): GuidancePayload | undefined {
  if (typeof argument === "string" || argument.length === 0) return undefined;
  return guidanceForRole(snapshot, argument);
}

function finderPayloads(
  snapshot: ReviewSnapshot,
  argument: readonly GuidanceFile[] | string,
  summary: string,
  followUpConstraints: string,
): Record<string, unknown>[] {
  const guidance = finderPayloadGuidance(snapshot, argument);
  const diffs = diffVariants(snapshot.diff);
  const summaryValue = summary.trim();
  const base = (diff: string, includeSummary: boolean): Record<string, unknown> => ({
    changedPaths: uniqueSorted(snapshot.changedPaths),
    diff,
    followUpConstraints,
    ...(guidance ? { guidance } : {}),
    ...(includeSummary && summaryValue ? { summary: summaryValue } : {}),
  });
  const payloads: Record<string, unknown>[] = [base(diffs[0]!, true)];
  if (diffs[1] !== undefined) payloads.push(base(diffs[1], true));
  if (summaryValue) {
    payloads.push({ ...base(diffs[1] ?? diffs[0]!, false), summary: OMITTED_SUMMARY });
  }
  if (diffs[1] !== undefined && summaryValue) payloads.push({ ...base(diffs[0]!, false), summary: OMITTED_SUMMARY });
  return withReviewScope(snapshot, payloads);
}

export function buildContextualBugPrompt(
  snapshot: ReviewSnapshot,
  arg: readonly GuidanceFile[] | string = [],
  summary = "",
  inputBudgetBytes = DEFAULT_INPUT_BUDGET_BYTES,
): string {
  const payloads = finderPayloads(
    snapshot,
    arg,
    summary,
    "Nearest direct callers, consumers, and definitions only; no unrelated files or broad repository exploration.",
  );
  return boundedRolePrompt(
    "contextual bug",
    "Inspect only the nearest direct context needed to establish an introduced defect. Follow up through direct callers or consumers only; stop once the changed-line suspicion is established.",
    payloads,
    inputBudgetBytes,
  );
}

export function buildIntegrationPrompt(
  snapshot: ReviewSnapshot,
  arg: readonly GuidanceFile[] | string = [],
  summary = "",
  inputBudgetBytes = DEFAULT_INPUT_BUDGET_BYTES,
): string {
  const payloads = finderPayloads(
    snapshot,
    arg,
    summary,
    "Immediate callers, consumers, adapters, and public boundaries only; do not inspect unrelated subsystems.",
  );
  return boundedRolePrompt(
    "integration",
    "Check only direct integration boundaries touched by the change. Follow up to the immediate consumer or contract boundary, and report only a concrete introduced failure.",
    payloads,
    inputBudgetBytes,
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

/** Compact only unchanged hunk context; all paths, hunk headers and changes remain. */
function compactDiff(diff: string): string {
  const lines = diff.split(/\r?\n/u);
  const output: string[] = [];
  let inHunk = false;
  let omittedOld = 0;
  let omittedNew = 0;
  const flush = (): void => {
    if (omittedOld > 0 || omittedNew > 0) {
      output.push(`[omitted unchanged context: old=${omittedOld} new=${omittedNew}]`);
      omittedOld = 0;
      omittedNew = 0;
    }
  };
  for (const line of lines) {
    const isHunkHeader = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(line);
    if (line.startsWith("diff --git ") || isHunkHeader) {
      flush();
      output.push(line);
      inHunk = isHunkHeader;
      continue;
    }
    if (!inHunk) {
      output.push(line);
      continue;
    }
    if (line.startsWith(" ") || line.length === 0) {
      omittedOld += 1;
      omittedNew += 1;
      continue;
    }
    flush();
    output.push(line);
    if (line.startsWith("--- ") || line.startsWith("+++ ")) inHunk = false;
  }
  flush();
  const compacted = output.join("\n");
  return compacted === diff ? diff : compacted;
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

  for (const line of diff.split(/\r?\n/u)) {
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
  }) ?? (hunks.length === 1 ? hunks[0] : undefined);

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

function deduplicateGuidance(files: readonly GuidanceFile[]): GuidanceFile[] {
  const unique = new Map<string, GuidanceFile>();
  for (const file of files) if (!unique.has(file.path)) unique.set(file.path, file);
  return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function buildValidatorPrompt(
  candidate: ReviewCandidate,
  snapshot: ReviewSnapshot,
  guidance: readonly GuidanceFile[],
  summary = "",
  options: { readonly passLabel?: string; readonly source?: string | undefined; readonly inputBudgetBytes?: number } = {},
): string {
  const selected = candidateHunk(snapshot.diff, candidate);
  const exactVariants = diffVariants(selected.hunk);
  const relevantGuidance = formatGuidance(deduplicateGuidance(guidance), snapshot.sourceCwd ?? snapshot.cwd);
  const context = selected.nearby;
  const source = options.source?.trim() || selected.nearby;
  const trimmedSummary = summary.trim();
  const optionalFields: Array<{ readonly context: string; readonly source: string; readonly summary?: string }> = [];
  const fullOptional = { context, source, ...(trimmedSummary ? { summary: trimmedSummary } : {}) };
  optionalFields.push(fullOptional);
  // Prefer the least omission necessary, but always leave a truthful marker
  // when optional context is dropped.
  const combinations = [1, 2, 4, 3, 5, 6, 7];
  for (const mask of combinations) {
    const next: { context: string; source: string; summary?: string } = {
      context: mask & 1 ? OMITTED_CONTEXT : context,
      source: mask & 2 ? OMITTED_SOURCE : source,
    };
    if (trimmedSummary) next.summary = mask & 4 ? OMITTED_SUMMARY : trimmedSummary;
    optionalFields.push(next);
  }
  const makePayload = (
    exactChangedHunk: string,
    optional: { readonly context: string; readonly source: string; readonly summary?: string },
  ): Record<string, unknown> => ({
    candidate,
    exactChangedHunk,
    nearbyContext: optional.context,
    nearbySource: optional.source,
    relevantGuidance,
    ...(optional.summary !== undefined ? { summary: optional.summary } : {}),
  });
  const payloads: Record<string, unknown>[] = [];
  payloads.push(makePayload(exactVariants[0]!, optionalFields[0]!));
  if (exactVariants[1] !== undefined) payloads.push(makePayload(exactVariants[1], optionalFields[0]!));
  for (const optional of optionalFields.slice(1)) payloads.push(makePayload(exactVariants[1] ?? exactVariants[0]!, optional));
  if (exactVariants[1] !== undefined) {
    for (const optional of optionalFields.slice(1)) payloads.push(makePayload(exactVariants[0]!, optional));
  }
  const fit = (choices: readonly Record<string, unknown>[]): string => boundedRolePrompt(
    `validator (${options.passLabel ?? "primary"} pass)`,
    "Validate only this candidate. Check the exact changed hunk, nearby diff context, and bounded nearby source supplied below; use relevant guidance and the optional summary only to establish this candidate's stated failure scenario. When evidenceScope labels an excerpt, do not assume omitted changes are absent. Return PLAUSIBLE rather than CONFIRMED if the supplied evidence is insufficient.",
    choices,
    options.inputBudgetBytes ?? DEFAULT_INPUT_BUDGET_BYTES,
  );
  let lastError: InputLimitError;
  try {
    return fit(withReviewScope(snapshot, payloads));
  } catch (error) {
    if (!(error instanceof InputLimitError)) throw error;
    lastError = error;
  }
  // Candidate verification is narrower than mandatory discovery. Preserve
  // exact source ranges and label any reduced evidence explicitly.
  for (const contextLines of [20, 5, 0]) {
    let excerpt: string;
    try {
      excerpt = candidateDiffExcerpt(snapshot.diff, snapshot.snapshotHash, [candidate], contextLines);
    } catch {
      throw lastError;
    }
    const exact = candidateHunk(excerpt, candidate).hunk;
    const excerptPayloads = optionalFields.map((optional) => ({
      ...makePayload(exact, optional),
      evidenceScope: "Candidate-focused excerpt; not the full original changed hunk. Missing context cannot establish a confirmed finding.",
    }));
    try {
      return fit(withReviewScope(snapshot, excerptPayloads));
    } catch (error) {
      if (!(error instanceof InputLimitError)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** The protocol name remains verifier while the role is a candidate validator. */
export const buildVerifierPrompt = buildValidatorPrompt;
