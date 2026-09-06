import { createHash } from "node:crypto";
import type {
  DiffHunk,
  DiffLine,
  DiffRange,
  DiffShard,
  DiffShardRange,
  ParsedDiff,
  ParsedDiffFile,
} from "./types.js";

/** Hard upper bound for a target serialized diff shard payload. */
export const MAX_DIFF_SHARD_BYTES = 40 * 1024;
export const MAX_SERIALIZED_DIFF_PAYLOAD_BYTES = MAX_DIFF_SHARD_BYTES;
export const DEFAULT_MAX_DIFF_SHARD_BYTES = MAX_DIFF_SHARD_BYTES;
export const DEFAULT_MAX_DIFF_PAYLOAD_BYTES = DEFAULT_MAX_DIFF_SHARD_BYTES;

export interface DiffParseOptions {
  readonly snapshotHash?: string;
}

export interface DiffShardingOptions extends DiffParseOptions {
  /** A smaller test or provider target is allowed; larger values are capped. */
  readonly maxBytes?: number;
  readonly maxShardBytes?: number;
  readonly maxPayloadBytes?: number;
}

export interface DiffShardInput {
  readonly diff: string;
  readonly snapshotHash?: string;
}

interface SourceLines {
  readonly lines: readonly string[];
  readonly normalized: string;
}

interface HeaderPaths {
  readonly oldPath: string | null;
  readonly newPath: string | null;
}

interface Piece {
  readonly id: string;
  readonly file: ParsedDiffFile;
  readonly text: string;
  readonly byteLength: number;
  readonly supported: boolean;
  readonly metadataOnly: boolean;
  readonly binary: boolean;
  readonly combined: boolean;
  readonly ranges: readonly DiffShardRange[];
  readonly reason?: string;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function freezeObject<T extends object>(value: T): T {
  return Object.freeze(value);
}

function normalizeDiff(diff: string): SourceLines {
  const normalized = diff.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return { normalized, lines: freezeArray(lines) };
}

/** Hash the logical LF-normalized snapshot used by the parser. */
export function hashDiffSnapshot(diff: string): string {
  return createHash("sha256").update(normalizeDiff(diff).normalized, "utf8").digest("hex");
}

function decodeGitQuoted(value: string): string {
  if (!value.startsWith('"')) return value;
  let output = "";
  let octalBytes: number[] = [];
  const flushOctalBytes = (): void => {
    if (octalBytes.length === 0) return;
    output += Buffer.from(octalBytes).toString("utf8");
    octalBytes = [];
  };
  let index = 1;
  while (index < value.length) {
    const character = value[index];
    if (character === '"') {
      flushOctalBytes();
      return output;
    }
    if (character !== "\\") {
      flushOctalBytes();
      output += character;
      index += 1;
      continue;
    }
    index += 1;
    const escaped = value[index];
    if (escaped === undefined) break;
    const simple: Record<string, string> = {
      "\\": "\\",
      '"': '"',
      "a": "\x07",
      "b": "\b",
      "t": "\t",
      "n": "\n",
      "v": "\v",
      "f": "\f",
      "r": "\r",
    };
    const decoded = simple[escaped];
    if (decoded !== undefined) {
      flushOctalBytes();
      output += decoded;
      index += 1;
      continue;
    }
    if (/^[0-7]$/u.test(escaped)) {
      let digits = escaped;
      index += 1;
      while (digits.length < 3 && index < value.length && /^[0-7]$/u.test(value[index] ?? "")) {
        digits += value[index] ?? "";
        index += 1;
      }
      octalBytes.push(Number.parseInt(digits, 8));
      continue;
    }
    flushOctalBytes();
    output += escaped;
    index += 1;
  }
  flushOctalBytes();
  return output;
}

/** Tokenize the two path operands of a git diff header, including quoted paths. */
function gitTokens(value: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/u.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    if (value[index] === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < value.length) {
        const character = value[index] ?? "";
        index += 1;
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          break;
        }
      }
      tokens.push(decodeGitQuoted(value.slice(start, index)));
      continue;
    }
    const start = index;
    while (index < value.length && !/\s/u.test(value[index] ?? "")) index += 1;
    tokens.push(value.slice(start, index));
  }
  return tokens;
}

