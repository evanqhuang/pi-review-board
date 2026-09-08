import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { guidanceCoversPath, guidanceForPath, discoverApplicableGuidance, type GuidanceFile } from "./guidance.js";
import { candidateDiffExcerpt, parseUnifiedDiff, shardDiff } from "./diff-shards.js";
import { applyReviewWorkCoverage, planReviewWork } from "./review-work.js";
import { scheduleReviewWork, type ReviewScheduleOutcome, type ReviewScheduleTask, type ReviewTaskExecution } from "./review-scheduler.js";
import { REVIEWER_RESULT_TOOLS, REVIEWER_RETRY_SUFFIX } from "./reviewer-protocol.js";
import { reviewerControlReserveBytes } from "./reviewer-control.js";
import {
  buildContextualBugPrompt,
  buildDiffOnlyBugPrompt,
  buildGuidancePrompt,
  buildIntegrationPrompt,
  buildSummaryPrompt,
  buildValidatorPrompt,
  validateContextualBug,
  validateDiffOnlyBug,
  validateGuidance,
  validateIntegration,
  validateSummary,
  validateVerifier,
  type FinderOutput,
  type SummaryOutput,
  type VerifierOutput,
} from "./prompts.js";
import { loadReviewConfig } from "./config.js";
import { analyzeDiff, routeReview, type ReviewRoleConfig } from "./routing.js";
import {
  collectChangedLocations,
  deduplicateCandidates,
  filterCandidatesToChangedLines,
  filterVerifiedFindings,
  formatPrComment,
  formatReviewReport,
} from "./output.js";
import {
  captureReviewSnapshot,
  hasExistingReview,
  hasSnapshotDrift,
  isLikelyAutomatedPullRequest,
} from "./targets.js";
import { ReviewerRunError } from "./runner.js";
import { prepareReviewSourceView } from "./source-view.js";
import { assertInputBudget, InputLimitError, resolveInputBudget } from "./input-budget.js";
import { MAX_REVIEW_WORK_UNITS } from "./types.js";
import type {
  AgentInvocation,
  AgentResult,
  DiffShard,
  ReviewCandidate,
  ReviewContract,
  ReviewCoverage,
  ReviewCoverageCandidate,
  ReviewDependencies,
  ReviewOptions,
  ReviewResult,
  ReviewRole,
  ReviewSnapshot,
  ReviewStage,
  ReviewWorkManifest,
  ReviewWorkPlan,
  ReviewWorkUnit,
  StageFailure,
  VerifiedFinding,
} from "./types.js";

const VALIDATOR_CONCURRENCY = 4;
const MAX_FINDINGS = 5;
const VALIDATOR_SOURCE_WINDOW = 20;
const MAX_VALIDATOR_SOURCE_LINES = VALIDATOR_SOURCE_WINDOW * 2 + 1;
const MAX_VALIDATOR_SOURCE_BYTES = 16 * 1024;
const MAX_VALIDATOR_SOURCE_READ_BYTES = 256 * 1024;

/** Protect completion work without taking capacity from admitted discovery. */
function validationReserve(plan: ReviewWorkPlan): number {
  const required = plan.units.filter((unit) => unit.status === "planned").reduce((sum, unit) => sum + unit.weight, 0);
  // Split spare capacity between retries/follow-ups and validation. The reserve
  // covers up to two validation attempts for each reportable finding.
  return Math.min(MAX_FINDINGS * 2, Math.floor(Math.max(0, plan.maxReviewWorkUnits - required) / 2));
}

function rejectedWorkMessage(plan: ReviewWorkPlan): string {
  const required = plan.units.filter((unit) => unit.shardIds.every((id) => plan.shards.find((shard) => shard.id === id)?.supported))
    .reduce((sum, unit) => sum + unit.weight, 0);
  const reasons = [...new Set(plan.units.filter((unit) => unit.status === "uncovered").map((unit) => unit.reason).filter(Boolean))];
  const budgetRejected = reasons.some((reason) => reason?.startsWith("review work limit rejected plan:"));
  if (budgetRejected) {
    return `Review did not start: ${required} weighted units required for ${plan.units.length} discovery tasks; limit ${plan.maxReviewWorkUnits}. Validation and retries need additional headroom. ${required < MAX_REVIEW_WORK_UNITS ? `Increase --max-work-units (up to ${MAX_REVIEW_WORK_UNITS}).` : "Reduce the review scope or required discovery work."}`;
  }
  return `Review did not start: required work is unsupported. ${reasons.join("; ")}`.slice(0, 500);
}

function progress(dependencies: ReviewDependencies, stage: ReviewStage, message: string): void {
  dependencies.onProgress?.({ type: "stage", stage, message });
}

function usageFromError(error: unknown): AgentResult<unknown>["usage"] | undefined {
  return error instanceof ReviewerRunError ? error.usage : undefined;
}

function errorMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim().slice(0, 500);
  if (!(error instanceof ReviewerRunError)) return message;
  const diagnostics = error.diagnostics;
  const count = (value: number): string => Number.isSafeInteger(value) && value >= 0 ? String(value) : "unknown";
  const retry = diagnostics.retryDenial === "scheduler-admission-denied" || diagnostics.retryDenial === "canceled"
    ? diagnostics.retryDenial : diagnostics.retryDenial === undefined ? "none" : "denied";
  return `${message} [attempt=${count(diagnostics.attempt)}; turns=${count(diagnostics.turns)}/${count(diagnostics.maxTurns)}; results=${count(diagnostics.resultCount)}; finalization=${diagnostics.finalizationEntered === true}; retry=${retry}; semanticBytes=${count(diagnostics.semanticBytes)}; stdoutBytes=${count(diagnostics.stdoutBytes)}; stderrBytes=${count(diagnostics.stderrBytes)}]`.slice(0, 500);
}

function isPromptBudgetFailure(error: unknown): error is InputLimitError {
  return error instanceof InputLimitError
    && error.inputBudgetBytes !== undefined
    && error.promptBytes !== undefined
    && error.inputBudgetBytes > 1
    && error.promptBytes > error.inputBudgetBytes;
}

