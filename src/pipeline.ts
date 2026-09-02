import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { guidanceCoversPath, guidanceForPath, discoverApplicableGuidance, type GuidanceFile } from "./guidance.js";
import { REVIEWER_RESULT_TOOLS } from "./reviewer-protocol.js";
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
  type VerifierOutput,
} from "./prompts.js";
import { loadReviewConfig } from "./config.js";
import { routeReview, type ReviewRoleConfig } from "./routing.js";
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
import type {
  AgentInvocation,
  AgentResult,
  ReviewCandidate,
  ReviewContract,
  ReviewDependencies,
  ReviewOptions,
  ReviewResult,
  ReviewRole,
  ReviewSnapshot,
  ReviewStage,
  StageFailure,
  VerifiedFinding,
} from "./types.js";

const VALIDATOR_CONCURRENCY = 4;
const MAX_FINDINGS = 5;
const VALIDATOR_SOURCE_WINDOW = 20;
const MAX_VALIDATOR_SOURCE_LINES = VALIDATOR_SOURCE_WINDOW * 2 + 1;
const MAX_VALIDATOR_SOURCE_BYTES = 16 * 1024;
const MAX_VALIDATOR_SOURCE_READ_BYTES = 256 * 1024;

function progress(dependencies: ReviewDependencies, stage: ReviewStage, message: string): void {
  dependencies.onProgress?.({ type: "stage", stage, message });
}

function usageFromError(error: unknown): AgentResult<unknown>["usage"] | undefined {
  return error instanceof ReviewerRunError ? error.usage : undefined;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 500);
}

