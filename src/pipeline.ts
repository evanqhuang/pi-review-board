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
  buildFinderPrompt,
  buildSummaryPrompt,
  buildBatchVerifierPrompt,
  FINDER_LENSES,
  GAP_SWEEP_LENS,
  validateFinder,
  validateSummary,
  validateBatchVerifier,
  type FinderLens,
  type FinderOutput,
  type SummaryOutput,
} from "./prompts.js";
import {
  captureReviewSnapshot,
  hasSnapshotDrift,
  isLikelyAutomatedPullRequest,
} from "./targets.js";
import type {
  AgentInvocation,
  AgentResult,
  ReviewCandidate,
  ReviewContract,
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

function candidateWithFinder(candidate: FinderOutput["candidates"][number], finder: string, index: number): ReviewCandidate {
  return {
    ...candidate,
    id: `${finder}:${candidate.rootCauseKey}:${index}`,
    finder,
  };
}

function stageFailure(stage: StageFailure["stage"], error: unknown): StageFailure {
  return { stage, message: error instanceof Error ? error.message : String(error) };
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

function bounded(items: readonly string[], limit = 20): string[] {
  return items.slice(0, limit).map((item) => item.trim().slice(0, 500)).filter(Boolean);
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

export async function runCodeReview(options: ReviewOptions, dependencies: ReviewDependencies, signal?: AbortSignal): Promise<ReviewResult> {
  const effortConfig = getReviewEffortConfig(options.effort);
  let snapshot: ReviewSnapshot;
  try {
    progress(dependencies, "eligibility", options.snapshot ? "Using immutable supplied review snapshot" : "Capturing immutable review snapshot");
    snapshot = options.snapshot ?? await captureReviewSnapshot(options.target, options.cwd, dependencies.commands, signal);
  } catch (error) {
    return resultWithoutSnapshot("incomplete", error instanceof Error ? error.message : String(error), options);
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
    if (isLikelyAutomatedPullRequest(pullRequest)) return completedResult(snapshot, options, "ineligible", "The pull request appears to be automated.", [], [], [], false);
    if (options.comment && !pullRequest.reviewerIdentityAvailable) {
      failures.push({ stage: "eligibility", message: "Could not verify the current reviewer identity; publishing is disabled." });
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
  summary = appendReviewContext(summary, options);

  const finderLenses = effortConfig.finderLensNames
    .map((name) => FINDER_LENSES.find((lens) => lens.name === name))
    .filter((lens): lens is FinderLens => lens !== undefined);
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
        (value) => validateFinder(Array.isArray(value) ? { candidates: value } : value),
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
      finderResults.flatMap(({ lens, result }) => result?.data.candidates
        .slice(0, effortConfig.maxCandidatesPerFinder)
        .map((candidate, index) => candidateWithFinder(candidate, lens.name, index)) ?? []),
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
