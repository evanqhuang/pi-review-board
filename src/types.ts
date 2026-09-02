import type { ReviewEffort, ReviewThinking } from "./effort.js";
import type { ReviewerResultToolName, ReviewerSafeToolName } from "./reviewer-protocol.js";

export type ReviewTargetKind = "pull-request" | "current-diff" | "branch" | "path" | "worktree";

/** Bounded reviewer roles used by deterministic routing. */
export type ReviewRole =
  | "summary"
  | "guidance-a"
  | "guidance-b"
  | "diff-only-bug"
  | "contextual-bug"
  | "integration"
  | "validator";

export interface PullRequestMetadata {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly authorLogin: string;
  readonly url: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly repository: string;
  readonly changedPaths: readonly string[];
  readonly comments: readonly { readonly body: string; readonly authorLogin: string }[];
  readonly reviewerLogin?: string;
  readonly reviewerIdentityAvailable: boolean;
}

export type ReviewTarget =
  | { readonly kind: "pull-request"; readonly value: string; readonly metadata?: PullRequestMetadata }
  | { readonly kind: "current-diff" }
  | { readonly kind: "branch"; readonly ref: string }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "worktree"; readonly path: string };

export type ReviewPhase = "initial" | "delta" | "final";
export type ReviewDecision =
  | "awaiting-adjudication"
  | "approve"
  | "comment"
  | "request-changes"
  | "incomplete"
  | "blocked";

export interface ReviewContract {
  readonly guarantees: readonly string[];
  readonly nonGoals: readonly string[];
  readonly riskAreas: readonly string[];
  readonly requiredChecks: readonly string[];
  readonly source?: string;
}

export interface ReviewOptions {
  readonly cwd: string;
  readonly target: ReviewTarget;
  readonly comment: boolean;
  readonly effort: ReviewEffort;
  readonly phase?: ReviewPhase;
  readonly contract?: ReviewContract;
  readonly snapshot?: ReviewSnapshot;
  readonly openFindings?: readonly FindingLedgerEntry[];
}

export interface ReviewSnapshot {
  readonly target: ReviewTarget;
  readonly cwd: string;
  readonly changedPaths: readonly string[];
  readonly diff: string;
  readonly snapshotHash: string;
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly pullRequest?: PullRequestMetadata;
}

export type FindingCategory = "correctness" | "guidance" | "history" | "integration" | "contract";
export type FindingSeverity = "critical" | "high" | "medium" | "low";

export interface ReviewCandidate {
  readonly id: string;
  readonly rootCauseKey: string;
  readonly file: string;
  readonly line: number;
  readonly summary: string;
  readonly failureScenario: string;
  readonly evidence: string;
  readonly category: FindingCategory;
  readonly severity: FindingSeverity;
  /** Internal request to inspect the nearest direct context; never reportable by itself. */
  readonly needsContext: boolean;
  readonly finder: string;
}

export interface VerifiedFinding extends ReviewCandidate {
  readonly confidence: number;
  readonly verification: string;
}

export type ReviewStage =
  | "eligibility"
  | "guidance"
  | "summary"
  | "finders"
  | "verification"
  | "revalidation"
  | "comment";

export interface StageFailure {
  readonly stage: ReviewStage;
  readonly message: string;
}

export type FindingLedgerStatus =
  | "candidate"
  | "open"
  | "resolved"
  | "non-blocking"
  | "accepted-risk"
  | "product-decision"
  | "follow-up"
  | "not-reproducible";

export interface FindingLedgerEntry {
  readonly id: string;
  readonly rootCauseKey: string;
  readonly severity: FindingSeverity;
  readonly confidence: number;
  readonly status: FindingLedgerStatus;
  readonly firstObservedHead: string;
  readonly lastVerifiedHead: string;
  readonly introducedByDelta: boolean;
  readonly file: string;
  readonly line: number;
  readonly trigger: string;
  readonly impact: string;
  readonly contractBasis?: string;
  readonly evidence: string;
  readonly parentEvidence?: string;
}

