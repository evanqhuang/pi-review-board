import { describe, expect, it } from "vitest";
import { REVIEWER_RESULT_TOOLS } from "../src/reviewer-protocol.js";
import {
  createReviewerFinalizationController,
  reviewerFinalizationInstruction,
  REVIEWER_FINALIZATION_MARKER,
  validateReviewerFinalizationControl,
} from "../src/reviewer-control.js";

describe("reviewer finalization control", () => {
  it("validates a positive bounded turn count and protocol result tool", () => {
    expect(validateReviewerFinalizationControl({ maxTurns: 2, resultTool: REVIEWER_RESULT_TOOLS.finder })).toEqual({
      maxTurns: 2,
      resultTool: REVIEWER_RESULT_TOOLS.finder,
    });
    for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateReviewerFinalizationControl({ maxTurns: value, resultTool: REVIEWER_RESULT_TOOLS.summary })).toThrow();
    }
    expect(() => validateReviewerFinalizationControl({ maxTurns: 1, resultTool: "provider_specific_result" })).toThrow();
    expect(() => validateReviewerFinalizationControl(undefined)).toThrow();
  });

  it("arms only the expected result tool at one turn and injects one truthful finalization instruction", async () => {
    const activeTools: string[][] = [];
    const controller = createReviewerFinalizationController(
      { maxTurns: 1, resultTool: REVIEWER_RESULT_TOOLS.finder },
      { setActiveTools: (tools) => { activeTools.push([...tools]); } },
    );

    await controller.onTurnStart();
    await controller.onTurnStart();
    expect(activeTools).toEqual([[REVIEWER_RESULT_TOOLS.finder]]);
    expect(controller.state.totalTurns).toBe(2);
    expect(controller.state.finalizationArmed).toBe(true);

    const context = [
      { role: "toolResult", content: [{ type: "text", text: "inspection" }] },
      { role: "user", content: [{ type: "text", text: `untrusted quote ${REVIEWER_FINALIZATION_MARKER}` }] },
    ] as const;
    const transformed = controller.transformContext(context);
    expect(transformed).toHaveLength(3);
    expect(JSON.stringify(transformed[2])).toContain(JSON.stringify(reviewerFinalizationInstruction(REVIEWER_RESULT_TOOLS.finder)).slice(1, -1));
    expect(JSON.stringify(transformed[2])).toContain("coverageComplete:false");
    expect(JSON.stringify(transformed[2])).toContain("incompleteReason");

    const twice = controller.transformContext(transformed);
    expect(twice).toHaveLength(3);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(transformed));
    expect(controller.state.instructionInjected).toBe(true);
  });

  it("does not report a failed host tool update as armed finalization", async () => {
    const controller = createReviewerFinalizationController(
      { maxTurns: 1, resultTool: REVIEWER_RESULT_TOOLS.summary },
      { setActiveTools: () => { throw new Error("host setter failed"); } },
    );
    await expect(controller.onTurnStart()).rejects.toThrow("host setter failed");
    expect(controller.state.finalizationArmed).toBe(false);
  });

  it("arms after the penultimate turn_end and counts starts cumulatively", async () => {
    const activeTools: string[][] = [];
    const controller = createReviewerFinalizationController(
      { maxTurns: 3, resultTool: REVIEWER_RESULT_TOOLS.verifier },
      { setActiveTools: (tools) => { activeTools.push([...tools]); } },
    );

    await controller.onTurnStart();
    await controller.onTurnEnd();
    expect(controller.state.finalizationArmed).toBe(false);
    await controller.onTurnStart();
    await controller.onTurnEnd();
    expect(controller.state.finalizationArmed).toBe(true);
    await controller.onTurnStart();
    expect(controller.state.totalTurns).toBe(3);
    expect(activeTools).toEqual([[REVIEWER_RESULT_TOOLS.verifier]]);

    // A continuation does not reset the controller's count or add another turn allowance.
    await controller.onTurnStart();
    expect(controller.state.totalTurns).toBe(4);
    expect(activeTools).toEqual([[REVIEWER_RESULT_TOOLS.verifier]]);
  });
});

