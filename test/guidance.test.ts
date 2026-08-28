import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverApplicableGuidance, formatGuidance } from "../src/guidance.js";

describe("discoverApplicableGuidance", () => {
  it("returns root and nearest nested guidance in order", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-guidance-"));
    await mkdir(join(cwd, "src", "feature"), { recursive: true });
    await writeFile(join(cwd, "AGENTS.md"), "root rule");
    await writeFile(join(cwd, "src", "AGENTS.md"), "src rule");
    await writeFile(join(cwd, "src", "feature", "CLAUDE.md"), "feature rule");
    await writeFile(join(cwd, "unrelated.md"), "not guidance");

    const discovery = discoverApplicableGuidance(cwd, ["src/feature/file.ts"]);

    expect(discovery.failures).toEqual([]);
    expect(discovery.files.map((file) => file.path)).toEqual([
      join(cwd, "AGENTS.md"),
      join(cwd, "src", "AGENTS.md"),
      join(cwd, "src", "feature", "CLAUDE.md"),
    ]);
    expect(formatGuidance(discovery.files, cwd)).toContain("src/feature/CLAUDE.md");
  });

  it("reports unreadable applicable guidance instead of silently completing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-guidance-unreadable-"));
    await mkdir(join(cwd, "AGENTS.md"));
    const discovery = discoverApplicableGuidance(cwd, ["src/file.ts"]);
    expect(discovery.files).toEqual([]);
    expect(discovery.failures[0]).toContain("AGENTS.md");
  });
});
