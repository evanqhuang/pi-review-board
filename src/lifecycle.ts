import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { runCodeReview } from "./pipeline.js";
import { captureReviewSnapshot } from "./targets.js";
import type { ReviewEffort } from "./effort.js";
import type {
  CommandRunner,
  FindingLedgerEntry,
  FindingLedgerStatus,
  AgentUsage,
  ReviewContract,
  ReviewCoverage,
  ReviewCoverageCandidate,
  ReviewCoverageValidation,
  ReviewDecision,
  ReviewDependencies,
  ReviewLedgerAttempt,
  ReviewLedgerSummary,
  ReviewOptions,
  ReviewPhase,
  ReviewResult,
  ReviewSnapshot,
  ReviewStage,
  ReviewTarget,
  VerifiedFinding,
  WorkLimitPolicy,
} from "./types.js";
import {
  DEFAULT_WORK_LIMIT_POLICY,
  REVIEW_WORK_POLICY,
  REVIEW_WORK_POLICY_VERSION,
} from "./types.js";

const VERSION = 2;
const MAX_PASSES = 3;
const MAX_REMEDIATIONS = 2;
const MAX_INCOMPLETE = 2;
const locks = new Set<string>();

export type FindingDisposition =
  | "confirmed-blocker"
  | "non-blocking"
  | "accepted-risk"
  | "product-decision"
  | "follow-up"
  | "not-reproducible"
  | "resolved";

const FINDING_DISPOSITIONS = new Set<FindingDisposition>([
  "confirmed-blocker",
  "non-blocking",
  "accepted-risk",
  "product-decision",
  "follow-up",
  "not-reproducible",
  "resolved",
]);

export interface FindingDispositionInput {
  readonly id: string;
  readonly disposition: FindingDisposition;
  readonly parentEvidence?: string;
  readonly deterministic?: boolean;
  readonly contractBasis?: string;
}

export interface ManagedReviewRunInput {
  readonly cwd: string;
  readonly target?: ReviewTarget;
  readonly requestedPhase: "auto" | "initial" | "delta" | "final";
  readonly effort: ReviewEffort;
  readonly implementationId?: string;
  readonly sessionId?: string;
  readonly planPath?: string;
  readonly contract?: ReviewContract;
  readonly maxReviewWorkUnits?: number;
  readonly workLimitPolicy?: WorkLimitPolicy;
}

export interface RecordReviewInput {
  readonly cwd: string;
  readonly sessionId: string;
  readonly reviewedSnapshotHash: string;
  readonly dispositions: readonly FindingDispositionInput[];
}

export interface ReviewStatus extends ReviewLedgerSummary {
  /** Status always materializes legacy missing coverage as unknown. */
  readonly coverage: ReviewCoverage;
  readonly coverageValidation: ReviewCoverageValidation;
  readonly currentHead?: string;
  readonly stale: boolean;
  readonly nextAction: string;
}

type Phase = "initial" | "delta" | "final" | "approved" | "blocked";
type MutableFinding = { -readonly [K in keyof FindingLedgerEntry]: FindingLedgerEntry[K] };

interface Ledger {
  version: 2;
  policyVersion: 2;
  sessionId: string;
  implementationId?: string;
  repositoryRoot: string;
  target: ReviewTarget;
  targetIdentity: string;
  baseSha: string;
  planPath?: string;
  planHash?: string;
  contract: ReviewContract;
  phase: Phase;
  decision: ReviewDecision;
  initialReviewedHead?: string;
  lastReviewedHead?: string;
  lastReviewedSnapshotHash?: string;
  completedPasses: number;
  remediationBatches: number;
  incompleteAttemptsThisPhase: number;
  awaitingAdjudication: boolean;
  findings: MutableFinding[];
  /** Optional additive coverage state; absent means legacy coverage is unknown. */
  coverage?: ReviewCoverage;
  coverageValidation?: ReviewCoverageValidation;
  workLimitPolicy?: WorkLimitPolicy;
  lastAttempt?: ReviewLedgerAttempt;
  createdAt: string;
  updatedAt: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, max) : "";
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

const MAX_PERSISTED_COVERAGE_ITEMS = 200;
const MAX_PERSISTED_COVERAGE_RANGES = 200;
const MAX_PERSISTED_COVERAGE_CANDIDATES = 20;
const MAX_PERSISTED_FAILURES = 20;
const MAX_PERSISTED_USAGE = 32;
const MAX_PERSISTED_FINDINGS = 5;

const FINDING_CATEGORIES = new Set(["correctness", "guidance", "history", "integration", "contract"]);
const FINDING_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const COVERAGE_STATES = new Set(["complete", "incomplete", "unknown"]);

function cleanIds(items: readonly string[] | undefined, limit = MAX_PERSISTED_COVERAGE_ITEMS): string[] {
  return (items ?? []).slice(0, limit).map((item) => text(item, 300)).filter(Boolean);
}

function unknownCoverage(snapshotHash: string, reason: string): ReviewCoverage {
  const empty = Object.freeze([]) as readonly string[];
  const ranges = Object.freeze([]) as readonly ReviewCoverage["uncoveredRanges"][number][];
  const candidates = Object.freeze([]) as readonly ReviewCoverageCandidate[];
  return {
    snapshotHash: text(snapshotHash, 300),
    state: "unknown",
    plannedUnitIds: empty,
    coveredUnitIds: empty,
    uncoveredUnitIds: empty,
    plannedUnits: empty,
    coveredUnits: empty,
    uncoveredUnits: empty,
    uncoveredRanges: ranges,
    uncoveredRangeEvidence: ranges,
    uncoveredCandidates: candidates,
    unvalidatedCandidates: candidates,
    reason: text(reason),
  };
}

function cleanCoverageCandidate(candidate: ReviewCoverageCandidate): ReviewCoverageCandidate {
  return {
    id: text(candidate.id, 300),
    ...(candidate.unitId ? { unitId: text(candidate.unitId, 300) } : {}),
    ...(candidate.file ? { file: text(candidate.file, 500) } : {}),
    ...(Number.isSafeInteger(candidate.line) ? { line: candidate.line } : {}),
    reason: text(candidate.reason),
  };
}

