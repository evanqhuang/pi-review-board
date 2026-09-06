import type {
  AgentUsage,
  ReviewWorkPlan,
  ReviewerFailureKind,
} from "./types.js";
import { DEFAULT_MAX_REVIEW_WORK_UNITS } from "./types.js";

/** The scheduler never starts more than this many reviewer attempts at once. */
export const MAX_REVIEW_SCHEDULER_CONCURRENCY = 4;

export type ReviewSchedulerFailureKind = ReviewerFailureKind | "capacity" | "canceled" | "task";

export interface ReviewScheduleTaskContext {
  /** The request-scoped cancellation signal for this task. */
  readonly signal: AbortSignal;
  /** Mark the subprocess attempt as having actually started. */
  readonly markAttemptStarted: (attempt?: number) => void;
  /** Mark the current attempt as rejected before a subprocess was started. */
  readonly markPreSpawnFailure: () => void;
  /** Admit an equal-weight protocol retry, before its subprocess is started. */
  readonly retryAdmission: () => Promise<boolean>;
}

export interface ReviewTaskExecution<T> {
  readonly value: T;
  readonly covered?: boolean;
  readonly status?: "covered" | "uncovered";
  readonly reason?: string;
  readonly usage?: AgentUsage;
  /** Override the scheduler's conservative started inference for this attempt. */
  readonly started?: boolean;
}

export interface ReviewAgentTaskExecution<T> {
  readonly data: T;
  readonly usage: AgentUsage;
}

/** Generic work input: the scheduler does not know or invoke reviewer roles. */
export interface ReviewScheduleTask<T> {
  readonly id: string;
  readonly weight: number;
  readonly run: (context: ReviewScheduleTaskContext) => Promise<T | ReviewTaskExecution<T> | ReviewAgentTaskExecution<T>>;
}

export interface ReviewScheduleFailure {
  readonly kind: ReviewSchedulerFailureKind;
  readonly reason: string;
}

export interface ReviewScheduleResult<T> {
  readonly id: string;
  readonly weight: number;
  readonly status: "covered" | "uncovered";
  readonly attempted: boolean;
  readonly attempts: number;
  readonly startedWeight: number;
  readonly value?: T;
  readonly usage?: AgentUsage;
  readonly reason?: string;
  readonly failure?: ReviewScheduleFailure;
}

export interface ReviewScheduleOutcome<T> {
  /** Results always follow the input task order, not completion order. */
  readonly results: readonly ReviewScheduleResult<T>[];
  readonly capacity: number;
  readonly maxConcurrency: number;
  readonly attemptedUnitIds: readonly string[];
  readonly coveredUnitIds: readonly string[];
  readonly uncoveredUnitIds: readonly string[];
  readonly unlaunchedUnitIds: readonly string[];
  readonly failedUnitIds: readonly string[];
  readonly attempts: Readonly<Record<string, number>>;
  readonly attemptsByUnit: Readonly<Record<string, number>>;
  readonly usageByUnit: Readonly<Record<string, AgentUsage>>;
  readonly unitUsage: Readonly<Record<string, AgentUsage>>;
  readonly reasonByUnit: Readonly<Record<string, string>>;
  /** Weight charged for attempts whose subprocess actually began. */
  readonly spentWeight: number;
  /** Weight admitted, including reservations released by pre-spawn failures. */
  readonly admittedWeight: number;
  /** Always zero after a schedule settles; exposed for coverage consumers. */
  readonly reservedWeight: number;
}

export interface ReviewScheduleOptions {
  /** Weighted capacity for this request-scoped wave. */
  readonly capacity?: number;
  readonly maxWeight?: number;
  readonly maxReviewWorkUnits?: number;
  /** A plan supplies the default capacity without making the scheduler plan-specific. */
  readonly plan?: Pick<ReviewWorkPlan, "maxReviewWorkUnits">;
  readonly maxConcurrency?: number;
  readonly signal?: AbortSignal;
}

