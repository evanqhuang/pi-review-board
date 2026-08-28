import { discoverApplicableGuidance, type GuidanceFile } from "./guidance.js";
import { getReviewEffortConfig } from "./effort.js";
import {
  collectChangedLocations,
  deduplicateCandidates,
  filterCandidatesToChangedLines,
  filterVerifiedFindings,
  formatPrComment,
  formatReviewReport,
  promoteDirectFindings,
} from "./output.js";
import {
  buildEligibilityPrompt,
  buildFinderPrompt,
  buildSummaryPrompt,
  buildBatchVerifierPrompt,
  FINDER_LENSES,
  GAP_SWEEP_LENS,
  validateEligibility,
  validateFinder,
  validateSummary,
  validateBatchVerifier,
  type FinderLens,
  type FinderOutput,
  type SummaryOutput,
} from "./prompts.js";
import {
  captureReviewSnapshot,
  hasExistingReview,
  hasSnapshotDrift,
  isLikelyAutomatedPullRequest,
} from "./targets.js";
import type {
  AgentInvocation,
  AgentResult,
  ReviewCandidate,
  ReviewDependencies,
  ReviewOptions,
  ReviewResult,
  ReviewSnapshot,
  ReviewStage,
  StageFailure,
  VerifiedFinding,
} from "./types.js";

const REVIEW_TOOLS = ["read", "grep", "find", "ls"] as const;

type FinderPassResult = { readonly lens: FinderLens; readonly result?: AgentResult<FinderOutput> };

function progress(dependencies: ReviewDependencies, stage: ReviewStage, message: string): void {
  dependencies.onProgress?.(stage, message);
}