function runAgent<T>(
  dependencies: ReviewDependencies,
  invocation: AgentInvocation,
  validate: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<AgentResult<T>> {
  return dependencies.agents.run(invocation, validate, signal, (event) => dependencies.onProgress?.(event));
}

/** Adapt one agent invocation to the generic scheduler without losing stable
 * runner errors or usage from a failed attempt. */
async function runScheduledAgent<T>(
  dependencies: ReviewDependencies,
  invocation: AgentInvocation,
  validate: (value: unknown) => T,
  context: { readonly signal: AbortSignal; readonly markAttemptStarted: (attempt?: number) => void; readonly retryAdmission: () => Promise<boolean> },
): Promise<ReviewTaskExecution<T>> {
  try {
    const result = await runAgent(dependencies, {
      ...invocation,
      onAttemptStart: context.markAttemptStarted,
      retryAdmission: context.retryAdmission,
    }, validate, context.signal);
    return { value: result.data, usage: result.usage };
  } catch (error) {
    const failedUsage = usageFromError(error);
    const preSpawnFailure = isPromptBudgetFailure(error)
      || (error instanceof ReviewerRunError && (error.kind === "input-limit" || error.kind === "spawn"));
    return {
      value: undefined as T,
      covered: false,
      reason: errorMessage(error),
      ...(failedUsage === undefined ? {} : { usage: failedUsage }),
      ...(preSpawnFailure ? { started: false } : {}),
    };
  }
}

async function runScheduledFinder(
  dependencies: ReviewDependencies,
  invocation: AgentInvocation,
  validate: (value: unknown) => FinderOutput,
  context: Parameters<typeof runScheduledAgent>[3],
): Promise<ReviewTaskExecution<FinderOutput>> {
  const execution = await runScheduledAgent(dependencies, invocation, validate, context);
  if (!execution.value || execution.covered === false) return execution;
  return {
    ...execution,
    covered: execution.value.coverageComplete === true,
    ...(execution.value.coverageComplete ? {} : { reason: execution.value.incompleteReason ?? "Reviewer did not complete assigned discovery." }),
  };
}

function resultWithoutSnapshot(status: ReviewResult["status"], message: string, options: ReviewOptions): ReviewResult {
  return {
    effort: options.effort,
    status,
    summary: message,
    findings: [],
    failures: [{ stage: "eligibility", message }],
    report: `### Code review\n\n${status === "ineligible" ? "Not reviewed" : "Review could not start"}: ${message}`,
    commented: false,
    usage: [],
    ...(options.phase ? { phase: options.phase } : {}),
  };
}

function completedResult(
  snapshot: ReviewSnapshot,
  options: ReviewOptions,
  status: ReviewResult["status"],
  summary: string,
  findings: readonly VerifiedFinding[],
  failures: readonly StageFailure[],
  usage: readonly AgentResult<unknown>["usage"][],
  commented: boolean | "unknown",
  coverage?: ReviewCoverage,
): ReviewResult {
  return {
    effort: options.effort,
    status,
    summary,
    findings,
    failures,
    report: formatReviewReport(snapshot, status, summary, findings, failures, coverage),
    commented,
    usage,
    ...(coverage === undefined ? {} : { coverage }),
    reviewedSnapshotHash: snapshot.snapshotHash,
    ...(options.phase ? { phase: options.phase } : {}),
  };
}

function candidateWithFinder(
  candidate: FinderOutput["candidates"][number],
  finder: ReviewRole,
  index: number,
  source?: { readonly unitId: string; readonly shardId: string },
): ReviewCandidate {
  return {
    ...candidate,
    id: source === undefined
      ? `${finder}:${candidate.rootCauseKey}:${index}`
      : `${source.unitId}:${source.shardId}:${finder}:${candidate.rootCauseKey}:${index}`,
    finder,
  };
}

function snapshotValidatorSource(snapshot: ReviewSnapshot, candidate: ReviewCandidate): string | undefined {
  const pinned = snapshot.target.kind === "pull-request" || snapshot.pullRequest !== undefined;
  const deleted = pinned && parseUnifiedDiff(snapshot.diff).files.some((file) =>
    !file.malformed && file.oldPath === candidate.file && file.newPath === null);
  if (deleted) return "File intentionally deleted at the captured revision; the supplied diff contains the prior source evidence.";
  return collectValidatorSource(snapshot.sourceCwd ?? snapshot.cwd, candidate, { required: pinned });
}

function stageFailure(stage: StageFailure["stage"], error: unknown): StageFailure {
  return { stage, message: errorMessage(error) };
}

function bounded(items: readonly string[], limit = 20): string[] {
  return items.slice(0, limit).map((item) => item.trim().slice(0, 500)).filter(Boolean);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Read only a bounded source window for a no-tool candidate validator. */
export function collectValidatorSource(
  cwd: string,
  candidate: Pick<ReviewCandidate, "file" | "line">,
  options: { required?: boolean } = {},
): string | undefined {
  const unavailable = (): undefined => {
    if (options.required) throw new Error("Captured revision source could not be read within the validator source boundary");
    return undefined;
  };
  if (!Number.isInteger(candidate.line) || candidate.line < 1) return unavailable();
  const root = resolve(cwd);
  const requested = resolve(root, candidate.file);
  if (!isWithinRoot(root, requested)) return unavailable();

  let sourcePath: string;
  try {
    const realRoot = realpathSync(root);
    sourcePath = realpathSync(requested);
    if (!isWithinRoot(realRoot, sourcePath) || !statSync(sourcePath).isFile()) return unavailable();
  } catch {
    return unavailable();
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(sourcePath, "r");
    const buffer = Buffer.allocUnsafe(MAX_VALIDATOR_SOURCE_READ_BYTES);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split(/\r?\n/u);
    // Do not use an unterminated partial line as source for the candidate.
    if (candidate.line > lines.length || (bytesRead === buffer.length && !text.endsWith("\n") && candidate.line === lines.length)) {
      return unavailable();
    }
    const start = Math.max(0, candidate.line - 1 - VALIDATOR_SOURCE_WINDOW);
    const end = Math.min(lines.length, candidate.line - 1 + VALIDATOR_SOURCE_WINDOW + 1);
    const rendered: string[] = [];
    let renderedBytes = 0;
    for (let index = start; index < end && rendered.length < MAX_VALIDATOR_SOURCE_LINES; index += 1) {
      const line = `${index + 1}: ${lines[index] ?? ""}`;
      const lineBytes = Buffer.byteLength(line);
      const separatorBytes = rendered.length > 0 ? 1 : 0;
      if (rendered.length > 0 && renderedBytes + separatorBytes + lineBytes > MAX_VALIDATOR_SOURCE_BYTES) break;
      if (rendered.length === 0 && lineBytes > MAX_VALIDATOR_SOURCE_BYTES) {
        let truncated = Buffer.from(line).subarray(0, MAX_VALIDATOR_SOURCE_BYTES).toString("utf8");
        while (Buffer.byteLength(truncated) > MAX_VALIDATOR_SOURCE_BYTES) truncated = truncated.slice(0, -1);
        rendered.push(truncated);
        break;
      }
      rendered.push(line);
      renderedBytes += separatorBytes + lineBytes;
    }
    return rendered.length > 0 ? rendered.join("\n") : unavailable();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function contractContext(contract: ReviewContract | undefined): string {
  if (!contract) return "";
  const sections = [
    ["Supported guarantees", bounded(contract.guarantees)],
    ["Explicit non-goals", bounded(contract.nonGoals)],
    ["Risk areas", bounded(contract.riskAreas)],
    ["Required checks", bounded(contract.requiredChecks)],
  ] as const;
  const rendered = sections.flatMap(([title, items]) => items.length > 0
    ? [`${title}:`, ...items.map((item) => `- ${item}`)]
    : []);
  if (rendered.length === 0) return "";
  return [
    "Review contract supplied by the approved plan or caller:",
    ...rendered,
    "Do not promote an explicit non-goal into a blocker unless it violates a fundamental authorization, security, data-integrity, or backward-compatibility invariant.",
  ].join("\n");
}

function phaseContext(options: ReviewOptions): string {
  switch (options.phase) {
    case "delta":
      return "This is a remediation-delta review. Review the supplied delta and directly affected invariants. Do not restart a broad search over unchanged initial code.";
    case "final":
      return "This is the final bounded confirmation review. Check the final remediation delta and open high-risk invariants only; do not perform a fresh broad gap sweep.";
    case "initial":
      return "This is the one comprehensive initial review for the managed change.";
    default:
      return "";
  }
}

function openFindingContext(options: ReviewOptions): string {
  const findings = options.openFindings?.slice(0, 3) ?? [];
  if (findings.length === 0) return "";
  return [
    "Open root causes from the prior managed pass. Re-check these invariants while reviewing the remediation delta; the parent still owns final resolution:",
    ...findings.map((finding) => `- ${finding.id} [${finding.severity}/${finding.confidence}%] ${finding.impact} — trigger: ${finding.trigger}${finding.contractBasis ? ` — contract: ${finding.contractBasis}` : ""}`),
  ].join("\n");
}

function appendReviewContext(summary: string, options: ReviewOptions): string {
  return [summary, phaseContext(options), contractContext(options.contract), openFindingContext(options)].filter(Boolean).join("\n\n");
}

function resultToolFor(role: ReviewRole): AgentInvocation["resultTool"] {
  return role === "summary" ? REVIEWER_RESULT_TOOLS.summary
    : role === "validator" ? REVIEWER_RESULT_TOOLS.verifier
      : REVIEWER_RESULT_TOOLS.finder;
}

export function roleInvocation(
  role: ReviewRole,
  rolePlan: ReviewRoleConfig,
  buildPrompt: (inputBudgetBytes: number) => string,
  cwd: string,
  dependencies: ReviewDependencies,
): AgentInvocation {
  // Resolve the selected model before constructing the prompt. An override is
  // a provider identity, so its context window must be resolved rather than
  // inheriting the routed model's budget.
  const model = dependencies.reviewerModel ?? rolePlan.modelRoute.model;
  const budget = resolveInputBudget(
    rolePlan.contextBudget,
    dependencies.resolveModelContextWindow?.(model),
    rolePlan.inputBudgetBytes,
    rolePlan.reservedTokens,
  );
  const resultTool = resultToolFor(role);
  const promptBudget = budget.inputBudgetBytes - reviewerControlReserveBytes(resultTool)
    - Buffer.byteLength(`\n\n${REVIEWER_RETRY_SUFFIX}`, "utf8");
  const prompt = buildPrompt(promptBudget);
  assertInputBudget(prompt, promptBudget);
  return {
    role,
    prompt,
    cwd,
    tools: rolePlan.tools,
    resultTool,
    model,
    thinking: rolePlan.modelRoute.thinking,
    maxTurns: rolePlan.maxTurns,
    contextBudget: budget.contextBudget,
    inputBudgetBytes: budget.inputBudgetBytes,
    reservedTokens: budget.reservedTokens,
  };
}

function finderValidator(role: Exclude<ReviewRole, "summary" | "validator">): (value: unknown) => FinderOutput {
  switch (role) {
    case "guidance-a":
    case "guidance-b":
      return validateGuidance;
    case "diff-only-bug":
      return validateDiffOnlyBug;
    case "contextual-bug":
      return validateContextualBug;
    case "integration":
      return validateIntegration;
  }
}

function diffPath(value: string): string {
  const unquoted = value.trim().replace(/^"|"$/gu, "");
  return unquoted.replace(/^[ab]\//u, "");
}

/** Keep only complete git diff file sections relevant to a focused escalation. */
function diffForPaths(diff: string, paths: readonly string[]): string {
  const wanted = new Set(paths);
  return diff.split(/(?=^diff --git )/m).filter((section) => {
    if (!section.trim()) return false;
    return section.split(/\r?\n/).some((line) => {
      if (line.startsWith("--- ") || line.startsWith("+++ ")) return wanted.has(diffPath(line.slice(4).split("\t", 1)[0] ?? ""));
      if (!line.startsWith("diff --git ")) return false;
      const header = line.slice("diff --git ".length).split(" ");
      return header.some((part) => wanted.has(diffPath(part)));
    });
  }).join("");
}

function focusedSnapshot(snapshot: ReviewSnapshot, candidates: readonly ReviewCandidate[]): ReviewSnapshot {
  const paths = [...new Set(candidates.map((candidate) => candidate.file))].sort();
  return { ...snapshot, changedPaths: paths, diff: diffForPaths(snapshot.diff, paths) };
}

function relevantGuidance(
  cwd: string,
  guidance: readonly GuidanceFile[],
  candidates: readonly ReviewCandidate[],
): GuidanceFile[] {
  return guidance.filter((file) => candidates.some((candidate) => guidanceCoversPath(cwd, file.path, candidate.file)));
}

function rolePrompt(
  role: ReviewRole,
  snapshot: ReviewSnapshot,
  guidance: readonly GuidanceFile[],
  guidanceByPath: readonly { readonly path: string; readonly guidance: readonly GuidanceFile[] }[],
  context: string,
  inputBudgetBytes: number,
): string {
  switch (role) {
    case "summary":
      return buildSummaryPrompt(snapshot, [], inputBudgetBytes);
    case "guidance-a":
    case "guidance-b":
      return buildGuidancePrompt(snapshot, guidanceByPath, context, inputBudgetBytes);
    case "diff-only-bug":
      return buildDiffOnlyBugPrompt(snapshot, guidance, context, inputBudgetBytes);
    case "contextual-bug":
      return buildContextualBugPrompt(snapshot, guidance, context, inputBudgetBytes);
    case "integration":
      return buildIntegrationPrompt(snapshot, guidance, context, inputBudgetBytes);
    case "validator":
      throw new Error("validator prompts require a candidate");
  }
}

/** Keep the fitting path logically single-unit even when the shard serializer
 * would split the payload for its smaller escalation target. This never
 * truncates the immutable diff; sharding still owns prompt-overflow cases. */
function fittingWorkShard(snapshot: ReviewSnapshot): DiffShard {
  const serialized = shardDiff(snapshot.diff, snapshot.snapshotHash);
  const first = serialized[0];
  if (first === undefined) throw new Error("changed diff produced no review work shard");
  const fileIdentities = [...new Set(serialized.flatMap((shard) => shard.fileIdentities))];
  const byteLength = Buffer.byteLength(snapshot.diff, "utf8");
  // A supported atomic record can be larger than the shard target. That is
  // still runnable on the fitting path; only semantic parser failures make a
  // fitting unit unsupported.
  const oversizedAtomic = (shard: DiffShard): boolean => shard.byteLength > shard.maxBytes
    && shard.unsupportedReason?.startsWith("indivisible diff line exceeds") === true;
  const unsupportedReasons = [...new Set(serialized.flatMap((shard) => !shard.supported && !oversizedAtomic(shard) && shard.unsupportedReason !== undefined ? [shard.unsupportedReason] : []))];
  return {
    ...first,
    id: `${snapshot.snapshotHash}:fitting`,
    sourceOrder: 0,
    fileIdentity: fileIdentities.length === 1 ? fileIdentities[0] ?? "unknown" : "multiple",
    fileIdentities,
    oldPath: null,
    newPath: null,
    payload: snapshot.diff,
    byteLength,
    maxBytes: Math.max(first.maxBytes, byteLength),
    supported: serialized.every((shard) => shard.supported || oversizedAtomic(shard)),
    metadataOnly: serialized.some((shard) => shard.metadataOnly),
    binary: serialized.some((shard) => shard.binary),
    combined: serialized.some((shard) => shard.combined),
    malformed: serialized.some((shard) => shard.malformed),
    pieceIds: [...new Set(serialized.flatMap((shard) => shard.pieceIds))],
    ranges: serialized.flatMap((shard) => shard.ranges),
    coveredRanges: serialized.flatMap((shard) => shard.coveredRanges),
    ...(unsupportedReasons.length === 0 ? {} : { unsupportedReason: unsupportedReasons.join("; ") }),
  };
}

function shardSnapshot(snapshot: ReviewSnapshot, shard: { readonly payload: string; readonly fileIdentities: readonly string[] }): ReviewSnapshot {
  return { ...snapshot, diff: shard.payload, changedPaths: [...shard.fileIdentities] };
}

function shardGuidance(
  cwd: string,
  guidance: readonly GuidanceFile[],
  paths: readonly string[],
): { readonly path: string; readonly guidance: readonly GuidanceFile[] }[] {
  return paths.map((path) => ({ path, guidance: guidanceForPath(cwd, guidance, path) }));
}

function shardedManifestContext(snapshotHash: string, shardId: string, paths: readonly string[], options?: ReviewOptions): string {
  return [
    "Deterministic sharded review manifest; no summary reviewer was run.",
    `Snapshot: ${snapshotHash}`,
    `Shard: ${shardId}`,
    `Evidence paths assigned to this shard: ${paths.join(", ")}`,
    "The assigned shard evidence is complete unless reviewScope.assignedScopeComplete says otherwise. This is not the full global review manifest; reviewScope.globalScopeComplete:false means local omissions do not establish globally unchanged files.",
    ...(options === undefined ? [] : [phaseContext(options), contractContext(options.contract), openFindingContext(options)]),
  ].filter(Boolean).join("\n");
}

function coverageWithUnvalidated(
  coverage: ReviewCoverage,
  candidates: readonly { readonly id: string; readonly unitId?: string; readonly file?: string; readonly line?: number; readonly reason: string }[],
  reason?: string,
): ReviewCoverage {
  const existing = [...(coverage.unvalidatedCandidates ?? []), ...candidates];
  const seen = new Set<string>();
  const unique = existing.filter((candidate) => {
    const key = `${candidate.id}:${candidate.unitId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return Object.freeze({
    ...coverage,
    state: "incomplete",
    ...(reason === undefined ? {} : { reason: coverage.reason ?? reason }),
    uncoveredCandidates: Object.freeze([...coverage.uncoveredCandidates, ...unique]),
    unvalidatedCandidates: Object.freeze(unique),
  });
}

function mergeCoverage(left: ReviewCoverage, right: ReviewCoverage, spentWeight: number): ReviewCoverage {
  const planned = [...new Set([...left.plannedUnitIds, ...right.plannedUnitIds])];
  // A synthetic dependency in a later wave must not erase an earlier failure.
  const failed = new Set([...left.uncoveredUnitIds, ...right.uncoveredUnitIds]);
  const covered = planned.filter((id) => !failed.has(id) && (left.coveredUnitIds.includes(id) || right.coveredUnitIds.includes(id)));
  const uncovered = planned.filter((id) => !covered.includes(id));
  const ranges = [...left.uncoveredRanges, ...right.uncoveredRanges];
  const plannedShards = [...new Set([...(left.plannedShardIds ?? []), ...(right.plannedShardIds ?? [])])];
  const requiredShardUnitIds = Object.freeze(Object.fromEntries(plannedShards.map((id) => {
    const sides = [left, right].filter((side) => side.plannedShardIds?.includes(id));
    // Legacy records cannot establish full required-role scope from old counts.
    const known = sides.every((side) => side.requiredShardUnitIds?.[id]?.length);
    return [id, Object.freeze(known ? [...new Set(sides.flatMap((side) => side.requiredShardUnitIds![id]!))] : [])];
  })));
  const coveredShards = plannedShards.filter((id) => requiredShardUnitIds[id]!.length > 0
    && requiredShardUnitIds[id]!.every((unitId) => covered.includes(unitId)));
  const uncoveredShards = plannedShards.filter((id) => !coveredShards.includes(id));
  const state = uncovered.length > 0 || uncoveredShards.length > 0 || left.state !== "complete" || right.state !== "complete" ? "incomplete" : "complete";
  const maxWeight = left.budget?.maxWeight ?? left.maxWeight ?? right.budget?.maxWeight ?? right.maxWeight ?? 0;
  const attemptedUnitIds = [...new Set([...(left.attemptedUnitIds ?? []), ...(right.attemptedUnitIds ?? [])])];
  const attempts = { ...(left.attempts ?? {}), ...(right.attempts ?? {}) };
  return Object.freeze({
    ...left,
    state,
    plannedUnitIds: Object.freeze(planned),
    coveredUnitIds: Object.freeze(covered),
    uncoveredUnitIds: Object.freeze(uncovered),
    attemptedUnitIds: Object.freeze(attemptedUnitIds),
    attempts: Object.freeze(attempts),
    plannedUnits: Object.freeze(planned),
    coveredUnits: Object.freeze(covered),
    uncoveredUnits: Object.freeze(uncovered),
    uncoveredRanges: Object.freeze(ranges),
    uncoveredRangeEvidence: Object.freeze(ranges),
    requiredShardUnitIds,
    plannedShardIds: Object.freeze(plannedShards),
    coveredShardIds: Object.freeze(coveredShards),
    uncoveredShardIds: Object.freeze(uncoveredShards),
    plannedShardCount: plannedShards.length,
    coveredShardCount: coveredShards.length,
    uncoveredShardCount: uncoveredShards.length,
    plannedShards: Object.freeze(plannedShards),
    coveredShards: Object.freeze(coveredShards),
    uncoveredShards: Object.freeze(uncoveredShards),
    budgetMaxWeight: maxWeight,
    maxWeight,
    budgetSpentWeight: spentWeight,
    spentWeight,
    budget: Object.freeze({ maxWeight, reservedWeight: 0, spentWeight }),
  });
}

async function finalizeReview(
  snapshot: ReviewSnapshot,
  options: ReviewOptions,
  dependencies: ReviewDependencies,
  signal: AbortSignal | undefined,
  summary: string,
  findings: readonly VerifiedFinding[],
  failures: StageFailure[],
  usage: readonly AgentResult<unknown>["usage"][],
  coverage?: ReviewCoverage,
): Promise<ReviewResult> {
  progress(dependencies, "revalidation", "Checking that the reviewed target did not change");
  try {
    if (options.snapshot) {
      // Managed snapshots are constructed from exact committed SHAs. The
      // lifecycle wrapper performs its own current-HEAD revalidation.
    } else if (await hasSnapshotDrift(snapshot, dependencies.commands, signal)) {
      failures.push({ stage: "revalidation", message: "The reviewed target changed during review; no comment was published." });
    }
  } catch (error) {
    failures.push(stageFailure("revalidation", error));
  }
  const incompleteCoverage = coverage !== undefined && (coverage.state !== "complete" || (coverage.unvalidatedCandidates?.length ?? 0) > 0);
  const status: ReviewResult["status"] = failures.length > 0 || incompleteCoverage ? "incomplete" : "complete";
  let commented: boolean | "unknown" = false;
  if (options.comment && snapshot.pullRequest && status === "complete") {
    progress(dependencies, "comment", "Rechecking the target immediately before publishing");
    try {
      const publishSnapshot = await captureReviewSnapshot(snapshot.target, snapshot.cwd, dependencies.commands, signal);
      if (publishSnapshot.snapshotHash !== snapshot.snapshotHash) {
        failures.push({ stage: "revalidation", message: "The pull request changed immediately before publication; no comment was published." });
      } else if (publishSnapshot.pullRequest && hasExistingReview(publishSnapshot.pullRequest)) {
        failures.push({ stage: "comment", message: "A code review from the current reviewer already exists; no duplicate comment was published." });
      } else {
        const body = formatPrComment(publishSnapshot, status, summary, findings, failures);
        try {
          const result = await dependencies.commands.run(
            "gh",
            ["pr", "comment", String(publishSnapshot.pullRequest?.number ?? snapshot.pullRequest.number), "--repo", publishSnapshot.pullRequest?.repository ?? snapshot.pullRequest.repository, "--body", body],
            { cwd: snapshot.cwd, signal },
          );
          if (result.canceled || result.truncated || result.exitCode !== 0) {
            commented = "unknown";
            failures.push({
              stage: "comment",
              message: result.canceled
                ? "gh pr comment was canceled; GitHub may have accepted the request before cancellation."
                : result.truncated
                  ? "gh pr comment output was truncated; publication outcome is unknown."
                  : `gh pr comment outcome is unknown: ${result.stderr.trim() || `exited ${result.exitCode}`}`,
            });
          } else {
            commented = true;
          }
        } catch (error) {
          commented = "unknown";
          failures.push(stageFailure("comment", error));
        }
      }
    } catch (error) {
      failures.push(stageFailure("revalidation", error));
    }
  }
  const finalStatus: ReviewResult["status"] = failures.length > 0 || incompleteCoverage ? "incomplete" : "complete";
  const finalCoverage = coverage === undefined || failures.length === 0
    ? coverage
    : Object.freeze({ ...coverage, state: "incomplete", reason: coverage.reason ?? "review completed with failures" });
  return completedResult(snapshot, options, finalStatus, summary, findings, failures, usage, commented, finalCoverage);
}

interface FinderPassResult {
  readonly role: Exclude<ReviewRole, "summary" | "validator">;
  readonly result?: AgentResult<FinderOutput>;
  readonly failure?: StageFailure;
  readonly usage?: AgentResult<unknown>["usage"];
}

interface ShardedCandidateSource {
  readonly unitId: string;
  readonly shardId: string;
}

function roleForWorkUnit(unit: ReviewWorkUnit): Exclude<ReviewRole, "summary" | "validator"> | undefined {
  if (unit.agentRole !== undefined && unit.agentRole !== "summary" && unit.agentRole !== "validator") return unit.agentRole;
  switch (unit.role) {
    case "diff": return "diff-only-bug";
    case "guidance": return "guidance-a";
    case "contextual": return "contextual-bug";
    case "integration": return "integration";
    default: return undefined;
  }
}

function shardRiskPredicate(
  snapshot: ReviewSnapshot,
  analysis: { readonly highRiskPaths: readonly string[]; readonly publicContractPaths: readonly string[]; readonly publicContractMarkers: readonly string[]; readonly binary: boolean; readonly renamed: boolean; readonly copied: boolean; readonly risk: boolean },
): (shard: Pick<DiffShard, "fileIdentities" | "payload">) => boolean {
  const parsed = parseUnifiedDiff(snapshot.diff, snapshot.snapshotHash);
  const riskyFiles = new Set<string>([...analysis.highRiskPaths, ...analysis.publicContractPaths]);
  for (const file of parsed.files) {
    const fileAnalysis = analyzeDiff({ diff: file.raw, changedPaths: [file.fileIdentity] });
    if (fileAnalysis.risk) riskyFiles.add(file.fileIdentity);
  }
  const markerRisk = (payload: string): boolean => analysis.publicContractMarkers.some((marker) => {
    if (marker === "package-export-map") return /["']exports["']\s*:/i.test(payload);
    if (marker === "package-bin") return /["']bin["']\s*:/i.test(payload);
    if (marker === "package-types") return /["']types?["']\s*:/i.test(payload);
    return payload.toLowerCase().includes(marker.toLowerCase());
  });
  const structuralRisk = analysis.binary || analysis.renamed || analysis.copied;
  return (shard) => structuralRisk
    || shard.fileIdentities.some((path) => riskyFiles.has(path))
    || markerRisk(shard.payload);
}

function unitSnapshot(snapshot: ReviewSnapshot, shards: ReadonlyMap<string, { readonly payload: string; readonly fileIdentities: readonly string[] }>, unit: ReviewWorkUnit): ReviewSnapshot {
  const selected = unit.shardIds.flatMap((id) => {
    const shard = shards.get(id);
    return shard === undefined ? [] : [shard];
  });
  const payload = selected.map((shard) => shard.payload).join("");
  const paths = [...new Set(selected.flatMap((shard) => shard.fileIdentities))];
  return { ...snapshot, diff: payload, changedPaths: paths };
}

function workUnitGuidance(
  cwd: string,
  guidance: readonly GuidanceFile[],
  snapshot: ReviewSnapshot,
): { readonly path: string; readonly guidance: readonly GuidanceFile[] }[] {
  return shardGuidance(cwd, guidance, snapshot.changedPaths);
}

function candidateFragmentSnapshot(
  snapshot: ReviewSnapshot,
  shard: { readonly payload: string; readonly id: string; readonly fileIdentities: readonly string[] },
  candidate: Pick<ReviewCandidate, "file" | "line">,
): ReviewSnapshot {
  const parsed = parseUnifiedDiff(shard.payload, snapshot.snapshotHash);
  const file = parsed.files.find((entry) => entry.fileIdentity === candidate.file
    || entry.oldPath === candidate.file || entry.newPath === candidate.file);
  const hunk = file?.hunks.find((entry) => entry.lines.some((line) => line.newLine === candidate.line || line.oldLine === candidate.line));
  if (file === undefined || hunk === undefined) return shardSnapshot(snapshot, shard);
  const diff = `${[...file.headerLines, ...hunk.rawLines].join("\n")}\n`;
  return { ...snapshot, diff, changedPaths: [file.fileIdentity] };
}

function candidateFollowUpPrompt(
  role: "contextual-bug" | "integration",
  snapshot: ReviewSnapshot,
  guidance: readonly GuidanceFile[],
  context: string,
  candidates: readonly ReviewCandidate[],
  inputBudgetBytes: number,
): string {
  const suffix = `\nCandidate suspicions (inspect only these; do not recurse):\n${JSON.stringify(candidates)}`;
  assertInputBudget(suffix, inputBudgetBytes);
  const baseBudget = inputBudgetBytes - Buffer.byteLength(suffix, "utf8");
  let lastError: unknown;
  for (const contextLines of [undefined, 20, 5, 0]) {
    const selected = contextLines === undefined ? snapshot : {
      ...snapshot,
      diff: candidateDiffExcerpt(snapshot.diff, snapshot.snapshotHash, candidates, contextLines),
      changedPaths: [...new Set(candidates.map((candidate) => candidate.file))],
    };
    const selectedContext = contextLines === undefined ? context : `${context}\nCandidate-focused excerpts only; discovery covered the remaining changes. Use read/grep for additional source context.`;
    try {
      const base = rolePrompt(role, selected, guidance, workUnitGuidance(snapshot.sourceCwd ?? snapshot.cwd, guidance, selected), selectedContext, baseBudget);
      const prompt = base + suffix;
      assertInputBudget(prompt, inputBudgetBytes);
      return prompt;
    } catch (error) {
      if (!isPromptBudgetFailure(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function workUnitStage(unit: ReviewWorkUnit): ReviewStage {
  if (unit.role === "summary") return "summary";
  return unit.role === "guidance" ? "guidance" : "finders";
}

function unvalidatedCandidate(
  candidate: Pick<ReviewCandidate, "id" | "file" | "line">,
  reason: string,
  source?: ShardedCandidateSource,
): ReviewCoverageCandidate {
  return {
    id: candidate.id,
    file: candidate.file,
    line: candidate.line,
    reason,
    ...(source?.unitId === undefined ? {} : { unitId: source.unitId }),
  };
}

async function runShardedReview(
  snapshot: ReviewSnapshot,
  options: ReviewOptions,
  dependencies: ReviewDependencies,
  signal: AbortSignal | undefined,
  route: { readonly route: "tiny" | "small" | "normal" | "deep"; readonly analysis: { readonly highRiskPaths: readonly string[]; readonly publicContractPaths: readonly string[]; readonly publicContractMarkers: readonly string[]; readonly binary: boolean; readonly renamed: boolean; readonly copied: boolean; readonly risk: boolean }; readonly plan: { readonly roles: Readonly<Record<ReviewRole, ReviewRoleConfig>> } },
  guidance: readonly GuidanceFile[],
  guidanceFailures: readonly StageFailure[],
  initialFailures: readonly StageFailure[] = [],
): Promise<ReviewResult> {
  const explicitManifest: ReviewWorkManifest | undefined = options.manifest ?? options.reviewWorkManifest ?? options.reviewWorkObligations;
  const isRisky = shardRiskPredicate(snapshot, route.analysis);
  const rolesForShard = (shard: DiffShard): ReviewRole[] => {
    const hasGuidance = shard.fileIdentities.some((path) => guidanceForPath(snapshot.sourceCwd ?? snapshot.cwd, guidance, path).length > 0);
    const risky = isRisky(shard);
    return [
      "diff-only-bug",
      ...(hasGuidance ? ["guidance-a" as const] : []),
      ...(hasGuidance && risky ? ["guidance-b" as const] : []),
      ...(risky ? ["contextual-bug" as const] : []),
      ...(route.route === "deep" && risky ? ["integration" as const] : []),
    ];
  };
  let shards: readonly DiffShard[];
  try {
    // Explicit manifests may refer to standalone shard IDs; retain that layout.
    if (explicitManifest !== undefined) {
      shards = shardDiff(snapshot.diff, snapshot.snapshotHash);
    } else {
      const budgets = new Map<ReviewRole, number>();
      const budgetFor = (role: ReviewRole): number => {
        const cached = budgets.get(role);
        if (cached !== undefined) return cached;
        let budget = 0;
        roleInvocation(role, route.plan.roles[role], (inputBudgetBytes) => { budget = inputBudgetBytes; return ""; }, snapshot.sourceCwd ?? snapshot.cwd, dependencies);
        budgets.set(role, budget);
        return budget;
      };
      shards = shardDiff(snapshot.diff, snapshot.snapshotHash, {
        maxBytes: budgetFor("diff-only-bug"),
        fitsPrompt: (shard) => {
          const selected = shardSnapshot(snapshot, shard);
          const context = shardedManifestContext(snapshot.snapshotHash, shard.id, selected.changedPaths, options);
          const scoped = shardGuidance(snapshot.sourceCwd ?? snapshot.cwd, guidance, selected.changedPaths);
          for (const role of rolesForShard(shard)) {
            try {
              rolePrompt(role, selected, guidance, scoped, context, budgetFor(role));
            } catch (error) {
              if (isPromptBudgetFailure(error)) return false;
              throw error;
            }
          }
          return true;
        },
      });
    }
  } catch (error) {
    return completedResult(snapshot, options, "incomplete", "Review could not start because prompt-aware sharding failed.", [], [stageFailure("eligibility", error), ...initialFailures, ...guidanceFailures], [], false);
  }
  const shardMap = new Map(shards.map((shard) => [shard.id, shard]));
  const obligations: Array<{ readonly role: ReviewRole; readonly shardIds: readonly string[]; readonly trigger?: "always" | "risk" | "candidate" }> = [];
  for (const shard of shards) {
    for (const role of rolesForShard(shard)) {
      if (role === "diff-only-bug" && !shard.supported) continue;
      const trigger = role === "diff-only-bug" || role === "guidance-a" ? "always" : "risk";
      obligations.push({ role, shardIds: [shard.id], trigger });
    }
  }

  let plan: ReviewWorkPlan;
  try {
    plan = planReviewWork(snapshot, {
      shards,
      manifest: explicitManifest ?? obligations,
      ...(options.maxReviewWorkUnits === undefined ? {} : { maxReviewWorkUnits: options.maxReviewWorkUnits }),
      ...(options.workLimitPolicy === undefined ? {} : { workLimitPolicy: options.workLimitPolicy }),
    });
  } catch (error) {
    return completedResult(snapshot, options, "incomplete", "Review could not start because the sharded work plan is invalid.", [], [stageFailure("eligibility", error), ...initialFailures, ...guidanceFailures], [], false);
  }

  // This path is semantically sharded even when the serializer produces one
  // supported shard (for example, a prompt-only preflight split).
  plan = { ...plan, coverage: { ...plan.coverage, mode: "sharded", sharded: true } };
  const preflight = new Map<string, AgentInvocation>();
  const preflightFailures = new Map<string, string>();
  for (const unit of plan.units) {
    const role = roleForWorkUnit(unit);
    if (role === undefined) continue;
    const selectedShards = unit.shardIds.flatMap((id) => {
      const shard = shardMap.get(id);
      return shard === undefined ? [] : [shard];
    });
    const unsupported = selectedShards.find((shard) => !shard.supported);
    if (unsupported !== undefined) {
      preflightFailures.set(unit.id, unsupported.unsupportedReason ?? "unsupported diff shard");
      continue;
    }
    try {
      const selected = unitSnapshot(snapshot, shardMap, unit);
      const context = shardedManifestContext(snapshot.snapshotHash, selectedShards[0]?.id ?? unit.id, selected.changedPaths, options);
      const unitGuidance = selectedShards.flatMap((shard) => shardGuidance(snapshot.sourceCwd ?? snapshot.cwd, guidance, shard.fileIdentities));
      preflight.set(unit.id, roleInvocation(
        role,
        route.plan.roles[role],
        (inputBudgetBytes) => rolePrompt(role, selected, guidance, unitGuidance, context, inputBudgetBytes),
        snapshot.sourceCwd ?? snapshot.cwd,
        dependencies,
      ));
    } catch (error) {
      preflightFailures.set(unit.id, errorMessage(error));
    }
  }

  const plannedUncovered = plan.units.filter((unit) => unit.status === "uncovered");
  const unsupported = plannedUncovered.filter((unit) => unit.reason?.toLowerCase().includes("unsupported") || unit.shardIds.some((id) => !shardMap.get(id)?.supported));
  const anyPromptFailure = preflightFailures.size > 0;
  const discoveryFailureMessages = guidanceFailures.map((failure) => failure.message);
  const reject = plan.workLimitPolicy === "reject";
  if (reject && (plannedUncovered.length > 0 || unsupported.length > 0 || anyPromptFailure || discoveryFailureMessages.length > 0)) {
    const reasonByUnit: Record<string, string> = {};
    for (const unit of plan.units) {
      reasonByUnit[unit.id] = preflightFailures.get(unit.id) ?? unit.reason ?? "required sharded work was rejected before launch";
    }
    const rejected = applyReviewWorkCoverage(plan, {
      uncoveredUnitIds: plan.units.map((unit) => unit.id),
      reasonByUnit,
      reason: "required sharded work was not runnable before launch",
    });
    const failures: StageFailure[] = [...initialFailures, ...guidanceFailures];
    for (const [unitId, reason] of preflightFailures) {
      const unit = plan.units.find((candidate) => candidate.id === unitId);
      if (unit) failures.push({ stage: workUnitStage(unit), message: `${roleForWorkUnit(unit) ?? unit.role}: ${reason}`.slice(0, 500) });
    }
    if (plannedUncovered.length > 0) failures.push({ stage: "finders", message: rejectedWorkMessage(plan) });
    return completedResult(snapshot, options, "incomplete", "Review could not start because required sharded coverage was unavailable.", [], failures, [], false, rejected.coverage);
  }

  const completionReserve = validationReserve(plan);
  const selectedUnits = plan.units.filter((unit) => plan.selectedUnitIds.includes(unit.id) && unit.status === "planned" && !preflightFailures.has(unit.id));
  const initialUncoveredIds = plan.units.filter((unit) => unit.status === "uncovered" || preflightFailures.has(unit.id)).map((unit) => unit.id);
  const reasonByUnit: Record<string, string> = {};
  for (const unit of plan.units) {
    const reason = preflightFailures.get(unit.id) ?? unit.reason;
    if (reason !== undefined) reasonByUnit[unit.id] = reason;
  }
  const tasks: ReviewScheduleTask<FinderOutput>[] = selectedUnits.flatMap((unit) => {
    const role = roleForWorkUnit(unit);
    const invocation = preflight.get(unit.id);
    if (role === undefined || invocation === undefined) return [];
    return [{
      id: unit.id,
      weight: unit.weight,
      run: async (context) => runScheduledFinder(dependencies, invocation, finderValidator(role), context),
    }];
  });
  let primaryOutcome: ReviewScheduleOutcome<FinderOutput> | undefined;
  progress(dependencies, "finders", `Running ${selectedUnits.map((unit) => roleForWorkUnit(unit) ?? unit.role).join(", ")} in parallel`);
  if (tasks.length > 0) {
    primaryOutcome = await scheduleReviewWork(tasks, { capacity: plan.maxReviewWorkUnits - completionReserve, maxConcurrency: 4, ...(signal === undefined ? {} : { signal }) });
  }
  const primaryCovered = primaryOutcome?.coveredUnitIds ?? [];
  const primaryUncovered = [...initialUncoveredIds, ...(primaryOutcome?.uncoveredUnitIds ?? [])];
  if (primaryOutcome) {
    for (const [id, reason] of Object.entries(primaryOutcome.reasonByUnit)) reasonByUnit[id] = reason;
  }
  const coveredPlan = applyReviewWorkCoverage(plan, {
    coveredUnitIds: primaryCovered,
    uncoveredUnitIds: [...new Set(primaryUncovered)],
    attemptedUnitIds: primaryOutcome?.attemptedUnitIds ?? [],
    attempts: primaryOutcome?.attempts ?? {},
    reasonByUnit,
  });

  const failures: StageFailure[] = [...initialFailures, ...guidanceFailures];
  for (const unit of coveredPlan.units) {
    if (unit.status !== "uncovered") continue;
    const reason = unit.reason ?? "sharded work unit was not covered";
    failures.push({ stage: workUnitStage(unit), message: `${roleForWorkUnit(unit) ?? unit.role}: ${reason}`.slice(0, 500) });
  }
  const usage: AgentResult<unknown>["usage"][] = [];
  for (const result of primaryOutcome?.results ?? []) if (result.usage) usage.push(result.usage);

  let aggregateCoverage = coveredPlan.coverage;
  const sourceByCandidate = new Map<string, ShardedCandidateSource>();
  const collectFinderCandidates = (outcome: ReviewScheduleOutcome<FinderOutput> | undefined): ReviewCandidate[] => (outcome?.results ?? []).flatMap((result) => {
    if (result.value === undefined) return [];
    const unit = plan.units.find((candidate) => candidate.id === result.id);
    const role = unit === undefined ? undefined : roleForWorkUnit(unit);
    if (unit === undefined || role === undefined) return [];
    const shardId = unit.shardIds[0];
    if (shardId === undefined) return [];
    return result.value.candidates.slice(0, route.plan.roles[role].candidateCap).map((candidate, index) => {
      const output = candidateWithFinder(candidate, role, index, { unitId: unit.id, shardId });
      sourceByCandidate.set(output.id, { unitId: unit.id, shardId });
      return output;
    });
  });
  let candidates = deduplicateCandidates(filterCandidatesToChangedLines(collectFinderCandidates(primaryOutcome), collectChangedLocations(snapshot.diff)));
  const changedLocations = collectChangedLocations(snapshot.diff);

  const runCandidateWave = async (
    role: "contextual-bug" | "integration",
    selectedCandidates: readonly ReviewCandidate[],
  ): Promise<void> => {
    if (selectedCandidates.length === 0) return;
    const byShard = new Map<string, ReviewCandidate[]>();
    for (const candidate of selectedCandidates) {
      const source = sourceByCandidate.get(candidate.id);
      if (source === undefined || !shardMap.has(source.shardId)) continue;
      const group = byShard.get(source.shardId) ?? [];
      group.push(candidate);
      byShard.set(source.shardId, group);
    }
    if (byShard.size === 0) return;
    const unspent = plan.maxReviewWorkUnits - (aggregateCoverage.budget?.spentWeight ?? primaryOutcome?.spentWeight ?? 0);
    const remaining = Math.max(0, unspent - Math.min(unspent, Math.max(completionReserve, candidates.length)));
    const candidateShards = [...byShard.keys()].map((id) => shardMap.get(id)!).filter(Boolean);
    const candidatePlan = planReviewWork(snapshot, {
      shards: candidateShards,
      manifest: [...byShard.keys()].map((shardId) => ({ role, shardIds: [shardId], trigger: "candidate" as const })),
      maxReviewWorkUnits: Math.max(1, Math.min(MAX_REVIEW_WORK_UNITS, remaining + candidateShards.length)),
      workLimitPolicy: "partial",
    });
    const syntheticDiffIds = candidatePlan.units.filter((unit) => unit.role === "diff").map((unit) => unit.id);
    const candidatePrepared = candidatePlan;
    const candidateTasks: ReviewScheduleTask<FinderOutput>[] = [];
    const candidatePromptFailures = new Map<string, string>();
    const expectedRole = role === "contextual-bug" ? "contextual" : "integration";
    for (const unit of candidatePrepared.units) {
      if (unit.role !== expectedRole) continue;
      if (unit.status !== "planned") continue;
      const shardId = unit.shardIds[0];
      const shard = shardId === undefined ? undefined : shardMap.get(shardId);
      const group = shardId === undefined ? undefined : byShard.get(shardId);
      if (!shard || !group) continue;
      try {
        const focused = shardSnapshot(snapshot, shard);
        const context = shardedManifestContext(snapshot.snapshotHash, shard.id, focused.changedPaths, options);
        const invocation = roleInvocation(
          role,
          route.plan.roles[role],
          (inputBudgetBytes) => candidateFollowUpPrompt(role, focused, guidance, context, group, inputBudgetBytes),
          snapshot.sourceCwd ?? snapshot.cwd,
          dependencies,
        );
        candidateTasks.push({
          id: unit.id,
          weight: unit.weight,
          run: async (taskContext) => runScheduledFinder(dependencies, invocation, finderValidator(role), taskContext),
        });
      } catch (error) {
        candidatePromptFailures.set(unit.id, errorMessage(error));
      }
    }
    const available = Math.max(0, remaining);
    let outcome: ReviewScheduleOutcome<FinderOutput> | undefined;
    if (candidateTasks.length > 0 && available > 0) {
      outcome = await scheduleReviewWork(candidateTasks, { capacity: available, maxConcurrency: 4, ...(signal === undefined ? {} : { signal }) });
      for (const result of outcome.results) if (result.usage) usage.push(result.usage);
    }
    const uncovered = [
      ...candidatePrepared.units.filter((unit) => unit.status === "uncovered").map((unit) => unit.id),
      ...candidatePromptFailures.keys(),
      ...(outcome?.uncoveredUnitIds ?? []),
    ];
    const reasons: Record<string, string> = {};
    for (const unit of candidatePrepared.units) if (unit.reason) reasons[unit.id] = unit.reason;
    for (const [id, value] of candidatePromptFailures) reasons[id] = value;
    for (const [id, value] of Object.entries(outcome?.reasonByUnit ?? {})) reasons[id] = value;
    const completedCandidatePlan = applyReviewWorkCoverage(candidatePrepared, {
      coveredUnitIds: [...syntheticDiffIds, ...(outcome?.coveredUnitIds ?? [])],
      uncoveredUnitIds: [...new Set(uncovered)],
      attemptedUnitIds: outcome?.attemptedUnitIds ?? [],
      attempts: outcome?.attempts ?? {},
      reasonByUnit: reasons,
    });
    aggregateCoverage = mergeCoverage(aggregateCoverage, completedCandidatePlan.coverage, (aggregateCoverage.budget?.spentWeight ?? primaryOutcome?.spentWeight ?? 0) + (outcome?.spentWeight ?? 0));
    for (const unit of completedCandidatePlan.units) {
      if (unit.status === "uncovered" && unit.role !== "diff") failures.push({ stage: role === "contextual-bug" ? "finders" : "finders", message: `${role}: ${unit.reason ?? "candidate follow-up was not covered"}`.slice(0, 500) });
    }
    for (const result of outcome?.results ?? []) {
      if (result.value === undefined) continue;
      const unit = candidatePrepared.units.find((candidate) => candidate.id === result.id);
      const shardId = unit?.shardIds[0];
      if (!unit || !shardId) continue;
      for (const [index, candidate] of result.value.candidates.slice(0, route.plan.roles[role].candidateCap).entries()) {
        const output = candidateWithFinder(candidate, role, index, { unitId: unit.id, shardId });
        sourceByCandidate.set(output.id, { unitId: unit.id, shardId });
        candidates.push(output);
      }
    }
    candidates = deduplicateCandidates(filterCandidatesToChangedLines(candidates, changedLocations));
  };

  // Only the first concrete request is escalated.  This is deliberately a
  // collapsed, non-recursive follow-up rather than a new broad contextual pass.
  await runCandidateWave("contextual-bug", candidates.filter((candidate) => candidate.needsContext).slice(0, 1));
  await runCandidateWave("integration", candidates.filter((candidate) => candidate.category === "integration"));

  const unvalidated: ReviewCoverageCandidate[] = [];
  if (candidates.length > 0) progress(dependencies, "verification", `Starting candidate validation for ${candidates.length} finding${candidates.length === 1 ? "" : "s"}`);
  const verdicts: VerifierOutput[] = [];
  const validatorTasks: ReviewScheduleTask<VerifierOutput>[] = [];
  const validatorByTask = new Map<string, ReviewCandidate>();
  const ownerForCandidate = (candidate: ReviewCandidate): { readonly shard: (typeof shards)[number]; readonly source: ShardedCandidateSource } | undefined => {
    const source = sourceByCandidate.get(candidate.id);
    if (!source) return undefined;
    const shard = shardMap.get(source.shardId);
    if (!shard) return undefined;
    const ownsPath = shard.fileIdentities.includes(candidate.file) || shard.oldPath === candidate.file || shard.newPath === candidate.file;
    const ownsLine = shard.ranges.some((range) => range.fileIdentity === undefined || range.fileIdentity === candidate.file
      ? range.newLineNumbers.includes(candidate.line) || range.oldLineNumbers.includes(candidate.line)
      : false);
    return ownsPath && ownsLine ? { shard, source } : undefined;
  };
  for (const candidate of candidates) {
    const owner = ownerForCandidate(candidate);
    if (!owner) {
      const reason = "candidate source shard or changed hunk is unavailable";
      unvalidated.push(unvalidatedCandidate(candidate, reason, sourceByCandidate.get(candidate.id)));
      failures.push({ stage: "verification", message: `${candidate.id}: ${reason}`.slice(0, 500) });
      continue;
    }
    try {
      const ownerSnapshot = candidateFragmentSnapshot(snapshot, owner.shard, candidate);
      const candidateGuidance = guidanceForPath(snapshot.sourceCwd ?? snapshot.cwd, guidance, candidate.file);
      const invocation = roleInvocation(
        "validator",
        route.plan.roles.validator,
        (inputBudgetBytes) => buildValidatorPrompt(candidate, ownerSnapshot, candidateGuidance, shardedManifestContext(snapshot.snapshotHash, owner.shard.id, ownerSnapshot.changedPaths, options), {
          passLabel: "primary",
          source: snapshotValidatorSource(snapshot, candidate),
          inputBudgetBytes,
        }),
        snapshot.sourceCwd ?? snapshot.cwd,
        dependencies,
      );
      validatorByTask.set(candidate.id, candidate);
      validatorTasks.push({
        id: candidate.id,
        weight: 1,
        run: async (context) => {
          const result = await runAgent(dependencies, {
            ...invocation,
            onAttemptStart: context.markAttemptStarted,
            retryAdmission: context.retryAdmission,
          }, (value) => validateVerifier(value, candidate.id), context.signal);
          return result;
        },
      });
    } catch (error) {
      unvalidated.push(unvalidatedCandidate(candidate, errorMessage(error), owner.source));
      failures.push({ stage: "verification", message: `${candidate.id}: ${errorMessage(error)}`.slice(0, 500) });
    }
  }
  const spentBeforeValidation = aggregateCoverage.budget?.spentWeight ?? (primaryOutcome?.spentWeight ?? 0);
  const validatorCapacity = Math.max(0, plan.maxReviewWorkUnits - spentBeforeValidation);
  let validatorOutcome: ReviewScheduleOutcome<VerifierOutput> | undefined;
  if (validatorTasks.length > 0 && validatorCapacity > 0) {
    validatorOutcome = await scheduleReviewWork(validatorTasks, { capacity: validatorCapacity, maxConcurrency: 4, ...(signal === undefined ? {} : { signal }) });
    for (const result of validatorOutcome.results) {
      if (result.usage) usage.push(result.usage);
      if (result.status === "covered" && result.value !== undefined) verdicts.push(result.value);
      if (result.status !== "covered") {
        const candidate = validatorByTask.get(result.id);
        if (candidate) unvalidated.push(unvalidatedCandidate(candidate, result.reason ?? "validator capacity was exhausted", sourceByCandidate.get(candidate.id)));
        failures.push({ stage: "verification", message: `${result.id}: ${result.reason ?? "validator capacity was exhausted"}`.slice(0, 500) });
      }
    }
  } else {
    for (const task of validatorTasks) {
      const candidate = validatorByTask.get(task.id);
      if (!candidate) continue;
      unvalidated.push(unvalidatedCandidate(candidate, "validator capacity was exhausted", sourceByCandidate.get(candidate.id)));
      failures.push({ stage: "verification", message: `${candidate.id}: validator capacity was exhausted`.slice(0, 500) });
    }
  }
  const findings = filterVerifiedFindings(candidates, verdicts, { changedLocations, minimumConfidence: 85 }).slice(0, MAX_FINDINGS);
  const validatorSpent = validatorOutcome?.spentWeight ?? 0;
  let finalCoverage = validatorSpent === 0 ? aggregateCoverage : Object.freeze({
    ...aggregateCoverage,
    budgetSpentWeight: (aggregateCoverage.budgetSpentWeight ?? aggregateCoverage.spentWeight ?? 0) + validatorSpent,
    spentWeight: (aggregateCoverage.spentWeight ?? 0) + validatorSpent,
    budget: Object.freeze({
      maxWeight: aggregateCoverage.budget?.maxWeight ?? aggregateCoverage.maxWeight ?? plan.maxReviewWorkUnits,
      reservedWeight: aggregateCoverage.budget?.reservedWeight ?? aggregateCoverage.reservedWeight ?? 0,
      spentWeight: (aggregateCoverage.budget?.spentWeight ?? aggregateCoverage.spentWeight ?? 0) + validatorSpent,
    }),
  });
  if (unvalidated.length > 0) finalCoverage = coverageWithUnvalidated(finalCoverage, unvalidated, "one or more candidates were not validated");
  const statusCoverage = finalCoverage.state === "complete" && unvalidated.length === 0;
  if (candidates.length > 0) progress(dependencies, "verification", `Completed candidate validation with ${findings.length} retained finding${findings.length === 1 ? "" : "s"}`);
  if (!statusCoverage && failures.length === 0) failures.push({ stage: "finders", message: "Required sharded review coverage is incomplete." });
  return finalizeReview(snapshot, options, dependencies, signal, "", findings, failures, usage, finalCoverage);
}

export async function runCodeReview(options: ReviewOptions, dependencies: ReviewDependencies, signal?: AbortSignal): Promise<ReviewResult> {
  let snapshot: ReviewSnapshot;
  try {
    progress(dependencies, "eligibility", options.snapshot ? "Using immutable supplied review snapshot" : "Capturing immutable review snapshot");
    snapshot = options.snapshot ?? await captureReviewSnapshot(options.target, options.cwd, dependencies.commands, signal);
  } catch (error) {
    return resultWithoutSnapshot("incomplete", errorMessage(error), options);
  }
  if (snapshot.changedPaths.length === 0 || snapshot.diff.trim().length === 0) {
    return completedResult(snapshot, options, "ineligible", "No changed files were found in the requested target.", [], [], [], false);
  }

  const failures: StageFailure[] = [];
  const usage: AgentResult<unknown>["usage"][] = [];

  if (snapshot.pullRequest) {
    const pullRequest = snapshot.pullRequest;
    if (pullRequest.state.toUpperCase() !== "OPEN") return completedResult(snapshot, options, "ineligible", "The pull request is not open.", [], [], [], false);
    if (pullRequest.isDraft) return completedResult(snapshot, options, "ineligible", "The pull request is a draft.", [], [], [], false);
    if (isLikelyAutomatedPullRequest(pullRequest)) return completedResult(snapshot, options, "ineligible", "The pull request appears to be automated.", [], [], [], false);
    if (hasExistingReview(pullRequest)) return completedResult(snapshot, options, "ineligible", "The pull request already has a code review from the current reviewer.", [], [], [], false);
    if (options.comment && !pullRequest.reviewerIdentityAvailable) {
      failures.push({ stage: "eligibility", message: "Could not verify the current reviewer identity; publishing is disabled." });
    }
  }

  let sourceView: Awaited<ReturnType<typeof prepareReviewSourceView>>;
  try {
    sourceView = await (dependencies.prepareSourceView
      ? dependencies.prepareSourceView(snapshot, signal)
      : prepareReviewSourceView(snapshot, dependencies.commands, signal));
  } catch (error) {
    return completedResult(snapshot, options, "incomplete", "Review could not start because snapshot-pinned source evidence is unavailable.", [], [stageFailure("eligibility", error), ...failures], usage, false);
  }
  let result: ReviewResult;
  try {
    result = await runPreparedReview({ ...snapshot, sourceCwd: sourceView.root,
      reviewChangedPaths: snapshot.reviewChangedPaths ?? snapshot.changedPaths }, options, dependencies, signal, failures, usage);
  } catch (error) {
    result = completedResult(snapshot, options, "incomplete", "Review execution did not complete.", [], [...failures, stageFailure("finders", error)], usage, false);
  }
  try {
    await sourceView.dispose();
  } catch (error) {
    return completedResult(snapshot, options, "incomplete", result.summary, result.findings,
      [...result.failures, stageFailure("revalidation", error)], result.usage, result.commented, result.coverage);
  }
  return result;
}

async function runPreparedReview(
  snapshot: ReviewSnapshot,
  options: ReviewOptions,
  dependencies: ReviewDependencies,
  signal: AbortSignal | undefined,
  failures: StageFailure[],
  usage: AgentResult<unknown>["usage"][],
): Promise<ReviewResult> {
  const reviewCwd = snapshot.sourceCwd ?? snapshot.cwd;
  // Configuration and classification happen once, after immutable snapshot
  // eligibility. A malformed root config is never silently downgraded.
  let routing;
  try {
    const config = loadReviewConfig(reviewCwd);
    routing = routeReview({ diff: snapshot.diff, changedPaths: snapshot.changedPaths, effort: options.effort, config }, options.effort, config);
  } catch (error) {
    const failure = stageFailure("eligibility", error);
    return completedResult(snapshot, options, "incomplete", "Review could not start because repository routing configuration is invalid.", [], [failure, ...failures], usage, false);
  }

  const { route, plan } = routing;

  // Guidance is discovered once from the immutable snapshot.  It is loaded
  // before sharding so both the routing decision and every shard preflight
  // use the same applicability result.
  let guidance: readonly GuidanceFile[] = [];
  const guidanceFailures: StageFailure[] = [];
  const guidanceSelected = plan.activeRoles.includes("guidance-a") || plan.activeRoles.includes("guidance-b");
  if (guidanceSelected) {
    progress(dependencies, "guidance", "Loading applicable repository guidance");
    const guidanceDiscovery = discoverApplicableGuidance(reviewCwd, snapshot.changedPaths);
    guidance = guidanceDiscovery.files;
    guidanceFailures.push(...guidanceDiscovery.failures.map((message) => ({ stage: "guidance" as const, message: message.slice(0, 500) })));
  }
  const guidanceByPath = [...new Set(snapshot.changedPaths)]
    .sort()
    .map((path) => ({ path, guidance: guidanceForPath(reviewCwd, guidance, path) }));

  // Construct the exact current-role prompts before launching anything. A
  // model-capacity or role/configuration failure is retained on the fitting
  // path; only an actual prompt-budget overflow selects sharding.
  const currentPreflight = new Map<ReviewRole, AgentInvocation>();
  const currentPreflightFailures: Array<{ readonly role: ReviewRole; readonly error: unknown }> = [];
  const preflightRoles: readonly ReviewRole[] = [
    ...(route === "normal" || route === "deep" ? ["summary" as const] : []),
    ...plan.activeRoles.filter((role) => role !== "summary" && role !== "validator"),
  ];
  const currentPromptContext = appendReviewContext("", options);
  for (const role of preflightRoles) {
    try {
      currentPreflight.set(role, roleInvocation(
        role,
        plan.roles[role],
        (inputBudgetBytes) => rolePrompt(role, snapshot, guidance, guidanceByPath, currentPromptContext, inputBudgetBytes),
        reviewCwd,
        dependencies,
      ));
    } catch (error) {
      currentPreflightFailures.push({ role, error });
    }
  }
  const promptNeedsSharding = currentPreflightFailures.some(({ error }) => isPromptBudgetFailure(error));
  if (promptNeedsSharding) {
    return runShardedReview(snapshot, options, dependencies, signal, routing, guidance, guidanceFailures, failures);
  }

  const promptSummaryRequired = route === "normal" || route === "deep";
  const primaryRoles = plan.activeRoles.filter((role): role is Exclude<ReviewRole, "summary" | "validator"> => role !== "summary" && role !== "validator");
  const explicitManifest: ReviewWorkManifest | undefined = options.manifest ?? options.reviewWorkManifest ?? options.reviewWorkObligations;
  const fixedManifest: ReviewWorkManifest = explicitManifest ?? [
    ...(promptSummaryRequired ? [{ role: "summary" as const }] : []),
    ...primaryRoles.map((role) => ({ role })),
  ];
  let fittingShard: DiffShard;
  let workPlan: ReviewWorkPlan;
  try {
    fittingShard = fittingWorkShard(snapshot);
    workPlan = planReviewWork(snapshot, {
      shards: [fittingShard],
      manifest: fixedManifest,
      ...(options.maxReviewWorkUnits === undefined ? {} : { maxReviewWorkUnits: options.maxReviewWorkUnits }),
      ...(options.workLimitPolicy === undefined ? {} : { workLimitPolicy: options.workLimitPolicy }),
    });
  } catch (error) {
    return completedResult(snapshot, options, "incomplete", "Review could not start because the fitting work plan is invalid.", [], [stageFailure("eligibility", error), ...failures, ...guidanceFailures], usage, false);
  }

  const unitAgentRole = (unit: ReviewWorkUnit): ReviewRole | undefined => unit.role === "summary" ? "summary" : roleForWorkUnit(unit);
  const initialPreflightByRole = new Map(currentPreflightFailures.map(({ role, error }) => [role, errorMessage(error)]));
  const fixedUncovered = workPlan.units.filter((unit) => unit.status === "uncovered");
  if (workPlan.workLimitPolicy === "reject" && fixedUncovered.length > 0) {
    const reasonByUnit: Record<string, string> = {};
    for (const unit of workPlan.units) {
      reasonByUnit[unit.id] = unit.reason ?? "required fitting work was rejected before launch";
    }
    const rejected = applyReviewWorkCoverage(workPlan, {
      uncoveredUnitIds: workPlan.units.map((unit) => unit.id),
      reasonByUnit,
      reason: "required fitting work was not admitted within the configured work limit",
    });
    const rejectFailures: StageFailure[] = [...failures, ...guidanceFailures, { stage: "finders", message: rejectedWorkMessage(workPlan) }];
    for (const unit of workPlan.units) {
      rejectFailures.push({
        stage: workUnitStage(unit),
        message: `${unitAgentRole(unit) ?? unit.role}: ${reasonByUnit[unit.id]}`.slice(0, 500),
      });
    }
    return completedResult(snapshot, options, "incomplete", "Review could not start because required fitting coverage was unavailable.", [], rejectFailures, usage, false, rejected.coverage);
  }

  const completionReserve = validationReserve(workPlan);
  let summary = "";
  let summaryOutcome: ReviewScheduleOutcome<SummaryOutput> | undefined;
  const summaryUnit = workPlan.units.find((unit) => unit.role === "summary");
  const fixedPromptFailures = new Map<string, string>();
  if (summaryUnit?.status === "planned") {
    const summaryInvocation = currentPreflight.get("summary");
    if (summaryInvocation === undefined) {
      fixedPromptFailures.set(summaryUnit.id, initialPreflightByRole.get("summary") ?? "summary prompt preflight failed");
    } else {
      progress(dependencies, "summary", "Summarizing the change");
      summaryOutcome = await scheduleReviewWork([{
        id: summaryUnit.id,
        weight: summaryUnit.weight,
        run: async (context) => runScheduledAgent(dependencies, summaryInvocation, validateSummary, context),
      }], { capacity: workPlan.maxReviewWorkUnits - completionReserve - workPlan.units.filter((unit) => unit.status === "planned" && unit.role !== "summary").reduce((sum, unit) => sum + unit.weight, 0), maxConcurrency: 1, ...(signal === undefined ? {} : { signal }) });
      const result = summaryOutcome.results[0];
      if (result?.usage) usage.push(result.usage);
      if (result?.status === "covered" && result.value !== undefined) summary = result.value.summary;
    }
  }
  const promptContext = appendReviewContext(summary, options);

  // Finder prompts are deliberately built only after the summary has
  // completed. The initial preflight above may decide to shard, but it is not
  // an invocation that can bypass this final-context check.
  const primaryPromptFailures = new Map<string, string>();
  const primaryInvocations = new Map<string, AgentInvocation>();
  const selectedPrimaryUnits = workPlan.units
    .filter((unit) => unit.status === "planned" && unit.role !== "summary" && unit.role !== "validator")
    .sort((left, right) => {
      const leftRole = unitAgentRole(left);
      const rightRole = unitAgentRole(right);
      const leftIndex = leftRole === undefined ? Number.MAX_SAFE_INTEGER : primaryRoles.indexOf(leftRole as Exclude<ReviewRole, "summary" | "validator">);
      const rightIndex = rightRole === undefined ? Number.MAX_SAFE_INTEGER : primaryRoles.indexOf(rightRole as Exclude<ReviewRole, "summary" | "validator">);
      return leftIndex - rightIndex || left.id.localeCompare(right.id);
    });
  for (const unit of selectedPrimaryUnits) {
    const role = unitAgentRole(unit);
    if (role === undefined || role === "summary" || role === "validator") {
      primaryPromptFailures.set(unit.id, "fitting work unit has no runnable reviewer role");
      continue;
    }
    try {
      const preflightInvocation = summary === "" ? currentPreflight.get(role) : undefined;
      primaryInvocations.set(unit.id, preflightInvocation ?? roleInvocation(
        role,
        plan.roles[role],
        (inputBudgetBytes) => {
          const prompt = rolePrompt(role, snapshot, guidance, guidanceByPath, promptContext, inputBudgetBytes);
          // Prompt builders may otherwise select an omitted-summary variant.
          // The fitting planner has already admitted this finder, so silently
          // dropping the actual final summary would make that admission false.
          const serializedPromptContext = JSON.stringify(promptContext);
          const summaryInPrompt = serializedPromptContext !== undefined
            && prompt.includes(`"summary":${serializedPromptContext}`);
          if (summary.trim() !== "" && !summaryInPrompt) {
            throw new InputLimitError("Final finder prompt cannot include the generated summary within its input budget", {
              inputBudgetBytes,
              promptBytes: inputBudgetBytes + 1,
            });
          }
          return prompt;
        },
        reviewCwd,
        dependencies,
      ));
    } catch (error) {
      primaryPromptFailures.set(unit.id, errorMessage(error));
    }
  }

  const primaryTasks: ReviewScheduleTask<FinderOutput>[] = selectedPrimaryUnits.flatMap((unit) => {
    const role = unitAgentRole(unit);
    const invocation = primaryInvocations.get(unit.id);
    if (role === undefined || role === "summary" || role === "validator" || invocation === undefined) return [];
    return [{
      id: unit.id,
      weight: unit.weight,
      run: async (context) => runScheduledFinder(dependencies, invocation, finderValidator(role), context),
    }];
  });
  progress(dependencies, "finders", `Running ${primaryRoles.join(", ")} in parallel`);
  const primaryCapacity = Math.max(0, workPlan.maxReviewWorkUnits - completionReserve - (summaryOutcome?.spentWeight ?? 0));
  let primaryOutcome: ReviewScheduleOutcome<FinderOutput> | undefined;
  if (primaryTasks.length > 0 && primaryCapacity > 0) {
    primaryOutcome = await scheduleReviewWork(primaryTasks, { capacity: primaryCapacity, maxConcurrency: 4, ...(signal === undefined ? {} : { signal }) });
  }
  const fixedInitialUncovered = workPlan.units.filter((unit) => unit.status === "uncovered").map((unit) => unit.id);
  const primaryPromptUncovered = [...primaryPromptFailures.keys()];
  const primaryNotScheduled = primaryTasks.length > 0 && primaryOutcome === undefined ? primaryTasks.map((task) => task.id) : [];
  const fixedCovered = [
    ...(summaryOutcome?.coveredUnitIds ?? []),
    ...(primaryOutcome?.coveredUnitIds ?? []),
  ];
  const fixedExecutionUncovered = [
    ...fixedInitialUncovered,
    ...fixedPromptFailures.keys(),
    ...primaryPromptUncovered,
    ...primaryNotScheduled,
    ...(primaryOutcome?.uncoveredUnitIds ?? []),
  ];
  const fixedReasonByUnit: Record<string, string> = {};
  for (const unit of workPlan.units) {
    if (unit.reason !== undefined) fixedReasonByUnit[unit.id] = unit.reason;
  }
  for (const [id, reason] of fixedPromptFailures) fixedReasonByUnit[id] = reason;
  for (const [id, reason] of primaryPromptFailures) fixedReasonByUnit[id] = reason;
  for (const [id, reason] of Object.entries(summaryOutcome?.reasonByUnit ?? {})) fixedReasonByUnit[id] = reason;
  for (const [id, reason] of Object.entries(primaryOutcome?.reasonByUnit ?? {})) fixedReasonByUnit[id] = reason;
  const coveredPlan = applyReviewWorkCoverage(workPlan, {
    coveredUnitIds: [...new Set(fixedCovered)],
    uncoveredUnitIds: [...new Set(fixedExecutionUncovered)],
    attemptedUnitIds: [
      ...(summaryOutcome?.attemptedUnitIds ?? []),
      ...(primaryOutcome?.attemptedUnitIds ?? []),
    ],
    attempts: {
      ...(summaryOutcome?.attempts ?? {}),
      ...(primaryOutcome?.attempts ?? {}),
    },
    reasonByUnit: fixedReasonByUnit,
  });

  const fixedFailureUnitIds = new Set<string>();
  const recordFixedFailure = (unit: ReviewWorkUnit, stage: ReviewStage, reason: string): void => {
    if (fixedFailureUnitIds.has(unit.id)) return;
    fixedFailureUnitIds.add(unit.id);
    failures.push({ stage, message: (unit.role === "summary" ? reason : `${unitAgentRole(unit) ?? unit.role}: ${reason}`).slice(0, 500) });
  };
  for (const [id, reason] of fixedPromptFailures) {
    const unit = workPlan.units.find((candidate) => candidate.id === id);
    if (unit) recordFixedFailure(unit, workUnitStage(unit), reason);
  }
  failures.push(...guidanceFailures);
  for (const [id, reason] of primaryPromptFailures) {
    const unit = workPlan.units.find((candidate) => candidate.id === id);
    if (unit) recordFixedFailure(unit, "finders", reason);
  }
  for (const result of primaryOutcome?.results ?? []) {
    if (result.status === "covered") continue;
    const unit = workPlan.units.find((candidate) => candidate.id === result.id);
    if (unit) recordFixedFailure(unit, "finders", result.reason ?? "fitting finder work was not covered");
  }
  for (const unit of coveredPlan.units) {
    if (unit.status === "uncovered") recordFixedFailure(unit, workUnitStage(unit), unit.reason ?? "fitting work unit was not covered");
  }
  const fixedSpent = (summaryOutcome?.spentWeight ?? 0) + (primaryOutcome?.spentWeight ?? 0);
  const usageFromOutcome = (outcome: ReviewScheduleOutcome<unknown> | undefined): void => {
    for (const result of outcome?.results ?? []) if (result.usage) usage.push(result.usage);
  };
  // Summary usage was recorded above; primary usage is recorded here in task
  // order so retry/failure usage remains visible and deterministic.
  usageFromOutcome(primaryOutcome);

  const changedLocations = collectChangedLocations(snapshot.diff);
  const primaryCandidates = deduplicateCandidates(
    filterCandidatesToChangedLines(
      (primaryOutcome?.results ?? []).flatMap((result) => {
        if (result.value === undefined) return [];
        const unit = workPlan.units.find((candidate) => candidate.id === result.id);
        const role = unit === undefined ? undefined : unitAgentRole(unit);
        if (role === undefined || role === "summary" || role === "validator") return [];
        return result.value.candidates
          .slice(0, plan.roles[role].candidateCap)
          .map((candidate, index) => candidateWithFinder(candidate, role, index));
      }),
      changedLocations,
    ),
  );
  let candidates = primaryCandidates;
  const unvalidated: ReviewCoverageCandidate[] = [];
  let aggregateCoverage = coveredPlan.coverage;
  let spentWeight = fixedSpent;

  // Small reviews get one candidate-triggered contextual unit. It is planned
  // with the same canonical diff unit as the fixed manifest, so only the
  // contextual weight is charged against the remaining request budget.
  if (route === "small") {
    const escalationCandidates = primaryCandidates.filter((candidate) => candidate.needsContext).slice(0, 1);
    if (escalationCandidates.length > 0) {
      const unspent = Math.max(0, workPlan.maxReviewWorkUnits - spentWeight);
      const remaining = Math.max(0, unspent - Math.min(unspent, Math.max(completionReserve, candidates.length)));
      const candidatePlan = planReviewWork(snapshot, {
        shards: [fittingShard],
        manifest: [
          { role: "diff-only-bug" },
          { role: "contextual-bug", trigger: "candidate" },
        ],
        maxReviewWorkUnits: Math.max(1, Math.min(MAX_REVIEW_WORK_UNITS, remaining + 1)),
        workLimitPolicy: workPlan.workLimitPolicy,
      });
      const syntheticDiffIds = candidatePlan.units.filter((unit) => unit.role === "diff").map((unit) => unit.id);
      const contextualUnits = candidatePlan.units.filter((unit) => unit.role === "contextual" && unit.status === "planned");
      const contextualUnit = contextualUnits[0];
      const candidatePromptFailures = new Map<string, string>();
      const candidateTasks: ReviewScheduleTask<FinderOutput>[] = [];
      if (contextualUnit !== undefined) {
        const escalationSnapshot = focusedSnapshot(snapshot, escalationCandidates);
        const escalationGuidance = relevantGuidance(reviewCwd, guidance, escalationCandidates);
        try {
          const invocation = roleInvocation(
            "contextual-bug",
            plan.roles["contextual-bug"],
            (inputBudgetBytes) => candidateFollowUpPrompt("contextual-bug", escalationSnapshot, escalationGuidance, promptContext, escalationCandidates, inputBudgetBytes),
            reviewCwd,
            dependencies,
          );
          candidateTasks.push({
            id: contextualUnit.id,
            weight: contextualUnit.weight,
            run: async (context) => runScheduledFinder(dependencies, invocation, validateContextualBug, context),
          });
        } catch (error) {
          candidatePromptFailures.set(contextualUnit.id, errorMessage(error));
        }
      }
      let candidateOutcome: ReviewScheduleOutcome<FinderOutput> | undefined;
      if (candidateTasks.length > 0 && remaining > 0) {
        candidateOutcome = await scheduleReviewWork(candidateTasks, { capacity: remaining, maxConcurrency: 4, ...(signal === undefined ? {} : { signal }) });
        usageFromOutcome(candidateOutcome);
      }
      const candidateUncovered = [
        ...candidatePlan.units.filter((unit) => unit.status === "uncovered" && !syntheticDiffIds.includes(unit.id)).map((unit) => unit.id),
        ...candidatePromptFailures.keys(),
        ...(candidateTasks.length > 0 && candidateOutcome === undefined ? candidateTasks.map((task) => task.id) : []),
        ...(candidateOutcome?.uncoveredUnitIds ?? []),
      ];
      const candidateReasons: Record<string, string> = {};
      for (const unit of candidatePlan.units) if (unit.reason) candidateReasons[unit.id] = unit.reason;
      for (const [id, reason] of candidatePromptFailures) candidateReasons[id] = reason;
      for (const [id, reason] of Object.entries(candidateOutcome?.reasonByUnit ?? {})) candidateReasons[id] = reason;
      const completedCandidatePlan = applyReviewWorkCoverage(candidatePlan, {
        coveredUnitIds: [...syntheticDiffIds, ...(candidateOutcome?.coveredUnitIds ?? [])],
        uncoveredUnitIds: [...new Set(candidateUncovered)],
        attemptedUnitIds: candidateOutcome?.attemptedUnitIds ?? [],
        attempts: candidateOutcome?.attempts ?? {},
        reasonByUnit: candidateReasons,
      });
      const candidateSpent = candidateOutcome?.spentWeight ?? 0;
      spentWeight += candidateSpent;
      aggregateCoverage = mergeCoverage(aggregateCoverage, completedCandidatePlan.coverage, spentWeight);
      const contextualFailure = completedCandidatePlan.units.find((unit) => unit.role === "contextual" && unit.status === "uncovered");
      if (contextualFailure !== undefined) {
        const reason = contextualFailure.reason ?? "candidate contextual follow-up was not covered";
        failures.push({ stage: "finders", message: `contextual-bug: ${reason}`.slice(0, 500) });
        for (const candidate of escalationCandidates) unvalidated.push(unvalidatedCandidate(candidate, reason));
      }
      for (const result of candidateOutcome?.results ?? []) {
        if (result.value === undefined) continue;
        for (const [index, candidate] of result.value.candidates.slice(0, plan.roles["contextual-bug"].candidateCap).entries()) {
          candidates.push(candidateWithFinder(candidate, "contextual-bug", index));
        }
      }
      candidates = deduplicateCandidates(filterCandidatesToChangedLines(candidates, changedLocations));
    }
  }

  const verdicts: VerifierOutput[] = [];
  const validatorTasks: ReviewScheduleTask<VerifierOutput>[] = [];
  const validatorByTask = new Map<string, ReviewCandidate>();
  for (const candidate of candidates) {
    try {
      const candidateGuidance = guidanceForPath(reviewCwd, guidance, candidate.file);
      const invocation = roleInvocation(
        "validator",
        plan.roles.validator,
        (inputBudgetBytes) => buildValidatorPrompt(candidate, snapshot, candidateGuidance, promptContext, {
          passLabel: "primary",
          source: snapshotValidatorSource(snapshot, candidate),
          inputBudgetBytes,
        }),
        reviewCwd,
        dependencies,
      );
      validatorByTask.set(candidate.id, candidate);
      validatorTasks.push({
        id: candidate.id,
        weight: 1,
        run: async (context) => runScheduledAgent(dependencies, invocation, (value) => validateVerifier(value, candidate.id), context),
      });
    } catch (error) {
      const reason = errorMessage(error);
      unvalidated.push(unvalidatedCandidate(candidate, reason));
      failures.push({ stage: "verification", message: `${candidate.id}: ${reason}`.slice(0, 500) });
    }
  }
  if (candidates.length > 0) progress(dependencies, "verification", `Starting candidate validation for ${candidates.length} finding${candidates.length === 1 ? "" : "s"}`);
  const validatorCapacity = Math.max(0, workPlan.maxReviewWorkUnits - spentWeight);
  let validatorOutcome: ReviewScheduleOutcome<VerifierOutput> | undefined;
  const rejectValidatorWave = workPlan.workLimitPolicy === "reject" && validatorTasks.length > validatorCapacity;
  if (validatorTasks.length > 0 && validatorCapacity > 0 && !rejectValidatorWave) {
    validatorOutcome = await scheduleReviewWork(validatorTasks, { capacity: validatorCapacity, maxConcurrency: 4, ...(signal === undefined ? {} : { signal }) });
    usageFromOutcome(validatorOutcome);
    for (const result of validatorOutcome.results) {
      if (result.status === "covered" && result.value !== undefined) verdicts.push(result.value);
      if (result.status !== "covered") {
        const candidate = validatorByTask.get(result.id);
        const reason = result.reason ?? "validator capacity was exhausted";
        if (candidate) unvalidated.push(unvalidatedCandidate(candidate, reason));
        failures.push({ stage: "verification", message: `${result.id}: ${reason}`.slice(0, 500) });
      }
    }
  } else {
    const reason = rejectValidatorWave ? "required validator work was rejected by the configured work limit" : "validator capacity was exhausted";
    for (const task of validatorTasks) {
      const candidate = validatorByTask.get(task.id);
      if (candidate) unvalidated.push(unvalidatedCandidate(candidate, reason));
      failures.push({ stage: "verification", message: `${task.id}: ${reason}`.slice(0, 500) });
    }
  }
  const validatorSpent = validatorOutcome?.spentWeight ?? 0;
  spentWeight += validatorSpent;
  const findings = filterVerifiedFindings(candidates, verdicts, { changedLocations, minimumConfidence: 85 }).slice(0, MAX_FINDINGS);
  let finalCoverage: ReviewCoverage = Object.freeze({
    ...aggregateCoverage,
    budgetMaxWeight: workPlan.maxReviewWorkUnits,
    budgetReservedWeight: 0,
    budgetSpentWeight: spentWeight,
    maxWeight: workPlan.maxReviewWorkUnits,
    reservedWeight: 0,
    spentWeight,
    budget: Object.freeze({ maxWeight: workPlan.maxReviewWorkUnits, reservedWeight: 0, spentWeight }),
  });
  if (unvalidated.length > 0) finalCoverage = coverageWithUnvalidated(finalCoverage, unvalidated, "one or more candidates were not validated");
  const statusCoverage = finalCoverage.state === "complete" && unvalidated.length === 0;
  if (candidates.length > 0) progress(dependencies, "verification", `Completed candidate validation with ${findings.length} retained finding${findings.length === 1 ? "" : "s"}`);
  if (!statusCoverage && failures.length === 0) failures.push({ stage: "finders", message: "Required fitting review coverage is incomplete." });
  return finalizeReview(snapshot, options, dependencies, signal, summary, findings, failures, usage, finalCoverage);
}
