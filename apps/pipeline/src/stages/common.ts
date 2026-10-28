import path from "node:path";
import {
  FIGMA,
  figmaOptionsFromEnv,
  figmaServer,
  figmaTools,
  isInside,
  mcpTool,
  type FigmaMode,
  type McpServerConfig,
} from "@storypage/agents";
import { OUTPUT_DIR } from "../paths.js";

export const FIGMA_DOWNLOAD_DIR = `${OUTPUT_DIR}/figma`;

export interface FigmaAccess {
  mode: FigmaMode | null;
  servers: Record<string, McpServerConfig>;
  tools: string[];
  checks: Record<string, (input: Record<string, unknown>) => string | null>;
  /** How to use this server's tools, for the stage's instructions. */
  guide: string;
}

const GUIDES: Record<FigmaMode, string> = {
  official: `figma (Figma's MCP server): get_design_context with the component's Figma URL (or fileKey + nodeId)
  for layout, spacing, typography, variables and reference code; get_screenshot for a render of the
  node to compare against; get_variable_defs for the tokens it uses; get_metadata for the layer tree.`,
  url: `figma (Figma MCP server): get_design_context with the component's Figma URL (or nodeId) for layout,
  spacing, typography and reference code; get_screenshot for a render; get_variable_defs for tokens.`,
  framelink: `figma: get_figma_data with the fileKey and nodeId for exact layout, spacing, typography and fills
  of every variant; download_figma_images into ${FIGMA_DOWNLOAD_DIR}/ for reference renders you can Read.`,
};

const NO_FIGMA = `figma: not connected in this run. Work from the plan's Figma layout tree and preview image.`;

/** Figma MCP for a stage, in whichever mode is configured (official by default). */
export function figmaAccess(repoRoot: string, log: (line: string) => void): FigmaAccess {
  if (process.env.FIGMA_MCP === "off") {
    log("Figma MCP turned off (FIGMA_MCP=off); agents will use the manifest only.");
    return { mode: null, servers: {}, tools: [], checks: {}, guide: NO_FIGMA };
  }
  let options;
  try {
    options = figmaOptionsFromEnv();
    const server = figmaServer(options);
    const checks: FigmaAccess["checks"] =
      options.mode === "framelink"
        ? {
            [mcpTool(FIGMA, "download_figma_images")]: (input) =>
              isInside(repoRoot, FIGMA_DOWNLOAD_DIR, path.join(String(input.localPath ?? ""), "x"))
                ? null
                : `Save Figma images under ${FIGMA_DOWNLOAD_DIR}/ (relative to the repo root).`,
          }
        : {};
    return { mode: options.mode, servers: { [FIGMA]: server }, tools: figmaTools(options.mode), checks, guide: GUIDES[options.mode] };
  } catch (error) {
    log(`Figma MCP not configured (${error instanceof Error ? error.message : String(error)}); agents will use the manifest only.`);
    return { mode: null, servers: {}, tools: [], checks: {}, guide: NO_FIGMA };
  }
}

/** A line for reports when Figma wasn't usable in a stage. */
export function figmaProblem(mcpStatus: Record<string, string>, mode: FigmaMode | null): string | null {
  if (!mode) return "Figma MCP isn't configured, so agents worked from the manifest's layout and preview images only.";
  const status = mcpStatus[FIGMA];
  if (!status || status === "connected") return null;
  return mode === "official" && status === "needs-auth"
    ? "Figma's MCP server needs signing in again (`pnpm --filter @storypage/pipeline pipeline figma-connect` on the runner). Agents worked from the manifest only."
    : `Figma MCP was ${status}, so agents worked from the manifest only.`;
}
