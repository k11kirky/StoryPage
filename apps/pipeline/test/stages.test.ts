import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { diffManifests, parseManifest, summarizeDiff, toRegistry, type DesignSystemManifest } from "@storypage/schema";
import type { StageOptions } from "@storypage/agents";

// Capture what each stage would run instead of starting real agent sessions.
const calls: StageOptions[] = [];
vi.mock("@storypage/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@storypage/agents")>();
  return {
    ...actual,
    runStage: vi.fn(async (options: StageOptions) => {
      calls.push(options);
      return { sessionId: "s1", success: true, summary: "ok", output: null, costUsd: 0, turns: 1, mcpStatus: { figma: "needs-auth" } };
    }),
  };
});

const { planTasks, releasePlan } = await import("../src/plan.js");
const { runBuildStage, fixPrompt } = await import("../src/stages/build.js");
const { runReviewStage } = await import("../src/stages/review.js");
const { runContentStage } = await import("../src/stages/content.js");

const seed = parseManifest(
  JSON.parse(readFileSync(new URL("../../../packages/design-system/manifests/1.0.0.json", import.meta.url), "utf8")),
);
const withFigma = (): DesignSystemManifest => ({ ...structuredClone(seed), source: { figmaFileKey: "AbCdEf1234567890", figmaFileName: "DS" } });
const storybook = { url: "http://localhost:6006", mcpUrl: "http://localhost:6006/mcp", stop: async () => {} };
const camera = {} as never;
const quiet = () => {};

function planFor(manifest: DesignSystemManifest) {
  const diff = diffManifests(null, manifest);
  return releasePlan(manifest, diff, planTasks(diff, manifest), summarizeDiff(diff), "packages/design-system/manifests");
}

beforeEach(() => {
  calls.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv("FIGMA_MCP", "");
  vi.stubEnv("FIGMA_API_KEY", "");
  vi.stubEnv("FIGMA_MCP_URL", "");
});

describe("release plan", () => {
  it("gives agents Figma node references only for real Figma files", () => {
    expect(planFor(seed).components[0]!.figma).toBeUndefined();
    const plan = planFor(withFigma());
    expect(plan.components.find((c) => c.name === "Hero")).toMatchObject({
      task: "create",
      figma: { fileKey: "AbCdEf1234567890", nodeId: "14:1", url: "https://www.figma.com/design/AbCdEf1234567890/?node-id=14-1" },
      contract: { placement: "section" },
    });
  });
});

describe("build stage", () => {
  it("uses Figma's official MCP server by default, and has no shell", async () => {
    const result = await runBuildStage({ repoRoot: "/repo", plan: planFor(withFigma()), storybook, camera, log: quiet });
    const options = calls[0]!;
    expect(Object.keys(options.mcpServers).sort()).toEqual(["figma", "pipeline", "storybook"]);
    expect(options.mcpServers.figma).toEqual({ type: "http", url: "https://mcp.figma.com/mcp", alwaysLoad: true });
    expect(options.mcpServers.storybook).toMatchObject({ type: "http", url: "http://localhost:6006/mcp" });
    expect(options.tools).toEqual(
      expect.arrayContaining([
        "Write",
        "mcp__pipeline__verify_design_system",
        "mcp__pipeline__screenshot_story",
        "mcp__storybook__get-storybook-story-instructions",
        "mcp__figma__get_design_context",
        "mcp__figma__get_screenshot",
      ]),
    );
    expect(options.tools).not.toContain("Bash");
    expect(options.writeRoots).toEqual(["packages/design-system/src/components"]);
    expect(options.instructions).toContain("get_design_context with the component's Figma URL");
    // The mocked session reported Figma as not signed in: the PR should say so.
    expect(result.figmaProblem).toMatch(/needs signing in again/);
  });

  it("can use Framelink with a personal access token, confining its downloads", async () => {
    vi.stubEnv("FIGMA_API_KEY", "figd_test");
    await runBuildStage({ repoRoot: "/repo", plan: planFor(withFigma()), storybook, camera, log: quiet });
    const options = calls[0]!;
    expect(options.mcpServers.figma).toMatchObject({ type: "stdio", env: { FIGMA_API_KEY: "figd_test", FRAMELINK_TELEMETRY: "off" } });
    expect(options.tools).toContain("mcp__figma__get_figma_data");
    expect(options.checks?.["mcp__figma__download_figma_images"]?.({ localPath: ".storypage/figma/1.0.0" })).toBeNull();
    expect(options.checks?.["mcp__figma__download_figma_images"]?.({ localPath: "packages/design-system" })).toMatch(/\.storypage\/figma/);
  });

  it("works from the manifest alone when Figma can't be configured", async () => {
    vi.stubEnv("FIGMA_MCP", "framelink");
    const result = await runBuildStage({ repoRoot: "/repo", plan: planFor(seed), storybook, camera, log: quiet });
    expect(Object.keys(calls[0]!.mcpServers).sort()).toEqual(["pipeline", "storybook"]);
    expect(result.figmaProblem).toMatch(/isn't configured/);
  });

  it("resumes its own session with review findings", async () => {
    const findings = [{ component: "Hero", severity: "blocking" as const, issue: "Padding is 48px, Figma has 96px" }];
    await runBuildStage({ repoRoot: "/repo", plan: planFor(seed), storybook, camera, resume: { sessionId: "abc", findings }, log: quiet });
    expect(calls[0]!.resume).toBe("abc");
    expect(calls[0]!.prompt).toBe(fixPrompt(findings));
  });
});

describe("review stage", () => {
  it("is read-only", async () => {
    await runReviewStage({ repoRoot: "/repo", plan: planFor(withFigma()), storybook, camera, round: 1, log: quiet });
    const options = calls[0]!;
    expect(options.tools.filter((t) => ["Write", "Edit", "Bash"].includes(t))).toEqual([]);
    expect(options.tools).toContain("mcp__pipeline__screenshot_story");
    expect(options.tools).not.toContain("mcp__pipeline__verify_design_system");
    expect(options.resume).toBeUndefined();
  });
});

describe("content stage", () => {
  it("works only in the release environment, with schema changes through the pipeline", async () => {
    await runContentStage({
      repoRoot: "/repo",
      config: { managementToken: "cfm", spaceId: "space1", environment: "master", locale: "en-US" },
      target: { environment: "ds-2-0-0", previousEnvironment: "ds-1-0-0", strategy: "alias" },
      registry: toRegistry(seed),
      promote: {},
      storybookDocsUrl: "http://127.0.0.1:9999/mcp",
      log: quiet,
    });
    const options = calls[0]!;
    expect(options.mcpServers.contentful).toMatchObject({
      env: { ENVIRONMENT_ID: "ds-2-0-0", PROTECTED_ENVIRONMENTS: "master,ds-1-0-0", CONTENTFUL_MANAGEMENT_ACCESS_TOKEN: "cfm" },
    });
    expect(options.tools).toEqual(expect.arrayContaining(["mcp__pipeline__promote_environment", "mcp__contentful__update_entry", "mcp__storybook__docs-show"]));
    expect(options.tools.filter((t) => /content_type|delete|environment$/.test(t) && t.startsWith("mcp__contentful"))).toEqual(
      ["mcp__contentful__list_content_types", "mcp__contentful__get_content_type"],
    );
    expect(options.tools.filter((t) => !t.startsWith("mcp__"))).toEqual([]);
    expect(options.checks?.["mcp__contentful__update_entry"]?.({ spaceId: "space1", environmentId: "master" })).toMatch(/ds-2-0-0/);
  });
});