export interface ReviewLedgerSummary {
  readonly sessionId: string;
  readonly implementationId?: string;
  readonly target: ReviewTarget;
  readonly targetIdentity: string;
  readonly phase: ReviewPhase | "approved" | "blocked";
  readonly decision: ReviewDecision;
  readonly baseSha: string;
  readonly lastReviewedHead?: string;
  readonly lastReviewedSnapshotHash?: string;
  readonly completedPasses: number;
  readonly remediationBatches: number;
  readonly incompleteAttemptsThisPhase: number;
  readonly awaitingAdjudication: boolean;
  readonly findings: readonly FindingLedgerEntry[];
}

export interface ReviewResult {
  readonly effort: ReviewEffort;
  readonly status: "complete" | "ineligible" | "incomplete";
  readonly summary: string;
  readonly findings: readonly VerifiedFinding[];
  readonly failures: readonly StageFailure[];
  readonly report: string;
  readonly commented: boolean | "unknown";
  readonly usage: readonly AgentUsage[];
  readonly phase?: ReviewPhase;
  readonly decision?: ReviewDecision;
  readonly sessionId?: string;
  readonly reviewedSnapshotHash?: string;
  readonly ledger?: ReviewLedgerSummary;
}

export interface AgentUsage {
  readonly role: string;
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly contextTokens: number;
}

export type ReviewerFailureKind =
  | "missing-result"
  | "malformed-result"
  | "duplicate-result"
  | "wrong-result"
  | "validation"
  | "canceled"
  | "output-limit"
  | "turn-limit"
  | "context-limit"
  | "compaction"
  | "spawn"
  | "transport"
  | "process";

export type ReviewerProgressEvent =
  | {
      readonly type: "reviewer-start";
      readonly role: string;
      readonly resultTool: ReviewerResultToolName;
      readonly attempt: number;
    }
  | {
      readonly type: "reviewer-turn";
      readonly role: string;
      readonly attempt: number;
      readonly usage: AgentUsage;
    }
  | {
      readonly type: "reviewer-tool";
      readonly role: string;
      readonly attempt: number;
      readonly tool: ReviewerSafeToolName | "other";
      readonly status: "started" | "updated" | "completed";
    }
  | {
      readonly type: "reviewer-retry";
      readonly role: string;
      readonly attempt: number;
      readonly usage: AgentUsage;
    }
  | {
      readonly type: "reviewer-complete";
      readonly role: string;
      readonly attempt: number;
      readonly usage: AgentUsage;
    }
  | {
      readonly type: "reviewer-failed";
      readonly role: string;
      readonly attempt: number;
      readonly kind: ReviewerFailureKind;
      readonly usage: AgentUsage;
    };

export type ReviewProgressEvent =
  | { readonly type: "stage"; readonly stage: ReviewStage; readonly message: string }
  | ReviewerProgressEvent;

export interface AgentInvocation {
  readonly role: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly resultTool: ReviewerResultToolName;
  /** Maximum model turns allowed for this isolated reviewer process. */
  readonly maxTurns: number;
  /** Maximum provider-reported context usage allowed for this reviewer. */
  readonly contextBudget: number;
  readonly model?: string;
  readonly thinking: ReviewThinking;
}

export interface AgentResult<T> {
  readonly data: T;
  readonly usage: AgentUsage;
}

export interface ReviewAgentRunner {
  run<T>(
    invocation: AgentInvocation,
    validate: (value: unknown) => T,
    signal?: AbortSignal,
    onProgress?: (event: ReviewerProgressEvent) => void,
  ): Promise<AgentResult<T>>;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly canceled?: boolean;
  readonly truncated?: boolean;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options: { cwd: string; signal?: AbortSignal | undefined }): Promise<CommandResult>;
}

export interface ReviewDependencies {
  readonly commands: CommandRunner;
  readonly agents: ReviewAgentRunner;
  readonly reviewerModel?: string;
  readonly onProgress?: (event: ReviewProgressEvent) => void;
}
