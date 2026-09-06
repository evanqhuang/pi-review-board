import { describe, expect, it } from "vitest";
import { hashDiffSnapshot, parseUnifiedDiff, shardDiff } from "../src/diff-shards.js";

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