interface MutableState<T> {
  readonly task: ReviewScheduleTask<T>;
  readonly index: number;
  reservation: "initial" | "retry" | undefined;
  initialFinished: boolean;
  retryRequested: boolean;
  retryDecision: boolean | undefined;
  retryWaiter: ((admitted: boolean) => void) | undefined;
  currentAttempt: 1 | 2;
  currentStarted: boolean;
  preSpawnFailure: boolean;
  actualAttempts: number;
  settled: boolean;
  result: ReviewScheduleResult<T> | undefined;
}

interface NormalizedExecution<T> {
  readonly value?: T;
  readonly covered: boolean;
  readonly reason?: string;
  readonly usage?: AgentUsage;
  readonly started?: boolean;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function freezeRecord<T>(value: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(value);
}

function validPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function failureKind(error: unknown): ReviewSchedulerFailureKind {
  if (error && typeof error === "object") {
    const kind = (error as { readonly kind?: unknown }).kind;
    if (typeof kind === "string") return kind as ReviewSchedulerFailureKind;
    if ((error as { readonly name?: unknown }).name === "AbortError") return "canceled";
  }
  return "task";
}

function failureReason(error: unknown, kind: ReviewSchedulerFailureKind): string {
  if (kind === "canceled") return "review task was canceled";
  if (kind === "capacity") return "review work capacity was exhausted";
  if (kind === "task") return "review task failed";
  // Runner errors intentionally expose only their typed kind, not provider or
  // subprocess text. This also gives coverage consumers a stable reason.
  return `review task failed: ${kind}`;
}

function errorUsage(error: unknown): AgentUsage | undefined {
  if (!error || typeof error !== "object") return undefined;
  const usage = (error as { readonly usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  if (typeof record.role !== "string") return undefined;
  if (typeof record.turns !== "number" || typeof record.inputTokens !== "number"
    || typeof record.outputTokens !== "number" || typeof record.contextTokens !== "number") return undefined;
  return usage as AgentUsage;
}

function isPreSpawnKind(kind: ReviewSchedulerFailureKind): boolean {
  return kind === "input-limit" || kind === "spawn" || kind === "canceled";
}

function normalizeExecution<T>(value: T | ReviewTaskExecution<T> | ReviewAgentTaskExecution<T>): NormalizedExecution<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, covered: true };
  const record = value as Record<string, unknown>;
  const hasExecutionMarker = Object.prototype.hasOwnProperty.call(record, "value")
    || Object.prototype.hasOwnProperty.call(record, "covered")
    || Object.prototype.hasOwnProperty.call(record, "status")
    || Object.prototype.hasOwnProperty.call(record, "reason")
    || Object.prototype.hasOwnProperty.call(record, "started");
  // AgentResult<T> is a common scheduler callback return value. Keep direct
  // object results direct unless one of the scheduler markers is present.
  if (!hasExecutionMarker && Object.prototype.hasOwnProperty.call(record, "data")) return {
    value: record.data as T,
    covered: true,
    ...(record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
      ? { usage: record.usage as AgentUsage }
      : {}),
  };
  if (!hasExecutionMarker) return { value: value as T, covered: true };
  return {
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? { value: record.value as T } : {}),
    covered: record.covered !== false && record.status !== "uncovered",
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(record.usage && typeof record.usage === "object" && !Array.isArray(record.usage) ? { usage: record.usage as AgentUsage } : {}),
    ...(typeof record.started === "boolean" ? { started: record.started } : {}),
  };
}

function capacityFrom(options: ReviewScheduleOptions): number {
  return validPositiveInteger(
    options.capacity ?? options.maxWeight ?? options.maxReviewWorkUnits ?? options.plan?.maxReviewWorkUnits ?? DEFAULT_MAX_REVIEW_WORK_UNITS,
    "review scheduler capacity",
  );
}

/**
 * Run one deterministic wave of generic weighted work. Each invocation owns
 * all reservations, so a later candidate-validation wave starts with no
 * reservations left by an earlier finder wave.
 */
