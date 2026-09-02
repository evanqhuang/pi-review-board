import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_EFFORT, isReviewEffort, parseReviewEffort, REVIEW_EFFORTS } from "../src/effort.js";
import { getReviewPlan, REVIEW_ROLE_PLANS } from "../src/routing.js";
import type { ReviewRole } from "../src/types.js";

const roles: readonly ReviewRole[] = [
  "summary",
  "guidance-a",
  "guidance-b",
  "diff-only-bug",
  "contextual-bug",
  "integration",
  "validator",
];

const noRepositoryTools = ["summary", "guidance-a", "guidance-b", "diff-only-bug", "validator"] as const;
const repositoryTools = ["contextual-bug", "integration"] as const;
const caps: Readonly<Record<ReviewRole, number>> = {
  summary: 3,
  "guidance-a": 6,
  "guidance-b": 6,
  "diff-only-bug": 4,
  "contextual-bug": 8,
  integration: 8,
  validator: 6,
};

const candidateCaps: Readonly<Record<ReviewRole, number>> = {
  summary: 0,
  "guidance-a": 4,
  "guidance-b": 4,
  "diff-only-bug": 4,
  "contextual-bug": 4,
  integration: 4,
  validator: 1,
};

const activeRoles = {
  tiny: ["diff-only-bug"],
  small: ["diff-only-bug", "guidance-a"],
  normal: ["guidance-a", "guidance-b", "diff-only-bug", "contextual-bug"],
  deep: ["guidance-a", "guidance-b", "diff-only-bug", "contextual-bug", "integration"],
} as const;

describe("review effort contract", () => {
  it("has only normal and deep, defaulting to normal", () => {
    expect(REVIEW_EFFORTS).toEqual(["normal", "deep"]);
    expect(DEFAULT_REVIEW_EFFORT).toBe("normal");
    expect(parseReviewEffort(undefined)).toBe("normal");
    expect(parseReviewEffort(" NORMAL ")).toBe("normal");
    expect(parseReviewEffort("deep")).toBe("deep");
    expect(isReviewEffort("normal")).toBe(true);
    expect(isReviewEffort("low")).toBe(false);
    expect(() => parseReviewEffort("low")).toThrow("Expected normal or deep");
  });

  it("defines exact primary topology, tool restrictions, and role caps", () => {
    expect(Object.keys(REVIEW_ROLE_PLANS)).toEqual(["tiny", "small", "normal", "deep"]);
    for (const [route, plan] of Object.entries(REVIEW_ROLE_PLANS)) {
      const reviewPlan = getReviewPlan(route as keyof typeof activeRoles, route === "deep" ? "deep" : "normal");
      expect(Object.keys(reviewPlan.roles), route).toEqual(roles);
      expect(reviewPlan.activeRoles, route).toEqual(activeRoles[route as keyof typeof activeRoles]);

      for (const role of roles) {
        const rolePlan = reviewPlan.roles[role];
        expect(rolePlan.maxTurns, `${route}/${role}`).toBe(caps[role]);
        expect(rolePlan.candidateCap, `${route}/${role}`).toBe(candidateCaps[role]);
        expect(rolePlan.modelRoute.thinking, `${route}/${role}`).not.toMatch(/^(xhigh|max)$/);
        if ((noRepositoryTools as readonly string[]).includes(role)) {
          expect(rolePlan.tools, `${route}/${role}`).toEqual([]);
        } else if ((repositoryTools as readonly string[]).includes(role)) {
          expect(rolePlan.tools, `${route}/${role}`).toEqual(["read", "grep"]);
        }
      }
    }
  });

  it("keeps validator out of primary invocations and makes guidance multiplicity explicit", () => {
    expect(getReviewPlan("tiny").activeRoles).not.toContain("validator");
    expect(getReviewPlan("small").activeRoles).not.toContain("contextual-bug");
    expect(getReviewPlan("normal").activeRoles.filter((role) => role.startsWith("guidance"))).toEqual(["guidance-a", "guidance-b"]);
    expect(getReviewPlan("deep").activeRoles).toContain("integration");
    expect(getReviewPlan("deep").activeRoles).not.toContain("validator");
  });

  it("forces deep routing independently of the requested plan route", () => {
    expect(getReviewPlan("tiny", "deep").route).toBe("deep");
    expect(getReviewPlan("tiny", "deep").effort).toBe("deep");
  });
});