function logicalPath(value: string | undefined, prefix?: "a" | "b"): string | null {
  if (value === undefined) return null;
  const decoded = decodeGitQuoted(value.trim());
  if (decoded === "/dev/null") return null;
  if (prefix !== undefined && decoded.startsWith(`${prefix}/`)) return decoded.slice(2);
  if (/^[ab]\//u.test(decoded)) return decoded.slice(2);
  return decoded;
}

function patchPathFromLine(line: string, marker: "---" | "+++"): string | null | undefined {
  if (!line.startsWith(`${marker} `)) return undefined;
  const value = line.slice(4);
  const token = value.startsWith('"') ? gitTokens(value)[0] : value.split("\t", 1)[0];
  return logicalPath(token);
}

function parseHeaderPaths(line: string): { readonly paths: HeaderPaths; readonly combined: boolean } {
  const combined = line.startsWith("diff --combined ") || line.startsWith("diff --cc ");
  const prefix = line.startsWith("diff --git ") ? "diff --git " : line.startsWith("diff --combined ") ? "diff --combined " : "diff --cc ";
  const tokens = line.startsWith(prefix) ? gitTokens(line.slice(prefix.length)) : [];
  if (combined) {
    const path = logicalPath(tokens[0]);
    return { paths: { oldPath: path, newPath: path }, combined };
  }
  return {
    paths: {
      oldPath: logicalPath(tokens[0], "a"),
      newPath: logicalPath(tokens[1], "b"),
    },
    combined: false,
  };
}

function pathFromRenameLine(line: string, marker: "rename from" | "rename to"): string | undefined {
  if (!line.startsWith(`${marker} `)) return undefined;
  const value = line.slice(marker.length + 1).trim();
  return logicalPath(value) ?? undefined;
}

function hunkHeader(line: string): { readonly oldRange: DiffRange; readonly newRange: DiffRange; readonly sectionHeader: string } | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(line);
  if (match === null) return undefined;
  const oldStart = Number.parseInt(match[1] ?? "", 10);
  const newStart = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart)) return undefined;
  const oldCount = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
  const newCount = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);
  if (!Number.isSafeInteger(oldCount) || !Number.isSafeInteger(newCount)) return undefined;
  return {
    oldRange: freezeObject({ start: oldStart, count: oldCount }),
    newRange: freezeObject({ start: newStart, count: newCount }),
    sectionHeader: match[5] ?? "",
  };
}

function unsupportedFile(
  sourceOrder: number,
  lines: readonly string[],
  paths: HeaderPaths,
  combined: boolean,
  malformed: boolean,
  reason: string,
): ParsedDiffFile {
  const oldPath = paths.oldPath;
  const newPath = paths.newPath;
  const fileIdentity = newPath ?? oldPath ?? `unknown-${sourceOrder}`;
  const headerLines = freezeArray(lines);
  return freezeObject({
    sourceOrder,
    fileIdentity,
    oldPath,
    newPath,
    headerLines,
    metadataLines: freezeArray(lines.slice(1)),
    hunks: freezeArray([]),
    raw: lines.join("\n"),
    binary: false,
    combined,
    malformed,
    supported: false,
    unsupportedReason: reason,
  });
}

