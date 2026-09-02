import { describe, expect, it } from "vitest";
import { ReviewProgressPresenter, reviewProgressLimits, type ProgressUI } from "../src/progress.js";
import type { ReviewProgressEvent } from "../src/types.js";

function event(type: ReviewProgressEvent["type"], role: string): ReviewProgressEvent {
  if (type === "reviewer-start") return { type, role, resultTool: "review_finder_result", attempt: 1 };
  if (type === "reviewer-turn") return { type, role, attempt: 1, usage: { role, turns: 1, inputTokens: 1200, outputTokens: 250, contextTokens: 1500 } };
  return { type: "reviewer-start", role, resultTool: "review_finder_result", attempt: 1 };
}

function mockUI() {
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, string[] | undefined>();
  const working: (string | undefined)[] = [];
  const ui: ProgressUI = {
    setStatus: (key, value) => statuses.set(key, value),
    setWidget: (key, value) => widgets.set(key, value),
    setWorkingMessage: (value) => working.push(value),
  };
  return { ui, statuses, widgets, working };
}

describe("ReviewProgressPresenter", () => {
  it("renders bounded stage and reviewer state without raw stage messages", () => {
    const mock = mockUI();
    const presenter = new ReviewProgressPresenter({ ui: mock.ui, key: "review:one" });
    presenter.start();
    presenter.update({ type: "stage", stage: "finders", message: "sensitive prompt/output should not render" });
    for (let index = 0; index < reviewProgressLimits.maxReviewers + 4; index += 1) {
      const role = `finder:${index}`;
      presenter.update(event("reviewer-start", role));
      presenter.update(event("reviewer-turn", role));
    }

    const lines = mock.widgets.get("review:one") ?? [];
    expect(lines.length).toBeLessThanOrEqual(reviewProgressLimits.maxPanelLines);
    expect(lines.join("\n")).toContain("Finders");
    expect(lines.join("\n")).toContain("finder:0");
    expect(lines.join("\n")).not.toContain("sensitive");
    expect(mock.statuses.get("review:one")).toContain("Finders");
  });

  it("keeps interleaved reviewer rows separate and displays only safe tool names", () => {
    const mock = mockUI();
    const presenter = new ReviewProgressPresenter({ ui: mock.ui, key: "review:interleaved" });
    presenter.start();
    presenter.update({ type: "reviewer-start", role: "finder:a", resultTool: "review_finder_result", attempt: 1 });
    presenter.update({ type: "reviewer-start", role: "finder:b", resultTool: "review_finder_result", attempt: 1 });
    presenter.update({ type: "reviewer-tool", role: "finder:a", attempt: 1, tool: "read", status: "started" });
    presenter.update({ type: "reviewer-tool", role: "finder:b", attempt: 1, tool: "other", status: "started" });
    const activeLines = (mock.widgets.get("review:interleaved") ?? []).join("\n");
    presenter.update({ type: "reviewer-retry", role: "finder:a", attempt: 2, usage: { role: "finder:a", turns: 2, inputTokens: 20, outputTokens: 10, contextTokens: 30 } });

    const lines = (mock.widgets.get("review:interleaved") ?? []).join("\n");
    expect(activeLines).toContain("finder:a");
    expect(activeLines).toContain("finder:b");
    expect(activeLines).toContain("read");
    expect(lines).toContain("protocol retry");
    expect(lines).not.toContain("other");
  });

  it("surfaces bounded reviewer budget failures with usage", () => {
    const mock = mockUI();
    const presenter = new ReviewProgressPresenter({ ui: mock.ui, key: "review:budget" });
    presenter.start();
    presenter.update({ type: "reviewer-failed", role: "validator", attempt: 1, kind: "context-limit", usage: { role: "validator", turns: 8, inputTokens: 2_000, outputTokens: 500, contextTokens: 8_001 } });
    const lines = (mock.widgets.get("review:budget") ?? []).join("\\n");
    expect(lines).toContain("validator · failed");
    expect(lines).toContain("context-limit");
    expect(lines).toContain("ctx:8.0k");
  });

  it("isolates cleanup for concurrent run keys and clears all state for the owner", () => {
    const mock = mockUI();
    let owner: string | undefined;
    const first = new ReviewProgressPresenter({ ui: mock.ui, key: "review:first", acquire: () => { owner = "review:first"; }, isOwner: () => owner === "review:first", release: () => { if (owner === "review:first") owner = undefined; } });
    const second = new ReviewProgressPresenter({ ui: mock.ui, key: "review:second", acquire: () => { owner = "review:second"; }, isOwner: () => owner === "review:second", release: () => { if (owner === "review:second") owner = undefined; } });

    first.start();
    second.start();
    first.clear();
    expect(mock.statuses.get("review:first")).toBeUndefined();
    expect(mock.widgets.get("review:first")).toBeUndefined();
    expect(owner).toBe("review:second");
    second.clear();
    expect(mock.statuses.get("review:second")).toBeUndefined();
    expect(mock.widgets.get("review:second")).toBeUndefined();
    expect(owner).toBeUndefined();
    expect(mock.working.at(-1)).toBeUndefined();
  });
});
