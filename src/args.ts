import { isReviewEffort, parseReviewEffort, type ReviewEffort } from "./effort.js";

export interface ParsedReviewArgs {
  readonly target?: string;
  readonly comment: boolean;
  readonly effort: ReviewEffort;
  readonly model?: string;
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

export function parseReviewArgs(input: string): ParsedReviewArgs {
  const tokens = tokenize(input);
  let comment = false;
  let effort: ReviewEffort = "medium";
  let effortProvided = false;
  let model: string | undefined;
  let modelProvided = false;
  let target: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "--comment") {
      if (comment) throw new Error("--comment may be provided only once");
      comment = true;
      continue;
    }
    if (token === "--model") {
      if (modelProvided) throw new Error("Model may be provided only once");
      const value = tokens[index + 1];
      if (!value) throw new Error("--model requires a provider/id");
      model = value;
      modelProvided = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--model=")) {
      if (modelProvided) throw new Error("Model may be provided only once");
      const value = token.slice("--model=".length);
      if (!value) throw new Error("--model requires a provider/id");
      model = value;
      modelProvided = true;
      continue;
    }
    if (token === "--effort") {
      if (effortProvided) throw new Error("Effort level may be provided only once");
      const value = tokens[index + 1];
      if (!value) throw new Error("--effort requires a level");
      effort = parseReviewEffort(value);
      effortProvided = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--effort=")) {
      if (effortProvided) throw new Error("Effort level may be provided only once");
      effort = parseReviewEffort(token.slice("--effort=".length));
      effortProvided = true;
      continue;
    }
    if (token.startsWith("-")) throw new Error(`Unknown option: ${token}`);
    if (!effortProvided && target === undefined && isReviewEffort(token)) {
      effort = parseReviewEffort(token);
      effortProvided = true;
      continue;
    }
    if (target !== undefined) throw new Error(`Ambiguous review target: ${target} and ${token}`);
    target = token;
  }

  if (target === undefined) return model === undefined ? { comment, effort } : { comment, effort, model };
  return model === undefined ? { target, comment, effort } : { target, comment, effort, model };
}
