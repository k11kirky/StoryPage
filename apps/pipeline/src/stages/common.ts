import path from "node:path";
import {
  FIGMA,
  figmaOptionsFromEnv,
  figmaServer,
  FIGMA_TOOLS,
  isInside,
  type McpServerConfig,
} from "@storypage/agents";
import { OUTPUT_DIR } from "../paths.js";

export const FIGMA_DOWNLOAD_DIR = `${OUTPUT_DIR}/figma`;

export interface FigmaAccess {
  servers: Record<string, McpServerConfig>;
  tools: string[];
  checks: Record<string, (input: Record<string, unknown>) => string | null>;
  available: boolean;
}

/**
 * Figma MCP for a stage, when credentials are configured. Image downloads are
 * confined to .storypage/figma so the server can't write into the repo.
 */
export function figmaAccess(repoRoot: string, log: (line: string) => void): FigmaAccess {
  const options = figmaOptionsFromEnv();
  if (!options.apiKey && !options.url) {
    log("No FIGMA_API_KEY or FIGMA_MCP_URL: agents will work from the manifest's layout and preview images only.");
    return { servers: {}, tools: [], checks: {}, available: false };
  }
  return {
    servers: { [FIGMA]: figmaServer(options) },
    tools: FIGMA_TOOLS,
    checks: {
      [FIGMA_TOOLS[1]!]: (input) =>
        isInside(repoRoot, FIGMA_DOWNLOAD_DIR, path.join(String(input.localPath ?? ""), "x"))
          ? null
          : `Save Figma images under ${FIGMA_DOWNLOAD_DIR}/ (relative to the repo root).`,
    },
    available: true,
  };
}