function cleanCoverage(coverage: ReviewCoverage | undefined, fallbackSnapshotHash: string, fallbackReason: string): ReviewCoverage {
  if (!coverage) return unknownCoverage(fallbackSnapshotHash, fallbackReason);
  const planned = cleanIds(coverage.plannedUnitIds);
  const covered = cleanIds(coverage.coveredUnitIds);
  const uncovered = cleanIds(coverage.uncoveredUnitIds);
  const evidenceTruncated = coverage.plannedUnitIds.length > MAX_PERSISTED_COVERAGE_ITEMS
    || coverage.coveredUnitIds.length > MAX_PERSISTED_COVERAGE_ITEMS
    || coverage.uncoveredUnitIds.length > MAX_PERSISTED_COVERAGE_ITEMS
    || coverage.uncoveredCandidates.length > MAX_PERSISTED_COVERAGE_CANDIDATES
    || (coverage.unvalidatedCandidates?.length ?? 0) > MAX_PERSISTED_COVERAGE_CANDIDATES;
  const attempted = coverage.attemptedUnitIds === undefined ? undefined : cleanIds(coverage.attemptedUnitIds);
  const plannedShards = coverage.plannedShardIds === undefined && coverage.plannedShards === undefined ? undefined : cleanIds(coverage.plannedShardIds ?? coverage.plannedShards);
  const coveredShards = coverage.coveredShardIds === undefined && coverage.coveredShards === undefined ? undefined : cleanIds(coverage.coveredShardIds ?? coverage.coveredShards);
  const uncoveredShards = coverage.uncoveredShardIds === undefined && coverage.uncoveredShards === undefined ? undefined : cleanIds(coverage.uncoveredShardIds ?? coverage.uncoveredShards);
  const ranges = coverage.uncoveredRanges.slice(0, MAX_PERSISTED_COVERAGE_RANGES).map((range) => ({
    ...(range.unitId ? { unitId: text(range.unitId, 300) } : {}),
    ...(range.shardId ? { shardId: text(range.shardId, 300) } : {}),
    ...(range.role ? { role: text(range.role, 100) } : {}),
    ...(range.fileIdentity ? { fileIdentity: text(range.fileIdentity, 500) } : {}),
    ...(range.oldRange ? { oldRange: range.oldRange } : {}),
    ...(range.newRange ? { newRange: range.newRange } : {}),
    reason: text(range.reason),
  }));
  const candidates = coverage.uncoveredCandidates.slice(0, MAX_PERSISTED_COVERAGE_CANDIDATES).map(cleanCoverageCandidate);
  const unvalidated = (coverage.unvalidatedCandidates ?? candidates).slice(0, MAX_PERSISTED_COVERAGE_CANDIDATES).map(cleanCoverageCandidate);
  const attempts = coverage.attempts
    ? Object.fromEntries(Object.entries(coverage.attempts).slice(0, MAX_PERSISTED_COVERAGE_ITEMS).map(([id, count]) => [text(id, 300), Number.isSafeInteger(count) && count >= 0 ? count : 0]))
    : undefined;
  const budgetValues = [
    coverage.budget?.maxWeight ?? coverage.budgetMaxWeight ?? coverage.maxWeight,
    coverage.budget?.reservedWeight ?? coverage.budgetReservedWeight ?? coverage.reservedWeight,
    coverage.budget?.spentWeight ?? coverage.budgetSpentWeight ?? coverage.spentWeight,
  ];
  const budget = budgetValues.every((item) => Number.isFinite(item) && (item as number) >= 0)
    ? {
        maxWeight: budgetValues[0] as number,
        reservedWeight: budgetValues[1] as number,
        spentWeight: budgetValues[2] as number,
      }
    : undefined;
  const state: ReviewCoverage["state"] = evidenceTruncated
    ? "incomplete"
    : COVERAGE_STATES.has(coverage.state) ? coverage.state : "unknown";
  return {
    snapshotHash: text(coverage.snapshotHash, 300),
    state,
    ...(coverage.policyVersion === undefined ? {} : { policyVersion: coverage.policyVersion }),
    ...(coverage.policy === undefined ? {} : { policy: text(coverage.policy, 200) }),
    ...(coverage.workLimitPolicy === undefined ? {} : { workLimitPolicy: coverage.workLimitPolicy }),
    ...(coverage.mode === undefined ? {} : { mode: coverage.mode }),
    ...(coverage.sharded === undefined ? {} : { sharded: coverage.sharded }),
    plannedUnitIds: planned,
    coveredUnitIds: covered,
    uncoveredUnitIds: uncovered,
    plannedUnits: planned,
    coveredUnits: covered,
    uncoveredUnits: uncovered,
    ...(attempted === undefined ? {} : { attemptedUnitIds: attempted }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(coverage.reason || fallbackReason || evidenceTruncated ? { reason: text(coverage.reason || fallbackReason || "coverage evidence exceeded the persistence bound") } : {}),
    uncoveredRanges: ranges,
    uncoveredRangeEvidence: ranges,
    uncoveredCandidates: candidates,
    unvalidatedCandidates: unvalidated,
    ...(plannedShards === undefined ? {} : { plannedShardIds: plannedShards, plannedShards, plannedShardCount: plannedShards.length }),
    ...(coveredShards === undefined ? {} : { coveredShardIds: coveredShards, coveredShards, coveredShardCount: coveredShards.length }),
    ...(uncoveredShards === undefined ? {} : { uncoveredShardIds: uncoveredShards, uncoveredShards, uncoveredShardCount: uncoveredShards.length }),
    ...(budget === undefined ? {} : {
      budget,
      budgetMaxWeight: budget.maxWeight,
      budgetReservedWeight: budget.reservedWeight,
      budgetSpentWeight: budget.spentWeight,
      maxWeight: budget.maxWeight,
      reservedWeight: budget.reservedWeight,
      spentWeight: budget.spentWeight,
    }),
  };
}

function coverageIssues(
  coverage: ReviewCoverage,
  expectedSnapshotHash: string | undefined,
  expectedWorkLimitPolicy: WorkLimitPolicy,
): string[] {
  const issues: string[] = [];
  if (coverage.state !== "complete") issues.push(`coverage is ${coverage.state}`);
  if (!expectedSnapshotHash) issues.push("no reviewed snapshot is recorded");
  else if (coverage.snapshotHash !== expectedSnapshotHash) issues.push("coverage snapshot does not match the reviewed snapshot");
  if (coverage.policyVersion === undefined) issues.push("coverage policy version is missing");
  else if (coverage.policyVersion !== REVIEW_WORK_POLICY_VERSION) {
    issues.push(`coverage policy version ${String(coverage.policyVersion)} does not match ${REVIEW_WORK_POLICY_VERSION}`);
  }
  if (coverage.policy === undefined) issues.push("coverage policy is missing");
  else if (coverage.policy !== REVIEW_WORK_POLICY) {
    issues.push("coverage policy does not match the current review policy");
  }
  if (coverage.workLimitPolicy === undefined) issues.push("coverage work-limit policy is missing");
  else if (coverage.workLimitPolicy !== expectedWorkLimitPolicy) {
    issues.push(`coverage work-limit policy ${coverage.workLimitPolicy} does not match ${expectedWorkLimitPolicy}`);
  }
  if (coverage.plannedUnitIds.length === 0) issues.push("coverage contains no planned work units");
  if (coverage.uncoveredUnitIds.length > 0 || coverage.uncoveredUnits.length > 0
    || coverage.plannedUnitIds.some((id) => !coverage.coveredUnitIds.includes(id))) issues.push("coverage has uncovered work units");
  if (coverage.uncoveredCandidates.length > 0) issues.push("coverage has uncovered candidates");
  if ((coverage.unvalidatedCandidates?.length ?? 0) > 0) issues.push("coverage has unvalidated candidates");
  return [...new Set(issues)];
}

function cleanFinding(finding: VerifiedFinding): VerifiedFinding {
  const category = FINDING_CATEGORIES.has(finding.category) ? finding.category : "correctness";
  const severity = FINDING_SEVERITIES.has(finding.severity) ? finding.severity : "medium";
  return {
    id: text(finding.id, 300),
    rootCauseKey: text(finding.rootCauseKey, 500),
    file: text(finding.file, 500),
    line: Number.isSafeInteger(finding.line) && finding.line > 0 ? finding.line : 1,
    summary: text(finding.summary, 1_000),
    failureScenario: text(finding.failureScenario, 1_000),
    evidence: text(finding.evidence, 2_000),
    category,
    severity,
    needsContext: finding.needsContext === true,
    finder: text(finding.finder, 100),
    confidence: Number.isFinite(finding.confidence) ? Math.max(0, Math.min(100, finding.confidence)) : 0,
    verification: text(finding.verification, 2_000),
  };
}

function cleanUsage(usage: AgentUsage): AgentUsage {
  const boundedNumber = (value: number): number => Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, value) : 0;
  return {
    role: text(usage.role, 100),
    turns: boundedNumber(usage.turns),
    inputTokens: boundedNumber(usage.inputTokens),
    outputTokens: boundedNumber(usage.outputTokens),
    contextTokens: boundedNumber(usage.contextTokens),
  };
}

function cleanFailures(failures: readonly { readonly stage: string; readonly message: string }[]): Array<{ readonly stage: ReviewStage; readonly message: string }> {
  return failures.slice(0, MAX_PERSISTED_FAILURES).map((failure) => ({
    stage: failure.stage as ReviewStage,
    message: text(failure.message),
  }));
}

