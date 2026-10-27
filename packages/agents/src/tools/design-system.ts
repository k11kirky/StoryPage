import { spawnSync } from "node:child_process";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { verifyEnv } from "../env.js";
import { mcpTool, PIPELINE } from "../mcp.js";
import type { StoryCamera } from "../screenshot.js";
import { failure, guarded, image, text } from "./result.js";

export interface VerifyResult {
  passed: boolean;
  steps: { step: string; passed: boolean; output: string }[];
}

const STEPS = {
  typecheck: ["--filter", "@storypage/design-system", "typecheck"],
  test: ["--filter", "@storypage/design-system", "test"],
  build: ["--filter", "@storypage/design-system", "build-storybook", "--quiet"],
} as const;
export type VerifyStep = keyof typeof STEPS;

/** Typecheck, contract tests, Storybook build. Runs agent-written code, so no credentials. */
export function verifyDesignSystem(repoRoot: string, steps: VerifyStep[] = ["typecheck", "test", "build"]): VerifyResult {
  const result: VerifyResult = { passed: true, steps: [] };
  for (const step of steps) {
    const run = spawnSync("pnpm", [...STEPS[step]], { cwd: repoRoot, env: verifyEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const passed = run.status === 0;
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").slice(passed ? -5 : -120).join("\n");
    result.steps.push({ step, passed, output });
    if (!passed) {
      result.passed = false;
      break; // later steps would fail for the same reason
    }
  }
  return result;
}

export interface DesignSystemToolsOptions {
  repoRoot: string;
  /** The release plan given to the agent, re-readable as a tool. */
  plan: unknown;
  camera?: StoryCamera | undefined;
}

export const DESIGN_SYSTEM_TOOLS = {
  plan: mcpTool(PIPELINE, "get_release_plan"),
  verify: mcpTool(PIPELINE, "verify_design_system"),
  screenshot: mcpTool(PIPELINE, "screenshot_story"),
};

/** Pipeline tools for the build and review stages. */
export function designSystemTools(options: DesignSystemToolsOptions) {
  return createSdkMcpServer({
    name: PIPELINE,
    version: "1.0.0",
    tools: [
      tool(
        "get_release_plan",
        "The design-system release being built: version, diff, and per-component tasks with their contracts and Figma node references.",
        {},
        async () => text(options.plan as object),
        { alwaysLoad: true },
      ),
      tool(
        "verify_design_system",
        "Run the design system's checks: typecheck, contract tests (every registry component exported, storied and rendering for each enum option) and a Storybook build. Returns each step's result and the failing output.",
        { steps: z.array(z.enum(["typecheck", "test", "build"])).optional().describe("Defaults to all three, in order") },
        async ({ steps }) => guarded(async () => text(verifyDesignSystem(options.repoRoot, steps))),
        { alwaysLoad: true },
      ),
      tool(
        "screenshot_story",
        "Render a Storybook story (from the running dev server) to an image, to compare with the Figma design. Story ids look like 'marketing-hero--left'.",
        {
          storyId: z.string(),
          width: z.number().int().min(320).max(1920).optional().describe("Viewport width; default 1280. Use 375 to check mobile."),
          colorMode: z.enum(["light", "dark"]).optional(),
        },
        async ({ storyId, width, colorMode }) =>
          guarded(async () => {
            if (!options.camera) return failure("Screenshots are not available in this run.");
            const png = await options.camera.capture(storyId, {
              ...(width ? { width } : {}),
              ...(colorMode ? { colorMode } : {}),
            });
            return image(png, `${storyId} at ${width ?? 1280}px${colorMode ? `, ${colorMode} mode` : ""}`);
          }),
        { alwaysLoad: true },
      ),
    ],
  });
}