function parseFile(lines: readonly string[], sourceOrder: number): ParsedDiffFile {
  const firstLine = lines[0] ?? "";
  const parsedHeader = parseHeaderPaths(firstLine);
  let oldPath = parsedHeader.paths.oldPath;
  let newPath = parsedHeader.paths.newPath;
  let firstHunk = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^@@ /u.test(lines[index] ?? "")) {
      firstHunk = index;
      break;
    }
  }
  const preludeEnd = firstHunk < 0 ? lines.length : firstHunk;
  const prelude = lines.slice(1, preludeEnd);
  const hasOldPatchPath = prelude.some((line) => line.startsWith("--- "));
  const hasNewPatchPath = prelude.some((line) => line.startsWith("+++ "));
  for (const line of prelude) {
    const oldPatchPath = patchPathFromLine(line, "---");
    if (oldPatchPath !== undefined) oldPath = oldPatchPath;
    const newPatchPath = patchPathFromLine(line, "+++");
    if (newPatchPath !== undefined) newPath = newPatchPath;
    const renameFrom = pathFromRenameLine(line, "rename from");
    if (renameFrom !== undefined) oldPath = renameFrom;
    const renameTo = pathFromRenameLine(line, "rename to");
    if (renameTo !== undefined) newPath = renameTo;
  }
  const fileIdentity = newPath ?? oldPath ?? `unknown-${sourceOrder}`;
  const binary = lines.some((line) => /^Binary files /u.test(line) || line === "GIT binary patch" || /^(?:literal|delta) \d+$/u.test(line));
  const combined = parsedHeader.combined || lines.some((line) => /^@@@/u.test(line));
  const headerLines = freezeArray(lines.slice(0, firstHunk < 0 ? lines.length : firstHunk));
  const metadataLines = freezeArray(lines.slice(1, preludeEnd));
  const hunks: DiffHunk[] = [];
  let malformed = !/^diff --(?:git|combined|cc)(?:\s|$)/u.test(firstLine);
  let malformedReason = malformed ? "malformed diff file header" : undefined;
  const headerTokenCount = gitTokens(firstLine.replace(/^diff --(?:git|combined|cc)\s*/u, "")).length;
  if (!malformed && !parsedHeader.combined && headerTokenCount < 2) {
    malformed = true;
    malformedReason = "diff file header is missing one or more paths";
  }
  if (!malformed && hasOldPatchPath !== hasNewPatchPath) {
    malformed = true;
    malformedReason = "diff file is missing one of its ---/+++ paths";
  }
  if (!malformed && firstHunk < 0 && lines.slice(1).some((line) => /^@@/u.test(line))) {
    malformed = true;
    malformedReason = combined ? "combined diff hunk format is unsupported" : "malformed hunk header";
  }
  let index = firstHunk;

  while (!malformed && index >= 0 && index < lines.length) {
    const header = lines[index];
    if (header === undefined) break;
    const parsedHunk = hunkHeader(header);
    if (parsedHunk === undefined) {
      malformed = true;
      malformedReason = /^@@@/u.test(header) ? "combined diff hunk format is unsupported" : "malformed hunk header";
      break;
    }
    if (parsedHunk.oldRange.count === 0 && parsedHunk.newRange.count === 0) {
      malformed = true;
      malformedReason = "hunk has no old or new source lines";
      break;
    }
    const hunkHeaderIndex = index;
    index += 1;
    let oldCursor = parsedHunk.oldRange.start;
    let newCursor = parsedHunk.newRange.start;
    let oldConsumed = 0;
    let newConsumed = 0;
    let previousLine: DiffLine | undefined;
    const parsedLines: DiffLine[] = [];
    const rawLines = [header];
    let hunkMalformed = false;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line === "\\ No newline at end of file") {
        if (previousLine === undefined || previousLine.noNewlineMarker !== undefined) {
          hunkMalformed = true;
          malformedReason = "no-newline marker has no preceding diff line";
          break;
        }
        const marked = freezeObject({ ...previousLine, noNewlineMarker: line });
        parsedLines[parsedLines.length - 1] = marked;
        previousLine = marked;
        rawLines.push(line);
        index += 1;
        continue;
      }
      if (oldConsumed === parsedHunk.oldRange.count && newConsumed === parsedHunk.newRange.count) break;
      const prefix = line[0];
      let kind: DiffLine["kind"];
      if (prefix === " ") kind = "context";
      else if (prefix === "+") kind = "addition";
      else if (prefix === "-") kind = "deletion";
      else {
        hunkMalformed = true;
        malformedReason = "malformed hunk payload line";
        break;
      }
      const ownsOld = kind === "context" || kind === "deletion";
      const ownsNew = kind === "context" || kind === "addition";
      if ((ownsOld && oldConsumed >= parsedHunk.oldRange.count) || (ownsNew && newConsumed >= parsedHunk.newRange.count)) {
        hunkMalformed = true;
        malformedReason = "hunk payload exceeds its declared range";
        break;
      }
      const lineValue: DiffLine = {
        kind,
        text: line.slice(1),
        raw: line,
        ...(ownsOld ? { oldLine: oldCursor } : {}),
        ...(ownsNew ? { newLine: newCursor } : {}),
      };
      const frozenLine = freezeObject(lineValue);
      parsedLines.push(frozenLine);
      previousLine = frozenLine;
      rawLines.push(line);
      if (ownsOld) {
        oldConsumed += 1;
        oldCursor += 1;
      }
      if (ownsNew) {
        newConsumed += 1;
        newCursor += 1;
      }
      index += 1;
    }
    if (hunkMalformed || oldConsumed !== parsedHunk.oldRange.count || newConsumed !== parsedHunk.newRange.count) {
      malformed = true;
      malformedReason ??= "hunk payload does not match its declared ranges";
      break;
    }
    const hunk = freezeObject({
      index: hunks.length,
      headerLine: header,
      sectionHeader: parsedHunk.sectionHeader,
      oldRange: parsedHunk.oldRange,
      newRange: parsedHunk.newRange,
      lines: freezeArray(parsedLines),
      rawLines: freezeArray(rawLines),
      sourceStartLine: hunkHeaderIndex + 1,
      sourceEndLine: Math.max(hunkHeaderIndex + 1, index),
    });
    hunks.push(hunk);
    if (index >= lines.length) break;
    if (!/^@@ /u.test(lines[index] ?? "")) {
      malformed = true;
      malformedReason = "unexpected data after hunk";
      break;
    }
  }

  if (combined) {
    malformedReason = "combined diff format is unsupported";
  } else if (binary) {
    malformedReason = "binary diff is unsupported for line sharding";
  } else if (malformedReason === undefined && hunks.length === 0) {
    malformedReason = "metadata-only diff has no hunks";
  }
  const unsupportedReason = malformedReason;
  const supported = !combined && !binary && !malformed && hunks.length > 0;
  const result: ParsedDiffFile = {
    sourceOrder,
    fileIdentity,
    oldPath,
    newPath,
    headerLines,
    metadataLines,
    hunks: freezeArray(hunks),
    raw: lines.join("\n"),
    binary,
    combined,
    malformed,
    supported,
    ...(unsupportedReason === undefined ? {} : { unsupportedReason }),
  };
  return freezeObject(result);
}

