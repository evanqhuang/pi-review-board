import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, type AutocompleteItem } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { parseReviewArgs } from "../src/args.js";
import { cancelActiveReviews, startReviewCancellation } from "../src/cancellation.js";
import { parseReviewEffort, type ReviewEffort } from "../src/effort.js";
import { NodeCommandRunner } from "../src/commands.js";
import { PiReviewAgentRunner } from "../src/runner.js";
import { runCodeReview } from "../src/pipeline.js";
import {
  formatStatusReport,
  getReviewStatus,
  recordReviewDispositions,
  resetReviewSession,
  runManagedReview,
  type FindingDispositionInput,
} from "../src/lifecycle.js";
import { captureReviewSnapshot, resolveReviewTarget } from "../src/targets.js";
import type { ReviewDecision, ReviewPhase, ReviewResult, ReviewTarget } from "../src/types.js";

interface ReviewToolParams {
  readonly action?: "run" | "loop" | "record" | "status" | "reset" | undefined;
  readonly target?: string | undefined;
  readonly comment?: boolean | undefined;
  readonly effort?: string | undefined;
  readonly model?: string | undefined;
  readonly phase?: "auto" | ReviewPhase | undefined;
  readonly planPath?: string | undefined;
  readonly implementationId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly reviewedSnapshotHash?: string | undefined;
  readonly dispositions?: readonly FindingDispositionInput[] | undefined;
  readonly confirmReset?: boolean | undefined;
}

interface ReviewUI {
  notify(message: string, level: "info" | "warning" | "error"): void;
  setStatus?: ((key: string, text: string | undefined) => void) | undefined;
  setWorkingMessage?: ((message: string | undefined) => void) | undefined;
}

interface ReviewExecutionContext {
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
  readonly ui: ReviewUI;
}

const REVIEW_ARGUMENT_COMPLETIONS: readonly AutocompleteItem[] = [
  { value: "loop", label: "loop — start or continue the managed review loop" },
  { value: "low", label: "low — cheapest one-shot review (default)" },
  { value: "status", label: "status — inspect a managed review session" },
  { value: "reset", label: "reset — reset a managed review session" },
  { value: "--effort low", label: "--effort low — cheapest review (default)" },
  { value: "--effort medium", label: "--effort medium — broader review" },
  { value: "--effort high", label: "--effort high — expensive deep review" },
  { value: "--effort xhigh", label: "--effort xhigh — very expensive review" },
  { value: "--effort max", label: "--effort max — maximum-depth review" },
  { value: "--effort ultra", label: "--effort ultra — maximum review plus second verification" },
  { value: "--phase initial", label: "--phase initial — advanced managed override" },
  { value: "--phase auto", label: "--phase auto — advanced automatic override" },
  { value: "--phase delta", label: "--phase delta — advanced remediation override" },
  { value: "--phase final", label: "--phase final — advanced confirmation override" },
  { value: "--plan ", label: "--plan <path> — bind a managed plan" },
  { value: "--session ", label: "--session <id> — select managed session" },
  { value: "--implementation ", label: "--implementation <id> — select implementation" },
  { value: "--model ", label: "--model <provider/model> — override reviewer model" },
  { value: "--comment", label: "--comment — publish a one-shot PR review" },
  { value: "--confirm", label: "--confirm — confirm an explicit reset" },
];

export function getReviewArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const tokenStart = prefix.lastIndexOf(" ") + 1;
  const completedPrefix = prefix.slice(0, tokenStart);
  const currentToken = prefix.slice(tokenStart).toLowerCase();
  const matches = REVIEW_ARGUMENT_COMPLETIONS
    .filter((item) => item.value.toLowerCase().startsWith(currentToken))
    .map((item) => ({ ...item, value: `${completedPrefix}${item.value}` }));
  return matches.length > 0 ? matches : null;
}

const FINDING_DISPOSITIONS = new Set<FindingDispositionInput["disposition"]>([
  "confirmed-blocker",
  "non-blocking",
  "accepted-risk",
  "product-decision",
  "follow-up",
  "not-reproducible",
  "resolved",
]);

function renderProgress(ctx: { ui: ReviewUI }, stage: string, message: string): void {
  const progress = `[${stage}] ${message}`;
  ctx.ui.setStatus?.("code-review", progress);
  ctx.ui.setWorkingMessage?.(progress);
}

function clearProgress(ctx: { ui: ReviewUI }): void {
  ctx.ui.setStatus?.("code-review", undefined);
  ctx.ui.setWorkingMessage?.(undefined);
}