export async function scheduleReviewWork<T>(
  tasks: readonly ReviewScheduleTask<T>[],
  options: ReviewScheduleOptions = {},
): Promise<ReviewScheduleOutcome<T>> {
  const capacity = capacityFrom(options);
  const maxConcurrency = validPositiveInteger(options.maxConcurrency ?? MAX_REVIEW_SCHEDULER_CONCURRENCY, "review scheduler concurrency");
  if (maxConcurrency > MAX_REVIEW_SCHEDULER_CONCURRENCY) {
    throw new RangeError(`review scheduler concurrency cannot exceed ${MAX_REVIEW_SCHEDULER_CONCURRENCY}`);
  }

  const seenIds = new Set<string>();
  for (const task of tasks) {
    if (!task.id) throw new RangeError("review scheduler task id must not be empty");
    if (seenIds.has(task.id)) throw new RangeError(`duplicate review scheduler task id: ${task.id}`);
    seenIds.add(task.id);
    validPositiveInteger(task.weight, `review scheduler weight for ${task.id}`);
  }

  const controller = new AbortController();
  let externalAbort: (() => void) | undefined;
  if (options.signal) {
    externalAbort = (): void => controller.abort();
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", externalAbort, { once: true });
  }

  const states: MutableState<T>[] = tasks.map((task, index) => ({
    task,
    index,
    reservation: undefined,
    initialFinished: false,
    retryRequested: false,
    retryDecision: undefined,
    retryWaiter: undefined,
    currentAttempt: 1,
    currentStarted: false,
    preSpawnFailure: false,
    actualAttempts: 0,
    settled: false,
    result: undefined,
  }));
  let nextInitial = 0;
  let activeAttempts = 0;
  let reservedWeight = 0;
  let spentWeight = 0;
  let admittedWeight = 0;
  let settledCount = 0;
  let pumping = false;
  let resolveSchedule: ((outcome: ReviewScheduleOutcome<T>) => void) | undefined;
  let scheduleResolved = false;

  const markActualStart = (state: MutableState<T>, attempt: number): void => {
    if (attempt !== 1 && attempt !== 2) return;
    state.currentStarted = true;
    state.preSpawnFailure = false;
    if (state.actualAttempts < attempt) state.actualAttempts = attempt;
  };

  const markInitialFinished = (state: MutableState<T>, started: boolean): void => {
    if (state.initialFinished) return;
    state.initialFinished = true;
    if (started) {
      markActualStart(state, 1);
      spentWeight += state.task.weight;
    }
    if (state.reservation === "initial") {
      reservedWeight -= state.task.weight;
      state.reservation = undefined;
      activeAttempts -= 1;
    }
  };

  const retryAdmission = (state: MutableState<T>): Promise<boolean> => {
    if (state.retryRequested || state.retryDecision !== undefined || state.settled) return Promise.resolve(false);
    state.retryRequested = true;
    // A retry callback is reached only after the first attempt has produced a
    // retryable result. Settle that reservation before queueing the retry.
    markInitialFinished(state, true);
    return new Promise<boolean>((resolve) => {
      state.retryWaiter = resolve;
      pump();
    });
  };

  const markUnlaunched = (state: MutableState<T>, reason: string, kind: "capacity" | "canceled"): void => {
    if (state.settled) return;
    state.initialFinished = true;
    state.settled = true;
    settledCount += 1;
    state.result = {
      id: state.task.id,
      weight: state.task.weight,
      status: "uncovered",
      attempted: false,
      attempts: 0,
      startedWeight: 0,
      reason,
      failure: { kind, reason },
    };
  };

  const settle = (state: MutableState<T>, execution: NormalizedExecution<T> | undefined, error: unknown): void => {
    if (state.settled) return;
    const kind = error === undefined ? undefined : failureKind(error);
    const explicitStarted = execution?.started;
    const preSpawn = explicitStarted === false || state.preSpawnFailure
      || (error !== undefined && !state.currentStarted && isPreSpawnKind(kind as ReviewSchedulerFailureKind));
    const currentStarted = explicitStarted ?? (error === undefined ? true : !preSpawn);
    if (state.currentAttempt === 1) {
      markInitialFinished(state, currentStarted);
    } else if (state.reservation === "retry") {
      if (currentStarted) {
        markActualStart(state, 2);
        spentWeight += state.task.weight;
      }
      reservedWeight -= state.task.weight;
      state.reservation = undefined;
      activeAttempts -= 1;
    }
    const canceled = controller.signal.aborted;
    const covered = error === undefined && execution?.covered !== false && !canceled;
    const reason = covered
      ? execution?.reason
      : canceled
        ? "review schedule was canceled"
        : execution?.reason ?? (error === undefined ? "review task left this unit uncovered" : failureReason(error, kind ?? "task"));
    const failure = covered
      ? undefined
      : canceled && error === undefined
        ? { kind: "canceled" as const, reason: reason ?? "review schedule was canceled" }
        : error === undefined
          ? { kind: "task" as const, reason: reason ?? "review task left this unit uncovered" }
          : { kind: kind ?? "task", reason: reason ?? "review task failed" };
    const usage = execution?.usage ?? errorUsage(error);
    const result: ReviewScheduleResult<T> = {
      id: state.task.id,
      weight: state.task.weight,
      status: covered ? "covered" : "uncovered",
      attempted: state.actualAttempts > 0,
      attempts: state.actualAttempts,
      startedWeight: state.actualAttempts * state.task.weight,
      ...(execution && Object.prototype.hasOwnProperty.call(execution, "value") ? { value: execution.value } : {}),
      ...(usage === undefined ? {} : { usage }),
      ...(reason === undefined ? {} : { reason }),
      ...(failure === undefined ? {} : { failure }),
    };
    state.result = Object.freeze(result);
    state.settled = true;
    settledCount += 1;
    state.retryWaiter = undefined;
  };

  const processRetries = (): void => {
    if (controller.signal.aborted || nextInitial < states.length) return;
    const pending = states.filter((state) => state.retryWaiter !== undefined).sort((left, right) => left.index - right.index);
    for (const state of pending) {
      // Never let a later retry leap over an earlier first attempt. Earlier
      // retries may be admitted together, in order, once their admissions are
      // known; completion order is deliberately irrelevant.
      if (states.some((candidate) => candidate.index < state.index && !candidate.initialFinished)) return;
      if (activeAttempts >= maxConcurrency) return;
      if (spentWeight + reservedWeight + state.task.weight > capacity) {
        // Existing reservations may still be released without spending (for
        // example, a canceled pre-spawn attempt), so wait for them to settle.
        if (activeAttempts > 0 || reservedWeight > 0) return;
        state.retryDecision = false;
        const waiter = state.retryWaiter;
        state.retryWaiter = undefined;
        waiter?.(false);
        continue;
      }
      state.retryDecision = true;
      state.reservation = "retry";
      state.currentAttempt = 2;
      state.currentStarted = false;
      state.preSpawnFailure = false;
      reservedWeight += state.task.weight;
      admittedWeight += state.task.weight;
      activeAttempts += 1;
      const waiter = state.retryWaiter;
      state.retryWaiter = undefined;
      waiter?.(true);
    }
  };

  const pump = (): void => {
    if (pumping) return;
    pumping = true;
    try {
      while (!controller.signal.aborted && nextInitial < states.length && activeAttempts < maxConcurrency) {
        const state = states[nextInitial];
        if (!state) break;
        if (spentWeight + reservedWeight + state.task.weight > capacity) {
          if (activeAttempts > 0 || reservedWeight > 0) break;
          nextInitial += 1;
          markUnlaunched(state, `review work capacity cannot admit unit weight ${state.task.weight}`, "capacity");
          continue;
        }
        nextInitial += 1;
        state.reservation = "initial";
        state.currentAttempt = 1;
        state.currentStarted = false;
        state.preSpawnFailure = false;
        reservedWeight += state.task.weight;
        admittedWeight += state.task.weight;
        activeAttempts += 1;
        void execute(state);
      }
      processRetries();
    } finally {
      pumping = false;
    }
    maybeResolve();
  };

  const contextFor = (state: MutableState<T>): ReviewScheduleTaskContext => ({
    signal: controller.signal,
    markAttemptStarted: (attempt = state.currentAttempt): void => markActualStart(state, attempt),
    markPreSpawnFailure: (): void => {
      state.preSpawnFailure = true;
      state.currentStarted = false;
    },
    retryAdmission: (): Promise<boolean> => retryAdmission(state),
  });

  const execute = async (state: MutableState<T>): Promise<void> => {
    let execution: NormalizedExecution<T> | undefined;
    let error: unknown;
    try {
      const value = await state.task.run(contextFor(state));
      execution = normalizeExecution(value);
      if (execution.started === false) state.preSpawnFailure = true;
    } catch (caught: unknown) {
      error = caught;
    }
    settle(state, execution, error);
    pump();
  };

  const abortUnlaunched = (): void => {
    if (!controller.signal.aborted) return;
    while (nextInitial < states.length) {
      const state = states[nextInitial];
      nextInitial += 1;
      if (state) markUnlaunched(state, "review schedule was canceled before admission", "canceled");
    }
    for (const state of states) {
      if (!state.retryWaiter) continue;
      state.retryDecision = false;
      const waiter = state.retryWaiter;
      state.retryWaiter = undefined;
      waiter(false);
    }
    maybeResolve();
  };

  controller.signal.addEventListener("abort", abortUnlaunched, { once: true });

  const maybeResolve = (): void => {
    if (scheduleResolved || !resolveSchedule || settledCount !== states.length) return;
    scheduleResolved = true;
    if (options.signal && externalAbort) options.signal.removeEventListener("abort", externalAbort);
    const results = freezeArray(states.map((state) => state.result).filter((result): result is ReviewScheduleResult<T> => result !== undefined));
    const attemptedUnitIds = freezeArray(results.filter((result) => result.attempted).map((result) => result.id));
    const coveredUnitIds = freezeArray(results.filter((result) => result.status === "covered").map((result) => result.id));
    const uncoveredUnitIds = freezeArray(results.filter((result) => result.status === "uncovered").map((result) => result.id));
    const unlaunchedUnitIds = freezeArray(results.filter((result) => !result.attempted
      && (result.failure?.kind === "capacity" || result.failure?.kind === "canceled")).map((result) => result.id));
    const failedUnitIds = freezeArray(results.filter((result) => result.attempted
      && result.failure !== undefined && result.failure.kind !== "capacity").map((result) => result.id));
    const attempts: Record<string, number> = {};
    const usageByUnit: Record<string, AgentUsage> = {};
    const reasonByUnit: Record<string, string> = {};
    for (const result of results) {
      attempts[result.id] = result.attempts;
      if (result.usage !== undefined) usageByUnit[result.id] = result.usage;
      if (result.reason !== undefined) reasonByUnit[result.id] = result.reason;
    }
    const outcome: ReviewScheduleOutcome<T> = {
      results,
      capacity,
      maxConcurrency,
      attemptedUnitIds,
      coveredUnitIds,
      uncoveredUnitIds,
      unlaunchedUnitIds,
      failedUnitIds,
      attempts: freezeRecord(attempts),
      attemptsByUnit: freezeRecord({ ...attempts }),
      usageByUnit: freezeRecord(usageByUnit),
      unitUsage: freezeRecord({ ...usageByUnit }),
      reasonByUnit: freezeRecord(reasonByUnit),
      spentWeight,
      admittedWeight,
      reservedWeight,
    };
    resolveSchedule(Object.freeze(outcome));
  };

  const schedule = new Promise<ReviewScheduleOutcome<T>>((resolve) => {
    resolveSchedule = resolve;
    if (controller.signal.aborted) abortUnlaunched();
    else pump();
  });
  if (options.signal && externalAbort && !controller.signal.aborted) {
    // The listener is installed before the first task is pumped, but this
    // second check closes the small race between registration and pump().
    if (options.signal.aborted) abortUnlaunched();
  }
  return schedule;
}

export const runReviewWork = scheduleReviewWork;
export const runReviewSchedule = scheduleReviewWork;
export const scheduleReviewWave = scheduleReviewWork;

/** A request-scoped factory useful to callers that run multiple independent waves. */
export function createReviewScheduler(options: ReviewScheduleOptions = {}): {
  run<T>(tasks: readonly ReviewScheduleTask<T>[]): Promise<ReviewScheduleOutcome<T>>;
} {
  return {
    run: <T>(tasks: readonly ReviewScheduleTask<T>[]): Promise<ReviewScheduleOutcome<T>> => scheduleReviewWork(tasks, options),
  };
}
