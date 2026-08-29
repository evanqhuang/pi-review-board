import type { ReviewStage, ReviewerProgressEvent, ReviewProgressEvent, AgentUsage } from "./types.js";

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
  readonly role: string;
  readonly resultTool?: string | undefined;
  readonly attempt: number;
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

function isReviewerEvent(event: ReviewProgressEvent): event is ReviewerProgressEvent {
  return event.type !== "stage";
}

export class ReviewProgressPresenter {
  private currentStage: ReviewStage | undefined;
  private readonly completedStages = new Set<ReviewStage>();
  private readonly reviewers = new Map<string, ReviewerRow>();

  public constructor(private readonly options: ReviewProgressPresenterOptions) {}

  public start(): void {
    this.options.acquire?.();
    this.render();
  }

  public update(event: ReviewProgressEvent): void {
    if (event.type === "stage") {
      if (this.currentStage && this.currentStage !== event.stage) this.completedStages.add(this.currentStage);
      this.currentStage = event.stage;
    } else {
      this.updateReviewer(event);
    }
    this.render();
  }

  public lines(): string[] {
    const current = this.currentStage ? STAGE_LABELS[this.currentStage] : "Starting";
    const lines = [`Code review · ${current}`];
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
        return `  ${safeRole(row.role)} · ${row.status} · attempt ${row.attempt}${tool} · ${formatUsage(row.usage)}${failure}`;
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
    this.options.release?.();
  }

  private updateReviewer(event: ReviewerProgressEvent): void {
    const previous = this.reviewers.get(event.role) ?? {
      role: event.role,
      attempt: event.attempt,
      status: "starting" as const,
      usage: emptyUsage(event.role),
    };
    switch (event.type) {
      case "reviewer-start":
        this.setReviewer({ ...previous, resultTool: event.resultTool, attempt: event.attempt, status: "starting", failure: undefined });
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
        this.setReviewer({ ...previous, attempt: event.attempt, status: "retrying", usage: event.usage, activeTool: undefined, failure: "protocol retry" });
        break;
      case "reviewer-complete":
        this.setReviewer({ ...previous, attempt: event.attempt, status: "complete", usage: event.usage, activeTool: undefined, failure: undefined });
        break;
      case "reviewer-failed":
        this.setReviewer({ ...previous, attempt: event.attempt, status: "failed", usage: event.usage, activeTool: undefined, failure: event.kind });
        break;
    }
  }

  private setReviewer(row: ReviewerRow): void {
    if (!this.reviewers.has(row.role) && this.reviewers.size >= MAX_REVIEWER_ROWS) return;
    this.reviewers.set(row.role, row);
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