function currentCoverage(ledger: Ledger): ReviewCoverage {
  return ledger.coverage ?? unknownCoverage(ledger.lastReviewedSnapshotHash ?? "", "coverage was not recorded by this legacy ledger");
}

function ledgerCoverageIssues(ledger: Ledger): string[] {
  const coverage = currentCoverage(ledger);
  const policy = ledger.workLimitPolicy ?? coverage.workLimitPolicy ?? DEFAULT_WORK_LIMIT_POLICY;
  const issues = coverageIssues(coverage, ledger.lastReviewedSnapshotHash, policy);
  return [...new Set([...issues, ...(ledger.coverageValidation?.issues ?? [])])];
}

function coverageAuthorized(ledger: Ledger): boolean {
  return ledgerCoverageIssues(ledger).length === 0;
}

function effectiveDecision(ledger: Ledger): ReviewDecision {
  if ((ledger.decision === "approve" || ledger.decision === "comment") && !coverageAuthorized(ledger)) return "incomplete";
  return ledger.decision;
}

function targetIdentity(target: ReviewTarget): string {
  switch (target.kind) {
    case "pull-request": return `pr:${target.value}`;
    case "branch": return `branch:${target.ref}`;
    case "worktree": return `worktree:${resolve(target.path)}`;
    case "path": return `path:${target.path}`;
    case "current-diff": return "current-diff";
  }
}

function canonicalTarget(target: ReviewTarget): ReviewTarget {
  switch (target.kind) {
    case "pull-request": return { kind: "pull-request", value: target.value };
    case "branch": return { kind: "branch", ref: target.ref };
    case "worktree": return { kind: "worktree", path: resolve(target.path) };
    case "path": return { kind: "path", path: target.path };
    case "current-diff": return { kind: "current-diff" };
  }
}

function isReviewTarget(value: unknown): value is ReviewTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Partial<ReviewTarget>;
  switch (target.kind) {
    case "pull-request": return typeof (target as { value?: unknown }).value === "string";
    case "branch": return typeof (target as { ref?: unknown }).ref === "string";
    case "worktree":
    case "path": return typeof (target as { path?: unknown }).path === "string";
    case "current-diff": return true;
    default: return false;
  }
}

