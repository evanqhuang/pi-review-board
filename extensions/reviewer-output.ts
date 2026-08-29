import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
  REVIEWER_RESULT_PROTOCOL_VERSION,
  REVIEWER_RESULT_TOOLS,
} from "../src/reviewer-protocol.js";

const MAX_TEXT_LENGTH = 8_000;
const MAX_CANDIDATES = 100;
const MAX_VERIFICATIONS = 100;

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
  failureScenario: nonEmptyText("The input or state that triggers the defect"),
  evidence: nonEmptyText("Evidence from the supplied change and repository context"),
  category: StringEnum(["correctness", "guidance", "history", "integration", "contract"] as const, {
    description: "The concrete finding category",
  }),
  severity: StringEnum(["critical", "high", "medium", "low"] as const, {
    description: "The practical impact severity",
  }),
}, { additionalProperties: false });

const summarySchema = Type.Object({
  summary: nonEmptyText("A concise summary of the reviewed change"),
}, { additionalProperties: false });

const finderSchema = Type.Object({
  candidates: Type.Array(candidateSchema, {
    description: "Concrete changed-line defects, or an empty array",
    maxItems: MAX_CANDIDATES,
  }),
}, { additionalProperties: false });

const verificationSchema = Type.Object({
  candidateId: nonEmptyText("The exact candidate correlation identifier"),
  confidence: Type.Integer({ description: "Confidence from 0 to 100", minimum: 0, maximum: 100 }),
  verification: nonEmptyText("Evidence supporting the verdict"),
  confirmed: Type.Boolean({ description: "Whether the finding should remain actionable" }),
  disposition: StringEnum(["CONFIRMED", "PLAUSIBLE", "REFUTED"] as const, {
    description: "The verification disposition",
  }),
  file: Type.Optional(nonEmptyText("An optional corrected repository-relative file path")),
  line: Type.Optional(Type.Integer({ description: "An optional corrected positive line number", minimum: 1 })),
}, { additionalProperties: false });

const verifierSchema = Type.Object({
  verifications: Type.Array(verificationSchema, {
    description: "Exactly one verdict for each supplied candidate",
    maxItems: MAX_VERIFICATIONS,
  }),
}, { additionalProperties: false });

export type ReviewerSummaryResult = Static<typeof summarySchema>;
export type ReviewerFinderResult = Static<typeof finderSchema>;
export type ReviewerVerifierResult = Static<typeof verifierSchema>;

export const reviewerOutputSchemas = {
  summary: summarySchema,
  finder: finderSchema,
  verifier: verifierSchema,
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
  description: "Submit the final structured candidates for this review pass.",
  promptSnippet: "Submit final candidates with review_finder_result",
  promptGuidelines: [
    "Use review_finder_result exactly once as the final action, including candidates: [] when no defect exists.",
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
  label: "Review verifier result",
  description: "Submit the final structured verdicts for this review batch.",
  promptSnippet: "Submit final verdicts with review_verifier_result",
  promptGuidelines: [
    "Use review_verifier_result exactly once as the final action, with one verdict for every candidate.",
    "Do not emit a replacement assistant JSON response after submitting the result.",
  ],
  parameters: verifierSchema,
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: "Review verifier result submitted." }],
      details: params,
      terminate: true,
    };
  },
});

export const reviewerOutputTools = [summaryTool, finderTool, verifierTool] as const;

export default function reviewerOutputExtension(pi: ExtensionAPI): void {
  for (const tool of reviewerOutputTools) pi.registerTool(tool);
}
