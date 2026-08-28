import type { ReviewEffort, ReviewThinking } from "./effort.js";

export type ReviewTargetKind = "pull-request" | "current-diff" | "branch" | "path" | "worktree";

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

export interface ReviewOptions {
  readonly cwd: string;
  readonly target: ReviewTarget;
  readonly comment: boolean;
  readonly effort: ReviewEffort;
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
  readonly file: string;
  readonly line: number;
  readonly summary: string;
  readonly failureScenario: string;
  readonly evidence: string;
  readonly category: FindingCategory;
  readonly severity: FindingSeverity;
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

export interface ReviewResult {
  readonly effort: ReviewEffort;
  readonly status: "complete" | "ineligible" | "incomplete";
  readonly summary: string;
  readonly findings: readonly VerifiedFinding[];
  readonly failures: readonly StageFailure[];
  readonly report: string;
  readonly commented: boolean | "unknown";
  readonly usage: readonly AgentUsage[];
}

export interface AgentUsage {
  readonly role: string;
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly contextTokens: number;
}

export interface AgentInvocation {
  readonly role: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly tools: readonly string[];
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
    onProgress?: (message: string) => void,
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
  readonly onProgress?: (stage: ReviewStage, message: string) => void;
}