/** Parse only the supplied immutable diff text.  No repository or command is consulted. */
export function parseUnifiedDiff(diff: string, options?: DiffParseOptions | string): ParsedDiff {
  if (typeof diff !== "string") throw new TypeError("diff must be a string");
  const source = normalizeDiff(diff);
  const parseOptions = typeof options === "string" ? { snapshotHash: options } : options ?? {};
  const snapshotHash = parseOptions.snapshotHash ?? hashDiffSnapshot(diff);
  const starts: number[] = [];
  for (let index = 0; index < source.lines.length; index += 1) {
    if (/^diff --(?:git|combined|cc)(?:\s|$)/u.test(source.lines[index] ?? "")) starts.push(index);
  }
  const files: ParsedDiffFile[] = [];
  if (starts.length === 0) {
    if (source.lines.some((line) => line.trim() !== "")) {
      files.push(unsupportedFile(0, source.lines, { oldPath: null, newPath: null }, false, true, "diff contains no file header"));
    }
  } else {
    const firstStart = starts[0] ?? 0;
    const preamble = source.lines.slice(0, firstStart);
    if (preamble.some((line) => line.trim() !== "")) {
      files.push(unsupportedFile(0, preamble, { oldPath: null, newPath: null }, false, true, "data before first diff file header"));
    }
    for (let position = 0; position < starts.length; position += 1) {
      const start = starts[position] ?? 0;
      const end = starts[position + 1] ?? source.lines.length;
      files.push(parseFile(source.lines.slice(start, end), files.length));
    }
  }
  return freezeObject({
    snapshotHash,
    normalizedDiff: source.normalized,
    ordering: "source" as const,
    files: freezeArray(files),
    malformed: files.some((file) => file.malformed),
  });
}

export const parseDiff = parseUnifiedDiff;
export const parseGitDiff = parseUnifiedDiff;

