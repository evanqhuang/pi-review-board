import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUT_BUDGET_BYTES,
  DEFAULT_RESERVED_TOKENS,
  InputLimitError,
  UNKNOWN_CONTEXT_CEILING,
  assertInputBudget,
  resolveInputBudget,
} from "../src/input-budget.js";

describe("shared input budget contract", () => {
  it("uses conservative defaults and clamps known model windows", () => {
    expect(resolveInputBudget(200_000, 272_000)).toEqual({
      contextBudget: 200_000,
      inputBudgetBytes: DEFAULT_INPUT_BUDGET_BYTES,
      reservedTokens: DEFAULT_RESERVED_TOKENS,
    });

    const resolved = resolveInputBudget(240_000, 100_000);
    expect(resolved.contextBudget).toBe(68_000);
    expect(resolved.contextBudget).toBeLessThanOrEqual(100_000 - DEFAULT_RESERVED_TOKENS);
    expect(resolved.inputBudgetBytes).toBeLessThanOrEqual(resolved.contextBudget);
    expect(resolved.reservedTokens).toBeGreaterThanOrEqual(32_000);
  });

  it("honors configured budgets and clamps the input cap to usable context", () => {
    expect(resolveInputBudget(200_000, 100_000, 12_345, 7_000)).toEqual({
      contextBudget: 93_000,
      inputBudgetBytes: 12_345,
      reservedTokens: 7_000,
    });

    expect(resolveInputBudget(200_000, 100_000, 200_000, 7_000)).toEqual({
      contextBudget: 93_000,
      inputBudgetBytes: 93_000,
      reservedTokens: 7_000,
    });
  });

  it.each([
    ["inputBudgetBytes", 0, DEFAULT_RESERVED_TOKENS],
    ["reservedTokens", DEFAULT_INPUT_BUDGET_BYTES, 0],
  ] as const)("rejects a nonpositive configured %s with an input-limit error", (_name, inputBudgetBytes, reservedTokens) => {
    expect(() => resolveInputBudget(200_000, undefined, inputBudgetBytes, reservedTokens)).toThrow(InputLimitError);
  });

  it("fails with a typed error when a known context has no usable capacity", () => {
    expect(() => resolveInputBudget(200_000, DEFAULT_RESERVED_TOKENS)).toThrow(InputLimitError);
    expect(() => resolveInputBudget(200_000, 1_000)).toThrow(InputLimitError);
  });

  it("uses a conservative unknown-window fallback without raising a role ceiling", () => {
    const resolved = resolveInputBudget(200_000);
    expect(resolved.contextBudget).toBe(UNKNOWN_CONTEXT_CEILING);
    expect(resolved.contextBudget).toBeLessThanOrEqual(200_000);
    expect(resolved.inputBudgetBytes).toBe(Math.min(DEFAULT_INPUT_BUDGET_BYTES, UNKNOWN_CONTEXT_CEILING));
    expect(resolved.inputBudgetBytes).toBeLessThanOrEqual(resolved.contextBudget);
  });

  it("accounts for UTF-8 bytes rather than JavaScript string length", () => {
    expect(() => assertInputBudget("é", 1)).toThrow(InputLimitError);
    expect(() => assertInputBudget("é", 2)).not.toThrow();
    expect(() => assertInputBudget("😀", 3)).toThrow(InputLimitError);
    expect(() => assertInputBudget("😀", 4)).not.toThrow();
  });
});