function runAgent<T>(
  dependencies: ReviewDependencies,
  invocation: AgentInvocation,
  validate: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<AgentResult<T>> {
  // The parent may select a provider model, but cannot change a routed role's
  // tools, thinking, turn allowance, or context budget.
  const configuredInvocation = dependencies.reviewerModel
    ? { ...invocation, model: dependencies.reviewerModel }
    : invocation;
  return dependencies.agents.run(configuredInvocation, validate, signal, (event) => dependencies.onProgress?.(event));
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
): ReviewResult {
  return {
    effort: options.effort,
    status,
    summary,
    findings,
    failures,
    report: formatReviewReport(snapshot, status, summary, findings, failures),
    commented,
    usage,
    reviewedSnapshotHash: snapshot.snapshotHash,
    ...(options.phase ? { phase: options.phase } : {}),
  };
}

function candidateWithFinder(candidate: FinderOutput["candidates"][number], finder: ReviewRole, index: number): ReviewCandidate {
  return {
    ...candidate,
    id: `${finder}:${candidate.rootCauseKey}:${index}`,
    finder,
  };
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
): string | undefined {
  if (!Number.isInteger(candidate.line) || candidate.line < 1) return undefined;
  const root = resolve(cwd);
  const requested = resolve(root, candidate.file);
  if (!isWithinRoot(root, requested)) return undefined;

  let sourcePath: string;
  try {
    const realRoot = realpathSync(root);
    sourcePath = realpathSync(requested);
    if (!isWithinRoot(realRoot, sourcePath) || !statSync(sourcePath).isFile()) return undefined;
  } catch {
    return undefined;
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
      return undefined;
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
    return rendered.length > 0 ? rendered.join("\n") : undefined;
  } catch {
    return undefined;
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

function roleInvocation(
  role: ReviewRole,
  rolePlan: ReviewRoleConfig,
  prompt: string,
  cwd: string,
): AgentInvocation {
  return {
    role,
    prompt,
    cwd,
    tools: rolePlan.tools,
    resultTool: resultToolFor(role),
    model: rolePlan.modelRoute.model,
    thinking: rolePlan.modelRoute.thinking,
    maxTurns: rolePlan.maxTurns,
    contextBudget: rolePlan.contextBudget,
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

interface FinderPassResult {
  readonly role: Exclude<ReviewRole, "summary" | "validator">;
  readonly result?: AgentResult<FinderOutput>;
  readonly failure?: StageFailure;
  readonly usage?: AgentResult<unknown>["usage"];
}

export async function runCodeReview(options: ReviewOptions, dependencies: ReviewDependencies, signal?: AbortSignal): Promise<ReviewResult> {
  let snapshot: ReviewSnapshot;
  try {
    progress(dependencies, "eligibility", options.snapshot ? "Using immutable supplied review snapshot" : "Capturing immutable review snapshot");
    snapshot = options.snapshot ?? await captureReviewSnapshot(options.target, options.cwd, dependencies.commands, signal);
  } catch (error) {
    return resultWithoutSnapshot("incomplete", errorMessage(error), options);
  }
  const reviewCwd = snapshot.cwd;

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
  const promptSummaryRequired = route === "normal" || route === "deep";
  let summary = "";
  if (promptSummaryRequired) {
    progress(dependencies, "summary", "Summarizing the change");
    try {
      const rolePlan = plan.roles.summary;
      const summaryResult = await runAgent(
        dependencies,
        roleInvocation("summary", rolePlan, buildSummaryPrompt(snapshot), reviewCwd),
        validateSummary,
        signal,
      );
      usage.push(summaryResult.usage);
      summary = summaryResult.data.summary;
    } catch (error) {
      const failedUsage = usageFromError(error);
      if (failedUsage) usage.push(failedUsage);
      failures.push(stageFailure("summary", error));
    }
  }
  const promptContext = appendReviewContext(summary, options);

  let guidance: readonly GuidanceFile[] = [];
  const guidanceSelected = plan.activeRoles.includes("guidance-a") || plan.activeRoles.includes("guidance-b");
  if (guidanceSelected) {
    progress(dependencies, "guidance", "Loading applicable repository guidance");
    const guidanceDiscovery = discoverApplicableGuidance(reviewCwd, snapshot.changedPaths);
    guidance = guidanceDiscovery.files;
    failures.push(...guidanceDiscovery.failures.map((message) => ({ stage: "guidance" as const, message: message.slice(0, 500) })));
  }
  const guidanceByPath = [...new Set(snapshot.changedPaths)]
    .sort()
    .map((path) => ({ path, guidance: guidanceForPath(reviewCwd, guidance, path) }));

  const primaryRoles = plan.activeRoles.filter((role): role is Exclude<ReviewRole, "summary" | "validator"> => role !== "summary" && role !== "validator");
  progress(dependencies, "finders", `Running ${primaryRoles.join(", ")} in parallel`);
  const runFinderPass = async (role: Exclude<ReviewRole, "summary" | "validator">): Promise<FinderPassResult> => {
    let prompt: string;
    switch (role) {
      case "guidance-a":
      case "guidance-b":
        prompt = buildGuidancePrompt(snapshot, guidanceByPath, promptContext);
        break;
      case "diff-only-bug":
        prompt = buildDiffOnlyBugPrompt(snapshot, guidance, promptContext);
        break;
      case "contextual-bug":
        prompt = buildContextualBugPrompt(snapshot, guidance, promptContext);
        break;
      case "integration":
        prompt = buildIntegrationPrompt(snapshot, guidance, promptContext);
        break;
    }
    try {
      const result = await runAgent(
        dependencies,
        roleInvocation(role, plan.roles[role], prompt, reviewCwd),
        finderValidator(role),
        signal,
      );
      return { role, result };
    } catch (error) {
      const failedUsage = usageFromError(error);
      return {
        role,
        failure: stageFailure("finders", `${role}: ${errorMessage(error)}`),
        ...(failedUsage ? { usage: failedUsage } : {}),
      };
    }
  };

  const finderResults = await Promise.all(primaryRoles.map((role) => runFinderPass(role)));
  failures.push(...finderResults.flatMap(({ failure }) => failure ? [failure] : []));
  usage.push(...finderResults.flatMap(({ result, usage: failedUsage }) => result ? [result.usage] : failedUsage ? [failedUsage] : []));

  const changedLocations = collectChangedLocations(snapshot.diff);
  const primaryCandidates = deduplicateCandidates(
    filterCandidatesToChangedLines(
      finderResults.flatMap(({ role, result }) => result?.data.candidates
        .slice(0, plan.roles[role].candidateCap)
        .map((candidate, index) => candidateWithFinder(candidate, role, index)) ?? []),
      changedLocations,
    ),
  );

  let candidates = primaryCandidates;
  // Small reviews get one bounded escalation only, and only for concrete
  // changed-line candidates that explicitly requested nearest context.
  if (route === "small") {
    const escalationCandidates = primaryCandidates.filter((candidate) => candidate.needsContext);
    if (escalationCandidates.length > 0) {
      const escalationSnapshot = focusedSnapshot(snapshot, escalationCandidates);
      const escalationGuidance = relevantGuidance(reviewCwd, guidance, escalationCandidates);
      const escalationPrompt = [
        buildContextualBugPrompt(escalationSnapshot, escalationGuidance, promptContext),
        "Contextual escalation candidates (inspect only these concrete suspicions):",
        JSON.stringify({ candidates: escalationCandidates, relevantChangedPaths: escalationSnapshot.changedPaths }),
      ].join("\n");
      try {
        const result = await runAgent(
          dependencies,
          roleInvocation("contextual-bug", plan.roles["contextual-bug"], escalationPrompt, reviewCwd),
          validateContextualBug,
          signal,
        );
        usage.push(result.usage);
        const escalated = result.data.candidates
          .slice(0, plan.roles["contextual-bug"].candidateCap)
          .map((candidate, index) => candidateWithFinder(candidate, "contextual-bug", index));
        candidates = deduplicateCandidates(filterCandidatesToChangedLines([...primaryCandidates, ...escalated], changedLocations));
      } catch (error) {
        const failedUsage = usageFromError(error);
        if (failedUsage) usage.push(failedUsage);
        failures.push(stageFailure("finders", `contextual-bug escalation: ${errorMessage(error)}`));
      }
    }
  }

  const verifyCandidates = async (items: readonly ReviewCandidate[]): Promise<VerifiedFinding[]> => {
    if (items.length === 0) return [];
    progress(dependencies, "verification", `Starting candidate validation for ${items.length} finding${items.length === 1 ? "" : "s"}`);
    const verdicts: Array<VerifierOutput | undefined> = new Array(items.length);
    const failed: Array<StageFailure | undefined> = new Array(items.length);
    const usages: Array<AgentResult<unknown>["usage"] | undefined> = new Array(items.length);
    let next = 0;

    const validateOne = async (): Promise<void> => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        const candidate = items[index]!;
        try {
          const candidateGuidance = guidanceForPath(reviewCwd, guidance, candidate.file);
          const source = collectValidatorSource(reviewCwd, candidate);
          const result = await runAgent(
            dependencies,
            roleInvocation(
              "validator",
              plan.roles.validator,
              buildValidatorPrompt(candidate, snapshot, candidateGuidance, promptContext, { passLabel: "primary", source }),
              reviewCwd,
            ),
            (value) => validateVerifier(value, candidate.id),
            signal,
          );
          verdicts[index] = result.data;
          usages[index] = result.usage;
        } catch (error) {
          const failedUsage = usageFromError(error);
          failed[index] = stageFailure("verification", `${candidate.id}: ${errorMessage(error)}`);
          usages[index] = failedUsage;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(VALIDATOR_CONCURRENCY, items.length) }, () => validateOne()));
    usage.push(...usages.flatMap((item) => item ? [item] : []));
    failures.push(...failed.flatMap((item) => item ? [item] : []));
    // Verdict slots are filled by candidate index, not promise-completion
    // order; the shared filter then applies its deterministic display order.
    const verified = filterVerifiedFindings(items, verdicts.flatMap((item) => item ? [item] : []), {
      changedLocations,
      minimumConfidence: 85,
    }).slice(0, MAX_FINDINGS);
    progress(dependencies, "verification", `Completed candidate validation with ${verified.length} retained finding${verified.length === 1 ? "" : "s"}`);
    return verified;
  };

  const findings = await verifyCandidates(candidates);

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

  const status: ReviewResult["status"] = failures.length > 0 ? "incomplete" : "complete";
  let commented: boolean | "unknown" = false;
  if (options.comment && snapshot.pullRequest && status === "complete") {
    progress(dependencies, "comment", "Rechecking the target immediately before publishing");
    try {
      const publishSnapshot = await captureReviewSnapshot(snapshot.target, reviewCwd, dependencies.commands, signal);
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
            { cwd: reviewCwd, signal },
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

  const finalStatus: ReviewResult["status"] = failures.length > 0 ? "incomplete" : "complete";
  return completedResult(snapshot, options, finalStatus, summary, findings, failures, usage, commented);
}