function reviewTargetIdentity(target: ReviewTarget): string {
  switch (target.kind) {
    case "pull-request": return `pr:${target.value}`;
    case "branch": return `branch:${target.ref}`;
    case "worktree": return `worktree:${resolve(target.path)}`;
    case "path": return `path:${target.path}`;
    case "current-diff": return "current-diff";
  }
}

function operationCwd(ctx: ReviewExecutionContext, target: ReviewTarget): string {
  return target.kind === "worktree" ? target.path : ctx.cwd;
}

function contextAt(ctx: ReviewExecutionContext, cwd: string): ReviewExecutionContext {
  return { cwd, ui: ctx.ui, ...(ctx.signal ? { signal: ctx.signal } : {}) };
}

function plainResult(report: string, effort: ReviewEffort, decision?: ReviewDecision, status: ReviewResult["status"] = "complete"): ReviewResult {
  return {
    effort,
    status,
    summary: report,
    findings: [],
    failures: [],
    report,
    commented: false,
    usage: [],
    ...(decision ? { decision } : {}),
  };
}

export function validateFindingDispositionInputs(dispositions: readonly FindingDispositionInput[]): void {
  for (const disposition of dispositions) {
    if (!FINDING_DISPOSITIONS.has(disposition.disposition)) {
      throw new Error(`Unknown finding disposition for ${disposition.id}: ${String(disposition.disposition)}`);
    }
  }
}

export function buildManagedImplementationId(repositoryRoot: string, branchIdentity: string, planPath = ""): string {
  return createHash("sha256").update(`${repositoryRoot}|${branchIdentity}|${planPath}`).digest("hex").slice(0, 32);
}