async function command(commands: CommandRunner, cwd: string, name: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  const result = await commands.run(name, args, { cwd, signal });
  if (result.canceled) throw new Error(`${name} ${args.join(" ")} was canceled`);
  if (result.truncated) throw new Error(`${name} ${args.join(" ")} output was truncated`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${name} ${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout;
}

async function optionalCommand(commands: CommandRunner, cwd: string, name: string, args: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  const result = await commands.run(name, args, { cwd, signal });
  if (result.canceled) throw new Error(`${name} ${args.join(" ")} was canceled`);
  return result.exitCode === 0 && !result.truncated ? result.stdout : undefined;
}

async function repositoryRoot(cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<string> {
  const root = await command(commands, cwd, "git", ["rev-parse", "--show-toplevel"], signal);
  return realpath(root.trim());
}

async function stateDirectory(cwd: string, commands: CommandRunner): Promise<string> {
  const common = await optionalCommand(commands, cwd, "git", ["rev-parse", "--git-common-dir"]);
  const directory = common?.trim()
    ? join(resolve(cwd, common.trim()), "pi-code-review")
    : join(homedir(), ".pi", "agent", "state", "pi-code-review");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function pathFor(directory: string, sessionId: string): string {
  if (!/^[a-f0-9-]{12,80}$/u.test(sessionId)) throw new Error("Invalid review session ID");
  return join(directory, `${sessionId}.json`);
}

function isReviewCoverage(value: unknown): value is ReviewCoverage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const coverage = value as Partial<ReviewCoverage>;
  return typeof coverage.snapshotHash === "string"
    && typeof coverage.state === "string"
    && COVERAGE_STATES.has(coverage.state)
    && Array.isArray(coverage.plannedUnitIds)
    && Array.isArray(coverage.coveredUnitIds)
    && Array.isArray(coverage.uncoveredUnitIds)
    && Array.isArray(coverage.plannedUnits)
    && Array.isArray(coverage.coveredUnits)
    && Array.isArray(coverage.uncoveredUnits)
    && Array.isArray(coverage.uncoveredRanges)
    && Array.isArray(coverage.uncoveredCandidates)
    && (coverage.policyVersion === undefined || Number.isSafeInteger(coverage.policyVersion))
    && (coverage.policy === undefined || typeof coverage.policy === "string")
    && (coverage.workLimitPolicy === undefined || coverage.workLimitPolicy === "reject" || coverage.workLimitPolicy === "partial");
}

function isReviewCoverageValidation(value: unknown): value is ReviewCoverageValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const validation = value as Partial<ReviewCoverageValidation>;
  return typeof validation.valid === "boolean"
    && Array.isArray(validation.issues)
    && validation.issues.every((issue) => typeof issue === "string");
}

function isReviewLedgerAttempt(value: unknown): value is ReviewLedgerAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Partial<ReviewLedgerAttempt>;
  return attempt.version === 1
    && typeof attempt.snapshotHash === "string"
    && isReviewCoverage(attempt.coverage)
    && Array.isArray(attempt.findings)
    && Array.isArray(attempt.failures)
    && Array.isArray(attempt.usage)
    && (attempt.validationIssues === undefined || (Array.isArray(attempt.validationIssues) && attempt.validationIssues.every((issue) => typeof issue === "string")));
}

function validateLedger(value: unknown): Ledger {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Review ledger is malformed");
  const ledger = value as Partial<Ledger>;
  if (ledger.version !== VERSION || ledger.policyVersion !== VERSION || typeof ledger.sessionId !== "string"
    || typeof ledger.repositoryRoot !== "string" || !isReviewTarget(ledger.target) || typeof ledger.targetIdentity !== "string"
    || typeof ledger.baseSha !== "string" || !Array.isArray(ledger.findings)
    || (ledger.coverage !== undefined && !isReviewCoverage(ledger.coverage))
    || (ledger.coverageValidation !== undefined && !isReviewCoverageValidation(ledger.coverageValidation))
    || (ledger.lastAttempt !== undefined && !isReviewLedgerAttempt(ledger.lastAttempt))) {
    throw new Error("Review ledger is incompatible or incomplete");
  }
  return ledger as Ledger;
}

async function readLedger(path: string): Promise<Ledger | undefined> {
  try {
    return validateLedger(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  ledger.updatedAt = new Date().toISOString();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function withLedgerLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  if (locks.has(lockPath)) throw new Error("A review operation is already active for this session");
  locks.add(lockPath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        acquired = true;
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}
`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const metadata = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
          if (Number.isInteger(metadata.pid) && (metadata.pid as number) > 0) {
            try { process.kill(metadata.pid as number, 0); }
            catch (probeError) { stale = (probeError as NodeJS.ErrnoException).code === "ESRCH"; }
          }
        } catch {}
        if (!stale || attempt > 0) throw new Error("A review operation is already active for this session");
        await unlink(lockPath);
      }
    }
    if (!handle) throw new Error("Could not acquire the review session lock");
    return await fn();
  } finally {
    try { await handle?.close(); } catch {}
    if (acquired) {
      try { await unlink(lockPath); } catch {}
    }
    locks.delete(lockPath);
  }
}

function cleanItems(items: readonly string[]): string[] {
  return items.slice(0, 20).map((item) => text(item)).filter(Boolean);
}

function cleanContract(contract: ReviewContract): ReviewContract {
  return {
    guarantees: cleanItems(contract.guarantees),
    nonGoals: cleanItems(contract.nonGoals),
    riskAreas: cleanItems(contract.riskAreas),
    requiredChecks: cleanItems(contract.requiredChecks),
    ...(contract.source ? { source: text(contract.source) } : {}),
  };
}

function headingItems(body: string, heading: string): string[] {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^###\\s+${escaped}\\s*$([\\s\\S]*?)(?=^###\\s+|^##\\s+|(?![\\s\\S]))`, "imu").exec(body);
  if (!match) return [];
  return (match[1] ?? "").split("\n")
    .map((line) => /^\s*[-*]\s+(.+)$/u.exec(line)?.[1] ?? "")
    .map((item) => text(item))
    .filter(Boolean)
    .slice(0, 20);
}

export function parseReviewContract(body: string, source?: string): ReviewContract {
  const contract = cleanContract({
    guarantees: headingItems(body, "Guarantees"),
    nonGoals: headingItems(body, "Non-goals"),
    riskAreas: headingItems(body, "Risk areas"),
    requiredChecks: headingItems(body, "Required checks"),
    ...(source ? { source } : {}),
  });
  if (Buffer.byteLength(JSON.stringify(contract), "utf8") > 24 * 1024) throw new Error("Review contract is too large");
  return contract;
}

async function planData(planPath: string | undefined, supplied?: ReviewContract, cwd = process.cwd()): Promise<{ planPath?: string; planHash?: string; contract: ReviewContract }> {
  if (!planPath) return { contract: cleanContract(supplied ?? { guarantees: [], nonGoals: [], riskAreas: [], requiredChecks: [] }) };
  const canonical = await realpath(isAbsolute(planPath) ? planPath : resolve(cwd, planPath));
  const body = await readFile(canonical, "utf8");
  const extracted = parseReviewContract(body, canonical);
  return { planPath: canonical, planHash: hash(body), contract: cleanContract(supplied ?? extracted) };
}

export async function deriveImplementationId(cwd: string, planPath: string, commands: CommandRunner): Promise<string> {
  const root = await repositoryRoot(cwd, commands);
  const canonicalPlan = await realpath(isAbsolute(planPath) ? planPath : resolve(cwd, planPath));
  const shortRef = (await command(commands, cwd, "git", ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const branchIdentity = shortRef === "HEAD"
    ? (await command(commands, cwd, "git", ["rev-parse", "HEAD"])).trim()
    : shortRef;
  return hash(`${root}|${branchIdentity}|${canonicalPlan}`).slice(0, 32);
}

async function baseSha(cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<string> {
  const main = await optionalCommand(commands, cwd, "git", ["rev-parse", "--verify", "main^{commit}"], signal)
    ?? await optionalCommand(commands, cwd, "git", ["rev-parse", "--verify", "origin/main^{commit}"], signal);
  if (!main?.trim()) throw new Error("Could not resolve main or origin/main for managed review");
  return (await command(commands, cwd, "git", ["merge-base", "HEAD", main.trim()], signal)).trim();
}

async function observedBaseSha(target: ReviewTarget, cwd: string, dependencies: ReviewDependencies, signal?: AbortSignal): Promise<string> {
  if (target.kind !== "pull-request") return baseSha(cwd, dependencies.commands, signal);
  const snapshot = await captureReviewSnapshot(target, cwd, dependencies.commands, signal);
  if (!snapshot.baseSha) throw new Error("Pull-request review could not resolve the current base SHA");
  return snapshot.baseSha;
}

async function requireClean(cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<void> {
  if ((await command(commands, cwd, "git", ["status", "--porcelain"], signal)).trim()) {
    throw new Error("Managed review requires a clean committed worktree. Commit the intended implementation or remediation first.");
  }
}

function pathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (match?.[2]) paths.add(match[2]);
  }
  return [...paths].sort();
}

function reviewHash(target: ReviewTarget, diff: string, paths: readonly string[], base: string, head: string): string {
  return hash(JSON.stringify({ target, diff, paths, base, head }));
}

async function localSnapshot(target: ReviewTarget, cwd: string, commands: CommandRunner, phase: ReviewPhase, previousHead?: string, signal?: AbortSignal): Promise<ReviewSnapshot> {
  await requireClean(cwd, commands, signal);
  const head = (await command(commands, cwd, "git", ["rev-parse", "HEAD"], signal)).trim();
  const base = phase === "initial" ? await baseSha(cwd, commands, signal) : previousHead;
  if (!base) throw new Error(`${phase} review requires a previously reviewed head`);
  if (phase !== "initial") {
    const ancestor = await commands.run("git", ["merge-base", "--is-ancestor", base, head], { cwd, signal });
    if (ancestor.exitCode !== 0) throw new Error("The reviewed head is not an ancestor of the current head; reset is required");
    if (base === head) throw new Error("No committed remediation delta exists for the next review phase");
  }
  const range = `${base}...${head}`;
  const diff = await command(commands, cwd, "git", ["diff", "--find-renames", "--find-copies", range], signal);
  const paths = pathsFromDiff(diff);
  return { target, cwd, changedPaths: paths, diff, snapshotHash: reviewHash(target, diff, paths, base, head), baseSha: base, headSha: head };
}

async function managedSnapshot(input: ManagedReviewRunInput & { readonly target: ReviewTarget }, phase: ReviewPhase, previousHead: string | undefined, dependencies: ReviewDependencies, signal?: AbortSignal): Promise<ReviewSnapshot> {
  if (input.target.kind !== "pull-request") return localSnapshot(input.target, input.cwd, dependencies.commands, phase, previousHead, signal);
  if (phase === "initial") return captureReviewSnapshot(input.target, input.cwd, dependencies.commands, signal);
  const current = await captureReviewSnapshot(input.target, input.cwd, dependencies.commands, signal);
  const pr = current.pullRequest;
  if (!pr || !previousHead) throw new Error("Pull-request delta review requires prior review metadata");
  const compare = await command(dependencies.commands, current.cwd, "gh", [
    "api", `repos/${pr.repository}/compare/${previousHead}...${pr.headSha}`,
    "-H", "Accept: application/vnd.github.v3.diff",
  ], signal);
  const paths = pathsFromDiff(compare);
  return {
    ...current,
    changedPaths: paths,
    diff: compare,
    baseSha: previousHead,
    headSha: pr.headSha,
    snapshotHash: reviewHash(input.target, compare, paths, previousHead, pr.headSha),
  };
}

function summary(ledger: Ledger): ReviewLedgerSummary {
  const coverage = currentCoverage(ledger);
  const issues = ledgerCoverageIssues(ledger);
  const validation: ReviewCoverageValidation = {
    valid: issues.length === 0,
    issues,
  };
  return {
    sessionId: ledger.sessionId,
    ...(ledger.implementationId ? { implementationId: ledger.implementationId } : {}),
    target: ledger.target,
    targetIdentity: ledger.targetIdentity,
    phase: ledger.phase,
    decision: effectiveDecision(ledger),
    baseSha: ledger.baseSha,
    ...(ledger.lastReviewedHead ? { lastReviewedHead: ledger.lastReviewedHead } : {}),
    ...(ledger.lastReviewedSnapshotHash ? { lastReviewedSnapshotHash: ledger.lastReviewedSnapshotHash } : {}),
    completedPasses: ledger.completedPasses,
    remediationBatches: ledger.remediationBatches,
    incompleteAttemptsThisPhase: ledger.incompleteAttemptsThisPhase,
    awaitingAdjudication: ledger.awaitingAdjudication,
    findings: ledger.findings,
    coverage,
    coverageValidation: validation,
    ...(ledger.workLimitPolicy === undefined ? {} : { workLimitPolicy: ledger.workLimitPolicy }),
    ...(ledger.lastAttempt ? { lastAttempt: ledger.lastAttempt } : {}),
  };
}

async function findLedger(directory: string, sessionId?: string, implementationId?: string): Promise<{ path: string; ledger: Ledger } | undefined> {
  if (sessionId) {
    const path = pathFor(directory, sessionId);
    const ledger = await readLedger(path);
    return ledger ? { path, ledger } : undefined;
  }
  for (const name of await (await import("node:fs/promises")).readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const ledger = await readLedger(path);
    if (ledger && implementationId && ledger.implementationId === implementationId) return { path, ledger };
  }
  return undefined;
}

function newLedger(root: string, target: ReviewTarget, base: string, implementationId: string | undefined, plan: Awaited<ReturnType<typeof planData>>): Ledger {
  const created = new Date().toISOString();
  const canonical = canonicalTarget(target);
  const identity = targetIdentity(canonical);
  const sessionId = hash(`${root}|${identity}|${base}|${implementationId ?? ""}|${plan.planHash ?? ""}`).slice(0, 32);
  return {
    version: 2,
    policyVersion: 2,
    sessionId,
    ...(implementationId ? { implementationId } : {}),
    repositoryRoot: root,
    target: canonical,
    targetIdentity: identity,
    baseSha: base,
    ...(plan.planPath ? { planPath: plan.planPath } : {}),
    ...(plan.planHash ? { planHash: plan.planHash } : {}),
    contract: plan.contract,
    phase: "initial",
    decision: "incomplete",
    completedPasses: 0,
    remediationBatches: 0,
    incompleteAttemptsThisPhase: 0,
    awaitingAdjudication: false,
    findings: [],
    coverage: unknownCoverage("", "no review attempt has completed"),
    coverageValidation: { valid: false, issues: ["coverage is unknown", "no review attempt has completed"] },
    createdAt: created,
    updatedAt: created,
  };
}

function selectPhase(ledger: Ledger, requested: ManagedReviewRunInput["requestedPhase"]): ReviewPhase {
  if (ledger.phase === "blocked" || ledger.decision === "blocked") throw new Error("This review session is blocked; do not run another pass");
  if (ledger.awaitingAdjudication) throw new Error("Record parent dispositions for the last review before running another pass");
  if (ledger.completedPasses >= MAX_PASSES) throw new Error("No fourth review pass is permitted");
  const expected = ledger.completedPasses === 0 ? "initial" : ledger.completedPasses === 1 ? "delta" : "final";
  if (requested !== "auto" && requested !== expected) {
    throw new Error(`Review phase ${requested} is out of order; the next permitted phase is ${expected}`);
  }
  return expected;
}

function rootKey(finding: VerifiedFinding): string {
  return `root:${hash(`${finding.category}|${normalize(finding.rootCauseKey)}`).slice(0, 20)}`;
}

function mergeFindings(ledger: Ledger, findings: readonly VerifiedFinding[], head: string, phase: ReviewPhase): VerifiedFinding[] {
  const nextNumber = () => `REV-${String(ledger.findings.length + 1).padStart(3, "0")}`;
  const output: VerifiedFinding[] = [];
  for (const finding of findings.slice(0, 5)) {
    const key = rootKey(finding);
    let entry = ledger.findings.find((item) => item.rootCauseKey === key);
    if (!entry) {
      entry = {
        id: nextNumber(), rootCauseKey: key, severity: finding.severity, confidence: finding.confidence,
        status: "candidate", firstObservedHead: head, lastVerifiedHead: head, introducedByDelta: phase !== "initial",
        file: finding.file, line: finding.line, trigger: text(finding.failureScenario, 1_000),
        impact: text(finding.summary), evidence: text(finding.verification || finding.evidence, 2_000),
      };
      ledger.findings.push(entry);
    } else {
      entry.lastVerifiedHead = head;
      entry.file = finding.file;
      entry.line = finding.line;
      entry.confidence = finding.confidence;
      entry.evidence = text(finding.verification || finding.evidence, 2_000);
      if (entry.status === "resolved" || entry.status === "not-reproducible") entry.status = "candidate";
    }
    output.push({ ...finding, id: entry.id });
  }
  return output;
}

function coverageReportLines(ledger: Ledger): string[] {
  const coverage = currentCoverage(ledger);
  const issues = ledgerCoverageIssues(ledger);
  const gaps = coverage.uncoveredUnitIds.length || coverage.uncoveredCandidates.length || 0;
  const budget = coverage.budget;
  const lines = [
    `**Coverage:** ${coverage.state} (snapshot ${coverage.snapshotHash ? `\`${coverage.snapshotHash.slice(0, 12)}\`` : "unknown"})`,
    `**Coverage policy:** ${coverage.policy ?? "unknown"}${coverage.policyVersion === undefined ? "" : ` v${coverage.policyVersion}`}`,
    `**Coverage budget:** ${budget ? `${budget.spentWeight}/${budget.maxWeight} weighted units spent` : "unknown"}`,
  ];
  if (gaps > 0) lines.push(`**Coverage gaps:** ${gaps} bounded gap(s)`);
  if (coverage.unvalidatedCandidates?.length) lines.push(`**Unvalidated candidates:** ${coverage.unvalidatedCandidates.length}`);
  if (issues.length) lines.push(`**Coverage evidence:** ${issues.slice(0, 3).join("; ")}`);
  return lines;
}

function managedReport(decision: ReviewDecision, ledger: Ledger, phase: string, findings: readonly VerifiedFinding[], note = ""): string {
  const lines = [
    `## Decision: ${decision.toUpperCase().replaceAll("-", " ")}`,
    "",
    `**Session:** \`${ledger.sessionId}\``,
    `**Phase:** ${phase}`,
    `**Passes:** ${ledger.completedPasses}/${MAX_PASSES}`,
    `**Remediation batches:** ${ledger.remediationBatches}/${MAX_REMEDIATIONS}`,
    ...coverageReportLines(ledger),
  ];
  if (findings.length) {
    lines.push("", "### Candidate findings requiring parent adjudication", "");
    for (const finding of findings) lines.push(`- **${finding.id} · ${finding.severity} · ${finding.confidence}%** ${finding.summary} — ${finding.file}:${finding.line}`);
  }
  const open = ledger.findings.filter((finding) => finding.status === "open");
  if (open.length) {
    lines.push("", "### Open blockers requiring resolution", "");
    for (const finding of open) lines.push(`- **${finding.id} · ${finding.severity} · ${finding.confidence}%** ${finding.impact} — ${finding.file}:${finding.line}`);
  }
  if (note) lines.push("", note);
  lines.push("", decision === "awaiting-adjudication"
    ? "Inspect each candidate, then call code_review with action=record before editing."
    : decision === "request-changes"
      ? "Apply one coherent remediation commit, then run phase=auto."
      : decision === "blocked"
        ? "The bounded review lifecycle is exhausted. Stop for architecture/product attention or explicitly reset."
        : decision === "incomplete"
          ? "The review is incomplete and reached neither an approval nor a blocker conclusion. Retry this phase within the bounded lifecycle."
          : "No open validated blocker remains for the reviewed committed head.");
  return lines.join("\n");
}

function persistAttempt(
  ledger: Ledger,
  expectedSnapshotHash: string,
  pass: ReviewResult | undefined,
  message: string,
  extraIssues: readonly string[] = [],
  expectedWorkLimitPolicy: WorkLimitPolicy = DEFAULT_WORK_LIMIT_POLICY,
): string[] {
  const suppliedCoverage = pass?.coverage === undefined
    ? undefined
    : {
        ...pass.coverage,
        ...(pass.coverage.policyVersion === undefined ? { policyVersion: REVIEW_WORK_POLICY_VERSION } : {}),
        ...(pass.coverage.policy === undefined ? { policy: REVIEW_WORK_POLICY } : {}),
        ...(pass.coverage.workLimitPolicy === undefined ? { workLimitPolicy: expectedWorkLimitPolicy } : {}),
      };
  const coverage = cleanCoverage(suppliedCoverage, expectedSnapshotHash, pass ? "review pipeline did not provide coverage" : message);
  ledger.workLimitPolicy = expectedWorkLimitPolicy;
  const issues = [
    ...coverageIssues(coverage, expectedSnapshotHash, expectedWorkLimitPolicy),
    ...(pass && pass.status !== "complete" ? [`review result status is ${pass.status}`] : []),
    ...(pass && pass.failures.length > 0 ? ["review result contains failures"] : []),
    ...extraIssues,
  ];
  const failures = cleanFailures(pass?.failures ?? []);
  const failureMessages = new Set(failures.map((failure) => failure.message));
  for (const issue of issues) {
    if (failureMessages.has(issue)) continue;
    failures.push({ stage: "eligibility", message: text(issue) });
    failureMessages.add(issue);
  }
  if (!pass && failures.length === 0 && message) failures.push({ stage: "eligibility", message: text(message) });
  const findings = (pass?.findings ?? []).slice(0, MAX_PERSISTED_FINDINGS).map(cleanFinding);
  const usage = (pass?.usage ?? []).slice(0, MAX_PERSISTED_USAGE).map(cleanUsage);
  const validationIssues = [...new Set(issues)];
  const persistedFailures = failures.slice(0, MAX_PERSISTED_FAILURES);
  const validation: ReviewCoverageValidation = { valid: validationIssues.length === 0, issues: validationIssues };
  ledger.coverage = coverage;
  ledger.coverageValidation = validation;
  ledger.lastAttempt = {
    version: 1,
    snapshotHash: text(expectedSnapshotHash, 300),
    coverage,
    findings,
    failures: persistedFailures,
    usage,
    ...(validationIssues.length ? { validationIssues } : {}),
  };
  return validationIssues;
}

function resultFromLedger(ledger: Ledger, note: string): ReviewResult {
  const decision = effectiveDecision(ledger);
  const attempt = ledger.lastAttempt;
  const incomplete = decision === "incomplete" || decision === "blocked";
  const attemptFindings = incomplete ? attempt?.findings ?? [] : [];
  const attemptFailures = incomplete ? attempt?.failures ?? [] : [];
  const attemptUsage = incomplete ? attempt?.usage ?? [] : [];
  const resultSnapshotHash = attempt?.snapshotHash || ledger.lastReviewedSnapshotHash;
  return {
    effort: "normal", status: incomplete ? "incomplete" : "complete", summary: note,
    findings: attemptFindings, failures: attemptFailures, commented: false, usage: attemptUsage, report: managedReport(decision, ledger, ledger.phase, attemptFindings, note),
    coverage: currentCoverage(ledger),
    decision, sessionId: ledger.sessionId, ...(resultSnapshotHash ? { reviewedSnapshotHash: resultSnapshotHash } : {}),
    ledger: summary(ledger), ...(ledger.phase === "initial" || ledger.phase === "delta" || ledger.phase === "final" ? { phase: ledger.phase } : {}),
  };
}

async function markIncomplete(
  path: string,
  ledger: Ledger,
  phase: ReviewPhase,
  message: string,
  expectedSnapshotHash = "",
  pass?: ReviewResult,
  extraIssues: readonly string[] = [],
  expectedWorkLimitPolicy: WorkLimitPolicy = DEFAULT_WORK_LIMIT_POLICY,
): Promise<ReviewResult> {
  persistAttempt(ledger, expectedSnapshotHash, pass, message, extraIssues, expectedWorkLimitPolicy);
  ledger.incompleteAttemptsThisPhase += 1;
  ledger.decision = ledger.incompleteAttemptsThisPhase >= MAX_INCOMPLETE ? "blocked" : "incomplete";
  // An incomplete attempt is not an adjudicable pass. Keep the historical
  // head/pass counters intact but identify the phase that was attempted.
  if (ledger.decision === "blocked") ledger.phase = "blocked";
  else ledger.phase = phase;
  ledger.awaitingAdjudication = false;
  await writeLedger(path, ledger);
  return resultFromLedger(ledger, `${phase} review incomplete: ${message}`);
}

async function revalidateManagedSnapshot(
  target: ReviewTarget,
  snapshot: ReviewSnapshot,
  ledger: Ledger,
  dependencies: ReviewDependencies,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    await requireClean(snapshot.cwd, dependencies.commands, signal);
    const localHead = (await command(dependencies.commands, snapshot.cwd, "git", ["rev-parse", "HEAD"], signal)).trim();
    if (!snapshot.headSha || localHead !== snapshot.headSha) return "The local checkout changed or no longer matches the reviewed head";
    if (target.kind === "branch") {
      const branchHead = (await command(dependencies.commands, snapshot.cwd, "git", ["rev-parse", `${target.ref}^{commit}`], signal)).trim();
      if (branchHead !== snapshot.headSha) return "The reviewed branch ref changed during review";
    }
    if (target.kind === "pull-request") {
      const remote = await captureReviewSnapshot(target, snapshot.cwd, dependencies.commands, signal);
      if (remote.baseSha !== ledger.baseSha) return "The pull-request base changed during review";
      if (remote.headSha !== snapshot.headSha) return "The pull-request head changed during review";
    }
    if (ledger.planPath) {
      const currentPlan = await planData(ledger.planPath, undefined, snapshot.cwd);
      if (currentPlan.planHash !== ledger.planHash) return "The approved plan changed during review";
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function approvedHeadStillCurrent(
  target: ReviewTarget,
  ledger: Ledger,
  cwd: string,
  dependencies: ReviewDependencies,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ledger.lastReviewedHead) return false;
  const targetCwd = target.kind === "worktree" ? target.path : cwd;
  await requireClean(targetCwd, dependencies.commands, signal);
  const localHead = (await command(dependencies.commands, targetCwd, "git", ["rev-parse", "HEAD"], signal)).trim();
  if (localHead !== ledger.lastReviewedHead) return false;
  if (target.kind === "branch") {
    const branchHead = (await command(dependencies.commands, targetCwd, "git", ["rev-parse", `${target.ref}^{commit}`], signal)).trim();
    if (branchHead !== ledger.lastReviewedHead) return false;
  }
  if (target.kind === "pull-request") {
    const remote = await captureReviewSnapshot(target, targetCwd, dependencies.commands, signal);
    return remote.baseSha === ledger.baseSha && remote.headSha === ledger.lastReviewedHead;
  }
  return true;
}

export async function runManagedReview(input: ManagedReviewRunInput, dependencies: ReviewDependencies, signal?: AbortSignal): Promise<ReviewResult> {
  const root = await repositoryRoot(input.cwd, dependencies.commands, signal);
  const directory = await stateDirectory(input.cwd, dependencies.commands);
  const requestedPlan = input.planPath !== undefined || input.contract !== undefined
    ? await planData(input.planPath, input.contract, input.cwd)
    : undefined;
  const requestedImplementationId = input.implementationId
    ?? (input.planPath ? await deriveImplementationId(input.cwd, input.planPath, dependencies.commands) : undefined);
  const existing = await findLedger(directory, input.sessionId, requestedImplementationId);
  if (input.sessionId && !existing) throw new Error(`Review session not found: ${input.sessionId}`);
  if (existing && input.implementationId && existing.ledger.implementationId !== input.implementationId) {
    throw new Error("The supplied implementation ID does not match the review session");
  }
  const target = canonicalTarget(input.target ?? existing?.ledger.target ?? (() => { throw new Error("Managed review requires a target or existing session ID"); })());
  if (target.kind === "path") throw new Error("Managed review does not support path-only targets");
  if (existing && existing.ledger.targetIdentity !== targetIdentity(target)) {
    throw new Error("The supplied target does not match the review session");
  }
  const plan: Awaited<ReturnType<typeof planData>> = requestedPlan
    ?? (existing?.ledger.planPath
      ? await planData(existing.ledger.planPath, undefined, input.cwd)
      : existing
        ? { contract: existing.ledger.contract }
        : await planData(undefined, input.contract));
  const observedBase = await observedBaseSha(target, input.cwd, dependencies, signal);
  const ledger = existing?.ledger ?? newLedger(root, target, observedBase, requestedImplementationId, plan);
  const path = existing?.path ?? pathFor(directory, ledger.sessionId);

  return withLedgerLock(path, async () => {
    const current = await readLedger(path) ?? ledger;
    if (current.repositoryRoot !== root || current.targetIdentity !== targetIdentity(target)
      || current.planHash !== plan.planHash) {
      throw new Error("Existing review state does not match this repository, target, or approved plan");
    }
    if (current.baseSha !== observedBase) {
      current.phase = "blocked";
      current.decision = "blocked";
      await writeLedger(path, current);
      return resultFromLedger(current, "The review base changed after the session started; explicit reset is required.");
    }
    if (input.requestedPhase === "auto" && (current.decision === "approve" || current.decision === "comment") && coverageAuthorized(current)) {
      try {
        if (await approvedHeadStillCurrent(target, current, input.cwd, dependencies, signal)) {
          return resultFromLedger(current, "The current committed head is already review-complete.");
        }
      } catch (error) {
        return markIncomplete(path, current, current.completedPasses === 0 ? "initial" : current.completedPasses === 1 ? "delta" : "final", error instanceof Error ? error.message : String(error), "", undefined, [], input.workLimitPolicy ?? DEFAULT_WORK_LIMIT_POLICY);
      }
    }
    const phase = selectPhase(current, input.requestedPhase);
    if (phase !== "initial" && current.remediationBatches >= MAX_REMEDIATIONS) {
      current.phase = "blocked";
      current.decision = "blocked";
      await writeLedger(path, current);
      return resultFromLedger(current, "The two-remediation-batch budget is exhausted.");
    }

    let snapshot: ReviewSnapshot;
    try {
      snapshot = await managedSnapshot({ ...input, target }, phase, current.lastReviewedHead, dependencies, signal);
    } catch (error) {
      return markIncomplete(path, current, phase, error instanceof Error ? error.message : String(error), "", undefined, [], input.workLimitPolicy ?? DEFAULT_WORK_LIMIT_POLICY);
    }
    const beforeError = await revalidateManagedSnapshot(target, snapshot, current, dependencies, signal);
    if (beforeError) return markIncomplete(path, current, phase, beforeError, snapshot.snapshotHash, undefined, [beforeError], input.workLimitPolicy ?? DEFAULT_WORK_LIMIT_POLICY);
    const options: ReviewOptions = {
      cwd: snapshot.cwd,
      target,
      comment: false,
      effort: phase === "initial" ? input.effort : "normal",
      phase,
      contract: current.contract,
      snapshot,
      openFindings: current.findings.filter((finding) => finding.status === "open").slice(0, 3),
      ...(input.maxReviewWorkUnits === undefined ? {} : { maxReviewWorkUnits: input.maxReviewWorkUnits }),
      ...(input.workLimitPolicy === undefined ? {} : { workLimitPolicy: input.workLimitPolicy }),
    };
    let pass: ReviewResult;
    try {
      pass = await runCodeReview(options, dependencies, signal);
    } catch (error) {
      return markIncomplete(path, current, phase, error instanceof Error ? error.message : String(error), snapshot.snapshotHash, undefined, [], input.workLimitPolicy ?? DEFAULT_WORK_LIMIT_POLICY);
    }
    const afterError = await revalidateManagedSnapshot(target, snapshot, current, dependencies, signal);
    if (afterError) {
      return markIncomplete(path, current, phase, afterError, snapshot.snapshotHash, pass, [afterError], input.workLimitPolicy ?? DEFAULT_WORK_LIMIT_POLICY);
    }
    const passIssues = persistAttempt(
      current,
      snapshot.snapshotHash,
      pass,
      pass.summary,
      [],
      input.workLimitPolicy ?? DEFAULT_WORK_LIMIT_POLICY,
    );
    if (pass.status !== "complete" || passIssues.length > 0) {
      const message = passIssues.length > 0
        ? passIssues.join("; ")
        : pass.failures.map((failure) => `${failure.stage}: ${failure.message}`).join("; ") || pass.summary;
      return markIncomplete(path, current, phase, message, snapshot.snapshotHash, pass, passIssues, input.workLimitPolicy ?? DEFAULT_WORK_LIMIT_POLICY);
    }
    if (phase !== "initial") current.remediationBatches += 1;

    current.phase = phase;
    current.decision = "awaiting-adjudication";
    current.completedPasses += 1;
    current.incompleteAttemptsThisPhase = 0;
    current.lastReviewedHead = snapshot.headSha!;
    current.lastReviewedSnapshotHash = snapshot.snapshotHash;
    current.initialReviewedHead ??= snapshot.headSha!;
    const mapped = mergeFindings(current, pass.findings, snapshot.headSha!, phase);
    if (current.lastAttempt) current.lastAttempt = { ...current.lastAttempt, findings: mapped.slice(0, MAX_PERSISTED_FINDINGS).map(cleanFinding) };
    current.awaitingAdjudication = mapped.length > 0 || current.findings.some((finding) => finding.status === "open");
    if (!current.awaitingAdjudication) {
      current.phase = "approved";
      current.decision = current.findings.some((finding) => ["non-blocking", "accepted-risk", "product-decision", "follow-up"].includes(finding.status)) ? "comment" : "approve";
    }
    await writeLedger(path, current);
    return {
      ...pass,
      findings: mapped,
      coverage: currentCoverage(current),
      report: managedReport(current.decision, current, phase, mapped),
      phase,
      decision: current.decision,
      sessionId: current.sessionId,
      reviewedSnapshotHash: snapshot.snapshotHash,
      ledger: summary(current),
    };
  });
}

function statusFor(disposition: FindingDisposition): FindingLedgerStatus {
  return disposition === "confirmed-blocker" ? "open" : disposition;
}

function blockerAllowed(finding: MutableFinding, disposition: FindingDispositionInput): boolean {
  if (!text(disposition.parentEvidence, 2_000)) return false;
  if ((finding.severity === "critical" || finding.severity === "high") && finding.confidence >= 80) return true;
  return finding.severity === "medium" && finding.confidence >= 90 && disposition.deterministic === true && Boolean(text(disposition.contractBasis));
}

export async function recordReviewDispositions(input: RecordReviewInput, dependencies: Pick<ReviewDependencies, "commands">): Promise<ReviewResult> {
  const directory = await stateDirectory(input.cwd, dependencies.commands);
  const path = pathFor(directory, input.sessionId);
  return withLedgerLock(path, async () => {
    const ledger = await readLedger(path);
    if (!ledger) throw new Error(`Review session not found: ${input.sessionId}`);
    const status = await getReviewStatus(input.cwd, dependencies, { sessionId: input.sessionId, target: ledger.target });
    if (!status || status.stale) throw new Error("The target or approved plan changed after review; stale dispositions were not recorded");
    const authorizationIssues = ledgerCoverageIssues(ledger);
    if (authorizationIssues.length > 0) {
      throw new Error(`Cannot record review dispositions: coverage cannot authorize approval (${authorizationIssues.slice(0, 4).join("; ")}). Retry the managed review with the current policy and snapshot.`);
    }
    if (!ledger.awaitingAdjudication || ledger.lastReviewedSnapshotHash !== input.reviewedSnapshotHash) throw new Error("Adjudication is stale or this session is not awaiting it");
    const seen = new Set<string>();
    for (const disposition of input.dispositions) {
      if (!FINDING_DISPOSITIONS.has(disposition.disposition)) {
        throw new Error(`Unknown finding disposition for ${disposition.id}: ${String(disposition.disposition)}`);
      }
      if (seen.has(disposition.id)) throw new Error(`Duplicate disposition for ${disposition.id}`);
      seen.add(disposition.id);
      const finding = ledger.findings.find((item) => item.id === disposition.id);
      if (!finding) throw new Error(`Unknown review finding: ${disposition.id}`);
      if (disposition.disposition === "confirmed-blocker" && !blockerAllowed(finding, disposition)) {
        throw new Error(`${finding.id} does not meet the blocker evidence/severity gate`);
      }
      if (disposition.disposition === "resolved"
        && (finding.status !== "open" || ledger.completedPasses < 2 || !text(disposition.parentEvidence, 2_000))) {
        throw new Error(`${finding.id} can be resolved only after an open blocker has a reviewed remediation and parent evidence`);
      }
      finding.status = statusFor(disposition.disposition);
      if (disposition.parentEvidence) finding.parentEvidence = text(disposition.parentEvidence, 2_000);
      if (disposition.contractBasis) finding.contractBasis = text(disposition.contractBasis);
      finding.lastVerifiedHead = ledger.lastReviewedHead ?? finding.lastVerifiedHead;
    }
    const candidates = ledger.findings.filter((finding) => finding.status === "candidate");
    const open = ledger.findings.filter((finding) => finding.status === "open");
    ledger.awaitingAdjudication = candidates.length > 0;
    if (candidates.length) ledger.decision = "awaiting-adjudication";
    else if (open.length) {
      ledger.decision = ledger.completedPasses >= MAX_PASSES ? "blocked" : "request-changes";
      if (ledger.decision === "blocked") ledger.phase = "blocked";
    } else {
      ledger.phase = "approved";
      ledger.decision = ledger.findings.some((finding) => ["non-blocking", "accepted-risk", "product-decision", "follow-up"].includes(finding.status)) ? "comment" : "approve";
    }
    await writeLedger(path, ledger);
    return resultFromLedger(ledger, candidates.length ? `${candidates.length} candidate(s) still need disposition.`
      : open.length ? `${open.length} confirmed blocker root cause(s) require one coherent remediation commit.`
        : "No open blocker remains for the reviewed committed head.");
  });
}

async function locate(cwd: string, commands: CommandRunner, options: { sessionId?: string; implementationId?: string; planPath?: string }): Promise<{ path: string; ledger: Ledger } | undefined> {
  const directory = await stateDirectory(cwd, commands);
  const implementationId = options.implementationId ?? (options.planPath ? await deriveImplementationId(cwd, options.planPath, commands) : undefined);
  return findLedger(directory, options.sessionId, implementationId);
}

function nextAction(ledger: Ledger, stale: boolean, planChanged = false): string {
  if (ledger.decision === "blocked") return "Stop for architecture/product attention or explicitly reset the session.";
  if (planChanged) return "The approved plan changed after review; reapprove it and explicitly reset before another managed review.";
  if (!coverageAuthorized(ledger)) return "Coverage is not approval-authorized; retry this managed review with the current snapshot and policy.";
  if (ledger.awaitingAdjudication) return "Inspect candidates and record parent dispositions before editing.";
  if (ledger.decision === "request-changes") return "Apply one coherent remediation commit, then run phase=auto.";
  if (ledger.decision === "incomplete") return "Fix the target/reviewer problem, then retry the same phase.";
  if (stale) return "The target changed or the worktree is dirty; commit the intended state and run phase=auto.";
  return "The reviewed committed head is complete; run required project checks before sign-off.";
}

export async function getReviewStatus(cwd: string, dependencies: Pick<ReviewDependencies, "commands">, options: { sessionId?: string; implementationId?: string; planPath?: string; target?: ReviewTarget }, signal?: AbortSignal): Promise<ReviewStatus | undefined> {
  const found = await locate(cwd, dependencies.commands, options);
  if (!found) return undefined;
  const target = canonicalTarget(options.target ?? found.ledger.target);
  if (targetIdentity(target) !== found.ledger.targetIdentity) throw new Error("The supplied status target does not match the review session");
  const targetCwd = target.kind === "worktree" ? target.path : cwd;
  const localHead = (await command(dependencies.commands, targetCwd, "git", ["rev-parse", "HEAD"], signal)).trim();
  const dirty = Boolean((await command(dependencies.commands, targetCwd, "git", ["status", "--porcelain"], signal)).trim());
  let currentHead = localHead;
  let targetMismatch = false;
  if (target.kind === "branch") {
    const branchHead = (await command(dependencies.commands, targetCwd, "git", ["rev-parse", `${target.ref}^{commit}`], signal)).trim();
    targetMismatch = branchHead !== localHead;
  } else if (target.kind === "pull-request") {
    const remote = await captureReviewSnapshot(target, targetCwd, dependencies.commands, signal);
    currentHead = remote.headSha ?? "";
    targetMismatch = remote.baseSha !== found.ledger.baseSha || remote.headSha !== localHead;
  }
  const planPath = options.planPath ?? found.ledger.planPath;
  const currentPlan = planPath ? await planData(planPath, undefined, cwd) : undefined;
  const planChanged = Boolean(planPath && currentPlan?.planHash !== found.ledger.planHash);
  const stale = planChanged || dirty || targetMismatch || !currentHead
    || Boolean(found.ledger.lastReviewedHead && currentHead !== found.ledger.lastReviewedHead);
  const ledgerSummary = summary(found.ledger);
  return {
    ...ledgerSummary,
    coverage: ledgerSummary.coverage ?? currentCoverage(found.ledger),
    coverageValidation: ledgerSummary.coverageValidation ?? { valid: false, issues: ledgerCoverageIssues(found.ledger) },
    currentHead,
    stale,
    nextAction: nextAction(found.ledger, stale, planChanged),
  };
}

export async function resetReviewSession(cwd: string, dependencies: Pick<ReviewDependencies, "commands">, options: { sessionId?: string; implementationId?: string; planPath?: string; confirm: boolean }): Promise<string> {
  if (!options.confirm) throw new Error("Review reset requires explicit confirmation");
  const found = await locate(cwd, dependencies.commands, options);
  if (!found) return "No matching review session exists.";
  await withLedgerLock(found.path, () => rm(found.path, { force: true }));
  return `Review session ${found.ledger.sessionId} was reset.`;
}

export function formatStatusReport(status: ReviewStatus | undefined): string {
  if (!status) return "### Code review status\n\nNo managed review session exists for this target or approved plan.";
  const open = status.findings.filter((finding) => finding.status === "open").length;
  const coverage = status.coverage;
  const budget = coverage.budget;
  return [
    "### Code review status", "", `**Session:** \`${status.sessionId}\``,
    `**Decision:** ${status.decision.toUpperCase().replaceAll("-", " ")}`,
    `**Phase:** ${status.phase}`, `**Passes:** ${status.completedPasses}/${MAX_PASSES}`,
    `**Remediation batches:** ${status.remediationBatches}/${MAX_REMEDIATIONS}`,
    `**Coverage:** ${coverage.state}`, `**Coverage snapshot:** ${coverage.snapshotHash ? `\`${coverage.snapshotHash.slice(0, 12)}\`` : "unknown"}`,
    `**Coverage policy:** ${coverage.policy ?? "unknown"}${coverage.policyVersion === undefined ? "" : ` v${coverage.policyVersion}`}`,
    `**Coverage gaps:** ${coverage.uncoveredUnitIds.length + coverage.uncoveredCandidates.length}`,
    `**Coverage budget:** ${budget ? `${budget.spentWeight}/${budget.maxWeight} weighted units spent` : "unknown"}`,
    ...(status.coverageValidation.issues.length ? [`**Coverage evidence:** ${status.coverageValidation.issues.slice(0, 3).join("; ")}`] : []),
    `**Open blockers:** ${open}`, `**Current head stale:** ${status.stale ? "yes" : "no"}`, "", status.nextAction,
  ].join("\n");
}
