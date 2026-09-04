import { DEFAULT_REVIEW_ROUTING_CONFIG, type ReviewConfig } from "./config.js";
import { DEFAULT_REVIEW_EFFORT, defaultReviewEffort, type ReviewEffort, type ReviewThinking } from "./effort.js";
import type { ReviewRole } from "./types.js";

export type ReviewRoute = "tiny" | "small" | "normal" | "deep";

export interface ReviewModelRoute {
  readonly model: string;
  readonly thinking: ReviewThinking;
}

export interface ReviewRoleConfig {
  readonly tools: readonly string[];
  /** Maximum turns granted to this role. */
  readonly maxTurns: number;
  /** Maximum context supplied to this role, in tokens. */
  readonly contextBudget: number;
  /** Maximum candidates accepted from this role. */
  readonly candidateCap: number;
  readonly modelRoute: ReviewModelRoute;
}

export interface ReviewPlan {
  readonly route: ReviewRoute;
  readonly effort: ReviewEffort;
  readonly roles: Readonly<Record<ReviewRole, ReviewRoleConfig>>;
  /** Primary invocations only; validation happens later for each candidate. */
  readonly activeRoles: readonly ReviewRole[];
}

export interface DiffAnalysis {
  readonly changedPaths: readonly string[];
  readonly fileCount: number;
  readonly hunkCount: number;
  readonly changedContentLines: number;
  readonly binary: boolean;
  readonly renamed: boolean;
  readonly copied: boolean;
  readonly highRiskPaths: readonly string[];
  readonly publicContractPaths: readonly string[];
  readonly publicContractMarkers: readonly string[];
  readonly highRisk: boolean;
  readonly publicContract: boolean;
  readonly immediatePublicContractRisk: boolean;
  readonly contractRisk: boolean;
  readonly risk: boolean;
  readonly riskReasons: readonly string[];
}

export interface DiffInput {
  readonly diff: string;
  readonly changedPaths?: readonly string[];
  readonly config?: ReviewConfig;
  readonly effort?: ReviewEffort;
}

export interface ReviewRouting {
  readonly effort: ReviewEffort;
  readonly route: ReviewRoute;
  readonly analysis: DiffAnalysis;
  readonly plan: ReviewPlan;
}

const LUNA_MODEL = "openai-codex/gpt-5.6-luna";
const SOL_MODEL = "openai-codex/gpt-5.6-sol";
const NO_REPOSITORY_TOOLS = Object.freeze([]);
const CONTEXT_TOOLS = Object.freeze(["read", "grep"]);

export const REVIEW_ROLES: readonly ReviewRole[] = Object.freeze([
  "summary",
  "guidance-a",
  "guidance-b",
  "diff-only-bug",
  "contextual-bug",
  "integration",
  "validator",
]);

const IMMEDIATE_MARKER_NAMES = new Set(["route", "router", "openapi", "swagger", "schema", "package-export-map"]);
const IMMEDIATE_FILENAME_MARKER = /(?:route|router|schema|openapi|swagger)/i;
const MANIFEST_NAMES = new Set(["package.json", "manifest.json"]);

function modelRoute(model: string, thinking: ReviewThinking): ReviewModelRoute {
  return Object.freeze({ model, thinking });
}

function roleConfig(
  tools: readonly string[],
  maxTurns: number,
  contextBudget: number,
  candidateCap: number,
  model: string,
  thinking: ReviewThinking,
): ReviewRoleConfig {
  return Object.freeze({
    tools,
    maxTurns,
    contextBudget,
    candidateCap,
    modelRoute: modelRoute(model, thinking),
  });
}

// Direct GPT-5.6 routes expose a 272k context window. These ceilings leave at
// least 32k tokens for reasoning/output while allowing every role—including
// validators carrying the full snapshot—to inspect realistic diffs. Turn and
// output limits remain the independent runaway guards.
const ROLE_PLANS: Readonly<Record<ReviewRole, ReviewRoleConfig>> = Object.freeze({
  summary: roleConfig(NO_REPOSITORY_TOOLS, 3, 200_000, 0, LUNA_MODEL, "medium"),
  "guidance-a": roleConfig(NO_REPOSITORY_TOOLS, 6, 220_000, 4, LUNA_MODEL, "medium"),
  "guidance-b": roleConfig(NO_REPOSITORY_TOOLS, 6, 220_000, 4, LUNA_MODEL, "medium"),
  "diff-only-bug": roleConfig(NO_REPOSITORY_TOOLS, 4, 220_000, 4, LUNA_MODEL, "high"),
  "contextual-bug": roleConfig(CONTEXT_TOOLS, 16, 240_000, 4, LUNA_MODEL, "high"),
  integration: roleConfig(CONTEXT_TOOLS, 16, 240_000, 4, LUNA_MODEL, "high"),
  validator: roleConfig(NO_REPOSITORY_TOOLS, 6, 220_000, 1, SOL_MODEL, "medium"),
});

