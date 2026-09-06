import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverApplicableGuidance,
  formatGuidance,
  guidanceForPath,
  MAX_GUIDANCE_BYTES,
} from "../src/guidance.js";

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

  it("keeps files at and below the UTF-8 byte cap usable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-guidance-size-"));
    const below = `${"é".repeat((MAX_GUIDANCE_BYTES - 2) / 2)}x`;
    const exact = "é".repeat(MAX_GUIDANCE_BYTES / 2);
    expect(Buffer.byteLength(below, "utf8")).toBe(MAX_GUIDANCE_BYTES - 1);
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_GUIDANCE_BYTES);
    await writeFile(join(cwd, "AGENTS.md"), below, "utf8");
    await writeFile(join(cwd, "CLAUDE.md"), exact, "utf8");

    const discovery = discoverApplicableGuidance(cwd, ["src/file.ts"]);

    expect(discovery.failures).toEqual([]);
    expect(discovery.truncations).toEqual([]);
    expect(discovery.files).toEqual([
      { path: join(cwd, "AGENTS.md"), content: below },
      { path: join(cwd, "CLAUDE.md"), content: exact },
    ]);
  });

  it("reports an oversized file without exposing a partial GuidanceFile", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-guidance-oversized-"));
    const path = join(cwd, "AGENTS.md");
    const prefix = "prefix that must not be returned";
    await writeFile(path, Buffer.concat([
      Buffer.from(prefix, "utf8"),
      Buffer.alloc(MAX_GUIDANCE_BYTES + 1 - Buffer.byteLength(prefix, "utf8"), "x"),
    ]));

    const discovery = discoverApplicableGuidance(cwd, ["src/file.ts"]);

    expect(discovery.files).toEqual([]);
    expect(discovery.truncations).toEqual([{
      path,
      byteLength: MAX_GUIDANCE_BYTES + 1,
      maxBytes: MAX_GUIDANCE_BYTES,
      message: `guidance file exceeds ${MAX_GUIDANCE_BYTES} UTF-8-byte limit`,
    }]);
    expect(discovery.failures).toEqual([`${path}: guidance file exceeds ${MAX_GUIDANCE_BYTES} UTF-8-byte limit`]);
    expect(formatGuidance(discovery.files, cwd)).not.toContain(prefix);
  });

  it("reports unreadable applicable guidance instead of silently completing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-guidance-unreadable-"));
    await mkdir(join(cwd, "AGENTS.md"));
    const discovery = discoverApplicableGuidance(cwd, ["src/file.ts"]);
    expect(discovery.files).toEqual([]);
    expect(discovery.truncations).toEqual([]);
    expect(discovery.failures[0]).toContain("AGENTS.md");
  });

  it("keeps nested applicability stable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-review-guidance-applicability-"));
    await mkdir(join(cwd, "src", "feature"), { recursive: true });
    const root = { path: join(cwd, "AGENTS.md"), content: "root" } as const;
    const nested = { path: join(cwd, "src", "AGENTS.md"), content: "nested" } as const;
    await writeFile(root.path, root.content);
    await writeFile(nested.path, nested.content);

    const discovery = discoverApplicableGuidance(cwd, ["src/feature/file.ts"]);

    expect(discovery.files.map((file) => file.path)).toEqual([root.path, nested.path]);
    expect(guidanceForPath(cwd, discovery.files, "src/feature/file.ts")).toEqual([root, nested]);
    expect(guidanceForPath(cwd, discovery.files, "other/file.ts")).toEqual([root]);
  });
});
