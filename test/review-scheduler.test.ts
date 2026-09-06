import { describe, expect, it } from "vitest";
import { scheduleReviewWork, type ReviewScheduleTask } from "../src/review-scheduler.js";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function task(id: string, weight: number, run: ReviewScheduleTask<string>["run"]): ReviewScheduleTask<string> {
  return { id, weight, run };
}

describe("bounded deterministic review scheduler", () => {
  it("keeps at most four attempts active and starts the next units in stable order", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<string>>>();
    const started: string[] = [];
    let active = 0;
    let maximum = 0;
    const tasks = Array.from({ length: 8 }, (_, index) => {
      const id = `unit-${index + 1}`;
      const wait = deferred<string>();
      pending.set(id, wait);
      return task(id, 1, ({ markAttemptStarted }) => {
        started.push(id);
        markAttemptStarted();
        active += 1;
        maximum = Math.max(maximum, active);
        return wait.promise.finally(() => { active -= 1; });
      });
    });

    const schedule = scheduleReviewWork(tasks);
    await Promise.resolve();
    expect(started).toEqual(["unit-1", "unit-2", "unit-3", "unit-4"]);
    expect(maximum).toBe(4);

    for (const id of [...started].reverse()) pending.get(id)?.resolve(id);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["unit-1", "unit-2", "unit-3", "unit-4", "unit-5", "unit-6", "unit-7", "unit-8"]);

    for (const id of ["unit-8", "unit-7", "unit-6", "unit-5"]) pending.get(id)?.resolve(id);
    const result = await schedule;
    expect(result.results.map((entry) => entry.id)).toEqual(tasks.map((entry) => entry.id));
    expect(result.coveredUnitIds).toEqual(tasks.map((entry) => entry.id));
    expect(result.spentWeight).toBe(8);
  });

  it("charges launched failures, charges no pre-spawn rejection, and exposes unlaunched units", async () => {
    const result = await scheduleReviewWork([
      task("failed", 2, ({ markAttemptStarted }) => {
        markAttemptStarted();
        return Promise.reject({ kind: "provider" });
      }),
      task("refused", 1, () => Promise.reject({ kind: "input-limit" })),
      task("unlaunched", 3, () => Promise.resolve("must not run")),
    ], { capacity: 4 });

    expect(result.attemptedUnitIds).toEqual(["failed"]);
    expect(result.results.map((entry) => [entry.id, entry.status, entry.attempts])).toEqual([
      ["failed", "uncovered", 1],
      ["refused", "uncovered", 0],
      ["unlaunched", "uncovered", 0],
    ]);
    expect(result.unlaunchedUnitIds).toEqual(["unlaunched"]);
    expect(result.reasonByUnit.failed).toContain("provider");
    expect(result.reasonByUnit.refused).toContain("input-limit");
    expect(result.spentWeight).toBe(2);
    expect(result.spentWeight).toBeLessThanOrEqual(result.capacity);
  });

  it("admits retries only as an equal-weight second reservation", async () => {
    const retryStarted: string[] = [];
    const result = await scheduleReviewWork([
      task("first", 1, async ({ markAttemptStarted, retryAdmission }) => {
        markAttemptStarted(1);
        const admitted = await retryAdmission();
        if (admitted) {
          retryStarted.push("first");
          markAttemptStarted(2);
        }
        return { value: "first", covered: admitted };
      }),
      task("second", 1, ({ markAttemptStarted }) => {
        markAttemptStarted();
        return Promise.resolve("second");
      }),
    ], { capacity: 3 });

    expect(retryStarted).toEqual(["first"]);
    expect(result.results.map((entry) => [entry.id, entry.attempts, entry.status])).toEqual([
      ["first", 2, "covered"],
      ["second", 1, "covered"],
    ]);
    expect(result.spentWeight).toBe(3);
  });

  it("cancels active attempts and leaves later units explicitly unlaunched", async () => {
    const controller = new AbortController();
    let started = 0;
    const schedule = scheduleReviewWork(Array.from({ length: 6 }, (_, index) => task(`cancel-${index}`, 1, ({ signal, markAttemptStarted }) => {
      markAttemptStarted();
      started += 1;
      return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject({ kind: "canceled" }), { once: true }));
    })), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    const result = await schedule;

    expect(started).toBe(4);
    expect(result.unlaunchedUnitIds).toEqual(["cancel-4", "cancel-5"]);
    expect(result.attemptedUnitIds).toEqual(["cancel-0", "cancel-1", "cancel-2", "cancel-3"]);
    expect(result.spentWeight).toBe(4);
  });

  it("normalizes runner-shaped data while retaining per-unit usage", async () => {
    const usage = { role: "finder", turns: 1, inputTokens: 2, outputTokens: 3, contextTokens: 5 } as const;
    const result = await scheduleReviewWork([task("finder", 1, ({ markAttemptStarted }) => {
      markAttemptStarted();
      return Promise.resolve({ data: "candidate-data", usage });
    })]);
    expect(result.results[0]).toMatchObject({ id: "finder", value: "candidate-data", usage });
    expect(result.usageByUnit.finder).toEqual(usage);
  });

  it("does not let a later wave inherit reservations", async () => {
    const first = await scheduleReviewWork([task("finder", 2, ({ markAttemptStarted }) => {
      markAttemptStarted();
      return Promise.resolve("finder");
    })], { capacity: 2 });
    const second = await scheduleReviewWork([task("validator", 2, ({ markAttemptStarted }) => {
      markAttemptStarted();
      return Promise.resolve("validator");
    })], { capacity: 2 });

    expect(first.reservedWeight).toBe(0);
    expect(second.coveredUnitIds).toEqual(["validator"]);
    expect(second.spentWeight).toBe(2);
  });
});
