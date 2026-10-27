import {
  DESIGN_SYSTEM_TOOLS,
  designSystemTools,
  PIPELINE,
  runStage,
  STORYBOOK,
  storybookServer,
  STORYBOOK_DOCS_TOOLS,
  mcpTool,
  type RunningStorybook,
  type StageResult,
  type StoryCamera,
} from "@storypage/agents";
import { z } from "zod";
import { DESIGN_SYSTEM_DIR } from "../paths.js";
import type { ReleasePlan } from "../plan.js";
import { figmaAccess, FIGMA_DOWNLOAD_DIR } from "./common.js";

export const ReviewFinding = z.object({
  component: z.string(),
  severity: z.enum(["blocking", "minor"]),
  issue: z.string(),
  evidence: z.string().optional().describe("Story id, viewport, Figma node or file:line"),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const ReviewReport = z.object({
  verdict: z.enum(["approve", "changes_requested"]),
  findings: z.array(ReviewFinding),
  summary: z.string(),
});
export type ReviewReport = z.infer<typeof ReviewReport>;

const INSTRUCTIONS = `
You are an independent design QA reviewer in an automated Figma → Storybook pipeline. Another agent built
React components from a Figma release; you did not write them. Decide whether each changed component
faithfully implements its Figma design and contract. You can read but not change code.

For each component in the release plan (pipeline.get_release_plan):
- Look at the design: figma get_figma_data for the node (when available) and its reference render
  (download_figma_images into ${FIGMA_DOWNLOAD_DIR}/, or the preview image in the plan). Read the images.
- Look at the implementation: storybook docs-show for its stories and props, screenshot_story at 1280
  and 375 wide, in light and dark mode, and the source under ${DESIGN_SYSTEM_DIR}/src/components.
- Check: props match the contract exactly (names, options, defaults); layout, spacing, typography, color
  and radius match Figma; styles use tokens rather than raw values; it is responsive and accessible
  (semantic elements, alt text, focus states, contrast).

Severity: "blocking" for anything a designer would reject or that breaks the contract, accessibility or
responsiveness; "minor" for polish. Don't nitpick what Figma leaves open. Approve when there are no
blocking findings.
`.trim();

export interface ReviewStageOptions {
  repoRoot: string;
  plan: ReleasePlan;
  storybook: RunningStorybook;
  camera: StoryCamera;
  round: number;
  log?: (line: string) => void;
}

export async function runReviewStage(options: ReviewStageOptions): Promise<StageResult<ReviewReport>> {
  const log = options.log ?? ((line: string) => console.log(`[review ${options.round}] ${line}`));
  const figma = figmaAccess(options.repoRoot, log);
  const changed = options.plan.components.filter((c) => c.task !== "remove").map((c) => c.name);
  return runStage({
    name: `review-${options.round}`,
    cwd: options.repoRoot,
    instructions: INSTRUCTIONS,
    prompt: `Review design-system ${options.plan.version}. Components to review: ${changed.join(", ") || "(none; check removals left nothing behind)"}.`,
    projectSettings: true,
    mcpServers: {
      [PIPELINE]: designSystemTools({ repoRoot: options.repoRoot, plan: options.plan, camera: options.camera }),
      [STORYBOOK]: storybookServer(options.storybook.mcpUrl),
      ...figma.servers,
    },
    tools: [
      "Read",
      "Glob",
      "Grep",
      DESIGN_SYSTEM_TOOLS.plan,
      DESIGN_SYSTEM_TOOLS.screenshot,
      ...STORYBOOK_DOCS_TOOLS,
      mcpTool(STORYBOOK, "stories-find-by-component"),
      ...figma.tools,
    ],
    checks: figma.checks,
    output: ReviewReport,
    effort: "high",
    maxTurns: 120,
    log,
  });
}
