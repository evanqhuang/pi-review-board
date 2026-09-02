import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
  REVIEWER_RESULT_PROTOCOL_VERSION,
  REVIEWER_RESULT_TOOLS,
} from "../src/reviewer-protocol.js";

const MAX_TEXT_LENGTH = 8_000;
const MAX_CANDIDATES = 8;

const nonEmptyText = (description: string) => Type.String({
  description,
  minLength: 1,
  maxLength: MAX_TEXT_LENGTH,
});

const candidateSchema = Type.Object({
  id: nonEmptyText("A stable correlation identifier for this candidate"),
  rootCauseKey: nonEmptyText("A semantic key for the underlying root cause"),
  file: nonEmptyText("The changed repository-relative file path"),
  line: Type.Integer({ description: "The positive changed-line number", minimum: 1 }),
  summary: nonEmptyText("A concise concrete defect summary"),
  failureScenario: nonEmptyText("The concrete input or state that triggers the defect"),
  evidence: nonEmptyText("Evidence from the supplied changed code"),
  category: StringEnum(["correctness", "guidance", "history", "integration", "contract"] as const, {
    description: "The concrete finding category",
  }),
  severity: StringEnum(["critical", "high", "medium"] as const, {
    description: "The practical impact severity; low-noise observations are omitted",
  }),
  needsContext: Type.Boolean({
    description: "Internal escalation request for the nearest context; never reportable by itself",
  }),
}, { additionalProperties: false });

const summarySchema = Type.Object({
  summary: nonEmptyText("A concise summary of the reviewed change"),
}, { additionalProperties: false });

const finderSchema = Type.Object({
  candidates: Type.Array(candidateSchema, {
    description: "Concrete introduced high-signal changed-line defects, or an empty array",
    maxItems: MAX_CANDIDATES,
  }),
}, { additionalProperties: false });

/** One verdict for one candidate; there is deliberately no batch field. */
const verificationSchema = Type.Object({
  candidateId: nonEmptyText("The exact candidate correlation identifier"),
  disposition: StringEnum(["CONFIRMED", "PLAUSIBLE", "REFUTED"] as const, {
    description: "The one-candidate verification disposition",
  }),
  confidence: Type.Integer({ description: "Confidence from 0 to 100", minimum: 0, maximum: 100 }),
  verification: nonEmptyText("Evidence supporting the one-candidate verdict"),
}, { additionalProperties: false });

export type ReviewerSummaryResult = Static<typeof summarySchema>;
export type ReviewerFinderResult = Static<typeof finderSchema>;
export type ReviewerVerifierResult = Static<typeof verificationSchema>;

export const reviewerOutputSchemas = {
  summary: summarySchema,
  finder: finderSchema,
  verifier: verificationSchema,
} as const;

export const reviewerOutputToolNames = REVIEWER_RESULT_TOOLS;
export const reviewerOutputProtocolVersion = REVIEWER_RESULT_PROTOCOL_VERSION;

const summaryTool = defineTool({
  name: REVIEWER_RESULT_TOOLS.summary,
  label: "Review summary result",
  description: "Submit the final structured summary for this review pass.",
  promptSnippet: "Submit the final summary with review_summary_result",
  promptGuidelines: [
    "Use review_summary_result exactly once as the final action.",
    "Do not emit a replacement assistant JSON response after submitting the result.",
  ],
  parameters: summarySchema,
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: "Review summary submitted." }],
      details: params,
      terminate: true,
    };
  },
});

const finderTool = defineTool({
  name: REVIEWER_RESULT_TOOLS.finder,
  label: "Review finder result",
  description: "Submit the final bounded candidates for this review pass.",
  promptSnippet: "Submit final candidates with review_finder_result",
  promptGuidelines: [
    "Use review_finder_result exactly once as the final action, including candidates: [] when no introduced high-signal defect exists.",
    "Set needsContext only when the concrete changed-line suspicion needs nearest-context follow-up; it is never a finding by itself.",
    "Do not emit a replacement assistant JSON response after submitting the result.",
  ],
  parameters: finderSchema,
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: "Review finder result submitted." }],
      details: params,
      terminate: true,
    };
  },
});

const verifierTool = defineTool({
  name: REVIEWER_RESULT_TOOLS.verifier,
  label: "Review candidate validation result",
  description: "Submit the final verdict for exactly one candidate.",
  promptSnippet: "Submit one candidate verdict with review_verifier_result",
  promptGuidelines: [
    "Use review_verifier_result exactly once as the final action for exactly one candidate.",
    "Return candidateId, disposition, confidence, and verification only; do not submit a batch.",
    "Do not emit a replacement assistant JSON response after submitting the result.",
  ],
  parameters: verificationSchema,
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: "Review candidate validation submitted." }],
      details: params,
      terminate: true,
    };
  },
});

export const reviewerOutputTools = [summaryTool, finderTool, verifierTool] as const;

export default function reviewerOutputExtension(pi: ExtensionAPI): void {
  for (const tool of reviewerOutputTools) pi.registerTool(tool);
}
