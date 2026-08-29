export const REVIEWER_RESULT_TOOLS = {
  summary: "review_summary_result",
  finder: "review_finder_result",
  verifier: "review_verifier_result",
} as const;

export type ReviewerResultToolName = (typeof REVIEWER_RESULT_TOOLS)[keyof typeof REVIEWER_RESULT_TOOLS];

export type ReviewerSafeToolName = "read" | "grep" | "find" | "ls" | ReviewerResultToolName;

export const REVIEWER_RESULT_PROTOCOL_VERSION = 1 as const;
