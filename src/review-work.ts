import { createHash } from "node:crypto";
import { shardDiff } from "./diff-shards.js";
import {
  DEFAULT_MAX_REVIEW_WORK_UNITS,
  DEFAULT_WORK_LIMIT_POLICY,
  MAX_REVIEW_WORK_UNITS,
  REVIEW_WORK_POLICY,
  REVIEW_WORK_POLICY_VERSION,
  REVIEW_WORK_UNIT_WEIGHTS,
  reviewWorkUnitWeight,
} from "./types.js";
import type {
  DiffShard,
  ReviewCoverage,
  ReviewCoverageCandidate,
  ReviewCoverageRange,
  ReviewOptions,
  ReviewSnapshot,
  ReviewWorkManifest,
  ReviewWorkManifestRole,
  ReviewWorkObligation,
  ReviewWorkPlan,
  ReviewWorkRole,
  ReviewRole,
  ReviewWorkUnit,
  ReviewWorkUnitStatus,
  WorkLimitPolicy,
} from "./types.js";

/** Conservative generic default: primary diff work only. */
export const DEFAULT_REVIEW_WORK_ROLES: readonly ReviewWorkRole[] = Object.freeze(["diff"]);

export interface ReviewWorkPlanningOptions {
  readonly maxReviewWorkUnits?: number;
  readonly workLimitPolicy?: WorkLimitPolicy;
  /** Legacy role selector; agent-facing roles are mapped like manifest entries. */
  readonly roles?: readonly ReviewWorkManifestRole[];
  /** Explicit selective obligations, including agent-facing role names. */
  readonly manifest?: ReviewWorkManifest;
  /** Compatibility alias for callers that call the manifest obligations. */
  readonly obligations?: ReviewWorkManifest;
  readonly maxShardBytes?: number;
  readonly shards?: readonly DiffShard[];
}

export interface ReviewWorkInput {
  readonly snapshotHash: string;
  readonly diff: string;
}

export interface ReviewCoverageUpdate {
  readonly snapshotHash?: string;
  readonly coveredUnitIds?: readonly string[];
  readonly uncoveredUnitIds?: readonly string[];
  readonly attemptedUnitIds?: readonly string[];
  readonly attempts?: Readonly<Record<string, number>>;
  readonly reason?: string;
  readonly reasonByUnit?: Readonly<Record<string, string>>;
  readonly uncoveredRanges?: readonly ReviewCoverageRange[];
  /** Alias for callers that record range evidence rather than only gaps. */
  readonly uncoveredRangeEvidence?: readonly ReviewCoverageRange[];
  readonly uncoveredCandidates?: readonly ReviewCoverageCandidate[];
  readonly unvalidatedCandidates?: readonly ReviewCoverageCandidate[];
}

interface UnitDraft {
  readonly snapshotHash: string;
  readonly role: ReviewWorkRole;
  readonly agentRole?: ReviewRole;
  readonly trigger?: "always" | "risk" | "candidate";
  readonly shardIds: readonly string[];
  readonly ranges: readonly ReviewCoverageRange[];
  readonly dependencies: readonly string[];
  readonly weight: number;
  readonly id: string;
  readonly unsupportedReason?: string;
}

