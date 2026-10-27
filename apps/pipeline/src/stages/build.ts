import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  DESIGN_SYSTEM_TOOLS,
  designSystemTools,
  PIPELINE,
  runStage,
  STORYBOOK,
  storybookServer,
  STORYBOOK_DEV_TOOLS,
  type RunningStorybook,
  type StageResult,
  type StoryCamera,
} from "@storypage/agents";
import { z } from "zod";
import { COMPONENTS_DIR, DESIGN_SYSTEM_DIR } from "../paths.js";
import type { ReleasePlan } from "../plan.js";
import { figmaAccess, FIGMA_DOWNLOAD_DIR } from "./common.js";
import type { ReviewFinding } from "./review.js";

export const BuildReport = z.object({
  components: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["created", "updated", "removed", "unchanged", "blocked"]),
      notes: z.string().describe("What was built or changed, for the PR reviewer"),
    }),
  ),
  judgmentCalls: z.array(z.string()).describe("Places where the Figma design was ambiguous and you chose an interpretation"),
  unresolved: z.array(z.string()).describe("Anything you could not finish, and why"),
  verified: z.boolean().describe("Whether verify_design_system passed on your final code"),
});
export type BuildReport = z.infer<typeof BuildReport>;

const INSTRUCTIONS = `
You are the design-system engineer in an automated Figma → Storybook → Contentful pipeline. A designer
published a new design-system version from Figma; make the React components and Storybook stories in
${DESIGN_SYSTEM_DIR} match it exactly.

Your tools:
- pipeline: get_release_plan (the work, contracts and Figma node ids), verify_design_system,
  screenshot_story (render a story from the live dev server).
- storybook (the running Storybook's MCP): get-storybook-story-instructions before writing stories;
  docs-list / docs-show to study existing components and follow their patterns; stories-find-by-component
  to get story ids for screenshots.
- figma (when available): get_figma_data with the fileKey and nodeId from the plan for exact layout,
  spacing, typography and fills of every variant; download_figma_images into ${FIGMA_DOWNLOAD_DIR}/
  to get reference renders you can Read and compare against.
- Read/Glob/Grep anywhere; Write/Edit only inside ${COMPONENTS_DIR}/. Tokens, the registry and manifests
  are generated and read-only. There is no shell; checks run through verify_design_system.

How to work:
1. Read ${DESIGN_SYSTEM_DIR}/CLAUDE.md and look at an existing component before writing a new one.
2. Implement exactly the props in each contract: names, kinds, options and defaults.
3. Compare your result with Figma: screenshot the story (desktop 1280 and mobile 375, light and dark)
   and check it against the Figma render. Fix visible differences in layout, spacing, type and color.
4. Run verify_design_system and fix every failure. Don't weaken or skip tests.
5. Report per component in the structured output. Be specific about judgment calls.
`.trim();

export interface BuildStageOptions {
  repoRoot: string;
  plan: ReleasePlan;
  storybook: RunningStorybook;
  camera: StoryCamera;
  /** Continue the earlier build session with review findings. */
  resume?: { sessionId: string; findings: ReviewFinding[] } | undefined;
  log?: (line: string) => void;
}

export function buildPrompt(plan: ReleasePlan): string {
  const work = plan.components.map((c) => `- ${c.task} ${c.name}${c.changes?.length ? `: ${c.changes.join("; ")}` : ""}`).join("\n");
  return [
    `Build design system "${plan.designSystem}" ${plan.version} (from ${plan.previousVersion ?? "nothing"}), published by ${plan.publishedBy}.`,
    plan.changelog ? `Designer's changelog: ${plan.changelog}` : "",
    "",
    plan.diff,
    "",
    "Work to do:",
    work,
    "",
    "Call get_release_plan for the full contracts, Figma references and preview images. Tokens and the registry are already regenerated for this version.",
  ].join("\n");
}

export function fixPrompt(findings: ReviewFinding[]): string {
  return [
    "An independent reviewer compared your components with Figma and requested changes:",
    ...findings.map((f) => `- [${f.severity}] ${f.component}: ${f.issue}${f.evidence ? ` (${f.evidence})` : ""}`),
    "",
    "Fix the blocking findings (and minor ones where it's quick), run verify_design_system, and report again.",
  ].join("\n");
}

export async function runBuildStage(options: BuildStageOptions): Promise<StageResult<BuildReport>> {
  const log = options.log ?? ((line: string) => console.log(`[build] ${line}`));
  const figma = figmaAccess(options.repoRoot, log);
  mkdirSync(path.join(options.repoRoot, FIGMA_DOWNLOAD_DIR), { recursive: true });
  return runStage({
    name: "build",
    cwd: options.repoRoot,
    instructions: INSTRUCTIONS,
    prompt: options.resume ? fixPrompt(options.resume.findings) : buildPrompt(options.plan),
    resume: options.resume?.sessionId,
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
      "Write",
      "Edit",
      ...Object.values(DESIGN_SYSTEM_TOOLS),
      ...STORYBOOK_DEV_TOOLS,
      ...figma.tools,
    ],
    writeRoots: [COMPONENTS_DIR],
    checks: figma.checks,
    output: BuildReport,
    effort: "high",
    maxTurns: 250,
    log,
  });
}