function runAgent<T>(
  dependencies: ReviewDependencies,
  stage: ReviewStage,
  invocation: AgentInvocation,
  validate: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<AgentResult<T>> {
  const configuredInvocation = dependencies.reviewerModel
    ? { ...invocation, model: dependencies.reviewerModel }
    : invocation;
  return dependencies.agents.run(configuredInvocation, validate, signal, (message) => progress(dependencies, stage, message));
}

function resultWithoutSnapshot(status: ReviewResult["status"], message: string, effort: ReviewOptions["effort"]): ReviewResult {
  return {
    effort,
    status,
    summary: message,
    findings: [],
    failures: [{ stage: "eligibility", message }],
    report: `### Code review\n\n${status === "ineligible" ? "Not reviewed" : "Review could not start"}: ${message}`,
    commented: false,
    usage: [],
  };
}

function candidateWithFinder(candidate: FinderOutput["candidates"][number], finder: string, index: number): ReviewCandidate {
  return {
    ...candidate,
    id: `${finder}:${candidate.id}:${index}`,
    finder,
  };
}

function stageFailure(stage: StageFailure["stage"], error: unknown): StageFailure {
  return { stage, message: error instanceof Error ? error.message : String(error) };
}

function completedResult(
  snapshot: ReviewSnapshot,
  effort: ReviewOptions["effort"],
  status: ReviewResult["status"],
  summary: string,
  findings: readonly VerifiedFinding[],
  failures: readonly StageFailure[],
  usage: readonly AgentResult<unknown>["usage"][],
  commented: boolean | "unknown",
): ReviewResult {
  return {
    effort,
    status,
    summary,
    findings,
    failures,
    report: formatReviewReport(snapshot, status, summary, findings, failures),
    commented,
    usage,
  };
}

function reviewAlreadyPerformed(snapshot: ReviewSnapshot): boolean {
  return snapshot.pullRequest ? hasExistingReview(snapshot.pullRequest) : false;
}

export async function runCodeReview(options: ReviewOptions, dependencies: ReviewDependencies, signal?: AbortSignal): Promise<ReviewResult> {
  const effortConfig = getReviewEffortConfig(options.effort);
  let snapshot: ReviewSnapshot;
  try {
    progress(dependencies, "eligibility", "Capturing immutable review snapshot");
    snapshot = await captureReviewSnapshot(options.target, options.cwd, dependencies.commands, signal);
  } catch (error) {
    return resultWithoutSnapshot("incomplete", error instanceof Error ? error.message : String(error), options.effort);
  }
  const reviewCwd = snapshot.cwd;

  if (snapshot.changedPaths.length === 0 || snapshot.diff.trim().length === 0) {
    return completedResult(snapshot, options.effort, "ineligible", "No changed files were found in the requested target.", [], [], [], false);
  }

  const failures: StageFailure[] = [];
  const usage: AgentResult<unknown>["usage"][] = [];

  if (snapshot.pullRequest) {
    const pullRequest = snapshot.pullRequest;
    if (pullRequest.state.toUpperCase() !== "OPEN") return completedResult(snapshot, options.effort, "ineligible", "The pull request is not open.", [], [], [], false);
    if (pullRequest.isDraft) return completedResult(snapshot, options.effort, "ineligible", "The pull request is a draft.", [], [], [], false);
    if (isLikelyAutomatedPullRequest(pullRequest)) return completedResult(snapshot, options.effort, "ineligible", "The pull request appears to be automated.", [], [], [], false);
    if (reviewAlreadyPerformed(snapshot)) return completedResult(snapshot, options.effort, "ineligible", "A code review comment already exists on this pull request.", [], [], [], false);
    if (options.comment && !pullRequest.reviewerIdentityAvailable) {
      failures.push({ stage: "eligibility", message: "Could not verify the current reviewer identity; publishing is disabled to avoid duplicate comments." });
    }
  }

  if (snapshot.pullRequest) {
    progress(dependencies, "eligibility", "Checking whether the change needs review");
    try {
      const eligibility = await runAgent(
        dependencies,
        "eligibility",
        {
          role: "eligibility",
          prompt: buildEligibilityPrompt(snapshot.pullRequest),
          cwd: reviewCwd,
          tools: ["read", "grep", "find", "ls"],
          model: effortConfig.finderRoute.model,
          thinking: effortConfig.finderRoute.thinking,
        },
        validateEligibility,
        signal,
      );
      usage.push(eligibility.usage);
      if (!eligibility.data.proceed) return completedResult(snapshot, options.effort, "ineligible", eligibility.data.reason, [], failures, usage, false);
    } catch (error) {
      failures.push(stageFailure("eligibility", error));
    }
  }

  progress(dependencies, "guidance", "Loading applicable repository guidance");
  const guidanceDiscovery = discoverApplicableGuidance(reviewCwd, snapshot.changedPaths);
  const guidance: readonly GuidanceFile[] = guidanceDiscovery.files;
  failures.push(...guidanceDiscovery.failures.map((message) => ({ stage: "guidance" as const, message })));

  let summary = "Direct changed-line pass; no summary pass was requested.";
  if (effortConfig.includeSummary) {
    progress(dependencies, "summary", "Summarizing the change");
    try {
      const summaryResult = await runAgent<SummaryOutput>(
        dependencies,
        "summary",
        {
          role: "summary",
          prompt: buildSummaryPrompt(snapshot, guidance),
          cwd: reviewCwd,
          tools: REVIEW_TOOLS,
          model: effortConfig.finderRoute.model,
          thinking: effortConfig.finderRoute.thinking,
        },
        validateSummary,
        signal,
      );
      usage.push(summaryResult.usage);
      summary = summaryResult.data.summary;
    } catch (error) {
      failures.push(stageFailure("summary", error));
    }
  }

  const finderLenses = effortConfig.finderLensNames.map((name) => FINDER_LENSES.find((lens) => lens.name === name)).filter((lens): lens is FinderLens => lens !== undefined);
  if (finderLenses.length !== effortConfig.finderLensNames.length) {
    failures.push({ stage: "finders", message: "The configured effort level references an unavailable review pass." });
  }

  progress(dependencies, "finders", `Running ${finderLenses.length}${effortConfig.gapSweep ? " plus a gap sweep" : ""} independent review passes`);
  const runFinderPass = async (lens: FinderLens): Promise<FinderPassResult> => {
    try {
      const result = await runAgent<FinderOutput>(
        dependencies,
        "finders",
        {
          role: `finder:${lens.name}`,
          prompt: buildFinderPrompt(lens, snapshot, guidance, summary, { contextDepth: effortConfig.contextDepth }),
          cwd: reviewCwd,
          tools: REVIEW_TOOLS,
          model: effortConfig.finderRoute.model,
          thinking: effortConfig.finderRoute.thinking,
        },
        validateFinder,
        signal,
      );
      return { lens, result };
    } catch (error) {
      failures.push(stageFailure("finders", `${lens.name}: ${error instanceof Error ? error.message : String(error)}`));
      return { lens };
    }
  };

  const finderResults = await Promise.all(finderLenses.map((lens) => runFinderPass(lens)));
  if (effortConfig.gapSweep) finderResults.push(await runFinderPass(GAP_SWEEP_LENS));

  const changedLocations = collectChangedLocations(snapshot.diff);
  const candidates = deduplicateCandidates(
    filterCandidatesToChangedLines(
      finderResults.flatMap(({ lens, result }) => result?.data.candidates.slice(0, effortConfig.maxCandidatesPerFinder).map((candidate, index) => candidateWithFinder(candidate, lens.name, index)) ?? []),
      changedLocations,
    ),
  );
  usage.push(...finderResults.flatMap(({ result }) => (result ? [result.usage] : [])));

  const verifyCandidateBatch = async (items: readonly ReviewCandidate[], passLabel: string): Promise<VerifiedFinding[]> => {
    if (items.length === 0) return [];
    const candidateIds = new Set(items.map((candidate) => candidate.id));
    try {
      const result = await runAgent(
        dependencies,
        "verification",
        {
          role: passLabel,
          prompt: buildBatchVerifierPrompt(items, snapshot, guidance, summary, { contextDepth: effortConfig.contextDepth, passLabel }),
          cwd: reviewCwd,
          tools: REVIEW_TOOLS,
          model: effortConfig.verifierRoute.model,
          thinking: effortConfig.verifierRoute.thinking,
        },
        (value) => validateBatchVerifier(value, candidateIds),
        signal,
      );
      usage.push(result.usage);
      return filterVerifiedFindings(items, result.data.verifications, {
        changedLocations,
        minimumConfidence: effortConfig.minimumConfidence,
        retainPlausible: effortConfig.retainPlausible,
      }).slice(0, effortConfig.maxFindings);
    } catch (error) {
      failures.push(stageFailure("verification", `${passLabel}: ${error instanceof Error ? error.message : String(error)}`));
      return [];
    }
  };

  let findings: VerifiedFinding[] = effortConfig.verifyCandidates
    ? await verifyCandidateBatch(candidates, "verifier")
    : promoteDirectFindings(candidates.slice(0, effortConfig.maxFindings), "Direct changed-line pass; candidate verification was skipped.");

  if (effortConfig.independentVerification && findings.length > 0) {
    progress(dependencies, "verification", `Running an independent final verification pass for ${findings.length} finding${findings.length === 1 ? "" : "s"}`);
    const findingIds = new Set(findings.map((finding) => finding.id));
    findings = await verifyCandidateBatch(candidates.filter((candidate) => findingIds.has(candidate.id)), "independent-verifier");
  }

  progress(dependencies, "revalidation", "Checking that the reviewed target did not change");
  try {
    if (await hasSnapshotDrift(snapshot, dependencies.commands, signal)) {
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
  return completedResult(snapshot, options.effort, finalStatus, summary, findings, failures, usage, commented);
}
