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

export type WorkLimitPolicy = "reject" | "partial";

/** The roles which consume review work units.  These are intentionally
 * separate from the agent-facing roles: one contextual or integration pass
 * may cost more than a diff-local pass. */
export type ReviewWorkRole = "summary" | "diff" | "guidance" | "contextual" | "integration" | "validator";

/**
 * A work obligation may use either the canonical unit role or one of the
 * agent-facing roles.  The latter are mapped to canonical units by the work
 * planner, while retaining their distinction on the resulting unit.
 */
export type ReviewWorkManifestRole = ReviewWorkRole | ReviewRole;
export type ReviewWorkTrigger = "always" | "risk" | "candidate";

export interface ReviewWorkObligation {
  readonly role: ReviewWorkManifestRole;
  /** Restrict a per-shard role to these shard identities. */
  readonly shardIds?: readonly string[];
  /** Ergonomic singular/plural aliases accepted by manifest callers. */
  readonly shardId?: string;
  readonly shards?: readonly string[];
  /** False omits an otherwise declared conditional obligation. */
  readonly applicable?: boolean;
  readonly enabled?: boolean;
  readonly required?: boolean;
  /** Describes why conditional work was included; it does not select work. */
  readonly trigger?: ReviewWorkTrigger;
  readonly when?: ReviewWorkTrigger;
  readonly applicability?: ReviewWorkTrigger;
}

export interface ReviewWorkManifestSelectionOptions {
  readonly shardIds?: readonly string[];
  readonly shardId?: string;
  readonly shards?: readonly string[];
  readonly applicable?: boolean;
  readonly enabled?: boolean;
  readonly required?: boolean;
  readonly trigger?: ReviewWorkTrigger;
  readonly when?: ReviewWorkTrigger;
  readonly applicability?: ReviewWorkTrigger;
}

export type ReviewWorkManifestSelection =
  | boolean
  | readonly string[]
  | ReviewWorkManifestSelectionOptions;

export interface ReviewWorkManifestObject {
  readonly obligations: readonly ReviewWorkObligation[];
}

/** A list is the preferred form; the mapping form is convenient for callers. */
export type ReviewWorkManifest =
  | readonly ReviewWorkObligation[]
  | ReviewWorkManifestObject
  | Readonly<Partial<Record<ReviewWorkManifestRole, ReviewWorkManifestSelection>>>;

export const REVIEW_WORK_POLICY_VERSION = 1;
export const REVIEW_WORK_POLICY = "bounded-sharded-review";
export const DEFAULT_MAX_REVIEW_WORK_UNITS = 128;
export const MAX_REVIEW_WORK_UNITS = 128;
export const DEFAULT_WORK_LIMIT_POLICY: WorkLimitPolicy = "reject";

export const REVIEW_WORK_UNIT_WEIGHTS: Readonly<Record<ReviewWorkRole, number>> = Object.freeze({
  summary: 1,
  diff: 1,
  guidance: 1,
  validator: 1,
  contextual: 2,
  integration: 2,
});

/** Weights for the existing agent-facing role names. */
export const REVIEW_ROLE_WEIGHTS: Readonly<Record<ReviewRole, number>> = Object.freeze({
  summary: 1,
  "guidance-a": 1,
  "guidance-b": 1,
  "diff-only-bug": 1,
  "contextual-bug": 2,
  integration: 2,
  validator: 1,
});

/** Return the deterministic cost of a work role. */
export function reviewWorkUnitWeight(role: ReviewWorkRole): number {
  return REVIEW_WORK_UNIT_WEIGHTS[role];
}

/** Return the deterministic cost of an existing agent-facing role. */
export function reviewRoleWeight(role: ReviewRole): number {
  return REVIEW_ROLE_WEIGHTS[role];
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
  /** Maximum weighted review work units; CLI/default resolution happens later. */
  readonly maxReviewWorkUnits?: number;
  readonly workLimitPolicy?: WorkLimitPolicy;
  /** Optional selective work manifest for the review planner. */
  readonly manifest?: ReviewWorkManifest;
  readonly reviewWorkManifest?: ReviewWorkManifest;
  readonly reviewWorkObligations?: ReviewWorkManifest;
}