function formatRange(range: DiffRange): string {
  return range.count === 1 ? `${range.start}` : `${range.start},${range.count}`;
}

function sideRange(
  hunk: DiffHunk,
  lines: readonly DiffLine[],
  start: number,
  end: number,
  side: "oldLine" | "newLine",
): DiffRange {
  const owned = lines.slice(start, end).flatMap((line) => line[side] === undefined ? [] : [line[side] as number]);
  if (owned.length > 0) return { start: owned[0] ?? hunk[side === "oldLine" ? "oldRange" : "newRange"].start, count: owned.length };
  const previous = lines.slice(0, start).reverse().find((line) => line[side] !== undefined)?.[side];
  const original = side === "oldLine" ? hunk.oldRange : hunk.newRange;
  return { start: previous ?? original.start, count: 0 };
}

function shardRange(hunk: DiffHunk, start: number, end: number): DiffShardRange {
  const selected = hunk.lines.slice(start, end);
  const oldRange = sideRange(hunk, hunk.lines, start, end, "oldLine");
  const newRange = sideRange(hunk, hunk.lines, start, end, "newLine");
  return freezeObject({
    hunkIndex: hunk.index,
    oldRange: freezeObject(oldRange),
    newRange: freezeObject(newRange),
    oldLineNumbers: freezeArray(selected.flatMap((line) => line.oldLine === undefined ? [] : [line.oldLine])),
    newLineNumbers: freezeArray(selected.flatMap((line) => line.newLine === undefined ? [] : [line.newLine])),
  });
}

function correctedHunkHeader(hunk: DiffHunk, range: DiffShardRange): string {
  return `@@ -${formatRange(range.oldRange)} +${formatRange(range.newRange)} @@${hunk.sectionHeader}`;
}

function fragmentLines(hunk: DiffHunk, start: number, end: number): readonly string[] {
  const range = shardRange(hunk, start, end);
  const lines = hunk.lines.slice(start, end).flatMap((line) => line.noNewlineMarker === undefined ? [line.raw] : [line.raw, line.noNewlineMarker]);
  return freezeArray([correctedHunkHeader(hunk, range), ...lines]);
}

function joinedLines(lines: readonly string[]): string {
  return lines.join("\n");
}

function payloadWithTerminalLine(parts: readonly string[]): string {
  return `${parts.join("\n")}\n`;
}

function allRanges(file: ParsedDiffFile): readonly DiffShardRange[] {
  return freezeArray(file.hunks.map((hunk) => freezeObject({ ...shardRange(hunk, 0, hunk.lines.length), fileIdentity: file.fileIdentity })));
}

function pieceId(snapshotHash: string, file: ParsedDiffFile, hunkIndex: number | "file", start: number, end: number): string {
  const ranges = file.hunks.map((hunk) => `${hunk.index}:${hunk.oldRange.start},${hunk.oldRange.count}:${hunk.newRange.start},${hunk.newRange.count}`).join(";");
  const material = `${snapshotHash}\u0000${file.sourceOrder}\u0000${file.fileIdentity}\u0000${ranges}\u0000${hunkIndex}\u0000${start}\u0000${end}`;
  return `${snapshotHash}:piece:${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 24)}`;
}

function createPiece(
  snapshotHash: string,
  file: ParsedDiffFile,
  text: string,
  ranges: readonly DiffShardRange[],
  id: string,
  supported: boolean,
  reason?: string,
): Piece {
  const value: Piece = {
    id,
    file,
    text,
    byteLength: Buffer.byteLength(payloadWithTerminalLine([text]), "utf8"),
    supported,
    metadataOnly: file.hunks.length === 0,
    binary: file.binary,
    combined: file.combined,
    ranges: freezeArray(ranges),
    ...(reason === undefined ? {} : { reason }),
  };
  // Keep snapshotHash in this function's contract so a future serializer
  // cannot accidentally construct a piece from a different snapshot.
  void snapshotHash;
  return freezeObject(value);
}

