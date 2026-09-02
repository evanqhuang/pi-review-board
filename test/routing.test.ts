import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_ROUTING_CONFIG, loadReviewConfig } from "../src/config.js";
import { analyzeDiff, classifyDiff, routeReview } from "../src/routing.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function patch(path: string, body: string, oldBody = "old"): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,1 @@",
    ...oldBody.split("\n").map((line) => `-${line}`),
    ...body.split("\n").map((line) => `+${line}`),
  ].join("\n");
}

function newFile(path: string, body: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1 @@",
    ...body.split("\n").map((line) => `+${line}`),
  ].join("\n");
}

describe("deterministic diff routing", () => {
  it("keeps the tiny boundary exact and promotes larger ordinary changes", () => {
    expect(classifyDiff(patch("src/a.ts", "new"))).toBe("tiny");
    expect(classifyDiff(patch("src/a.ts", "new\nsecond"))).toBe("tiny");
    const eleven = Array.from({ length: 11 }, (_, index) => `${index}`).join("\n");
    expect(classifyDiff(patch("src/a.ts", eleven))).toBe("small");
    const twoHunks = `${patch("src/a.ts", "new")}\n@@ -10,1 +10,1 @@\n-old\n+new`;
    expect(classifyDiff(twoHunks)).toBe("small");
    expect(classifyDiff({ diff: patch("src/a.ts", "new"), changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"] })).toBe("normal");
  });

  it("uses the small boundary of three files and 150 changed lines", () => {
    const files = ["a.ts", "b.ts", "c.ts"].map((name) => patch(`src/${name}`, "new")).join("\n");
    expect(classifyDiff(files)).toBe("small");
    const fourFiles = `${files}\n${patch("src/d.ts", "new")}`;
    expect(classifyDiff(fourFiles)).toBe("normal");
    const manyLines = Array.from({ length: 149 }, (_, index) => `${index}`).join("\n");
    expect(classifyDiff(patch("src/a.ts", manyLines))).toBe("small");
    expect(analyzeDiff(newFile("src/a.ts", Array.from({ length: 150 }, (_, index) => `${index}`).join("\n"))).changedContentLines).toBe(150);
  });

  it("promotes binary, rename, and copy changes as explicit risk", () => {
    const binary = "diff --git a/assets/logo.png b/assets/logo.png\nBinary files a/assets/logo.png and b/assets/logo.png differ";
    expect(classifyDiff(binary)).toBe("normal");
    expect(analyzeDiff(binary).risk).toBe(true);
    const rename = "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts";
    expect(classifyDiff(rename)).toBe("normal");
    expect(analyzeDiff(rename).risk).toBe(true);
    const copy = "diff --git a/src/old.ts b/src/new.ts\ncopy from src/old.ts\ncopy to src/new.ts";
    expect(classifyDiff(copy)).toBe("normal");
    expect(analyzeDiff(copy).risk).toBe(true);
    expect(analyzeDiff({ diff: "", changedPaths: ["../../auth.ts"] })).toMatchObject({ fileCount: 0, highRisk: false });
  });

  it("recognizes the conservative built-in high-risk path set", () => {
    for (const path of [
      "src/auth/login.ts",
      "src/security/check.ts",
      "src/secrets/credentials.ts",
      "db/migrations/001.sql",
      "package-lock.json",
      "pyproject.toml",
      "requirements-dev.txt",
      "Gemfile",
      "composer.json",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      "gradle.properties",
      "Pipfile",
      "Pipfile.lock",
      "mix.exs",
      "Cargo.toml",
      "go.mod",
      ".github/workflows/test.yml",
      "deploy/production.tf",
      "Dockerfile",
      ".env.production",
    ]) {
      const analysis = analyzeDiff(patch(path, "new"));
      expect(analysis.highRisk, path).toBe(true);
      expect(classifyDiff(patch(path, "new"))).toBe("normal");
    }
  });

  it("promotes route, schema, and OpenAPI filenames immediately", () => {
    for (const path of ["src/api.schema.ts", "src/user-route.ts", "src/openapi-client.ts"]) {
      const analysis = analyzeDiff(patch(path, "unrelated"));
      expect(analysis.publicContract, path).toBe(true);
      expect(analysis.contractRisk, path).toBe(false);
      expect(analysis.immediatePublicContractRisk, path).toBe(true);
      expect(classifyDiff(patch(path, "unrelated")), path).toBe("normal");
    }
  });

  it("uses a conservative public-contract threshold with immediate signals", () => {
    expect(analyzeDiff(patch("src/routes/users.ts", "new")).immediatePublicContractRisk).toBe(true);
    const fourContractLines = newFile("src/api.d.ts", "one\ntwo\nthree\nfour");
    expect(analyzeDiff(fourContractLines)).toMatchObject({ publicContract: true, contractRisk: false, risk: false });
    const fiveContractLines = newFile("src/api.d.ts", "one\ntwo\nthree\nfour\nfive");
    expect(analyzeDiff(fiveContractLines)).toMatchObject({ publicContract: true, contractRisk: true, risk: true });
    const twoContractFiles = [patch("src/a.d.ts", "new"), patch("src/b.d.ts", "new")].join("\n");
    expect(analyzeDiff(twoContractFiles)).toMatchObject({ publicContract: true, contractRisk: true, risk: true });
    const oneContractFileWithUnrelatedLines = [patch("src/a.d.ts", "new"), patch("src/ordinary.ts", "one\ntwo\nthree\nfour")].join("\n");
    expect(analyzeDiff(oneContractFileWithUnrelatedLines).contractRisk).toBe(false);
    expect(analyzeDiff(newFile("src/api.ts", "export function api() {}"))).toMatchObject({ publicContract: true, contractRisk: false, risk: false });
    expect(analyzeDiff(patch("src/api.ts", "export function api() {}\nline2\nline3\nline4\nline5"))).toMatchObject({ contractRisk: true, risk: true });
    expect(analyzeDiff(patch("src/api.ts", "route registration"))).toMatchObject({ immediatePublicContractRisk: true, risk: true });
    const packageExport = patch("package.json", '"exports": { ".": "./index.js" }');
    expect(analyzeDiff(packageExport)).toMatchObject({ immediatePublicContractRisk: true, risk: true });
  });

  it("loads additive root configuration and fails closed for malformed files", async () => {
    const cwd = await mkdtemp(join("/tmp", "pi-code-review-routing-"));
    tempDirectories.push(cwd);
    expect(loadReviewConfig(cwd)).toEqual(DEFAULT_REVIEW_ROUTING_CONFIG);

    await writeFile(join(cwd, ".pi-code-review.json"), JSON.stringify({
      highRiskPathGlobs: ["**/generated/**", "**/generated/**"],
      publicContractPathGlobs: ["**/events/**"],
      publicContractMarkers: ["PUBLIC_EVENT"],
    }));
    const config = loadReviewConfig(cwd);
    expect(config.highRiskPathGlobs.slice(-1)).toEqual(["**/generated/**"]);
    expect(config.highRiskPathGlobs.slice(0, DEFAULT_REVIEW_ROUTING_CONFIG.highRiskPathGlobs.length)).toEqual(DEFAULT_REVIEW_ROUTING_CONFIG.highRiskPathGlobs);
    expect(analyzeDiff(patch("src/auth/login.ts", "new"), config).highRisk).toBe(true);
    expect(analyzeDiff(patch("src/generated/file.ts", "new"), config).highRisk).toBe(true);
    expect(analyzeDiff(patch("src/events/file.ts", "new"), config).publicContract).toBe(true);
    expect(analyzeDiff(patch("src/api.ts", "PUBLIC_EVENT"), config).publicContractMarkers).toContain("PUBLIC_EVENT");

    await writeFile(join(cwd, ".pi-code-review.json"), "{ malformed");
    expect(() => loadReviewConfig(cwd)).toThrow("not valid JSON");
    await rm(join(cwd, ".pi-code-review.json"));
    await writeFile(join(cwd, ".pi-code-review.json"), "[]");
    expect(() => loadReviewConfig(cwd)).toThrow("root value must be a JSON object");
  });

  it("routes normal by diff size and always routes deep effort deeply", () => {
    const tiny = patch("src/a.ts", "new");
    expect(routeReview(tiny).route).toBe("tiny");
    expect(routeReview(tiny, "normal").route).toBe("tiny");
    expect(routeReview(tiny, "deep").route).toBe("deep");
    expect(routeReview({ diff: tiny, effort: "deep" }).plan.route).toBe("deep");
  });
});