export interface ReviewSnapshot {
  readonly target: ReviewTarget;
  /** Original repository identity; never replaced with a temporary source root. */
  readonly cwd: string;
  /** Invocation-local source root pinned to the captured revision for PR reviews. */
  readonly sourceCwd?: string;
  /** Complete review scope, retained when changedPaths describes a local excerpt. */
  readonly reviewChangedPaths?: readonly string[];
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

/** Bounded, additive persistence for the most recent managed attempt. */
export interface ReviewLedgerAttempt {
  /** Version of this optional attempt record; absent on pre-coverage ledgers. */
  readonly version: 1;
  /** Snapshot identity expected by the managed lifecycle for this attempt. */
  readonly snapshotHash: string;
  readonly coverage: ReviewCoverage;
  readonly findings: readonly VerifiedFinding[];
  readonly failures: readonly StageFailure[];
  readonly usage: readonly AgentUsage[];
  /** Why this coverage cannot authorize approval, when it cannot. */
  readonly validationIssues?: readonly string[];
}

export interface ReviewCoverageValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
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
  /** Last attempt coverage. Legacy v2 ledgers are represented as unknown at runtime. */
  readonly coverage?: ReviewCoverage;
  readonly coverageValidation?: ReviewCoverageValidation;
  readonly workLimitPolicy?: WorkLimitPolicy;
  readonly lastAttempt?: ReviewLedgerAttempt;
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
  /** Deterministic work and diff coverage for this review attempt. */
  readonly coverage?: ReviewCoverage;
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
  | "input-limit"
  | "retry-budget"
  | "result-tool-error"
  | "provider"
  | "length"
  | "compaction"
  | "spawn"
  | "transport"
  | "process";

export type ReviewerProgressEvent =
  | {
      readonly type: "reviewer-start";
      readonly role: string;
      /** Optional sharded-work identity; legacy events omit these fields. */
      readonly unitId?: string;
      readonly shardId?: string;
      readonly resultTool: ReviewerResultToolName;
      readonly attempt: number;
    }
  | {
      readonly type: "reviewer-turn";
      readonly role: string;
      readonly unitId?: string;
      readonly shardId?: string;
      readonly attempt: number;
      readonly usage: AgentUsage;
    }
  | {
      readonly type: "reviewer-tool";
      readonly role: string;
      readonly unitId?: string;
      readonly shardId?: string;
      readonly attempt: number;
      readonly tool: ReviewerSafeToolName | "other";
      readonly status: "started" | "updated" | "completed";
    }
  | {
      readonly type: "reviewer-retry";
      readonly role: string;
      readonly unitId?: string;
      readonly shardId?: string;
      readonly attempt: number;
      readonly usage: AgentUsage;
    }
  | {
      readonly type: "reviewer-complete";
      readonly role: string;
      readonly unitId?: string;
      readonly shardId?: string;
      readonly attempt: number;
      readonly usage: AgentUsage;
    }
  | {
      readonly type: "reviewer-failed";
      readonly role: string;
      readonly unitId?: string;
      readonly shardId?: string;
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
  /** Optional UTF-8 prompt byte bound; omitted by legacy callers. */
  readonly inputBudgetBytes?: number;
  /** Optional output/provider reserve in tokens; omitted by legacy callers. */
  readonly reservedTokens?: number;
  /** Called only after the reviewer subprocess has been created for an attempt. */
  readonly onAttemptStart?: (attempt: number) => void;
  /** Optional bounded admission for the one protocol retry allowed by the runner. */
  readonly retryAdmission?: () => boolean | Promise<boolean>;
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
  run(command: string, args: readonly string[], options: { cwd: string; signal?: AbortSignal | undefined; env?: Readonly<Record<string, string>> }): Promise<CommandResult>;
}

export interface ReviewDependencies {
  readonly commands: CommandRunner;
  readonly agents: ReviewAgentRunner;
  readonly reviewerModel?: string;
  /** Override the source-view boundary for deterministic tests or embedded runners. */
  readonly prepareSourceView?: (snapshot: ReviewSnapshot, signal?: AbortSignal) => Promise<{
    readonly root: string;
    readonly revision?: string;
    dispose(): Promise<void>;
  }>;
  /** Resolve a provider model's context window without inferring unknown model identities. */
  readonly resolveModelContextWindow?: (model: string) => number | undefined;
  readonly onProgress?: (event: ReviewProgressEvent) => void;
}

export interface DiffRange {
  readonly start: number;
  readonly count: number;
}

export type DiffLineKind = "context" | "addition" | "deletion";

/** A source line in a unified hunk.  `oldLine` and `newLine` are deliberately
 * independent so additions and deletions can be accounted for side-aware. */
export interface DiffLine {
  readonly kind: DiffLineKind;
  /** The line payload without its unified-diff prefix. */
  readonly text: string;
  /** The complete logical diff line, including its prefix. */
  readonly raw: string;
  readonly oldLine?: number;
  readonly newLine?: number;
  /** Exact marker associated with this line, when the source had no newline. */
  readonly noNewlineMarker?: string;
}

export interface DiffHunk {
  readonly index: number;
  readonly headerLine: string;
  /** Bytes after the closing @@, including the original separator. */
  readonly sectionHeader: string;
  readonly oldRange: DiffRange;
  readonly newRange: DiffRange;
  readonly lines: readonly DiffLine[];
  /** Header and payload lines as parsed, retained for exact reconstruction. */
  readonly rawLines: readonly string[];
  readonly sourceStartLine: number;
  readonly sourceEndLine: number;
}

export interface ParsedDiffFile {
  readonly sourceOrder: number;
  /** Canonical identity, usually the new path, or old path for deletions. */
  readonly fileIdentity: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly headerLines: readonly string[];
  readonly metadataLines: readonly string[];
  readonly hunks: readonly DiffHunk[];
  readonly raw: string;
  readonly binary: boolean;
  readonly combined: boolean;
  readonly malformed: boolean;
  readonly supported: boolean;
  readonly unsupportedReason?: string;
}

export interface ParsedDiff {
  readonly snapshotHash: string;
  /** LF-normalized input used for parsing; payload line contents are unchanged. */
  readonly normalizedDiff: string;
  /** Source order is intentional: git's diff order is retained, not alphabetized. */
  readonly ordering: "source";
  readonly files: readonly ParsedDiffFile[];
  readonly malformed: boolean;
}

export interface DiffShardRange {
  readonly hunkIndex: number;
  readonly fileIdentity?: string;
  readonly oldRange: DiffRange;
  readonly newRange: DiffRange;
  readonly oldLineNumbers: readonly number[];
  readonly newLineNumbers: readonly number[];
}

export interface DiffShard {
  readonly id: string;
  readonly snapshotHash: string;
  readonly sourceOrder: number;
  readonly fileIdentity: string;
  readonly fileIdentities: readonly string[];
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly payload: string;
  readonly byteLength: number;
  readonly maxBytes: number;
  readonly supported: boolean;
  readonly metadataOnly: boolean;
  readonly binary: boolean;
  readonly combined: boolean;
  readonly malformed: boolean;
  readonly pieceIds: readonly string[];
  readonly ranges: readonly DiffShardRange[];
  /** Alias useful to coverage consumers; it is the same immutable range set. */
  readonly coveredRanges: readonly DiffShardRange[];
  readonly unsupportedReason?: string;
}

export type ReviewWorkUnitStatus = "planned" | "covered" | "uncovered";

export interface ReviewCoverageRange {
  readonly unitId?: string;
  readonly shardId?: string;
  /** Optional role annotation supplied by coverage producers. */
  readonly role?: string;
  readonly fileIdentity?: string;
  readonly oldRange?: DiffRange;
  readonly newRange?: DiffRange;
  readonly reason: string;
}

export interface ReviewCoverageCandidate {
  readonly id: string;
  readonly unitId?: string;
  readonly file?: string;
  readonly line?: number;
  readonly reason: string;
}

export interface ReviewWorkUnit {
  readonly id: string;
  readonly snapshotHash: string;
  readonly role: ReviewWorkRole;
  /** Original agent-facing distinction, when the obligation supplied one. */
  readonly agentRole?: ReviewRole;
  readonly trigger?: ReviewWorkTrigger;
  readonly status: ReviewWorkUnitStatus;
  readonly shardIds: readonly string[];
  readonly dependencies: readonly string[];
  readonly weight: number;
  readonly attempts: number;
  readonly ranges: readonly ReviewCoverageRange[];
  readonly candidates: readonly ReviewCoverageCandidate[];
  readonly reason?: string;
}

export type ReviewCoverageState = "complete" | "incomplete" | "unknown";

export interface ReviewCoverage {
  readonly snapshotHash: string;
  readonly state: ReviewCoverageState;
  /** The policy that produced this record, not an inferred result status. */
  readonly policyVersion?: number;
  readonly policy?: string;
  readonly workLimitPolicy?: WorkLimitPolicy;
  readonly mode?: "single" | "sharded";
  readonly sharded?: boolean;
  readonly plannedUnitIds: readonly string[];
  readonly coveredUnitIds: readonly string[];
  readonly uncoveredUnitIds: readonly string[];
  readonly attemptedUnitIds?: readonly string[];
  readonly attempts?: Readonly<Record<string, number>>;
  /** Stable aliases that make the three sets explicit to report consumers. */
  readonly plannedUnits: readonly string[];
  readonly coveredUnits: readonly string[];
  readonly uncoveredUnits: readonly string[];
  readonly reason?: string;
  readonly uncoveredRanges: readonly ReviewCoverageRange[];
  /** Explicit alias for consumers reporting range evidence. */
  readonly uncoveredRangeEvidence?: readonly ReviewCoverageRange[];
  readonly uncoveredCandidates: readonly ReviewCoverageCandidate[];
  /** Candidates that have not yet received a validation disposition. */
  readonly unvalidatedCandidates?: readonly ReviewCoverageCandidate[];
  /** All obligations whose success is required for each shard's full completion. */
  readonly requiredShardUnitIds?: Readonly<Record<string, readonly string[]>>;
  readonly plannedShardIds?: readonly string[];
  readonly coveredShardIds?: readonly string[];
  readonly uncoveredShardIds?: readonly string[];
  readonly plannedShardCount?: number;
  readonly coveredShardCount?: number;
  readonly uncoveredShardCount?: number;
  /** Stable aliases for report consumers that prefer shard identities. */
  readonly plannedShards?: readonly string[];
  readonly coveredShards?: readonly string[];
  readonly uncoveredShards?: readonly string[];
  readonly budgetMaxWeight?: number;
  readonly budgetReservedWeight?: number;
  readonly budgetSpentWeight?: number;
  readonly maxWeight?: number;
  readonly reservedWeight?: number;
  readonly spentWeight?: number;
  readonly budget?: {
    readonly maxWeight: number;
    readonly reservedWeight: number;
    readonly spentWeight: number;
  };
}

export interface ReviewWorkPlan {
  readonly snapshotHash: string;
  readonly shards: readonly DiffShard[];
  readonly units: readonly ReviewWorkUnit[];
  readonly selectedUnitIds: readonly string[];
  readonly totalWeight: number;
  readonly selectedWeight: number;
  readonly maxReviewWorkUnits: number;
  readonly workLimitPolicy: WorkLimitPolicy;
  readonly coverage: ReviewCoverage;
}