const ROUTE_PLANS: Readonly<Record<ReviewRoute, Readonly<Record<ReviewRole, ReviewRoleConfig>>>> = Object.freeze({
  tiny: ROLE_PLANS,
  small: ROLE_PLANS,
  normal: ROLE_PLANS,
  deep: ROLE_PLANS,
});

export const REVIEW_ROLE_PLANS = ROUTE_PLANS;

const ACTIVE_ROLES: Readonly<Record<ReviewRoute, readonly ReviewRole[]>> = Object.freeze({
  tiny: Object.freeze(["diff-only-bug"] as ReviewRole[]),
  small: Object.freeze(["diff-only-bug", "guidance-a"] as ReviewRole[]),
  normal: Object.freeze(["guidance-a", "guidance-b", "diff-only-bug", "contextual-bug"] as ReviewRole[]),
  deep: Object.freeze(["guidance-a", "guidance-b", "diff-only-bug", "contextual-bug", "integration"] as ReviewRole[]),
});

export function getReviewPlan(route: ReviewRoute, effort?: ReviewEffort): ReviewPlan {
  const selectedEffort = route === "deep" ? "deep" : defaultReviewEffort(effort ?? DEFAULT_REVIEW_EFFORT);
  const selectedRoute = selectedEffort === "deep" ? "deep" : route;
  return Object.freeze({
    route: selectedRoute,
    effort: selectedEffort,
    roles: ROUTE_PLANS[selectedRoute],
    activeRoles: ACTIVE_ROLES[selectedRoute],
  });
}

export function getReviewRolePlan(route: ReviewRoute, role: ReviewRole): ReviewRoleConfig {
  return ROUTE_PLANS[route][role];
}

function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"abfnrtv])/g, (_match, escaped: string) => {
      const escapes: Record<string, string> = { "\\": "\\", '"': '"', a: "\u0007", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\u000b" };
      return escapes[escaped] ?? escaped;
    });
  }
  return trimmed;
}

/** Normalize a repository-relative path without ever accepting traversal. */
export function normalizeReviewPath(value: string): string {
  if (typeof value !== "string") throw new Error("Review path must be a string");
  const raw = value.trim().replaceAll("\\", "/");
  if (raw.length === 0 || raw.includes("\u0000") || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`Unsafe repository path: ${value}`);
  }
  const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) throw new Error(`Unsafe repository path: ${value}`);
  return parts.join("/");
}

function safePath(value: string): string | undefined {
  try {
    return normalizeReviewPath(value);
  } catch {
    return undefined;
  }
}

function stripDiffPrefix(value: string, prefix: "a" | "b"): string {
  const path = unquoteGitPath(value.split("\t", 1)[0] ?? "");
  return path === "/dev/null" ? path : path.startsWith(`${prefix}/`) ? path.slice(2) : path;
}