function fullPiece(snapshotHash: string, file: ParsedDiffFile): Piece {
  const reason = file.supported ? undefined : file.unsupportedReason ?? "unsupported diff file";
  return createPiece(snapshotHash, file, file.raw, allRanges(file), pieceId(snapshotHash, file, "file", 0, file.raw.length), file.supported, reason);
}

function hunkPiece(
  snapshotHash: string,
  file: ParsedDiffFile,
  hunk: DiffHunk,
  start: number,
  end: number,
  baseLines: readonly string[],
  supported: boolean,
  reason?: string,
): Piece {
  const range = freezeObject({ ...shardRange(hunk, start, end), fileIdentity: file.fileIdentity });
  const text = joinedLines([...baseLines, ...fragmentLines(hunk, start, end)]);
  return createPiece(snapshotHash, file, text, [range], pieceId(snapshotHash, file, hunk.index, start, end), supported, reason);
}

function splitSupportedFile(snapshotHash: string, file: ParsedDiffFile, maxBytes: number): readonly Piece[] {
  const baseLines = file.headerLines;
  const baseText = joinedLines(baseLines);
  if (Buffer.byteLength(payloadWithTerminalLine([baseText]), "utf8") > maxBytes) {
    return freezeArray([createPiece(snapshotHash, file, file.raw, allRanges(file), pieceId(snapshotHash, file, "file", 0, file.raw.length), false, `file metadata exceeds ${maxBytes} UTF-8 bytes`)]);
  }
  const pieces: Piece[] = [];
  for (const hunk of file.hunks) {
    const complete = hunkPiece(snapshotHash, file, hunk, 0, hunk.lines.length, baseLines, true);
    if (complete.byteLength <= maxBytes) {
      pieces.push(complete);
      continue;
    }
    const headerOnly = hunkPiece(snapshotHash, file, hunk, 0, 0, baseLines, true);
    if (headerOnly.byteLength > maxBytes) {
      pieces.push(hunkPiece(
        snapshotHash,
        file,
        hunk,
        0,
        hunk.lines.length,
        baseLines,
        false,
        `indivisible hunk metadata exceeds ${maxBytes} UTF-8 bytes`,
      ));
      continue;
    }
    let start = 0;
    while (start < hunk.lines.length) {
      let end = start + 1;
      let best: Piece | undefined;
      while (end <= hunk.lines.length) {
        const candidate = hunkPiece(snapshotHash, file, hunk, start, end, baseLines, true);
        if (candidate.byteLength > maxBytes) break;
        best = candidate;
        end += 1;
      }
      if (best !== undefined) {
        pieces.push(best);
        start = end - 1;
      } else {
        const oversized = hunkPiece(
          snapshotHash,
          file,
          hunk,
          start,
          start + 1,
          baseLines,
          false,
          `indivisible diff line exceeds ${maxBytes} UTF-8 bytes; line was not truncated`,
        );
        pieces.push(oversized);
        start += 1;
      }
    }
  }
  return freezeArray(pieces);
}

function piecesForFile(snapshotHash: string, file: ParsedDiffFile, maxBytes: number): readonly Piece[] {
  const complete = fullPiece(snapshotHash, file);
  if (!file.supported || complete.byteLength <= maxBytes) return freezeArray([complete]);
  return splitSupportedFile(snapshotHash, file, maxBytes);
}

function shardId(snapshotHash: string, ordinal: number, pieces: readonly Piece[]): string {
  const material = pieces.map((piece) => piece.id).join("\u0000");
  return `${snapshotHash}:shard:${ordinal}:${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 24)}`;
}

