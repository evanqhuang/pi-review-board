export const REVIEW_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];
export type ReviewContextDepth = "hunk" | "nearby" | "deep" | "exhaustive";
export type ReviewThinking = "low" | "medium" | "high" | "xhigh" | "max";

export interface ReviewAgentRoute {
  readonly model: string;
  readonly thinking: ReviewThinking;
}

export interface ReviewEffortConfig {
  readonly finderLensNames: readonly string[];
  readonly maxCandidatesPerFinder: number;
  readonly maxFindings: number;
  readonly verifyCandidates: boolean;
  readonly minimumConfidence: number;
  readonly retainPlausible: boolean;
  readonly includeSummary: boolean;
  readonly fullContext: boolean;
  readonly contextDepth: ReviewContextDepth;
  readonly gapSweep: boolean;
  readonly independentVerification: boolean;
  readonly finderRoute: ReviewAgentRoute;
  readonly verifierRoute: ReviewAgentRoute;
}

const LUNA_MODEL = "openai-codex/gpt-5.6-luna";
const SOL_MODEL = "openai-codex/gpt-5.6-sol";

const LUNA_XHIGH: ReviewAgentRoute = { model: LUNA_MODEL, thinking: "xhigh" };
const LUNA_MAX: ReviewAgentRoute = { model: LUNA_MODEL, thinking: "max" };
const SOL_MEDIUM: ReviewAgentRoute = { model: SOL_MODEL, thinking: "medium" };
const SOL_HIGH: ReviewAgentRoute = { model: SOL_MODEL, thinking: "high" };
const SOL_XHIGH: ReviewAgentRoute = { model: SOL_MODEL, thinking: "xhigh" };
const SOL_MAX: ReviewAgentRoute = { model: SOL_MODEL, thinking: "max" };

const MEDIUM_LENSES = [
  "diff-correctness",
  "removed-behavior",
  "cross-file",
  "reuse",
  "simplification",
  "efficiency",
  "altitude",
  "conventions",
] as const;

const FULL_LENSES = [
  "diff-correctness",
  "removed-behavior",
  "cross-file",
  "framework-pitfalls",
  "delegation",
  "reuse",
  "simplification",
  "efficiency",
  "altitude",
  "conventions",
] as const;

export const REVIEW_EFFORT_CONFIGS: Readonly<Record<ReviewEffort, ReviewEffortConfig>> = {
  low: {
    finderLensNames: ["diff-correctness"],
    maxCandidatesPerFinder: 8,
    maxFindings: 8,
    verifyCandidates: true,
    minimumConfidence: 0,
    retainPlausible: false,
    includeSummary: false,
    fullContext: false,
    contextDepth: "hunk",
    gapSweep: false,
    independentVerification: false,
    finderRoute: LUNA_XHIGH,
    verifierRoute: LUNA_MAX,
  },
  medium: {
    finderLensNames: MEDIUM_LENSES,
    maxCandidatesPerFinder: 6,
    maxFindings: 8,
    verifyCandidates: true,
    minimumConfidence: 80,
    retainPlausible: false,
    includeSummary: true,
    fullContext: false,
    contextDepth: "nearby",
    gapSweep: false,
    independentVerification: false,
    finderRoute: LUNA_XHIGH,
    verifierRoute: SOL_MEDIUM,
  },
  high: {
    finderLensNames: MEDIUM_LENSES,
    maxCandidatesPerFinder: 6,
    maxFindings: 10,
    verifyCandidates: true,
    minimumConfidence: 80,
    retainPlausible: true,
    includeSummary: true,
    fullContext: false,
    contextDepth: "nearby",
    gapSweep: false,
    independentVerification: false,
    finderRoute: LUNA_XHIGH,
    verifierRoute: SOL_HIGH,
  },
  xhigh: {
    finderLensNames: FULL_LENSES,
    maxCandidatesPerFinder: 8,
    maxFindings: 15,
    verifyCandidates: true,
    minimumConfidence: 0,
    retainPlausible: true,
    includeSummary: true,
    fullContext: true,
    contextDepth: "deep",
    gapSweep: true,
    independentVerification: false,
    finderRoute: LUNA_XHIGH,
    verifierRoute: SOL_XHIGH,
  },
  max: {
    finderLensNames: FULL_LENSES,
    maxCandidatesPerFinder: 8,
    maxFindings: 15,
    verifyCandidates: true,
    minimumConfidence: 0,
    retainPlausible: true,
    includeSummary: true,
    fullContext: true,
    contextDepth: "exhaustive",
    gapSweep: true,
    independentVerification: false,
    finderRoute: LUNA_MAX,
    verifierRoute: SOL_MAX,
  },
  ultra: {
    finderLensNames: FULL_LENSES,
    maxCandidatesPerFinder: 8,
    maxFindings: 15,
    verifyCandidates: true,
    minimumConfidence: 0,
    retainPlausible: true,
    includeSummary: true,
    fullContext: true,
    contextDepth: "exhaustive",
    gapSweep: true,
    independentVerification: true,
    finderRoute: LUNA_MAX,
    verifierRoute: SOL_MAX,
  },
};

export function isReviewEffort(value: string): value is ReviewEffort {
  return (REVIEW_EFFORTS as readonly string[]).includes(value.toLowerCase());
}

export function parseReviewEffort(value: string | undefined): ReviewEffort {
  if (value === undefined) return "medium";
  const normalized = value.toLowerCase();
  if (isReviewEffort(normalized)) return normalized;
  throw new Error(`Unknown effort level: ${value}. Expected low, medium, high, xhigh, max, or ultra.`);
}

export function getReviewEffortConfig(effort: ReviewEffort): ReviewEffortConfig {
  return REVIEW_EFFORT_CONFIGS[effort];
}
