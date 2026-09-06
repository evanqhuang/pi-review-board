/** Conservative prompt budget used when a role does not provide a tighter limit. */
export const DEFAULT_INPUT_BUDGET_BYTES = 64 * 1024;

/** Tokens kept available for model output and internal provider overhead. */
export const DEFAULT_RESERVED_TOKENS = 32_000;

/**
 * A provider context ceiling used when model metadata is unavailable. This is
 * deliberately a ceiling, not a claim about any particular model's identity.
 */
export const UNKNOWN_CONTEXT_CEILING = 64_000;

export interface InputLimitErrorDetails {
  readonly inputBudgetBytes?: number;
  readonly promptBytes?: number;
  readonly contextBudget?: number;
  readonly contextWindow?: number;
}

/** Raised when a prompt or resolved context has no usable bounded capacity. */
export class InputLimitError extends Error {
  public readonly inputBudgetBytes?: number;
  public readonly promptBytes?: number;
  public readonly contextBudget?: number;
  public readonly contextWindow?: number;

  public constructor(message: string, details: InputLimitErrorDetails = {}) {
    super(message);
    this.name = "InputLimitError";
    if (details.inputBudgetBytes !== undefined) this.inputBudgetBytes = details.inputBudgetBytes;
    if (details.promptBytes !== undefined) this.promptBytes = details.promptBytes;
    if (details.contextBudget !== undefined) this.contextBudget = details.contextBudget;
    if (details.contextWindow !== undefined) this.contextWindow = details.contextWindow;
  }
}

export interface ResolvedInputBudget {
  /** Maximum provider-reported context usage after the output reserve. */
  readonly contextBudget: number;
  /** Maximum UTF-8 bytes accepted for the prompt. */
  readonly inputBudgetBytes: number;
  /** Tokens retained for output and provider overhead. */
  readonly reservedTokens: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InputLimitError(`${name} must be a positive safe integer`);
  }
  return value;
}

/**
 * Resolve a role's budget against provider context metadata.
 *
 * `contextBudget` is a role ceiling, while `contextWindow` is the full model
 * window when known. The reserve is removed from the latter and the prompt
 * budget is conservatively capped at the resulting usable context using a
 * one-byte-per-token safety proxy. Without metadata, a 64k usable-context
 * ceiling is used; no role ceiling is ever increased by this fallback.
 *
 * The optional configured budgets preserve the two-argument API while allowing
 * each routed role to supply its own prompt and output reserve limits.
 */
export function resolveInputBudget(
  contextBudget: number,
  contextWindow?: number,
  configuredInputBudgetBytes?: number,
  configuredReservedTokens?: number,
): ResolvedInputBudget {
  const requestedContextBudget = positiveInteger(contextBudget, "contextBudget");
  const inputBudgetBytes = configuredInputBudgetBytes === undefined
    ? DEFAULT_INPUT_BUDGET_BYTES
    : positiveInteger(configuredInputBudgetBytes, "inputBudgetBytes");
  const reservedTokens = configuredReservedTokens === undefined
    ? DEFAULT_RESERVED_TOKENS
    : positiveInteger(configuredReservedTokens, "reservedTokens");
  const knownContextWindow = contextWindow !== undefined;
  const effectiveContextWindow = knownContextWindow
    ? positiveInteger(contextWindow, "contextWindow")
    : UNKNOWN_CONTEXT_CEILING;
  // The unknown fallback is already a conservative usable-context ceiling;
  // known provider windows need the explicit output/overhead reserve removed.
  const usableContext = knownContextWindow
    ? effectiveContextWindow - reservedTokens
    : effectiveContextWindow;
  if (usableContext <= 0) {
    throw new InputLimitError("No usable context remains after the reserved token budget", {
      contextWindow: effectiveContextWindow,
    });
  }

  const resolvedContextBudget = Math.min(requestedContextBudget, usableContext);
  if (resolvedContextBudget <= 0) {
    throw new InputLimitError("No usable context remains for the requested role budget", {
      contextBudget: resolvedContextBudget,
      contextWindow: effectiveContextWindow,
    });
  }
  const resolvedInputBudgetBytes = Math.min(inputBudgetBytes, resolvedContextBudget);
  if (resolvedInputBudgetBytes <= 0) {
    throw new InputLimitError("No usable input capacity remains for the requested role budget", {
      inputBudgetBytes: resolvedInputBudgetBytes,
      contextBudget: resolvedContextBudget,
      contextWindow: effectiveContextWindow,
    });
  }

  return Object.freeze({
    contextBudget: resolvedContextBudget,
    inputBudgetBytes: resolvedInputBudgetBytes,
    reservedTokens,
  });
}

/** Assert that a prompt fits its UTF-8 byte budget. */
export function assertInputBudget(prompt: string, inputBudgetBytes: number): void {
  if (typeof prompt !== "string") {
    throw new InputLimitError("Prompt must be a string");
  }
  const budget = positiveInteger(inputBudgetBytes, "inputBudgetBytes");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > budget) {
    throw new InputLimitError(`Prompt is ${promptBytes} UTF-8 bytes, exceeding the ${budget}-byte input budget`, {
      inputBudgetBytes: budget,
      promptBytes,
    });
  }
}
