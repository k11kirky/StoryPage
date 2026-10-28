import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { serverEnv } from "./env.js";

/**
 * MCP servers the pipeline's agents use. Servers run from this package's
 * pinned dependencies (no `npx` downloads at runtime), and each gets only the
 * credentials it needs.
 */

export const FIGMA = "figma";
export const CONTENTFUL = "contentful";
export const STORYBOOK = "storybook";
export const PIPELINE = "pipeline";

/** Claude Code's name for an MCP tool. */
export const mcpTool = (server: string, tool: string) => `mcp__${server}__${tool}`;

const require = createRequire(import.meta.url);

function binPath(pkg: string, bin: string): string {
  const manifestPath = require.resolve(`${pkg}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: string | Record<string, string> };
  const relative = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
  if (!relative) throw new Error(`${pkg} has no "${bin}" bin`);
  return path.join(path.dirname(manifestPath), relative);
}

// ---------------------------------------------------------------------------
// Figma
// ---------------------------------------------------------------------------

/**
 * - `official`: Figma's remote MCP server (default). OAuth only, and only for
 *   approved clients, which include Claude Code (what the Agent SDK runs). A
 *   person signs in once (`pipeline figma-connect`); the grant lives in
 *   CLAUDE_CONFIG_DIR and is reused by every run on that machine.
 * - `framelink`: the community server with a Figma personal access token, for
 *   ephemeral CI runners where no sign-in can persist.
 * - `url`: another HTTP server with Figma's tool surface, e.g. the Dev Mode
 *   server in the Figma desktop app (http://127.0.0.1:3845/mcp).
 */
export type FigmaMode = "official" | "framelink" | "url";

export const FIGMA_OFFICIAL_URL = "https://mcp.figma.com/mcp";

export interface FigmaMcpOptions {
  mode: FigmaMode;
  /** Personal access token, for `framelink`. */
  apiKey?: string | undefined;
  /** Server URL, for `url`. */
  url?: string | undefined;
  /** Bearer token for a `url` server that needs one. */
  token?: string | undefined;
}

export function figmaOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): FigmaMcpOptions {
  const explicit = env.FIGMA_MCP as FigmaMode | undefined;
  const mode: FigmaMode = explicit || (env.FIGMA_MCP_URL ? "url" : env.FIGMA_API_KEY ? "framelink" : "official");
  return { mode, apiKey: env.FIGMA_API_KEY || undefined, url: env.FIGMA_MCP_URL || undefined, token: env.FIGMA_MCP_TOKEN || undefined };
}

export function figmaServer(options: FigmaMcpOptions): McpServerConfig {
  switch (options.mode) {
    case "official":
      // No headers: Claude Code finds the stored OAuth grant by name + type + URL + headers.
      return { type: "http", url: FIGMA_OFFICIAL_URL, alwaysLoad: true };
    case "url":
      if (!options.url) throw new Error("FIGMA_MCP=url needs FIGMA_MCP_URL");
      return {
        type: "http",
        url: options.url,
        alwaysLoad: true,
        ...(options.token ? { headers: { Authorization: `Bearer ${options.token}` } } : {}),
      };
    case "framelink":
      if (!options.apiKey) throw new Error("FIGMA_MCP=framelink needs FIGMA_API_KEY");
      return {
        type: "stdio",
        command: process.execPath,
        args: [binPath("figma-developer-mcp", "figma-developer-mcp"), "--stdio"],
        alwaysLoad: true,
        env: serverEnv({ FIGMA_API_KEY: options.apiKey, FRAMELINK_TELEMETRY: "off", DO_NOT_TRACK: "1" }),
      };
  }
}

/**
 * Read-only design tools per server. Figma's servers also have tools that
 * write to the canvas or to Code Connect; agents don't get those.
 */
export function figmaTools(mode: FigmaMode): string[] {
  const names =
    mode === "framelink"
      ? ["get_figma_data", "download_figma_images"]
      : ["get_design_context", "get_metadata", "get_screenshot", "get_variable_defs"];
  return names.map((t) => mcpTool(FIGMA, t));
}

// ---------------------------------------------------------------------------
// Contentful
// ---------------------------------------------------------------------------

export interface ContentfulMcpOptions {
  managementToken: string;
  spaceId: string;
  /** The environment the agent works in (the server's default). */
  environment: string;
  /** Environments the server refuses to write to, e.g. the live alias and its target. */
  protectedEnvironments?: string[] | undefined;
  /** API host when not api.contentful.com (the server only speaks HTTPS). */
  host?: string | undefined;
}

/** Contentful's MCP server needs HTTPS, so it can't reach a plain-HTTP stand-in (see e2e/). */
export const contentfulMcpReachable = (config: { insecure?: boolean | undefined }) => !config.insecure;

export function contentfulServer(options: ContentfulMcpOptions): McpServerConfig {
  return {
    type: "stdio",
    command: process.execPath,
    args: [binPath("@contentful/mcp-server", "contentful-mcp-server")],
    env: serverEnv({
      CONTENTFUL_MANAGEMENT_ACCESS_TOKEN: options.managementToken,
      SPACE_ID: options.spaceId,
      ENVIRONMENT_ID: options.environment,
      ...(options.host ? { CONTENTFUL_HOST: options.host } : {}),
      MAX_BULK_SIZE: "10",
      NODE_ENV: "production",
      ...(options.protectedEnvironments?.length ? { PROTECTED_ENVIRONMENTS: options.protectedEnvironments.join(",") } : {}),
    }),
  };
}

/**
 * The Contentful server's tools take spaceId/environmentId as arguments, so
 * its default environment alone doesn't confine the agent. These policy
 * checks pin every Contentful call, reads included, to one space and environment.
 */
export function contentfulScope(spaceId: string, environment: string): Record<string, (input: Record<string, unknown>) => string | null> {
  const check = (input: Record<string, unknown>) =>
    input.spaceId !== undefined && input.spaceId !== spaceId
      ? `Use spaceId "${spaceId}".`
      : input.environmentId !== undefined && input.environmentId !== environment
        ? `This stage works only in environment "${environment}"; use environmentId "${environment}".`
        : null;
  return Object.fromEntries(CONTENTFUL_ALL_TOOLS.map((tool) => [tool, check]));
}

/** Reading content, assets and the model. */
export const CONTENTFUL_READ_TOOLS = [
  "get_initial_context",
  "list_content_types",
  "get_content_type",
  "search_entries",
  "get_entry",
  "resolve_entry_references",
  "list_assets",
  "get_asset",
  "list_locales",
].map((t) => mcpTool(CONTENTFUL, t));

/** Every tool the Contentful server registers (README of @contentful/mcp-server 1.24). */
export const CONTENTFUL_ALL_TOOLS = [
  "get_initial_context", "list_content_types", "get_content_type", "create_content_type", "update_content_type",
  "publish_content_type", "unpublish_content_type", "delete_content_type", "search_entries", "get_entry",
  "get_entry_snapshot", "create_entry", "update_entry", "publish_entry", "unpublish_entry", "delete_entry",
  "resolve_entry_references", "list_editor_interfaces", "get_editor_interface", "update_editor_interface",
  "upload_asset", "list_assets", "get_asset", "update_asset", "publish_asset", "unpublish_asset", "delete_asset",
  "list_spaces", "get_space", "list_environments", "create_environment", "delete_environment", "list_locales",
  "get_locale", "create_locale", "update_locale", "delete_locale", "list_tags", "create_tag", "list_orgs", "get_org",
  "list_releases", "get_release", "create_release", "update_release", "delete_release", "publish_release",
  "unpublish_release", "validate_release", "get_release_action", "list_release_actions", "schedule_publish_release",
  "schedule_unpublish_release", "cancel_scheduled_release", "list_scheduled_actions", "create_ai_action",
  "invoke_ai_action", "get_ai_action_invocation", "get_ai_action", "list_ai_actions", "update_ai_action",
  "publish_ai_action", "unpublish_ai_action", "delete_ai_action", "create_concept", "get_concept", "list_concepts",
  "update_concept", "delete_concept", "create_concept_scheme", "get_concept_scheme", "list_concept_schemes",
  "update_concept_scheme", "delete_concept_scheme", "space_to_space_migration_handler",
  "space_to_space_param_collection", "export_space", "import_space", "get_usages",
].map((t) => mcpTool(CONTENTFUL, t));

/**
 * Editing existing entries. No content-type, environment, delete or
 * unpublish tools: schema changes go through the pipeline's planner only.
 */
export const CONTENTFUL_ENTRY_EDIT_TOOLS = ["update_entry", "publish_entry"].map((t) => mcpTool(CONTENTFUL, t));

// ---------------------------------------------------------------------------
// Storybook
// ---------------------------------------------------------------------------

/** `storybook dev` (addon-mcp) or a hosted docs server, both over HTTP. */
export function storybookServer(url: string): McpServerConfig {
  return { type: "http", url, alwaysLoad: true };
}

/** Component documentation: available from `storybook dev` and from a static build's manifests. */
export const STORYBOOK_DOCS_TOOLS = ["docs-list", "docs-show", "docs-show-story"].map((t) => mcpTool(STORYBOOK, t));

/** Story-writing workflow tools, only on `storybook dev`. */
export const STORYBOOK_DEV_TOOLS = [
  ...STORYBOOK_DOCS_TOOLS,
  ...["get-storybook-story-instructions", "stories-find-by-component", "stories-changed", "stories-preview"].map((t) =>
    mcpTool(STORYBOOK, t),
  ),
];
