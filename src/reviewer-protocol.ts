export const REVIEWER_RESULT_TOOLS = {
  summary: "review_summary_result",
  finder: "review_finder_result",
  verifier: "review_verifier_result",
} as const;

export type ReviewerResultToolName = (typeof REVIEWER_RESULT_TOOLS)[keyof typeof REVIEWER_RESULT_TOOLS];

export type ReviewerSafeToolName = "read" | "grep" | "find" | "ls" | ReviewerResultToolName;

export const REVIEWER_RESULT_PROTOCOL_VERSION = 1 as const;

/**
 * Exact bounded recovery text shared by the runner and the reviewer runtime.
 * Keep this as one value so input-budget calculations cannot drift from the
 * text actually sent to a recovery attempt.
 */
export const REVIEWER_RETRY_SUFFIX = [
  "Protocol correction: submit exactly one final result with the required terminating tool.",
  "Do not return assistant JSON; use the required result tool even when the result is empty.",
].join(" ");

/** Backwards-compatible short name for callers that own the retry policy. */
export const RETRY_SUFFIX = REVIEWER_RETRY_SUFFIX;
