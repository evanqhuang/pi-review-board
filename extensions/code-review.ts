import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseReviewArgs } from "../src/args.js";
import { cancelActiveReviews, startReviewCancellation } from "../src/cancellation.js";
import { parseReviewEffort, type ReviewEffort } from "../src/effort.js";
import { NodeCommandRunner } from "../src/commands.js";
import { PiReviewAgentRunner } from "../src/runner.js";
import { runCodeReview } from "../src/pipeline.js";
import { resolveReviewTarget } from "../src/targets.js";
import type { ReviewResult } from "../src/types.js";

interface ReviewToolParams {
  readonly target?: string;
  readonly comment?: boolean;
  readonly effort?: ReviewEffort;
  readonly model?: string;
}

interface ReviewUI {
  notify(message: string, level: "info" | "warning" | "error"): void;
  setStatus?: (key: string, text: string | undefined) => void;
  setWorkingMessage?: (message: string | undefined) => void;
}

function renderProgress(ctx: { ui: ReviewUI }, stage: string, message: string): void {
  const progress = `[${stage}] ${message}`;
  ctx.ui.setStatus?.("code-review", progress);
  ctx.ui.setWorkingMessage?.(progress);
}

function clearProgress(ctx: { ui: ReviewUI }): void {
  ctx.ui.setStatus?.("code-review", undefined);
  ctx.ui.setWorkingMessage?.(undefined);
}

async function executeReview(
  ctx: { cwd: string; signal?: AbortSignal | undefined; ui: ReviewUI },
  params: ReviewToolParams,
  activeReviews: Set<AbortController>,
): Promise<ReviewResult> {
  const cancellation = startReviewCancellation(activeReviews, ctx.signal);
  try {
    const parsed = params.target?.trim() ? { target: params.target.trim(), comment: params.comment === true } : { comment: params.comment === true };
    const effort = parseReviewEffort(params.effort);
    const reviewerModel = params.model?.trim();
    const commands = new NodeCommandRunner();
    const target = await resolveReviewTarget(parsed.target, ctx.cwd, commands, cancellation.signal);
    return await runCodeReview(
      { cwd: ctx.cwd, target, comment: parsed.comment, effort },
      {
        commands,
        agents: new PiReviewAgentRunner(),
        ...(reviewerModel ? { reviewerModel } : {}),
        onProgress: (stage, message) => renderProgress(ctx, stage, message),
      },
      cancellation.signal,
    );
  } finally {
    cancellation.dispose();
    clearProgress(ctx);
  }
}

export interface ReviewMessageSender {
  sendMessage<T = unknown>(
    message: { customType: string; content: string; display: boolean; details?: T },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

export function injectReviewResult(pi: ReviewMessageSender, result: ReviewResult): void {
  pi.sendMessage<ReviewResult>({
    customType: "code-review-result",
    content: result.report,
    display: true,
    details: result,
  });
}

export default function (pi: ExtensionAPI): void {
  const activeReviews = new Set<AbortController>();

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "escape") || cancelActiveReviews(activeReviews) === 0) return;
      ctx.ui.notify("Code review canceled.", "warning");
      return { consume: true };
    });
  });

  pi.on("session_shutdown", () => {
    cancelActiveReviews(activeReviews);
  });

  pi.registerMessageRenderer<ReviewResult>("code-review-result", (message, _options, _theme) => {
    const report = typeof message.content === "string" ? message.content : message.details?.report;
    return new Markdown(report || "Review result unavailable.", 0, 0, getMarkdownTheme());
  });

  // Preserve rendering for reports created before they participated in model context.
  pi.registerEntryRenderer<ReviewResult>("code-review-result", (entry, _options, _theme) => {
    return new Markdown(entry.data?.report ?? "Review result unavailable.", 0, 0, getMarkdownTheme());
  });

  pi.registerCommand("code-review", {
    description: "Run a deterministic multi-pass code review",
    handler: async (args, ctx) => {
      try {
        const parsed = parseReviewArgs(args);
        const result = await executeReview(ctx, parsed, activeReviews);
        injectReviewResult(pi, result);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "code_review",
    label: "Code Review",
    description: "Review a pull request, current diff, branch, path, or worktree. Results are report-only unless comment is explicitly true for a pull request.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Pull request number/URL, branch, path, worktree, or omit for current diff" })),
      comment: Type.Optional(Type.Boolean({ description: "Publish a comment only when true and target is a pull request" })),
      effort: Type.Optional(Type.String({ description: "Review depth: low, medium, high, xhigh, max, or ultra" })),
      model: Type.Optional(Type.String({ description: "Reviewer model provider/id; overrides the effort-routed reviewer model for this review" })),
    }),
    execute: async (_toolCallId, params: ReviewToolParams, signal, _onUpdate, ctx) => {
      try {
        const result = await executeReview({ cwd: ctx.cwd, signal, ui: ctx.ui }, params, activeReviews);
        return {
          content: [{ type: "text", text: result.report }],
          details: {
            effort: result.effort,
            status: result.status,
            findings: result.findings,
            failures: result.failures,
            commented: result.commented,
            usage: result.usage,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Code review failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { effort: params.effort ?? "medium", status: "incomplete", findings: [], failures: [String(error)], commented: false },
          isError: true,
        };
      }
    },
    renderResult: (result, _options, _theme) => {
      const text = result.content[0];
      return new Markdown(text?.type === "text" ? text.text : "Review result unavailable.", 0, 0, getMarkdownTheme());
    },
  });
}
