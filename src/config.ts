import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REVIEW_CONFIG_FILENAME = ".pi-code-review.json";

/** Repository-local additions to the built-in routing signals. */
export interface ReviewConfig {
  readonly highRiskPathGlobs?: readonly string[];
  readonly publicContractPathGlobs?: readonly string[];
  readonly publicContractMarkers?: readonly string[];
}

/** The loader always returns a complete, immutable configuration. */
export interface LoadedReviewConfig {
  readonly highRiskPathGlobs: readonly string[];
  readonly publicContractPathGlobs: readonly string[];
  readonly publicContractMarkers: readonly string[];
}

const BUILTIN_HIGH_RISK_PATH_GLOBS = Object.freeze([
  "**/auth",
  "**/auth/**",
  "**/*auth*",
  "**/security",
  "**/security/**",
  "**/*security*",
  "**/credential*",
  "**/*credential*",
  "**/secret",
  "**/secret/**",
  "**/secrets/**",
  "**/secret*",
  "**/*secret*",
  "**/token*",
  "**/*token*",
  "**/session*",
  "**/*session*",
  "**/payment*",
  "**/*payment*",
  "**/migration",
  "**/migration/**",
  "**/migrations",
  "**/migrations/**",
  "**/sql/**",
  "**/*.sql",
  "**/schema",
  "**/schema/**",
  "**/schemas",
  "**/schemas/**",
  "**/package.json",
  "**/manifest.json",
  "**/pyproject.toml",
  "**/requirements*.txt",
  "**/Gemfile",
  "**/composer.json",
  "**/pom.xml",
  "**/build.gradle",
  "**/build.gradle.kts",
  "**/settings.gradle",
  "**/settings.gradle.kts",
  "**/gradle.properties",
  "**/Pipfile",
  "**/Pipfile.lock",
  "**/mix.exs",
  "**/Cargo.toml",
  "**/go.mod",
  "**/manifest.yaml",
  "**/manifest.yml",
  "**/*manifest.*",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/go.sum",
  "**/poetry.lock",
  "**/uv.lock",
  "**/composer.lock",
  "**/Gemfile.lock",
  "**/mix.lock",
  "**/.github/workflows/**",
  "**/.gitlab-ci.yml",
  "**/.circleci/**",
  "**/ci/**",
  "**/workflows/**",
  "**/deploy/**",
  "**/deployment/**",
  "**/infra/**",
  "**/infrastructure/**",
  "**/terraform/**",
  "**/*.tf",
  "**/*.tfvars",
  "**/k8s/**",
  "**/kubernetes/**",
  "**/docker/**",
  "**/docker-compose*.yml",
  "**/docker-compose*.yaml",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "Dockerfile",
  "Dockerfile.*",
  "**/.env",
  "**/.env.*",
  "**/*.env",
  "**/env/**",
  "**/config/**",
  "**/Jenkinsfile",
  "**/azure-pipelines.yml",
] as const);

const BUILTIN_PUBLIC_CONTRACT_PATH_GLOBS = Object.freeze([
  "**/route",
  "**/route/**",
  "**/route*",
  "**/routes",
  "**/routes/**",
  "**/router*",
  "**/*route.*",
  "**/rpc",
  "**/rpc/**",
  "**/*rpc.*",
  "**/graphql",
  "**/graphql/**",
  "**/graphql*",
  "**/*.graphql",
  "**/*.gql",
  "**/openapi",
  "**/openapi/**",
  "**/*openapi*",
  "**/swagger",
  "**/swagger/**",
  "**/*swagger*",
  "**/schema",
  "**/schema/**",
  "**/schema*",
  "**/schemas",
  "**/schemas/**",
  "**/*.schema.*",
  "**/*.d.ts",
  "**/types",
  "**/types/**",
  "**/type",
  "**/type/**",
  "**/cli",
  "**/cli/**",
  "**/commands",
  "**/commands/**",
  "**/tools",
  "**/tools/**",
  "**/package.json",
  "**/manifest.json",
] as const);