function makeShard(snapshotHash: string, ordinal: number, maxBytes: number, pieces: readonly Piece[]): DiffShard {
  const payload = payloadWithTerminalLine(pieces.map((piece) => piece.text));
  const identities = freezeArray([...new Set(pieces.map((piece) => piece.file.fileIdentity))]);
  const ranges = freezeArray(pieces.flatMap((piece) => piece.ranges));
  const supported = pieces.every((piece) => piece.supported);
  const reasons = pieces.flatMap((piece) => piece.reason === undefined ? [] : [piece.reason]);
  const value: DiffShard = {
    id: shardId(snapshotHash, ordinal, pieces),
    snapshotHash,
    sourceOrder: Math.min(...pieces.map((piece) => piece.file.sourceOrder)),
    fileIdentity: identities.length === 1 ? identities[0] ?? "unknown" : "multiple",
    fileIdentities: identities,
    oldPath: pieces.length === 1 ? pieces[0]?.file.oldPath ?? null : null,
    newPath: pieces.length === 1 ? pieces[0]?.file.newPath ?? null : null,
    payload,
    byteLength: Buffer.byteLength(payload, "utf8"),
    maxBytes,
    supported,
    metadataOnly: pieces.some((piece) => piece.metadataOnly),
    binary: pieces.some((piece) => piece.binary),
    combined: pieces.some((piece) => piece.combined),
    malformed: pieces.some((piece) => piece.file.malformed),
    pieceIds: freezeArray(pieces.map((piece) => piece.id)),
    ranges,
    coveredRanges: ranges,
    ...(reasons.length === 0 ? {} : { unsupportedReason: [...new Set(reasons)].join("; ") }),
  };
  return freezeObject(value);
}

function targetBytes(options: DiffShardingOptions): number {
  const requested = options.maxBytes ?? options.maxShardBytes ?? options.maxPayloadBytes ?? MAX_DIFF_SHARD_BYTES;
  if (!Number.isSafeInteger(requested) || requested <= 0) throw new RangeError("max diff shard bytes must be a positive safe integer");
  return Math.min(requested, MAX_DIFF_SHARD_BYTES);
}

/**
 * Parse and greedily serialize a diff into independently replayable git-like
 * shards. Source file and hunk order is retained. Oversized atomic records are
 * returned as explicit unsupported shards rather than being truncated.
 */
export function shardDiff(diff: string, options?: DiffShardingOptions): readonly DiffShard[];
export function shardDiff(diff: string, snapshotHash: string, options?: Omit<DiffShardingOptions, "snapshotHash">): readonly DiffShard[];
export function shardDiff(input: DiffShardInput, options?: Omit<DiffShardingOptions, "snapshotHash">): readonly DiffShard[];
export function shardDiff(
  input: string | DiffShardInput,
  snapshotOrOptions: string | DiffShardingOptions = {},
  suppliedOptions: Omit<DiffShardingOptions, "snapshotHash"> = {},
): readonly DiffShard[] {
  const diff = typeof input === "string" ? input : input.diff;
  const options: DiffShardingOptions = typeof input === "string"
    ? typeof snapshotOrOptions === "string" ? { ...suppliedOptions, snapshotHash: snapshotOrOptions } : snapshotOrOptions
    : {
      ...(typeof snapshotOrOptions === "string" ? { snapshotHash: snapshotOrOptions } : snapshotOrOptions),
      ...(input.snapshotHash === undefined ? {} : { snapshotHash: input.snapshotHash }),
    };
  const parsed = parseUnifiedDiff(diff, options);
  const maxBytes = targetBytes(options);
  const pieces = parsed.files.flatMap((file) => piecesForFile(parsed.snapshotHash, file, maxBytes));
  const shards: DiffShard[] = [];
  let current: Piece[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    shards.push(makeShard(parsed.snapshotHash, shards.length, maxBytes, current));
    current = [];
  };
  for (const piece of pieces) {
    // Unsupported records are deliberately isolated: a supported neighboring
    // file must not make an incomplete record look covered.
    if (!piece.supported || piece.byteLength > maxBytes) {
      flush();
      shards.push(makeShard(parsed.snapshotHash, shards.length, maxBytes, [piece]));
      continue;
    }
    const candidate = [...current, piece];
    const candidatePayload = payloadWithTerminalLine(candidate.map((entry) => entry.text));
    if (current.length > 0 && Buffer.byteLength(candidatePayload, "utf8") > maxBytes) {
      flush();
    }
    current.push(piece);
  }
  flush();
  return freezeArray(shards);
}

export const buildDiffShards = shardDiff;
export const createDiffShards = shardDiff;
export const shardUnifiedDiff = shardDiff;

/** Return all source line ownership records represented by a shard. */
export function shardRanges(shard: DiffShard): readonly DiffShardRange[] {
  return shard.ranges;
}
