/** The two user-facing review depths. */
export const REVIEW_EFFORTS = ["normal", "deep"] as const;
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];

export type ReviewThinking = "low" | "medium" | "high" | "xhigh" | "max";

export function isReviewEffort(value: string): value is ReviewEffort {
  return REVIEW_EFFORTS.includes(value.trim().toLowerCase() as ReviewEffort);
}

/** Parse the effort contract, defaulting at the contract boundary. */
export function parseReviewEffort(value: string | undefined): ReviewEffort {
  if (value === undefined) return "normal";
  const normalized = value.trim().toLowerCase();
  if (isReviewEffort(normalized)) return normalized;
  throw new Error(`Unknown effort level: ${value}. Expected normal or deep.`);
}

export const DEFAULT_REVIEW_EFFORT: ReviewEffort = "normal";

/** Return the normalized effort without allowing callers to invent a third depth. */
export function defaultReviewEffort(value?: ReviewEffort): ReviewEffort {
  return value ?? DEFAULT_REVIEW_EFFORT;
}