const BUILTIN_PUBLIC_CONTRACT_MARKERS = Object.freeze([
  "route",
  "router",
  "rpc",
  "graphql",
  "openapi",
  "swagger",
  "schema",
  "package-export-map",
  "package-bin",
  "package-types",
  "exported-declaration",
  "public-declaration",
  "cli-registration",
] as const);

/** Built-in signals are first; repository additions follow in file order. */
export const DEFAULT_REVIEW_ROUTING_CONFIG: LoadedReviewConfig = Object.freeze({
  highRiskPathGlobs: BUILTIN_HIGH_RISK_PATH_GLOBS,
  publicContractPathGlobs: BUILTIN_PUBLIC_CONTRACT_PATH_GLOBS,
  publicContractMarkers: BUILTIN_PUBLIC_CONTRACT_MARKERS,
});

const CONFIG_KEYS = new Set<keyof ReviewConfig>([
  "highRiskPathGlobs",
  "publicContractPathGlobs",
  "publicContractMarkers",
]);

function configError(cwd: string, message: string, cause?: unknown): Error {
  const error = new Error(`Invalid ${REVIEW_CONFIG_FILENAME} at ${join(resolve(cwd), REVIEW_CONFIG_FILENAME)}: ${message}`);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function stringList(value: unknown, field: keyof ReviewConfig, cwd: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw configError(cwd, `${field} must be an array of non-empty strings`);
  }
  return Object.freeze([...new Set(value.map((item) => item.trim()))]);
}

function additive(builtIns: readonly string[], additions: readonly string[] | undefined): readonly string[] {
  return Object.freeze([...new Set([...builtIns, ...(additions ?? [])])]);
}

function completeConfig(value: ReviewConfig): LoadedReviewConfig {
  return Object.freeze({
    highRiskPathGlobs: additive(DEFAULT_REVIEW_ROUTING_CONFIG.highRiskPathGlobs, value.highRiskPathGlobs),
    publicContractPathGlobs: additive(DEFAULT_REVIEW_ROUTING_CONFIG.publicContractPathGlobs, value.publicContractPathGlobs),
    publicContractMarkers: additive(DEFAULT_REVIEW_ROUTING_CONFIG.publicContractMarkers, value.publicContractMarkers),
  });
}

/** Validate an already parsed configuration without consulting the filesystem. */
export function parseReviewConfig(value: unknown, cwd = "."): LoadedReviewConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(cwd, "the root value must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key as keyof ReviewConfig)) throw configError(cwd, `unknown property ${JSON.stringify(key)}`);
  }

  const additions: ReviewConfig = {};
  if (raw.highRiskPathGlobs !== undefined) {
    Object.assign(additions, { highRiskPathGlobs: stringList(raw.highRiskPathGlobs, "highRiskPathGlobs", cwd) });
  }
  if (raw.publicContractPathGlobs !== undefined) {
    Object.assign(additions, { publicContractPathGlobs: stringList(raw.publicContractPathGlobs, "publicContractPathGlobs", cwd) });
  }
  if (raw.publicContractMarkers !== undefined) {
    Object.assign(additions, { publicContractMarkers: stringList(raw.publicContractMarkers, "publicContractMarkers", cwd) });
  }
  return completeConfig(additions);
}

/**
 * Load only the repository root configuration. A missing file is the
 * successful built-in default; malformed or otherwise unreadable files throw
 * so a review cannot silently run with an unsafe configuration.
 */
export function loadReviewConfig(cwd: string): LoadedReviewConfig {
  const path = join(resolve(cwd), REVIEW_CONFIG_FILENAME);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return DEFAULT_REVIEW_ROUTING_CONFIG;
    throw configError(cwd, "the file could not be read", error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw configError(cwd, "the file is not valid JSON", error);
  }
  return parseReviewConfig(parsed, cwd);
}
