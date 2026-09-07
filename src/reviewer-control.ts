import {
  REVIEWER_RESULT_TOOLS,
  type ReviewerResultToolName,
} from "./reviewer-protocol.js";

const RESULT_TOOL_NAMES = new Set<string>(Object.values(REVIEWER_RESULT_TOOLS));

/** Stable marker used to make context injection idempotent. */
export const REVIEWER_FINALIZATION_MARKER = "[REVIEWER_FINALIZATION_V1]";

/**
 * The instruction is deliberately provider-neutral: it changes only the
 * conversation context and names the protocol tool, not a provider payload.
 */
export function reviewerFinalizationInstruction(resultTool: ReviewerResultToolName): string {
  return `${REVIEWER_FINALIZATION_MARKER}
Finalization gate: this is the final allowed provider call. Stop investigating and submit exactly one truthful result with ${resultTool}.
Do not invent candidates, evidence, or verification. If the assigned investigation is unfinished, say so honestly; do not turn an exhausted investigation into an empty-success result.
For finder results, retain valid candidates already established and set coverageComplete:false with an incompleteReason that explains the unfinished assigned investigation. Do not force candidates to [] merely because time ended. Set coverageComplete:true only when the assigned discovery is complete.
Summary and verifier results do not have coverageComplete or incompleteReason fields; do not add those unsupported fields to those tools.`;
}

/**
 * Return a conservative UTF-8 allowance for the injected finalization
 * context message. The timestamp uses the largest safe integer so this covers
 * the serialized shape used by the controller, rather than counting prompt
 * text alone. The small context margin covers surrounding JSON delimiters.
 */
export function reviewerControlReserveBytes(resultTool: ReviewerResultToolName): number {
  const message = {
    role: "user",
    content: [{ type: "text", text: reviewerFinalizationInstruction(resultTool) }],
    timestamp: Number.MAX_SAFE_INTEGER,
  };
  return Buffer.byteLength(JSON.stringify(message), "utf8") + 32;
}

export interface ReviewerFinalizationControl {
  readonly maxTurns: number;
  readonly resultTool: ReviewerResultToolName;
}

export interface ReviewerFinalizationControllerOptions {
  /** Switches the active tool set for the next agent turn. The SDK setter is synchronous. */
  readonly setActiveTools: (toolNames: readonly string[]) => void;
}

/** Environment key used to pass one bounded invocation into the extension. */
export const REVIEWER_FINALIZATION_CONTROL_ENV = "PI_REVIEWER_CONTROL";

export interface ReviewerFinalizationState extends ReviewerFinalizationControl {
  /** Number of turn_start events observed by this controller, across continuations. */
  readonly totalTurns: number;
  readonly finalizationArmed: boolean;
  readonly instructionInjected: boolean;
}

export interface ReviewerContextMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly timestamp?: number;
}

export interface ReviewerFinalizationController {
  /** Validate and reset the controller for one bounded reviewer invocation. */
  init(control: unknown): ReviewerFinalizationControl;
  /** Count a turn_start and arm result-only tools before a one-turn run. */
  onTurnStart(): Promise<void>;
  /** Arm result-only tools after the penultimate completed turn. */
  onTurnEnd(): Promise<void>;
  /** Append exactly one finalization instruction when the final call is armed. */
  transformContext<T extends ReviewerContextMessage>(messages: readonly T[]): T[];
  readonly state: ReviewerFinalizationState;
}

function invalidControl(message: string): never {
  throw new TypeError(`Invalid reviewer finalization control: ${message}`);
}

/** Runtime validation at the control boundary; callers cannot smuggle a provider/tool name in. */
export function validateReviewerFinalizationControl(value: unknown): ReviewerFinalizationControl {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidControl("expected an object");
  }
  const candidate = value as { readonly maxTurns?: unknown; readonly resultTool?: unknown };
  if (!Number.isSafeInteger(candidate.maxTurns) || (candidate.maxTurns as number) < 1) {
    return invalidControl("maxTurns must be a positive safe integer");
  }
  if (typeof candidate.resultTool !== "string" || !RESULT_TOOL_NAMES.has(candidate.resultTool)) {
    return invalidControl("resultTool must be one of the reviewer result tools");
  }
  return Object.freeze({
    maxTurns: candidate.maxTurns as number,
    resultTool: candidate.resultTool as ReviewerResultToolName,
  });
}