interface CoverageExtras {
  readonly reason?: string;
  readonly uncoveredRanges?: readonly ReviewCoverageRange[];
  readonly uncoveredCandidates?: readonly ReviewCoverageCandidate[];
  readonly policyVersion?: number;
  readonly policy?: string;
  readonly workLimitPolicy?: WorkLimitPolicy;
  readonly mode?: "single" | "sharded";
  readonly plannedShardIds?: readonly string[];
  readonly coveredShardIds?: readonly string[];
  readonly uncoveredShardIds?: readonly string[];
  readonly budgetMaxWeight?: number;
  readonly budgetReservedWeight?: number;
  readonly budgetSpentWeight?: number;
  readonly forceIncomplete?: boolean;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function freezeObject<T extends object>(value: T): T {
  return Object.freeze(value);
}

function unique(values: readonly string[]): readonly string[] {
  return freezeArray([...new Set(values)]);
}

function uniqueCandidates(values: readonly ReviewCoverageCandidate[]): readonly ReviewCoverageCandidate[] {
  const seen = new Set<string>();
  return freezeArray(values.filter((candidate) => {
    const key = `${candidate.id}\u0000${candidate.unitId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function workId(snapshotHash: string, role: ReviewWorkRole, key: string, agentRole?: ReviewRole): string {
  const identity = agentRole === undefined ? key : `${agentRole}:${key}`;
  const digest = createHash("sha256").update(`${snapshotHash}\u0000${role}\u0000${identity}`, "utf8").digest("hex").slice(0, 24);
  return `${snapshotHash}:work:${role}:${digest}`;
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("maxReviewWorkUnits must be a positive safe integer");
  if (value > MAX_REVIEW_WORK_UNITS) throw new RangeError(`maxReviewWorkUnits cannot exceed ${MAX_REVIEW_WORK_UNITS}`);
  return value;
}

function canonicalRole(role: ReviewWorkManifestRole): { readonly role: ReviewWorkRole; readonly agentRole?: ReviewRole } {
  const valid = new Set<ReviewWorkManifestRole>([
    "summary", "diff", "guidance", "contextual", "integration", "validator",
    "guidance-a", "guidance-b", "diff-only-bug", "contextual-bug",
  ]);
  if (!valid.has(role)) throw new RangeError(`unknown review work role: ${String(role)}`);
  if (role === "guidance-a" || role === "guidance-b" || role === "diff-only-bug" || role === "contextual-bug") {
    const mapped: ReviewWorkRole = role === "diff-only-bug" ? "diff" : role === "contextual-bug" ? "contextual" : "guidance";
    return { role: mapped, agentRole: role };
  }
  return { role };
}

function normalizeRoles(roles: readonly ReviewWorkManifestRole[] | undefined): readonly ReviewWorkObligation[] {
  const selected = roles ?? [];
  const valid = new Set<ReviewWorkManifestRole>([
    "summary", "diff", "guidance", "contextual", "integration", "validator",
    "guidance-a", "guidance-b", "diff-only-bug", "contextual-bug",
  ]);
  for (const role of selected) {
    if (!valid.has(role)) throw new RangeError(`unknown review work role: ${String(role)}`);
  }
  return freezeArray(selected.map((role) => ({ role })));
}

function manifestObligations(manifest: ReviewWorkManifest | undefined): readonly ReviewWorkObligation[] {
  if (manifest === undefined) return freezeArray([]);
  if (Array.isArray(manifest)) return freezeArray(manifest);
  if ("obligations" in manifest) return freezeArray(manifest.obligations);
  const obligations: ReviewWorkObligation[] = [];
  for (const [role, selection] of Object.entries(manifest)) {
    if (selection === false) continue;
    if (selection === true || selection === undefined) obligations.push({ role: role as ReviewWorkManifestRole });
    else if (Array.isArray(selection)) obligations.push({ role: role as ReviewWorkManifestRole, shardIds: selection });
    else obligations.push({ role: role as ReviewWorkManifestRole, ...selection });
  }
  return freezeArray(obligations);
}

function rangesForShard(shard: DiffShard, unitId: string): readonly ReviewCoverageRange[] {
  if (shard.ranges.length === 0 && !shard.supported) {
    return freezeArray([freezeObject({
      unitId,
      shardId: shard.id,
      fileIdentity: shard.fileIdentity,
      reason: "planned",
    })]);
  }
  return freezeArray(shard.ranges.map((range) => freezeObject({
    unitId,
    shardId: shard.id,
    fileIdentity: shard.fileIdentity,
    oldRange: range.oldRange,
    newRange: range.newRange,
    reason: "planned",
  })));
}

function makeDraft(
  snapshotHash: string,
  role: ReviewWorkRole,
  key: string,
  shardIds: readonly string[],
  ranges: readonly ReviewCoverageRange[],
  dependencies: readonly string[],
  unsupportedReason?: string,
  agentRole?: ReviewRole,
  trigger?: "always" | "risk" | "candidate",
): UnitDraft {
  return freezeObject({
    snapshotHash,
    role,
    ...(agentRole === undefined ? {} : { agentRole }),
    ...(trigger === undefined ? {} : { trigger }),
    shardIds: freezeArray(shardIds),
    ranges: freezeArray(ranges),
    dependencies: freezeArray(dependencies),
    weight: reviewWorkUnitWeight(role),
    id: workId(snapshotHash, role, key, agentRole),
    ...(unsupportedReason === undefined ? {} : { unsupportedReason }),
  });
}

interface NormalizedObligation {
  readonly role: ReviewWorkRole;
  readonly agentRole?: ReviewRole;
  readonly trigger?: "always" | "risk" | "candidate";
  readonly shardIds?: readonly string[];
}

const DRAFT_ROLE_ORDER: readonly ReviewWorkRole[] = Object.freeze([
  "diff",
  "summary",
  "guidance",
  "contextual",
  "integration",
  "validator",
]);

function createDrafts(
  snapshotHash: string,
  shards: readonly DiffShard[],
  roles: readonly ReviewWorkManifestRole[],
  manifest: ReviewWorkManifest | undefined,
): readonly UnitDraft[] {
  const shardById = new Map(shards.map((shard) => [shard.id, shard]));
  const obligations: NormalizedObligation[] = [...normalizeRoles(roles), ...manifestObligations(manifest)].map((obligation) => {
    const selected = canonicalRole(obligation.role);
    const shardIds = obligation.shardIds ?? (obligation.shardId === undefined
      ? obligation.shards
      : [...(obligation.shardIds ?? []), obligation.shardId]);
    const trigger = obligation.trigger ?? obligation.when ?? obligation.applicability;
    if (obligation.applicable === false || obligation.enabled === false) return {
      role: selected.role,
      shardIds: [],
      ...(selected.agentRole === undefined ? {} : { agentRole: selected.agentRole }),
      ...(trigger === undefined ? {} : { trigger }),
    };
    return {
      role: selected.role,
      ...(selected.agentRole === undefined ? {} : { agentRole: selected.agentRole }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(shardIds === undefined ? {} : { shardIds }),
    };
  }).filter((obligation) => obligation.shardIds === undefined || obligation.shardIds.length > 0);
  const hasDiffForShard = (shardId: string): boolean => obligations.some((obligation) => obligation.role === "diff" && (obligation.shardIds === undefined || obligation.shardIds.includes(shardId)));
  // Diff is the mandatory primary obligation.  Agent-facing diff-only-bug is
  // allowed to satisfy it without creating a duplicate canonical unit.
  for (const shard of shards) {
    if (!hasDiffForShard(shard.id)) obligations.push({ role: "diff", shardIds: [shard.id] });
  }
  for (const obligation of obligations) {
    for (const shardId of obligation.shardIds ?? []) {
      if (!shardById.has(shardId)) throw new RangeError(`unknown review work shard: ${shardId}`);
    }
  }
  const allShardIds = shards.map((shard) => shard.id);
  const shardOrder = new Map(shards.map((shard, index) => [shard.id, index]));
  const drafts: UnitDraft[] = [];
  const selectedShards = (obligation: NormalizedObligation): readonly DiffShard[] => {
    const ids = obligation.shardIds ?? allShardIds;
    return ids.flatMap((id) => {
      const shard = shardById.get(id);
      return shard === undefined ? [] : [shard];
    });
  };
  const add = (obligation: NormalizedObligation): void => {
    const selected = selectedShards(obligation);
    if (selected.length === 0) return;
    const shardIds = selected.map((shard) => shard.id);
    const triggerKey = obligation.trigger === undefined ? "" : `:${obligation.trigger}`;
    const key = (obligation.role === "diff" || obligation.role === "contextual"
      ? shardIds.join(",")
      : `selected:${shardIds.join(",")}`) + triggerKey;
    const id = workId(snapshotHash, obligation.role, key, obligation.agentRole);
    const ranges = freezeArray(selected.flatMap((shard) => rangesForShard(shard, id)));
    const unsupportedReason = selected.find((shard) => !shard.supported)?.unsupportedReason ?? (obligation.role === "diff"
      ? undefined
      : undefined);
    drafts.push(makeDraft(snapshotHash, obligation.role, key, shardIds, ranges, [], unsupportedReason, obligation.agentRole, obligation.trigger));
  };
  const expanded = obligations.flatMap((obligation) => {
    if (obligation.role === "diff" || obligation.role === "contextual") {
      return (obligation.shardIds ?? allShardIds).map((shardId) => ({ ...obligation, shardIds: [shardId] }));
    }
    return [obligation];
  });
  const ordered = expanded
    .filter((obligation) => obligation.shardIds === undefined || obligation.shardIds.length > 0)
    .sort((left, right) => {
      const roleOrder = DRAFT_ROLE_ORDER.indexOf(left.role) - DRAFT_ROLE_ORDER.indexOf(right.role);
      if (roleOrder !== 0) return roleOrder;
      const leftAgent = left.agentRole ?? "";
      const rightAgent = right.agentRole ?? "";
      if (leftAgent < rightAgent) return -1;
      if (leftAgent > rightAgent) return 1;
      const leftShards = (left.shardIds ?? allShardIds).map((shardId) => shardOrder.get(shardId) ?? Number.MAX_SAFE_INTEGER).join("\u0000");
      const rightShards = (right.shardIds ?? allShardIds).map((shardId) => shardOrder.get(shardId) ?? Number.MAX_SAFE_INTEGER).join("\u0000");
      if (leftShards < rightShards) return -1;
      if (leftShards > rightShards) return 1;
      return 0;
    });
  for (const obligation of ordered) add(obligation);
  // De-duplicate equivalent manifest entries while retaining agent-facing
  // distinctions.  The mandatory diff insertion above remains deterministic.
  const deduped: UnitDraft[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    if (seen.has(draft.id)) continue;
    seen.add(draft.id);
    deduped.push(draft);
  }
  return freezeArray(deduped.map((draft) => {
    let dependencies: readonly string[] = [];
    if (draft.role === "contextual") {
      dependencies = deduped
        .filter((candidate) => candidate.role === "diff" && candidate.shardIds.some((shardId) => draft.shardIds.includes(shardId)))
        .map((candidate) => candidate.id);
    } else if (draft.role === "integration") {
      dependencies = deduped
        .filter((candidate) => (candidate.role === "diff" || candidate.role === "contextual")
          && candidate.shardIds.some((shardId) => draft.shardIds.includes(shardId)))
        .map((candidate) => candidate.id);
    } else if (draft.role === "validator") {
      dependencies = deduped.filter((candidate) => candidate.role !== "validator").map((candidate) => candidate.id);
    }
    return dependencies.length === 0 ? draft : freezeObject({ ...draft, dependencies: freezeArray(dependencies) });
  }));
}

function unitFromDraft(draft: UnitDraft, status: ReviewWorkUnitStatus, reason?: string, attempts = 0): ReviewWorkUnit {
  const value: ReviewWorkUnit = {
    id: draft.id,
    snapshotHash: draft.snapshotHash,
    role: draft.role,
    ...(draft.agentRole === undefined ? {} : { agentRole: draft.agentRole }),
    ...(draft.trigger === undefined ? {} : { trigger: draft.trigger }),
    status,
    shardIds: draft.shardIds,
    dependencies: draft.dependencies,
    weight: draft.weight,
    attempts,
    ranges: draft.ranges,
    candidates: freezeArray([]),
    ...(reason === undefined ? {} : { reason }),
  };
  return freezeObject(value);
}

function coverageFromUnits(snapshotHash: string, units: readonly ReviewWorkUnit[], extras: CoverageExtras = {}): ReviewCoverage {
  const planned = units.map((unit) => unit.id);
  const covered = units.filter((unit) => unit.status === "covered").map((unit) => unit.id);
  const uncovered = units.filter((unit) => unit.status === "uncovered").map((unit) => unit.id);
  const uncoveredUnits = new Set(uncovered);
  const ranges = units.flatMap((unit) => {
    if (!uncoveredUnits.has(unit.id)) return [];
    const reason = unit.reason ?? "work unit is uncovered";
    return unit.ranges.map((range) => freezeObject({ ...range, reason }));
  });
  const reasons = units.flatMap((unit) => unit.reason === undefined ? [] : [unit.reason]);
  if (extras.reason !== undefined) reasons.push(extras.reason);
  const diffUnits = units.filter((unit) => unit.role === "diff");
  const plannedShardIds = unique(extras.plannedShardIds ?? diffUnits.flatMap((unit) => unit.shardIds));
  const requiredShardUnitIds = freezeObject(Object.fromEntries(plannedShardIds.map((shardId) => [
    shardId, freezeArray(units.filter((unit) => unit.shardIds.includes(shardId)).map((unit) => unit.id)),
  ])));
  const coveredSet = new Set(covered);
  const coveredShardIds = freezeArray(plannedShardIds.filter((id) => {
    const required = requiredShardUnitIds[id]!;
    return required.length > 0 && required.every((unitId) => coveredSet.has(unitId));
  }));
  const uncoveredShardIds = freezeArray(plannedShardIds.filter((id) => !coveredShardIds.includes(id)));
  const attemptedUnitIds = freezeArray(units.filter((unit) => unit.attempts > 0).map((unit) => unit.id));
  const attempts = Object.fromEntries(units.map((unit) => [unit.id, unit.attempts]));
  const reason = unique(reasons)[0];
  const uncoveredCandidates = uniqueCandidates(extras.uncoveredCandidates ?? units.flatMap((unit) => unit.candidates));
  const rangeEvidence = freezeArray([...ranges, ...(extras.uncoveredRanges ?? [])]);
  let state: ReviewCoverage["state"] = "unknown";
  if (extras.forceIncomplete || uncovered.length > 0 || rangeEvidence.length > 0 || uncoveredCandidates.length > 0) state = "incomplete";
  else if (units.length > 0 && covered.length === units.length) state = "complete";
  const spentWeight = extras.budgetSpentWeight ?? units.reduce((sum, unit) => sum + unit.weight * unit.attempts, 0);
  const reservedWeight = extras.budgetReservedWeight ?? 0;
  const maxWeight = extras.budgetMaxWeight ?? 0;
  const mode = extras.mode ?? (plannedShardIds.length > 1 ? "sharded" : "single");
  const value: ReviewCoverage = {
    snapshotHash,
    state,
    policyVersion: extras.policyVersion ?? REVIEW_WORK_POLICY_VERSION,
    policy: extras.policy ?? REVIEW_WORK_POLICY,
    ...(extras.workLimitPolicy === undefined ? {} : { workLimitPolicy: extras.workLimitPolicy }),
    mode,
    sharded: mode === "sharded",
    plannedUnitIds: freezeArray(planned),
    coveredUnitIds: freezeArray(covered),
    uncoveredUnitIds: freezeArray(uncovered),
    attemptedUnitIds,
    attempts: freezeObject(attempts),
    plannedUnits: freezeArray(planned),
    coveredUnits: freezeArray(covered),
    uncoveredUnits: freezeArray(uncovered),
    ...(reason === undefined ? {} : { reason }),
    uncoveredRanges: rangeEvidence,
    uncoveredRangeEvidence: rangeEvidence,
    uncoveredCandidates,
    unvalidatedCandidates: uncoveredCandidates,
    requiredShardUnitIds,
    plannedShardIds,
    coveredShardIds,
    uncoveredShardIds,
    plannedShardCount: plannedShardIds.length,
    coveredShardCount: coveredShardIds.length,
    uncoveredShardCount: uncoveredShardIds.length,
    plannedShards: plannedShardIds,
    coveredShards: coveredShardIds,
    uncoveredShards: uncoveredShardIds,
    budgetMaxWeight: maxWeight,
    budgetReservedWeight: reservedWeight,
    budgetSpentWeight: spentWeight,
    maxWeight,
    reservedWeight,
    spentWeight,
    budget: freezeObject({ maxWeight, reservedWeight, spentWeight }),
  };
  return freezeObject(value);
}

function inputParts(input: ReviewWorkInput | ReviewSnapshot, options: ReviewWorkPlanningOptions): { readonly snapshotHash: string; readonly diff: string; readonly shards?: readonly DiffShard[] } {
  return {
    snapshotHash: input.snapshotHash,
    diff: input.diff,
    ...(options.shards === undefined ? {} : { shards: options.shards }),
  };
}

/**
 * Build a deterministic, agent-free work plan from one immutable snapshot.
 * Limits apply to weighted units, so contextual and integration work costs
 * two units while summary, diff, guidance, and validator work costs one.
 */
export function planReviewWork(input: ReviewWorkInput | ReviewSnapshot, options?: ReviewWorkPlanningOptions): ReviewWorkPlan {
  const planning = options ?? {};
  const parts = inputParts(input, planning);
  const maxReviewWorkUnits = validateLimit(planning.maxReviewWorkUnits ?? DEFAULT_MAX_REVIEW_WORK_UNITS);
  const workLimitPolicy = planning.workLimitPolicy ?? DEFAULT_WORK_LIMIT_POLICY;
  if (workLimitPolicy !== "reject" && workLimitPolicy !== "partial") throw new RangeError(`unknown work limit policy: ${String(workLimitPolicy)}`);
  const roles = planning.roles ?? [];
  const manifest = planning.manifest ?? planning.obligations;
  const shards = parts.shards ?? shardDiff(parts.diff, parts.snapshotHash, planning.maxShardBytes === undefined ? {} : { maxBytes: planning.maxShardBytes });
  if (shards.some((shard) => shard.snapshotHash !== parts.snapshotHash)) {
    throw new Error("review work shards belong to a different snapshot");
  }
  const drafts = createDrafts(parts.snapshotHash, shards, roles, manifest);
  const runnableWeight = drafts.filter((draft) => draft.unsupportedReason === undefined).reduce((sum, draft) => sum + draft.weight, 0);
  const totalWeight = drafts.reduce((sum, draft) => sum + draft.weight, 0);
  const overLimit = runnableWeight > maxReviewWorkUnits;
  const rejectAll = overLimit && workLimitPolicy === "reject";
  let selectedWeight = 0;
  const selectedIds: string[] = [];
  const selectedSet = new Set<string>();
  const units: ReviewWorkUnit[] = [];
  for (const draft of drafts) {
    if (draft.unsupportedReason !== undefined) {
      units.push(unitFromDraft(draft, "uncovered", draft.unsupportedReason));
      continue;
    }
    if (rejectAll) {
      units.push(unitFromDraft(draft, "uncovered", `review work limit rejected plan: ${maxReviewWorkUnits} weighted units`));
      continue;
    }
    const missingDependency = draft.dependencies.find((dependency) => !selectedSet.has(dependency));
    if (missingDependency !== undefined) {
      units.push(unitFromDraft(draft, "uncovered", `dependency is uncovered: ${missingDependency}`));
      continue;
    }
    if (selectedWeight + draft.weight <= maxReviewWorkUnits) {
      selectedWeight += draft.weight;
      selectedIds.push(draft.id);
      selectedSet.add(draft.id);
      units.push(unitFromDraft(draft, "planned"));
    } else {
      units.push(unitFromDraft(draft, "uncovered", `review work limit leaves unit uncovered: ${maxReviewWorkUnits} weighted units`));
    }
  }
  const coverage = coverageFromUnits(parts.snapshotHash, units, {
    policyVersion: REVIEW_WORK_POLICY_VERSION,
    policy: REVIEW_WORK_POLICY,
    workLimitPolicy,
    mode: shards.length > 1 ? "sharded" : "single",
    plannedShardIds: shards.map((shard) => shard.id),
    budgetMaxWeight: maxReviewWorkUnits,
    budgetReservedWeight: selectedWeight,
    budgetSpentWeight: 0,
    ...(drafts.length === 0 && (planning.manifest !== undefined || planning.obligations !== undefined)
      ? { forceIncomplete: true, reason: "review manifest selected zero work units" }
      : {}),
  });
  return freezeObject({
    snapshotHash: parts.snapshotHash,
    shards: freezeArray(shards),
    units: freezeArray(units),
    selectedUnitIds: freezeArray(selectedIds),
    totalWeight,
    selectedWeight,
    maxReviewWorkUnits,
    workLimitPolicy,
    coverage,
  });
}

export function planReviewWorkFromOptions(options: ReviewOptions, planning: Omit<ReviewWorkPlanningOptions, "maxReviewWorkUnits" | "workLimitPolicy"> = {}): ReviewWorkPlan {
  const manifest = planning.manifest
    ?? planning.obligations
    ?? options.manifest
    ?? options.reviewWorkManifest
    ?? options.reviewWorkObligations;
  return planReviewWork(options.snapshot ?? { snapshotHash: "", diff: "" }, {
    ...planning,
    ...(manifest === undefined ? {} : { manifest }),
    ...(options.maxReviewWorkUnits === undefined ? {} : { maxReviewWorkUnits: options.maxReviewWorkUnits }),
    ...(options.workLimitPolicy === undefined ? {} : { workLimitPolicy: options.workLimitPolicy }),
  });
}

export const createReviewWorkPlan = planReviewWork;
export const buildReviewWorkPlan = planReviewWork;

function updateSets(coverage: ReviewCoverage, update: ReviewCoverageUpdate): ReviewCoverage {
  if (update.snapshotHash !== undefined && update.snapshotHash !== coverage.snapshotHash) throw new Error("coverage update belongs to a different snapshot");
  const planned = new Set(coverage.plannedUnitIds);
  const covered = new Set(coverage.coveredUnitIds);
  const uncovered = new Set(coverage.uncoveredUnitIds);
  const coveredUpdate = new Set(update.coveredUnitIds ?? []);
  const uncoveredUpdate = new Set(update.uncoveredUnitIds ?? []);
  const attemptedIds = update.attemptedUnitIds ?? [];
  const updateIds = [
    ...(update.coveredUnitIds ?? []),
    ...(update.uncoveredUnitIds ?? []),
    ...attemptedIds,
    ...Object.keys(update.attempts ?? {}),
    ...Object.keys(update.reasonByUnit ?? {}),
  ];
  for (const id of updateIds) {
    if (!planned.has(id)) throw new Error(`coverage update references unknown work unit: ${id}`);
  }
  for (const id of coveredUpdate) {
    if (uncoveredUpdate.has(id)) throw new Error(`coverage update marks a unit both covered and uncovered: ${id}`);
  }
  for (const [id, attempts] of Object.entries(update.attempts ?? {})) {
    if (!Number.isSafeInteger(attempts) || attempts < 0) throw new RangeError(`attempt count must be a non-negative safe integer for ${id}`);
  }
  for (const id of coveredUpdate) {
    covered.add(id);
    uncovered.delete(id);
  }
  for (const id of uncoveredUpdate) {
    uncovered.add(id);
    covered.delete(id);
  }
  // Once an execution result is supplied, omitted planned units are not
  // silently left in an indeterminate set that could later look complete.
  const hasExecution = coveredUpdate.size > 0 || uncoveredUpdate.size > 0 || attemptedIds.length > 0 || Object.keys(update.attempts ?? {}).length > 0;
  if (hasExecution) {
    for (const id of planned) {
      if (!covered.has(id)) uncovered.add(id);
    }
  }
  const plannedIds = freezeArray(coverage.plannedUnitIds);
  const coveredIds = freezeArray(plannedIds.filter((id) => covered.has(id)));
  const uncoveredIds = freezeArray(plannedIds.filter((id) => uncovered.has(id)));
  const reason = update.reason ?? coverage.reason;
  const rangeEvidence = freezeArray([...new Map([
    ...coverage.uncoveredRanges,
    ...(coverage.uncoveredRangeEvidence ?? []),
    ...(update.uncoveredRanges ?? []),
    ...(update.uncoveredRangeEvidence ?? []),
  ].map((range) => [JSON.stringify(range), range])).values()]);
  const attemptedUnitIds = unique([...(coverage.attemptedUnitIds ?? []), ...attemptedIds]);
  const attempts = freezeObject({
    ...(coverage.attempts ?? {}),
    ...(update.attempts ?? {}),
  });
  const candidates = uniqueCandidates([
    ...coverage.uncoveredCandidates,
    ...(coverage.unvalidatedCandidates ?? []),
    ...(update.uncoveredCandidates ?? []),
    ...(update.unvalidatedCandidates ?? []),
  ]);
  const rangeShardIds = new Set(rangeEvidence.flatMap((range) => range.shardId === undefined ? [] : [range.shardId]));
  const plannedShardIds = coverage.plannedShardIds ?? coverage.plannedShards;
  const coveredShardIds = plannedShardIds === undefined ? undefined : freezeArray(plannedShardIds.filter((shardId) => {
    const required = coverage.requiredShardUnitIds?.[shardId];
    const complete = required === undefined
      ? (coverage.coveredShardIds ?? coverage.coveredShards ?? []).includes(shardId)
      : required.length > 0 && required.every((unitId) => planned.has(unitId) && covered.has(unitId) && !uncovered.has(unitId));
    return complete && !rangeShardIds.has(shardId);
  }));
  const uncoveredShardIds = plannedShardIds === undefined ? undefined : freezeArray(plannedShardIds.filter((shardId) => !coveredShardIds!.includes(shardId)));
  let state: ReviewCoverage["state"] = "unknown";
  if (uncoveredIds.length > 0 || rangeEvidence.length > 0 || candidates.length > 0) state = "incomplete";
  else if (plannedIds.length > 0 && coveredIds.length === plannedIds.length) state = "complete";
  return freezeObject({
    ...coverage,
    state,
    plannedUnitIds: plannedIds,
    coveredUnitIds: coveredIds,
    uncoveredUnitIds: uncoveredIds,
    attemptedUnitIds,
    attempts,
    plannedUnits: plannedIds,
    coveredUnits: coveredIds,
    uncoveredUnits: uncoveredIds,
    ...(reason === undefined ? {} : { reason }),
    uncoveredRanges: rangeEvidence,
    uncoveredRangeEvidence: rangeEvidence,
    uncoveredCandidates: candidates,
    unvalidatedCandidates: candidates,
    ...(plannedShardIds === undefined ? {} : {
      plannedShardIds,
      plannedShards: plannedShardIds,
      plannedShardCount: plannedShardIds.length,
      coveredShardIds: coveredShardIds!,
      coveredShards: coveredShardIds!,
      coveredShardCount: coveredShardIds!.length,
      uncoveredShardIds: uncoveredShardIds!,
      uncoveredShards: uncoveredShardIds!,
      uncoveredShardCount: uncoveredShardIds!.length,
    }),
  });
}

/** Update a coverage record without mutating the original immutable record. */
export function updateReviewCoverage(coverage: ReviewCoverage, update: ReviewCoverageUpdate): ReviewCoverage {
  return updateSets(coverage, update);
}

/** Apply coverage and attempt counts to a plan without invoking any agent. */
export function applyReviewWorkCoverage(plan: ReviewWorkPlan, update: ReviewCoverageUpdate): ReviewWorkPlan {
  if (update.snapshotHash !== undefined && update.snapshotHash !== plan.snapshotHash) throw new Error("work update belongs to a different snapshot");
  const covered = new Set(update.coveredUnitIds ?? []);
  const uncovered = new Set(update.uncoveredUnitIds ?? []);
  const attempted = new Set(update.attemptedUnitIds ?? []);
  const knownIds = new Set(plan.units.map((unit) => unit.id));
  for (const id of [...covered, ...uncovered, ...attempted, ...Object.keys(update.attempts ?? {}), ...Object.keys(update.reasonByUnit ?? {})]) {
    if (!knownIds.has(id)) throw new Error(`coverage update references unknown work unit: ${id}`);
  }
  if ([...covered].some((id) => uncovered.has(id))) throw new Error("coverage update marks a unit both covered and uncovered");
  const hasExecution = covered.size > 0 || uncovered.size > 0 || attempted.size > 0 || Object.keys(update.attempts ?? {}).length > 0;
  const units = plan.units.map((unit) => {
    if (!plan.coverage.plannedUnitIds.includes(unit.id)) throw new Error(`plan unit is missing from coverage: ${unit.id}`);
    const explicitAttempts = update.attempts?.[unit.id];
    const attempts = explicitAttempts === undefined ? unit.attempts + (attempted.has(unit.id) ? 1 : 0) : explicitAttempts;
    if (!Number.isSafeInteger(attempts) || attempts < 0) throw new RangeError(`attempt count must be a non-negative safe integer for ${unit.id}`);
    if (attempts < unit.attempts) throw new RangeError(`attempt count cannot decrease for ${unit.id}`);
    const status: ReviewWorkUnitStatus = covered.has(unit.id)
      ? "covered"
      : uncovered.has(unit.id) || (hasExecution && unit.status !== "covered") ? "uncovered" : unit.status;
    const reason = update.reasonByUnit?.[unit.id] ?? (status === "uncovered"
      ? unit.reason ?? (hasExecution ? "work unit omitted from execution result" : undefined)
      : undefined);
    const candidates = freezeArray([
      ...unit.candidates,
      ...(update.uncoveredCandidates ?? update.unvalidatedCandidates ?? []).filter((candidate) => candidate.unitId === unit.id),
    ]);
    const draft: UnitDraft = {
      snapshotHash: plan.snapshotHash,
      role: unit.role,
      ...(unit.agentRole === undefined ? {} : { agentRole: unit.agentRole }),
      ...(unit.trigger === undefined ? {} : { trigger: unit.trigger }),
      shardIds: unit.shardIds,
      ranges: unit.ranges,
      dependencies: unit.dependencies,
      weight: unit.weight,
      id: unit.id,
    };
    const next = unitFromDraft(draft, status, reason, attempts);
    return freezeObject({ ...next, candidates });
  });
  const previousBudget = plan.coverage.budget;
  const coverage = updateSets(coverageFromUnits(plan.snapshotHash, units, {
    ...(plan.coverage.policyVersion === undefined ? {} : { policyVersion: plan.coverage.policyVersion }),
    ...(plan.coverage.policy === undefined ? {} : { policy: plan.coverage.policy }),
    workLimitPolicy: plan.workLimitPolicy,
    ...(plan.coverage.mode === undefined ? {} : { mode: plan.coverage.mode }),
    plannedShardIds: plan.coverage.plannedShardIds ?? plan.shards.map((shard) => shard.id),
    budgetMaxWeight: previousBudget?.maxWeight ?? plan.coverage.budgetMaxWeight ?? plan.maxReviewWorkUnits,
    budgetReservedWeight: previousBudget?.reservedWeight ?? plan.coverage.budgetReservedWeight ?? plan.selectedWeight,
    budgetSpentWeight: units.reduce((sum, unit) => sum + unit.weight * unit.attempts, 0),
  }), update);
  return freezeObject({ ...plan, units: freezeArray(units), coverage });
}

/** Record either a plan update or a standalone coverage update immutably. */
export function recordReviewCoverage(plan: ReviewWorkPlan, update: ReviewCoverageUpdate): ReviewWorkPlan;
export function recordReviewCoverage(coverage: ReviewCoverage, update: ReviewCoverageUpdate): ReviewCoverage;
export function recordReviewCoverage(planOrCoverage: ReviewWorkPlan | ReviewCoverage, update: ReviewCoverageUpdate): ReviewWorkPlan | ReviewCoverage {
  return "units" in planOrCoverage ? applyReviewWorkCoverage(planOrCoverage, update) : updateReviewCoverage(planOrCoverage, update);
}

export type {
  ReviewWorkManifest,
  ReviewWorkManifestRole,
  ReviewWorkObligation,
  ReviewWorkTrigger,
} from "./types.js";

export {
  DEFAULT_MAX_REVIEW_WORK_UNITS,
  DEFAULT_WORK_LIMIT_POLICY,
  MAX_REVIEW_WORK_UNITS,
  REVIEW_WORK_UNIT_WEIGHTS,
  reviewWorkUnitWeight,
};