function diffPaths(diff: string): { paths: string[]; renamed: boolean; copied: boolean } {
  const paths = new Set<string>();
  let renamed = false;
  let copied = false;
  const add = (value: string, prefix?: "a" | "b"): void => {
    const path = safePath(prefix ? stripDiffPrefix(value, prefix) : unquoteGitPath(value));
    if (path && path !== "/dev/null") paths.add(path);
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("--- ")) add(line.slice(4), "a");
    else if (line.startsWith("+++ ")) add(line.slice(4), "b");
    else if (/^Binary files .* differ$/.test(line)) {
      const match = /^Binary files (.+) and (.+) differ$/.exec(line);
      if (match) {
        add(match[1]!, "a");
        add(match[2]!, "b");
      }
    } else if (line.startsWith("rename from ")) {
      renamed = true;
      add(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      renamed = true;
      add(line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) {
      copied = true;
      add(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      copied = true;
      add(line.slice("copy to ".length));
    } else if (line.startsWith("similarity index ")) {
      renamed = true;
    } else if (line.startsWith("diff --git ")) {
      // This is a fallback for binary diffs, which do not have ---/+++ lines.
      const header = line.slice("diff --git ".length);
      const separator = header.lastIndexOf(" b/");
      if (separator > 0) {
        add(header.slice(0, separator), "a");
        add(header.slice(separator + 1), "b");
      }
    }
  }
  return { paths: [...paths].sort(), renamed, copied };
}

function globRegExp(glob: string): RegExp {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += /[\\^$+.()|{}[\]]/.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${expression}$`, "i");
}

function matchesGlob(path: string, glob: string): boolean {
  return globRegExp(glob.trim().replaceAll("\\", "/")).test(path);
}

function pathsMatching(paths: readonly string[], globs: readonly string[]): string[] {
  const usableGlobs = globs.filter((glob) => glob.trim().length > 0);
  return paths.filter((path) => usableGlobs.some((glob) => matchesGlob(path, glob)));
}

function changedContent(diff: string): string[] {
  return diff.split(/\r?\n/).filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")));
}

function changedLinesByPath(diff: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  let currentPath: string | undefined;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("--- ")) {
      const path = safePath(stripDiffPrefix(line.slice(4), "a"));
      currentPath = path;
    } else if (line.startsWith("+++ ")) {
      const path = safePath(stripDiffPrefix(line.slice(4), "b"));
      if (path !== undefined) currentPath = path;
    } else if (currentPath !== undefined && ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))) {
      counts.set(currentPath, (counts.get(currentPath) ?? 0) + 1);
    }
  }
  return counts;
}

function markerMatches(lines: readonly string[], marker: string): boolean {
  const normalized = marker.trim().toLowerCase();
  return normalized.length > 0 && lines.some((line) => line.toLowerCase().includes(normalized));
}

function builtinMarkerMatches(lines: readonly string[], paths: readonly string[]): string[] {
  const result: string[] = [];
  const add = (name: string): void => {
    if (!result.includes(name)) result.push(name);
  };
  const text = lines.join("\n");
  const has = (pattern: RegExp): boolean => pattern.test(text);
  if (has(/\b(?:route|router|endpoint)\b/i)) add("route");
  if (has(/\b(?:rpc|remote procedure call)\b/i)) add("rpc");
  if (has(/\bgraphql\b/i)) add("graphql");
  if (has(/\bopenapi\b/i)) add("openapi");
  if (has(/\bswagger\b/i)) add("swagger");
  if (has(/\bschema\b/i)) add("schema");

  const manifests = paths.filter((path) => MANIFEST_NAMES.has(path.split("/").at(-1)?.toLowerCase() ?? ""));
  if (manifests.length > 0 && /["']exports["']\s*:/i.test(text)) add("package-export-map");
  if (manifests.length > 0 && /["']bin["']\s*:/i.test(text)) add("package-bin");
  if (manifests.length > 0 && /["']types?["']\s*:/i.test(text)) add("package-types");
  if (has(/^[+-]\s*export\b/m) || has(/\bexport\s+(?:async\s+)?(?:class|const|default|enum|function|interface|type|var)\b/i)) add("exported-declaration");
  if (has(/^[+-]\s*public\b/m)) add("public-declaration");
  if (has(/\b(?:register(?:Command|Tool|Route)?|defineCommand|defineTool)\s*\(/i)) add("cli-registration");
  return result;
}

export function analyzeDiff(source: string | DiffInput, config?: ReviewConfig): DiffAnalysis {
  const diff = typeof source === "string" ? source : source.diff;
  const changedPaths = typeof source === "string" ? [] : source.changedPaths ?? [];
  const selectedConfig = config ?? (typeof source === "string" ? undefined : source.config);
  const parsed = diffPaths(diff);
  const paths = new Set(parsed.paths);
  for (const path of changedPaths) {
    const normalized = safePath(path);
    if (normalized) paths.add(normalized);
  }
  const normalizedChangedPaths = [...paths].sort();
  const lines = changedContent(diff);
  const changedLinesForPath = changedLinesByPath(diff);
  const binary = /^(?:Binary files .* differ|GIT binary patch)$/m.test(diff);
  const renamed = parsed.renamed || /^(?:similarity index|rename from|rename to) /m.test(diff);
  const copied = parsed.copied || /^(?:copy from|copy to) /m.test(diff);
  const routingConfig = selectedConfig === undefined
    ? DEFAULT_REVIEW_ROUTING_CONFIG
    : {
        highRiskPathGlobs: [...new Set([...DEFAULT_REVIEW_ROUTING_CONFIG.highRiskPathGlobs, ...(selectedConfig.highRiskPathGlobs ?? [])])],
        publicContractPathGlobs: [...new Set([...DEFAULT_REVIEW_ROUTING_CONFIG.publicContractPathGlobs, ...(selectedConfig.publicContractPathGlobs ?? [])])],
        publicContractMarkers: [...new Set([...DEFAULT_REVIEW_ROUTING_CONFIG.publicContractMarkers, ...(selectedConfig.publicContractMarkers ?? [])])],
      };
  const highRiskPaths = pathsMatching(normalizedChangedPaths, routingConfig.highRiskPathGlobs);
  const publicContractPaths = pathsMatching(normalizedChangedPaths, routingConfig.publicContractPathGlobs);
  const builtinMarkers = builtinMarkerMatches(lines, normalizedChangedPaths);
  const customMarkers = routingConfig.publicContractMarkers.filter((marker) => markerMatches(lines, marker));
  const publicContractMarkers = [...new Set([...builtinMarkers, ...customMarkers])];
  const immediatePublicContractRisk = publicContractMarkers.some((marker) => IMMEDIATE_MARKER_NAMES.has(marker))
    || publicContractPaths.some((path) => /(?:^|\/)(?:route|routes|router|schema|schemas|openapi|swagger)(?:[./]|\/|$)/i.test(path))
    || normalizedChangedPaths.some((path) => IMMEDIATE_FILENAME_MARKER.test(path.split("/").at(-1) ?? ""))
    || (publicContractPaths.some((path) => MANIFEST_NAMES.has(path.split("/").at(-1)?.toLowerCase() ?? "")) && publicContractMarkers.includes("package-export-map"));
  const publicContract = publicContractPaths.length > 0 || publicContractMarkers.length > 0;
  const countedPublicContractLines = publicContractPaths.reduce((total, path) => total + (changedLinesForPath.get(path) ?? 0), 0);
  const changedPublicContractLines = publicContractPaths.length === 0 || changedLinesForPath.size === 0
    ? lines.length
    : countedPublicContractLines;
  const contractRisk = publicContract && (changedPublicContractLines >= 5 || publicContractPaths.length >= 2);
  const risk = highRiskPaths.length > 0 || immediatePublicContractRisk || contractRisk || binary || renamed || copied;
  const riskReasons = [
    ...(highRiskPaths.length > 0 ? ["high-risk path"] : []),
    ...(immediatePublicContractRisk ? ["immediate public-contract signal"] : []),
    ...(contractRisk && !immediatePublicContractRisk ? ["public-contract threshold"] : []),
    ...(binary ? ["binary change"] : []),
    ...(renamed ? ["rename"] : []),
    ...(copied ? ["copy"] : []),
  ];
  const hunkCount = diff.split(/\r?\n/).filter((line) => line.startsWith("@@")).length;
  const changedContentLines = binary ? 0 : lines.length;
  return {
    changedPaths: normalizedChangedPaths,
    fileCount: normalizedChangedPaths.length,
    hunkCount,
    changedContentLines,
    binary,
    renamed,
    copied,
    highRiskPaths,
    publicContractPaths,
    publicContractMarkers,
    highRisk: highRiskPaths.length > 0,
    publicContract,
    immediatePublicContractRisk,
    contractRisk,
    risk,
    riskReasons,
  };
}

function classifyAnalysis(analysis: DiffAnalysis): ReviewRoute {
  if (analysis.risk) return "normal";
  if (analysis.fileCount === 1 && analysis.hunkCount === 1 && analysis.changedContentLines <= 10 && !analysis.binary && !analysis.renamed && !analysis.copied) return "tiny";
  if (analysis.fileCount <= 3 && analysis.fileCount > 0 && analysis.changedContentLines <= 150 && !analysis.binary && !analysis.renamed && !analysis.copied) return "small";
  return "normal";
}

export function classifyDiff(source: string | DiffInput, config?: ReviewConfig): ReviewRoute {
  if (typeof source !== "string" && source.effort === "deep") return "deep";
  return classifyAnalysis(analyzeDiff(source, config));
}

export function selectReviewRoute(source: string | DiffInput, effort?: ReviewEffort, config?: ReviewConfig): ReviewRoute {
  const selectedEffort = defaultReviewEffort(effort ?? (typeof source === "object" ? source.effort : undefined));
  return selectedEffort === "deep" ? "deep" : classifyDiff(source, config);
}

export function routeReview(source: string | DiffInput, effort?: ReviewEffort, config?: ReviewConfig): ReviewRouting {
  const selectedEffort = defaultReviewEffort(effort ?? (typeof source === "object" ? source.effort : undefined));
  const analysis = analyzeDiff(source, config);
  const route = selectedEffort === "deep" ? "deep" : classifyAnalysis(analysis);
  return {
    effort: selectedEffort,
    route,
    analysis,
    plan: getReviewPlan(route, selectedEffort),
  };
}
