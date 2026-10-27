import type { DesignSystemManifest, ManifestDiff } from "@storypage/schema";
import { summarizeDiff } from "@storypage/schema";
import { COMPONENTS_DIR, DESIGN_SYSTEM_DIR, MANIFESTS_DIR } from "./paths.js";
import type { Task } from "./plan.js";

export const SYSTEM_APPEND = `
You are the design-system engineer in an automated Figma → Storybook → Contentful pipeline.
A designer has published a new design-system version from Figma. Your job is to make the
React components and Storybook stories in ${DESIGN_SYSTEM_DIR} match it exactly.

Rules:
- Read ${DESIGN_SYSTEM_DIR}/CLAUDE.md first and follow it. Look at the existing components as
  examples of the expected style before writing new ones.
- Only write inside ${COMPONENTS_DIR}/. Tokens, the registry and manifests are generated for
  you and are read-only.
- Implement exactly the props in the contract: same names, kinds, options and defaults.
- Prefer small, readable components over clever abstractions. No new dependencies.
- When finished, run \`pnpm --filter @storypage/design-system verify\` and fix every failure.
- Finish with a short summary for the human reviewer: what you built or changed per component,
  any judgment calls you made where the Figma spec was ambiguous, and anything you could not do.
`.trim();

function describeTask(task: Task, manifest: DesignSystemManifest): string {
  if (task.type === "remove") {
    return `### Remove ${task.name}\nDelete ${COMPONENTS_DIR}/${task.name}/ and its entries in ${COMPONENTS_DIR}/index.ts.`;
  }
  const { component } = task;
  const preview = component.preview ? `${MANIFESTS_DIR}/${component.preview}` : null;
  const header =
    task.type === "create"
      ? `### Create ${component.name}`
      : `### Update ${component.name}${task.previousName !== component.name ? ` (renamed from ${task.previousName}: move the directory, rename exports)` : ""}\nChanges: ${task.changes.join("; ")}`;
  const spec = {
    name: component.name,
    category: component.category,
    description: component.description,
    placement: component.placement,
    props: component.props,
    figmaLayout: component.layout,
  };
  return [
    header,
    preview ? `Figma preview image: ${preview} (read it to check visual fidelity)` : "No preview image was exported.",
    "Specification (from the Figma manifest):",
    "```json",
    JSON.stringify(spec, null, 2),
    "```",
    `Text styles available: ${manifest.textStyles.map((s) => s.name).join(", ")}`,
  ].join("\n");
}

export function buildPrompt(manifest: DesignSystemManifest, diff: ManifestDiff, tasks: Task[]): string {
  return [
    `Design system "${manifest.name}" was published from Figma as version ${manifest.version} by ${manifest.publishedBy.name}.`,
    manifest.changelog ? `Designer's changelog: ${manifest.changelog}` : "",
    "",
    "## Release diff",
    summarizeDiff(diff),
    "",
    `Tokens and ${DESIGN_SYSTEM_DIR}/src/generated/registry.json have already been regenerated for ${manifest.version}.`,
    "",
    "## Tasks",
    ...tasks.map((t) => describeTask(t, manifest)),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function buildFixPrompt(verifyOutput: string): string {
  const tail = verifyOutput.split("\n").slice(-120).join("\n");
  return [
    "`pnpm --filter @storypage/design-system verify` failed after your changes. Output (last lines):",
    "```",
    tail,
    "```",
    "Fix the cause (do not weaken or skip tests), re-run verify, then summarize what you changed.",
  ].join("\n");
}
