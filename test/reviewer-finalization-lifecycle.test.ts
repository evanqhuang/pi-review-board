import { describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { REVIEWER_RESULT_TOOLS } from "../src/reviewer-protocol.js";
import {
  REVIEWER_FINALIZATION_CONTROL_ENV,
  REVIEWER_FINALIZATION_MARKER,
} from "../src/reviewer-control.js";
import reviewerOutputExtension from "../extensions/reviewer-output.js";

interface ProviderCall {
  readonly tools: readonly string[];
  readonly messages: readonly unknown[];
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function resultMessage(model: Model<any>, toolName: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: `call-${toolName}`,
      name: toolName,
      // The production result extension validates the real schema. Supplying
      // a valid summary payload keeps this offline lifecycle test focused on
      // turn/tool gating rather than schema rejection retries.
      arguments: toolName === REVIEWER_RESULT_TOOLS.summary ? { summary: "honest" } : {},
    }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function fakeStream(model: Model<any>, context: Context, calls: ProviderCall[]) {
  calls.push({
    tools: (context.tools ?? []).map((tool) => tool.name),
    messages: structuredClone(context.messages),
  });
  const activeTools = context.tools?.map((tool) => tool.name) ?? [];
  const resultTool = activeTools.length === 1 && activeTools[0] === REVIEWER_RESULT_TOOLS.summary
    ? REVIEWER_RESULT_TOOLS.summary
    : "inspect";
  const message = resultMessage(model, resultTool);
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "toolUse", message });
    stream.end();
  });
  return stream;
}

const inspectTool = defineTool({
  name: "inspect",
  label: "inspect",
  description: "Inspect assigned review material.",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "inspection complete" }], details: {} };
  },
});

async function runScenario(maxTurns: number): Promise<{
  readonly calls: readonly ProviderCall[];
  readonly observedTurns: number;
}> {
  const calls: ProviderCall[] = [];
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
  });
  runtime.registerProvider("review-test", {
    baseUrl: "http://offline.invalid/v1",
    api: "openai-completions",
    apiKey: "offline-test-key",
    models: [{
      id: "review-test-model",
      name: "review-test-model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 256,
    }],
    streamSimple: (model, context) => fakeStream(model, context, calls),
  });
  const model = runtime.getModel("review-test", "review-test-model");
  if (!model) throw new Error("offline test model was not registered");

  const previousControl = process.env[REVIEWER_FINALIZATION_CONTROL_ENV];
  process.env[REVIEWER_FINALIZATION_CONTROL_ENV] = JSON.stringify({
    maxTurns,
    resultTool: REVIEWER_RESULT_TOOLS.summary,
  });
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    extensionFactories: [reviewerOutputExtension],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    tools: ["inspect", REVIEWER_RESULT_TOOLS.summary],
    customTools: [inspectTool],
    thinkingLevel: "off",
  });
  await session.bindExtensions({ mode: "print" });
  let observedTurns = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_start") observedTurns += 1;
  });
  try {
    await session.prompt("Inspect the assigned review material.");
  } finally {
    unsubscribe();
    session.dispose();
    if (previousControl === undefined) delete process.env[REVIEWER_FINALIZATION_CONTROL_ENV];
    else process.env[REVIEWER_FINALIZATION_CONTROL_ENV] = previousControl;
  }
  return { calls, observedTurns };
}

describe("reviewer finalization against installed SDK loop", () => {
  it("supplies only the result tool and one finalization instruction before a maxTurns=1 provider call", async () => {
    const { calls, observedTurns } = await runScenario(1);
    expect(observedTurns).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toEqual([REVIEWER_RESULT_TOOLS.summary]);
    const text = JSON.stringify(calls[0]?.messages);
    expect(text).toContain(REVIEWER_FINALIZATION_MARKER);
    expect(text?.split(REVIEWER_FINALIZATION_MARKER)).toHaveLength(2);
  });

  it("switches at the penultimate turn_end and reaches the exact bounded limit", async () => {
    const { calls, observedTurns } = await runScenario(3);
    expect(observedTurns).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.tools).toEqual(["inspect", REVIEWER_RESULT_TOOLS.summary]);
    expect(calls[1]?.tools).toEqual(["inspect", REVIEWER_RESULT_TOOLS.summary]);
    expect(calls[2]?.tools).toEqual([REVIEWER_RESULT_TOOLS.summary]);
    expect(JSON.stringify(calls[0]?.messages)).not.toContain(REVIEWER_FINALIZATION_MARKER);
    expect(JSON.stringify(calls[1]?.messages)).not.toContain(REVIEWER_FINALIZATION_MARKER);
    expect(JSON.stringify(calls[2]?.messages)).toContain(REVIEWER_FINALIZATION_MARKER);
  });
});
