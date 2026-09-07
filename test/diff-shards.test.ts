import { describe, expect, it } from "vitest";
import { candidateDiffExcerpt, hashDiffSnapshot, parseUnifiedDiff, shardDiff } from "../src/diff-shards.js";

const simpleDiff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@ function f",
  " const a = 1;",
  "-return a;",
  "+const b = 2;",
  "+return a + b;",
].join("\n");

describe("deterministic unified diff parsing and sharding", () => {
  it("parses ordinary hunks with side-aware ownership and stable IDs", () => {
    const parsed = parseUnifiedDiff(simpleDiff, { snapshotHash: "snap" });
    expect(parsed.ordering).toBe("source");
    expect(parsed.files[0]?.fileIdentity).toBe("src/a.ts");
    expect(parsed.files[0]?.hunks[0]?.oldRange).toEqual({ start: 1, count: 2 });
    expect(parsed.files[0]?.hunks[0]?.newRange).toEqual({ start: 1, count: 3 });
    expect(parsed.files[0]?.hunks[0]?.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["context", 1, 1],
      ["deletion", 2, undefined],
      ["addition", undefined, 2],
      ["addition", undefined, 3],
    ]);
    const first = shardDiff(simpleDiff, "snap", { maxBytes: 40960 });
    const second = shardDiff(simpleDiff, "snap", { maxBytes: 40960 });
    expect(first).toEqual(second);
    expect(first[0]?.id).toContain("snap");
    expect(first[0]?.supported).toBe(true);
    expect(first[0]?.payload).toContain("@@ -1,2 +1,3 @@ function f");
    expect(first[0]?.byteLength).toBeLessThanOrEqual(40 * 1024);
  });

  it("normalizes CRLF for parsing without changing logical payload lines or hash", () => {
    const crlf = `${simpleDiff.replace(/\n/gu, "\r\n")}\r\n`;
    const parsed = parseUnifiedDiff(crlf);
    const normal = parseUnifiedDiff(`${simpleDiff}\n`);
    expect(parsed.normalizedDiff).toBe(normal.normalizedDiff);
    expect(parsed.snapshotHash).toBe(normal.snapshotHash);
    expect(parsed.files[0]?.hunks[0]?.lines[2]?.text).toBe("const b = 2;");
    expect(shardDiff(crlf, "snap")).toEqual(shardDiff(`${simpleDiff}\n`, "snap"));
  });

  it("supports quoted paths and preserves rename metadata", () => {
    const diff = [
      'diff --git "a/old name.txt" "b/new name.txt"',
      "similarity index 95%",
      "rename from old name.txt",
      "rename to new name.txt",
    ].join("\n");
    const parsed = parseUnifiedDiff(diff, { snapshotHash: "rename" });
    expect(parsed.files[0]?.oldPath).toBe("old name.txt");
    expect(parsed.files[0]?.newPath).toBe("new name.txt");
    const shards = shardDiff(diff, "rename");
    expect(shards[0]?.supported).toBe(false);
    expect(shards[0]?.metadataOnly).toBe(true);
    expect(shards[0]?.payload).toContain("rename from old name.txt");
  });

  it("preserves no-newline markers, binary/combined records, and malformed records", () => {
    const diff = [
      "diff --git a/a b/a",
      "--- a/a",
      "+++ b/a",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "diff --cc conflict",
      "--- a/conflict",
      "+++ b/conflict",
      "@@@ -1 -1 +1 @@@",
      "-old",
      "+new",
      "diff --git a/image b/image",
      "Binary files a/image and b/image differ",
      "diff --git a/bad b/bad",
      "--- a/bad",
      "+++ b/bad",
      "@@ -1 +1 @@",
      "not a diff line",
    ].join("\n");
    const parsed = parseUnifiedDiff(diff, { snapshotHash: "special" });
    expect(parsed.files).toHaveLength(4);
    expect(parsed.files[0]?.hunks[0]?.lines[0]?.noNewlineMarker).toBe("\\ No newline at end of file");
    const shards = shardDiff(diff, "special");
    expect(shards).toHaveLength(4);
    expect(shards.every((shard) => shard.supported === false || shard.payload.includes("diff --git"))).toBe(true);
    expect(shards.find((shard) => shard.combined)?.unsupportedReason).toContain("combined");
    expect(shards.find((shard) => shard.binary)?.unsupportedReason).toContain("binary");
    expect(shards.find((shard) => shard.fileIdentity === "bad")?.unsupportedReason).toBeDefined();
  });

  it("splits at diff line boundaries and gives each old/new source line one owner", () => {
    const diff = [
      "diff --git a/long.txt b/long.txt",
      "index 1111111..2222222 100644",
      "--- a/long.txt",
      "+++ b/long.txt",
      "@@ -1,4 +1,4 @@",
      " keep-1",
      "-delete-2",
      "+add-2",
      " keep-3",
      "-delete-4",
      "+add-4",
    ].join("\n");
    const shards = shardDiff(diff, "split", { maxBytes: 140 });
    expect(shards.length).toBeGreaterThan(1);
    const ranges = shards.flatMap((shard) => shard.ranges);
    expect(ranges.flatMap((range) => range.oldLineNumbers).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(ranges.flatMap((range) => range.newLineNumbers).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(shards.every((shard) => shard.supported && shard.byteLength <= 140)).toBe(true);
    expect(shards.map((shard) => shard.payload).join("\n")).not.toContain("+add-2\n ");
  });

  it("uses a resolved payload ceiling above the standalone default", () => {
    const diff = [
      "diff --git a/large.txt b/large.txt", "--- a/large.txt", "+++ b/large.txt",
      "@@ -0,0 +1 @@", `+${"x".repeat(45 * 1024)}`,
    ].join("\n");
    expect(shardDiff(diff, "resolved").some((shard) => !shard.supported)).toBe(true);
    const shards = shardDiff(diff, "resolved", { maxBytes: 60 * 1024 });
    expect(shards).toHaveLength(1);
    expect(shards[0]?.supported).toBe(true);
    expect(shards[0]?.payload).toContain("x".repeat(45 * 1024));
  });

  it("fits serialized prompts with escaping and overhead without losing line ownership", () => {
    const lines = Array.from({ length: 90 }, (_, index) => `+row-${index}-${'é"\\'.repeat(8)}`);
    const diff = ["diff --git a/q b/q", "--- a/q", "+++ b/q", `@@ -0,0 +1,${lines.length} @@`, ...lines].join("\n");
    const promptBytes = (payload: string): number => Buffer.byteLength(JSON.stringify({ guidance: "rules".repeat(30), diff: payload }), "utf8");
    const options = { maxBytes: 2000, fitsPrompt: (shard: { payload: string }) => promptBytes(shard.payload) <= 900 };
    const shards = shardDiff(diff, "escaped", options);
    expect(shards).toEqual(shardDiff(diff, "escaped", options));
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.every((shard) => shard.supported && promptBytes(shard.payload) <= 900)).toBe(true);
    expect(shards.flatMap((shard) => shard.ranges.flatMap((range) => range.newLineNumbers))).toEqual(Array.from({ length: 90 }, (_, index) => index + 1));
    const replayed = shards.map((shard) => shard.payload).join("\n");
    for (const line of lines) expect(replayed.split("\n").filter((value) => value === line)).toHaveLength(1);
  });

  it("retains unsupported coverage when guidance alone cannot fit", () => {
    const shards = shardDiff(simpleDiff, "overhead", { maxBytes: 64 * 1024, fitsPrompt: () => false });
    expect(shards).toHaveLength(1);
    expect(shards[0]?.supported).toBe(false);
    expect(shards[0]?.unsupportedReason).toContain("prompt budget");
    expect(shards[0]?.payload).toContain("+return a + b;");
    expect(shards[0]?.ranges.flatMap((range) => range.newLineNumbers)).toEqual([1, 2, 3]);
  });

  it("merges candidate windows and preserves exact old/new source ranges", () => {
    const excerpt = candidateDiffExcerpt(simpleDiff, "excerpt", [{ file: "src/a.ts", line: 2 }, { file: "src/a.ts", line: 3 }], 0);
    const parsed = parseUnifiedDiff(excerpt);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.supported).toBe(true);
    expect(parsed.files[0]?.hunks).toHaveLength(1);
    expect(parsed.files[0]?.hunks[0]?.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["deletion", 2, undefined], ["addition", undefined, 2], ["addition", undefined, 3],
    ]);
    expect(excerpt).not.toContain("const a = 1");
    expect(() => candidateDiffExcerpt(simpleDiff, "excerpt", [{ file: "missing.ts", line: 2 }], 0)).toThrow("no matching source line");
  });

  it("preserves deletion coordinates and no-newline excerpt metadata", () => {
    const diff = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -8 +8 @@", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file"].join("\n");
    const excerpt = candidateDiffExcerpt(diff, "markers", [{ file: "a", line: 8 }], 0);
    const lines = parseUnifiedDiff(excerpt).files[0]?.hunks[0]?.lines;
    expect(lines?.map((line) => [line.kind, line.oldLine, line.newLine, line.noNewlineMarker])).toEqual([
      ["deletion", 8, undefined, "\\ No newline at end of file"],
      ["addition", undefined, 8, "\\ No newline at end of file"],
    ]);
  });

  it("does not truncate a UTF-8 line that cannot fit", () => {
    const longLine = `+${"é".repeat(300)}`;
    const diff = [
      "diff --git a/u b/u",
      "--- a/u",
      "+++ b/u",
      "@@ -0,0 +1 @@",
      longLine,
    ].join("\n");
    const shards = shardDiff(diff, "utf8", { maxBytes: 100 });
    expect(shards.some((shard) => !shard.supported)).toBe(true);
    expect(shards.find((shard) => !shard.supported)?.payload).toContain(longLine);
    expect(shards.find((shard) => !shard.supported)?.unsupportedReason).toContain("not truncated");
    expect(hashDiffSnapshot(diff)).toHaveLength(64);
  });
});
