import type { ReviewEffort, ReviewThinking } from "./effort.js";
import type { ReviewStage, ReviewerProgressEvent, ReviewProgressEvent, AgentUsage, ReviewRoute } from "./types.js";

const STAGES: readonly ReviewStage[] = ["eligibility", "guidance", "summary", "finders", "verification", "revalidation", "comment"];
const STAGE_LABELS: Readonly<Record<ReviewStage, string>> = {
  eligibility: "Eligibility",
  guidance: "Guidance",
  summary: "Summary",
  finders: "Finders",
  verification: "Verification",
  revalidation: "Revalidation",
  comment: "Comment",
};
const MAX_REVIEWER_ROWS = 24;
const MAX_PANEL_LINES = 36;
const MAX_ROLE_LENGTH = 72;

export interface ProgressUI {
  setStatus?: ((key: string, text: string | undefined) => void) | undefined;
  setWorkingMessage?: ((message: string | undefined) => void) | undefined;
  setWidget?: ((key: string, content: string[] | undefined) => void) | undefined;
}

interface ReviewerRow {
  /** Composite key keeps same-role sharded workers distinct. */
  readonly key: string;
  readonly role: string;
  readonly unitId?: string | undefined;
  readonly shardId?: string | undefined;
  readonly resultTool?: string | undefined;
  readonly attempt: number;
  readonly model?: string | undefined;
  readonly thinking?: ReviewThinking | undefined;
  readonly status: "starting" | "working" | "retrying" | "complete" | "failed";
  readonly activeTool?: string | undefined;
  readonly usage: AgentUsage;
  readonly failure?: string | undefined;
}

export interface ReviewProgressPresenterOptions {
  readonly ui: ProgressUI;
  readonly key: string;
  readonly isOwner?: () => boolean;
  readonly acquire?: () => void;
  readonly release?: () => void;
}

