import { describe, expect, it } from "vitest";
import { cancelActiveReviews, startReviewCancellation } from "../src/cancellation.js";

describe("review cancellation", () => {
  it("cancels every active review and cleans up its registry entry", () => {
    const active = new Set<AbortController>();
    const first = startReviewCancellation(active);
    const second = startReviewCancellation(active);

    expect(active.size).toBe(2);
    expect(cancelActiveReviews(active)).toBe(2);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(cancelActiveReviews(active)).toBe(0);

    first.dispose();
    second.dispose();
    expect(active.size).toBe(0);
  });

  it("forwards an existing abort signal and removes its listener", () => {
    const active = new Set<AbortController>();
    const external = new AbortController();
    const review = startReviewCancellation(active, external.signal);

    external.abort();
    expect(review.signal.aborted).toBe(true);
    review.dispose();
    expect(active.size).toBe(0);
  });
});
