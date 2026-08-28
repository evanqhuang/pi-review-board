import { isReviewEffort, parseReviewEffort, type ReviewEffort } from "./effort.js";
import type { ReviewPhase } from "./types.js";

export type ReviewCommandAction = "run" | "loop" | "status" | "reset";

export interface ParsedReviewArgs {
  readonly action: ReviewCommandAction;
  readonly target?: string;
  readonly comment: boolean;
  readonly effort: ReviewEffort;
  readonly effortProvided: boolean;
  readonly model?: string;
  readonly phase: ReviewPhase | "auto";
  readonly planPath?: string;
  readonly implementationId?: string;
  readonly sessionId?: string;
  readonly confirmReset: boolean;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const canEscape = (character: string | undefined): boolean => Boolean(character && (character === "\\" || character === "'" || character === '"' || /\s/u.test(character)));

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] as string;
    const next = input[index + 1];
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && canEscape(next)) {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unclosed quote in review arguments");
  if (current) tokens.push(current);
  return tokens;
}

function optionValue(tokens: readonly string[], index: number, name: string): { value: string; consumed: number } {
  const token = tokens[index] ?? "";
  const prefix = `${name}=`;
  if (token.startsWith(prefix)) {
    const value = token.slice(prefix.length);
    if (!value) throw new Error(`${name} requires a value`);
    return { value, consumed: 0 };
  }
  const value = tokens[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return { value, consumed: 1 };
}

function isPhase(value: string): value is ReviewPhase | "auto" {
  return value === "auto" || value === "initial" || value === "delta" || value === "final";
}

export function parseReviewArgs(input: string): ParsedReviewArgs {
  const tokens = tokenize(input);
  let action: ReviewCommandAction = "run";
  let comment = false;
  let effort: ReviewEffort = "low";
  let effortProvided = false;
  let model: string | undefined;
  let phase: ReviewPhase | "auto" = "auto";
  let planPath: string | undefined;
  let implementationId: string | undefined;
  let sessionId: string | undefined;
  let confirmReset = false;
  let target: string | undefined;

  if (tokens[0] === "loop" || tokens[0] === "status" || tokens[0] === "reset") {
    action = tokens.shift() as ReviewCommandAction;
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "--comment") {
      if (comment) throw new Error("--comment may be provided only once");
      comment = true;
      continue;
    }
    if (token === "--confirm") {
      confirmReset = true;
      continue;
    }
    if (token === "--model" || token.startsWith("--model=")) {
      if (model !== undefined) throw new Error("Model may be provided only once");
      const parsed = optionValue(tokens, index, "--model");
      model = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (token === "--effort" || token.startsWith("--effort=")) {
      if (effortProvided) throw new Error("Effort level may be provided only once");
      const parsed = optionValue(tokens, index, "--effort");
      effort = parseReviewEffort(parsed.value);
      effortProvided = true;
      index += parsed.consumed;
      continue;
    }
    if (token === "--phase" || token.startsWith("--phase=")) {
      const parsed = optionValue(tokens, index, "--phase");
      if (!isPhase(parsed.value)) throw new Error(`Unknown review phase: ${parsed.value}`);
      phase = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (token === "--plan" || token.startsWith("--plan=")) {
      const parsed = optionValue(tokens, index, "--plan");
      planPath = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (token === "--implementation" || token.startsWith("--implementation=")) {
      const parsed = optionValue(tokens, index, "--implementation");
      implementationId = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (token === "--session" || token.startsWith("--session=")) {
      const parsed = optionValue(tokens, index, "--session");
      sessionId = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (token.startsWith("-")) throw new Error(`Unknown option: ${token}`);
    if (action === "run" && !effortProvided && target === undefined && isReviewEffort(token)) {
      effort = parseReviewEffort(token);
      effortProvided = true;
      continue;
    }
    if (target !== undefined) throw new Error(`Ambiguous review target: ${target} and ${token}`);
    target = token;
  }

  if (action === "reset" && !confirmReset) {
    // The command handler will return an explanatory refusal rather than
    // allowing an accidental reset from a terse command.
  }

  return {
    action,
    comment,
    effort,
    effortProvided,
    phase,
    confirmReset,
    ...(target === undefined ? {} : { target }),
    ...(model === undefined ? {} : { model }),
    ...(planPath === undefined ? {} : { planPath }),
    ...(implementationId === undefined ? {} : { implementationId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}