function emptyUsage(role: string): AgentUsage {
  return { role, turns: 0, inputTokens: 0, outputTokens: 0, contextTokens: 0 };
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatUsage(usage: AgentUsage): string {
  return `t${usage.turns} in:${formatTokenCount(usage.inputTokens)} out:${formatTokenCount(usage.outputTokens)} ctx:${formatTokenCount(usage.contextTokens)}`;
}

function safeRole(role: string): string {
  return role.slice(0, MAX_ROLE_LENGTH).replace(/[^a-zA-Z0-9:_-]/gu, "_");
}

function safeTool(tool: string): string {
  return tool.slice(0, MAX_ROLE_LENGTH).replace(/[^a-zA-Z0-9:_-]/gu, "_");
}

function reviewerKey(event: ReviewerProgressEvent): string {
  return [event.role, event.unitId ?? "", event.shardId ?? ""].join("\u0000");
}

function workerIdentity(row: ReviewerRow): string {
  const identity = [
    row.unitId === undefined ? undefined : `unit ${safeRole(row.unitId)}`,
    row.shardId === undefined ? undefined : `shard ${safeRole(row.shardId)}`,
  ].filter((value): value is string => value !== undefined);
  return identity.length === 0 ? "" : ` · ${identity.join(" · ")}`;
}

function isReviewerEvent(event: ReviewProgressEvent): event is ReviewerProgressEvent {
  return event.type !== "stage" && event.type !== "review-config";
}

export class ReviewProgressPresenter {
  private currentStage: ReviewStage | undefined;
  private readonly completedStages = new Set<ReviewStage>();
  private readonly reviewers = new Map<string, ReviewerRow>();
  private effort: ReviewEffort | undefined;
  private route: ReviewRoute | undefined;
  private configuredReviewers: Extract<ReviewProgressEvent, { type: "review-config" }>["reviewers"] = [];

  public constructor(private readonly options: ReviewProgressPresenterOptions) {}

  public start(): void {
    this.options.acquire?.();
    this.render();
  }

  public update(event: ReviewProgressEvent): void {
    if (event.type === "stage") {
      if (this.currentStage && this.currentStage !== event.stage) this.completedStages.add(this.currentStage);
      this.currentStage = event.stage;
    } else if (event.type === "review-config") {
      this.effort = event.effort;
      this.route = event.route;
      this.configuredReviewers = event.reviewers;
    } else {
      this.updateReviewer(event);
    }
    this.render();
  }

  public lines(): string[] {
    const current = this.currentStage ? STAGE_LABELS[this.currentStage] : "Starting";
    const lines = [`Code review · ${current}`];
    if (this.effort && this.route) lines.push(`Mode: ${this.effort} effort · ${this.route} route`);
    const configurations = [...new Set(this.configuredReviewers.map((reviewer) => `${reviewer.model} · ${reviewer.thinking}`))];
    if (configurations.length > 0) lines.push(`Models: ${configurations.join(" | ")}`);
    const totalUsage = [...this.reviewers.values()].reduce((total, row) => ({
      role: "total",
      turns: total.turns + row.usage.turns,
      inputTokens: total.inputTokens + row.usage.inputTokens,
      outputTokens: total.outputTokens + row.usage.outputTokens,
      contextTokens: Math.max(total.contextTokens, row.usage.contextTokens),
    }), emptyUsage("total"));
    if (this.reviewers.size > 0) lines.push(`Usage: ${formatUsage(totalUsage)} (peak ctx)`);
    lines.push(...STAGES.map((stage) => {
      const marker = this.completedStages.has(stage) ? "✓" : this.currentStage === stage ? "›" : "·";
      return `${marker} ${STAGE_LABELS[stage]}`;
    }));

    const rows = [...this.reviewers.values()].slice(0, MAX_REVIEWER_ROWS);
    if (rows.length > 0) {
      lines.push("", "Reviewers");
      lines.push(...rows.map((row) => {
        const tool = row.activeTool ? ` · ${safeTool(row.activeTool)}` : "";
        const failure = row.failure ? ` · ${row.failure}` : "";
        const runtime = row.model ? ` · ${row.model} · ${row.thinking ?? "unknown"}` : "";
        return `  ${safeRole(row.role)}${workerIdentity(row)} · ${row.status} · attempt ${row.attempt}${runtime}${tool} · ${formatUsage(row.usage)}${failure}`;
      }));
      if (this.reviewers.size > MAX_REVIEWER_ROWS) lines.push(`  +${this.reviewers.size - MAX_REVIEWER_ROWS} more reviewers`);
    }
    lines.push("", "Esc to cancel");
    return lines.slice(0, MAX_PANEL_LINES);
  }

  public clear(): void {
    if (this.isOwner()) this.options.ui.setWorkingMessage?.(undefined);
    this.options.ui.setStatus?.(this.options.key, undefined);
    this.options.ui.setWidget?.(this.options.key, undefined);
    this.reviewers.clear();
    this.completedStages.clear();
    this.currentStage = undefined;
    this.effort = undefined;
    this.route = undefined;
    this.configuredReviewers = [];
    this.options.release?.();
  }

  private updateReviewer(event: ReviewerProgressEvent): void {
    const exactKey = reviewerKey(event);
    const existing = this.findReviewer(event, exactKey);
    const key = existing?.key ?? exactKey;
    let previous: ReviewerRow = existing ?? {
      key,
      role: event.role,
      ...(event.unitId === undefined ? {} : { unitId: event.unitId }),
      ...(event.shardId === undefined ? {} : { shardId: event.shardId }),
      attempt: event.attempt,
      status: "starting" as const,
      usage: emptyUsage(event.role),
    };
    if (previous.unitId === undefined && event.unitId !== undefined) previous = { ...previous, unitId: event.unitId };
    if (previous.shardId === undefined && event.shardId !== undefined) previous = { ...previous, shardId: event.shardId };
    switch (event.type) {
      case "reviewer-start":
        this.setReviewer({ ...previous, resultTool: event.resultTool, attempt: event.attempt, model: event.model, thinking: event.thinking, status: "starting", failure: undefined });
        break;
      case "reviewer-turn":
        this.setReviewer({ ...previous, attempt: event.attempt, status: "working", usage: event.usage, failure: undefined });
        break;
      case "reviewer-tool":
        this.setReviewer({
          ...previous,
          attempt: event.attempt,
          status: "working",
          activeTool: event.status === "completed" ? undefined : event.tool === "other" ? undefined : event.tool,
        });
        break;
      case "reviewer-retry":
        this.setReviewer({ ...previous, attempt: event.attempt, status: "retrying", usage: event.usage, activeTool: undefined, failure: "bounded retry" });
        break;
      case "reviewer-complete":
        this.setReviewer({ ...previous, attempt: event.attempt, status: "complete", usage: event.usage, activeTool: undefined, failure: undefined });
        break;
      case "reviewer-failed":
        this.setReviewer({ ...previous, attempt: event.attempt, status: "failed", usage: event.usage, activeTool: undefined, failure: event.kind });
        break;
    }
  }

  private findReviewer(event: ReviewerProgressEvent, exactKey: string): ReviewerRow | undefined {
    const exact = this.reviewers.get(exactKey);
    if (exact !== undefined) return exact;
    const candidates = [...this.reviewers.values()].filter((row) => row.role === event.role);
    if (candidates.length !== 1) return undefined;
    const candidate = candidates[0]!;
    const unitMatches = event.unitId === undefined || candidate.unitId === undefined || event.unitId === candidate.unitId;
    const shardMatches = event.shardId === undefined || candidate.shardId === undefined || event.shardId === candidate.shardId;
    return unitMatches && shardMatches ? candidate : undefined;
  }

  private setReviewer(row: ReviewerRow): void {
    if (!this.reviewers.has(row.key) && this.reviewers.size >= MAX_REVIEWER_ROWS) return;
    this.reviewers.set(row.key, row);
  }

  private isOwner(): boolean {
    return this.options.isOwner ? this.options.isOwner() : true;
  }

  private render(): void {
    const lines = this.lines();
    const current = this.currentStage ? STAGE_LABELS[this.currentStage] : "Starting";
    this.options.ui.setStatus?.(this.options.key, `${current} · detailed progress`);
    this.options.ui.setWidget?.(this.options.key, lines);
    if (this.isOwner()) this.options.ui.setWorkingMessage?.(lines[0] ?? "Code review");
  }
}

export const reviewProgressLimits = {
  maxReviewers: MAX_REVIEWER_ROWS,
  maxPanelLines: MAX_PANEL_LINES,
} as const;

export function isReviewerProgressEvent(event: ReviewProgressEvent): event is ReviewerProgressEvent {
  return isReviewerEvent(event);
}