async function checkedCommand(
  commands: NodeCommandRunner,
  cwd: string,
  name: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await commands.run(name, args, { cwd, signal });
  if (result.canceled) throw new Error(`${name} ${args.join(" ")} was canceled`);
  if (result.truncated) throw new Error(`${name} ${args.join(" ")} output was truncated`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${name} ${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout;
}

async function managedImplementationId(
  cwd: string,
  planPath: string | undefined,
  supplied: string | undefined,
  commands: NodeCommandRunner,
  signal?: AbortSignal,
): Promise<string> {
  if (supplied?.trim()) return supplied.trim();
  const repositoryRoot = await realpath((await checkedCommand(commands, cwd, "git", ["rev-parse", "--show-toplevel"], signal)).trim());
  const shortRef = (await checkedCommand(commands, cwd, "git", ["rev-parse", "--abbrev-ref", "HEAD"], signal)).trim();
  const branchIdentity = shortRef === "HEAD"
    ? (await checkedCommand(commands, cwd, "git", ["rev-parse", "HEAD"], signal)).trim()
    : shortRef;
  const canonicalPlan = planPath
    ? await realpath(isAbsolute(planPath) ? planPath : resolve(cwd, planPath))
    : "";
  return buildManagedImplementationId(repositoryRoot, branchIdentity, canonicalPlan);
}

async function requireManagedTargetCheckout(
  ctx: ReviewExecutionContext,
  target: ReviewTarget,
  commands: NodeCommandRunner,
): Promise<Awaited<ReturnType<typeof captureReviewSnapshot>> | undefined> {
  if (target.kind === "path") {
    throw new Error("Managed review does not support path-only targets; use a committed branch, worktree, pull request, or current checkout.");
  }
  const cwd = operationCwd(ctx, target);
  const status = await checkedCommand(commands, cwd, "git", ["status", "--porcelain"], ctx.signal);
  if (status.trim()) throw new Error("Managed review and adjudication require a clean committed target checkout.");
  const localHead = (await checkedCommand(commands, cwd, "git", ["rev-parse", "HEAD"], ctx.signal)).trim();
  if (target.kind === "branch") {
    const branchHead = (await checkedCommand(commands, cwd, "git", ["rev-parse", `${target.ref}^{commit}`], ctx.signal)).trim();
    if (localHead !== branchHead) {
      throw new Error(`Managed branch review requires the local checkout at ${target.ref} (${branchHead}); current HEAD is ${localHead}.`);
    }
  }
  if (target.kind !== "pull-request") return undefined;
  const snapshot = await captureReviewSnapshot(target, cwd, commands, ctx.signal);
  if (!snapshot.headSha || localHead !== snapshot.headSha) {
    throw new Error(`Managed pull-request review requires the local checkout at PR head ${snapshot.headSha ?? "unknown"}; current HEAD is ${localHead}.`);
  }
  return snapshot;
}

async function requireCurrentAdjudicationTarget(
  ctx: ReviewExecutionContext,
  target: ReviewTarget,
  params: ReviewToolParams,
  dependencies: { commands: NodeCommandRunner },
): Promise<void> {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) throw new Error("record requires sessionId");
  const snapshot = await requireManagedTargetCheckout(ctx, target, dependencies.commands);
  const cwd = operationCwd(ctx, target);
  const status = await getReviewStatus(cwd, dependencies, { sessionId, target }, ctx.signal);
  if (!status) throw new Error(`Review session not found: ${sessionId}`);
  if (status.targetIdentity !== reviewTargetIdentity(target)) {
    throw new Error("The adjudication target does not match the managed review session; use the same target used for the review.");
  }
  if (status.stale) throw new Error("The target changed after review; run the next managed review phase before recording dispositions.");
  if (target.kind === "pull-request"
    && (!snapshot?.pullRequest || snapshot.pullRequest.baseSha !== status.baseSha || snapshot.headSha !== status.lastReviewedHead)) {
    throw new Error("The pull-request base or head changed after review; dispositions for the stale snapshot were not recorded.");
  }
}

export function reviewExecutionSelection(
  params: Pick<ReviewToolParams, "action" | "phase" | "planPath" | "implementationId" | "sessionId">,
): { readonly managed: boolean; readonly requestedPhase: "auto" | ReviewPhase } {
  const requestedPhase = params.phase ?? "auto";
  return {
    requestedPhase,
    managed: params.action === "loop"
      || Boolean(params.planPath?.trim() || params.implementationId?.trim() || params.sessionId?.trim()
        || requestedPhase === "initial" || requestedPhase === "delta" || requestedPhase === "final"),
  };
}

async function executeReview(
  ctx: ReviewExecutionContext,
  params: ReviewToolParams,
  activeReviews: Set<AbortController>,
): Promise<ReviewResult> {
  const commands = new NodeCommandRunner();
  const action = params.action ?? "run";
  if (!["run", "loop", "record", "status", "reset"].includes(action)) throw new Error(`Unknown code-review action: ${action}`);
  const effort = parseReviewEffort(params.effort);
  const planPath = params.planPath?.trim();
  const dependencies = {
    commands,
    agents: new PiReviewAgentRunner(),
    ...(params.model?.trim() ? { reviewerModel: params.model.trim() } : {}),
    onProgress: (stage: Parameters<typeof renderProgress>[1], message: string) => renderProgress(ctx, stage, message),
  };
  let target: ReviewTarget;
  if (params.target?.trim()) {
    target = await resolveReviewTarget(params.target.trim(), ctx.cwd, commands, ctx.signal);
  } else if (params.sessionId?.trim()) {
    const status = await getReviewStatus(ctx.cwd, dependencies, { sessionId: params.sessionId.trim() }, ctx.signal);
    if (!status) throw new Error(`Review session not found: ${params.sessionId.trim()}`);
    target = status.target;
  } else {
    target = await resolveReviewTarget(undefined, ctx.cwd, commands, ctx.signal);
  }
  const cwd = operationCwd(ctx, target);
  const targetContext = contextAt(ctx, cwd);

  if (action === "record") {
    if (!params.reviewedSnapshotHash?.trim()) throw new Error("record requires reviewedSnapshotHash");
    if (!params.dispositions || params.dispositions.length === 0) throw new Error("record requires at least one finding disposition");
    validateFindingDispositionInputs(params.dispositions);
    await requireCurrentAdjudicationTarget(targetContext, target, params, dependencies);
    return recordReviewDispositions({
      cwd,
      sessionId: params.sessionId!.trim(),
      reviewedSnapshotHash: params.reviewedSnapshotHash.trim(),
      dispositions: params.dispositions,
    }, dependencies);
  }

  const inferredImplementationId = planPath || params.implementationId?.trim()
    ? await managedImplementationId(cwd, planPath, params.implementationId, commands, ctx.signal)
    : undefined;

  if (action === "status") {
    const status = await getReviewStatus(cwd, dependencies, {
      ...(params.sessionId?.trim() ? { sessionId: params.sessionId.trim() } : {}),
      ...(inferredImplementationId ? { implementationId: inferredImplementationId } : {}),
      ...(planPath ? { planPath } : {}),
      target,
    }, ctx.signal);
    return plainResult(formatStatusReport(status), effort, status?.decision);
  }
  if (action === "reset") {
    const message = await resetReviewSession(cwd, dependencies, {
      ...(params.sessionId?.trim() ? { sessionId: params.sessionId.trim() } : {}),
      ...(inferredImplementationId ? { implementationId: inferredImplementationId } : {}),
      ...(planPath ? { planPath } : {}),
      confirm: params.confirmReset === true,
    });
    return plainResult(`### Code review reset\n\n${message}`, effort);
  }

  const { requestedPhase: phase, managed } = reviewExecutionSelection(params);
  if (!["auto", "initial", "delta", "final"].includes(phase)) throw new Error(`Unknown code-review phase: ${phase}`);
  const implementationId = managed
  ? inferredImplementationId ?? (params.sessionId?.trim() ? undefined : await managedImplementationId(cwd, planPath, params.implementationId, commands, ctx.signal))
  : undefined;
  const cancellation = startReviewCancellation(activeReviews, ctx.signal);
  try {
    if (managed) {
      await requireManagedTargetCheckout(targetContext, target, commands);
      return runManagedReview({
        cwd,
        target,
        requestedPhase: phase,
        effort,
        ...(implementationId ? { implementationId } : {}),
        ...(params.sessionId?.trim() ? { sessionId: params.sessionId.trim() } : {}),
        ...(planPath ? { planPath } : {}),
      }, dependencies, cancellation.signal);
    }
    return runCodeReview({
      cwd,
      target,
      comment: params.comment === true,
      effort,
    }, dependencies, cancellation.signal);
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

  pi.registerEntryRenderer<ReviewResult>("code-review-result", (entry, _options, _theme) => {
    return new Markdown(entry.data?.report ?? "Review result unavailable.", 0, 0, getMarkdownTheme());
  });

  pi.registerCommand("code-review", {
    description: "Run a one-shot review or start/continue a managed review loop (default effort: low)",
    getArgumentCompletions: getReviewArgumentCompletions,
    handler: async (args, ctx) => {
      try {
        const parsed = parseReviewArgs(args);
        const result = await executeReview(ctx, {
          action: parsed.action,
          comment: parsed.comment,
          effort: parsed.effort,
          phase: parsed.phase,
          confirmReset: parsed.confirmReset,
          ...(parsed.target ? { target: parsed.target } : {}),
          ...(parsed.model ? { model: parsed.model } : {}),
          ...(parsed.planPath ? { planPath: parsed.planPath } : {}),
          ...(parsed.implementationId ? { implementationId: parsed.implementationId } : {}),
          ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
        }, activeReviews);
        injectReviewResult(pi, result);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "code_review",
    label: "Code Review",
    description: "Run a one-shot review or start/continue the bounded managed review loop. Results are report-only unless comment is explicitly true for a one-shot pull-request review.",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("loop"), Type.Literal("record"), Type.Literal("status"), Type.Literal("reset")])),
      target: Type.Optional(Type.String({ description: "Pull request number/URL, branch, path, worktree, or omit for current diff" })),
      comment: Type.Optional(Type.Boolean({ description: "Publish only for an explicit one-shot pull-request review" })),
      effort: Type.Optional(Type.String({ description: "Review depth: low, medium, high, xhigh, max, or ultra" })),
      model: Type.Optional(Type.String({ description: "Reviewer model provider/id override" })),
      phase: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("initial"), Type.Literal("delta"), Type.Literal("final")])),
      planPath: Type.Optional(Type.String({ description: "Managed plan path whose review contract and implementation identity should be used" })),
      implementationId: Type.Optional(Type.String({ description: "Stable approved implementation identity" })),
      sessionId: Type.Optional(Type.String({ description: "Review session ID returned by a prior managed run" })),
      reviewedSnapshotHash: Type.Optional(Type.String({ description: "Exact snapshot hash returned by the managed review being adjudicated" })),
      dispositions: Type.Optional(Type.Array(Type.Object({
        id: Type.String(),
        disposition: Type.Union([
          Type.Literal("confirmed-blocker"),
          Type.Literal("non-blocking"),
          Type.Literal("accepted-risk"),
          Type.Literal("product-decision"),
          Type.Literal("follow-up"),
          Type.Literal("not-reproducible"),
          Type.Literal("resolved"),
        ]),
        parentEvidence: Type.Optional(Type.String()),
        deterministic: Type.Optional(Type.Boolean()),
        contractBasis: Type.Optional(Type.String()),
      }))),
      confirmReset: Type.Optional(Type.Boolean({ description: "Must be true for an explicit reset" })),
    }),
    execute: async (_toolCallId, params: ReviewToolParams, signal, _onUpdate, ctx) => {
      try {
        const result = await executeReview({ cwd: ctx.cwd, ui: ctx.ui, ...(signal ? { signal } : {}) }, params, activeReviews);
        return {
          content: [{ type: "text", text: result.report }],
          details: {
            effort: result.effort,
            status: result.status,
            decision: result.decision,
            phase: result.phase,
            sessionId: result.sessionId,
            reviewedSnapshotHash: result.reviewedSnapshotHash,
            findings: result.findings,
            ledger: result.ledger,
            failures: result.failures,
            commented: result.commented,
            usage: result.usage,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Code review failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { effort: params.effort ?? "low", status: "incomplete", decision: "incomplete", findings: [], failures: [String(error)], commented: false },
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