/** Parse and validate the optional process environment control boundary. */
export function reviewerFinalizationControlFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReviewerFinalizationControl | undefined {
  const encoded = environment[REVIEWER_FINALIZATION_CONTROL_ENV];
  if (encoded === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded) as unknown;
  } catch {
    return invalidControl("PI_REVIEWER_CONTROL must be valid JSON");
  }
  return validateReviewerFinalizationControl(decoded);
}

function isExactFinalizationInstruction(message: ReviewerContextMessage, resultTool: ReviewerResultToolName): boolean {
  if (message.role !== "user" || !Array.isArray(message.content) || message.content.length !== 1) return false;
  const [part] = message.content;
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;
  const record = part as { readonly type?: unknown; readonly text?: unknown };
  // Match the complete injected role/content shape. A user or tool result that
  // merely quotes the marker must never suppress the control instruction.
  const keys = Object.keys(part as object).sort();
  return keys.length === 2
    && keys[0] === "text"
    && keys[1] === "type"
    && record.type === "text"
    && record.text === reviewerFinalizationInstruction(resultTool);
}

function containsExactFinalizationInstruction<T extends ReviewerContextMessage>(
  messages: readonly T[],
  resultTool: ReviewerResultToolName,
): boolean {
  return messages.some((message) => isExactFinalizationInstruction(message, resultTool));
}

class ReviewerFinalizationControllerImpl implements ReviewerFinalizationController {
  private control: ReviewerFinalizationControl;
  private totalTurns = 0;
  private finalizationArmed = false;
  private instructionInjected = false;

  public constructor(private readonly options: ReviewerFinalizationControllerOptions, control: unknown) {
    // Do not touch host actions during extension loading. The runtime setter is
    // available once the session_start hook runs; init() arms maxTurns=1 then.
    this.control = validateReviewerFinalizationControl(control);
  }

  public init(control: unknown): ReviewerFinalizationControl {
    this.control = validateReviewerFinalizationControl(control);
    this.totalTurns = 0;
    this.finalizationArmed = false;
    this.instructionInjected = false;
    if (this.control.maxTurns === 1) this.armFinalization();
    return this.control;
  }

  public async onTurnStart(): Promise<void> {
    this.totalTurns += 1;
    if (this.control.maxTurns === 1 && this.totalTurns === 1) {
      await this.armFinalization();
    }
  }

  public async onTurnEnd(): Promise<void> {
    if (this.control.maxTurns > 1 && this.totalTurns === this.control.maxTurns - 1) {
      await this.armFinalization();
    }
  }

  public transformContext<T extends ReviewerContextMessage>(messages: readonly T[]): T[] {
    if (!this.finalizationArmed) return [...messages];
    if (containsExactFinalizationInstruction(messages, this.control.resultTool)) {
      this.instructionInjected = true;
      return [...messages];
    }
    this.instructionInjected = true;
    const instruction = {
      role: "user",
      content: [{ type: "text", text: reviewerFinalizationInstruction(this.control.resultTool) }],
      timestamp: Date.now(),
    } as unknown as T;
    return [...messages, instruction];
  }

  public get state(): ReviewerFinalizationState {
    return Object.freeze({
      ...this.control,
      totalTurns: this.totalTurns,
      finalizationArmed: this.finalizationArmed,
      instructionInjected: this.instructionInjected,
    });
  }

  private armFinalization(): void {
    if (this.finalizationArmed) return;
    // setActiveTools is synchronous in the host SDK. Set the state only after
    // it returns so a failed host update cannot falsely arm finalization.
    this.options.setActiveTools([this.control.resultTool]);
    this.finalizationArmed = true;
  }
}

export function createReviewerFinalizationController(
  control: unknown,
  options: ReviewerFinalizationControllerOptions,
): ReviewerFinalizationController {
  return new ReviewerFinalizationControllerImpl(options, control);
}