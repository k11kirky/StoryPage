/**
 * Agents read designer- and user-authored text (manifests, Slack messages) and
 * write code that gets executed, so child processes get allowlisted
 * environments instead of the parent's. MCP servers receive their own
 * credentials explicitly in their configs.
 */
const BASE_KEYS = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI", "PNPM_HOME", "NODE_OPTIONS"];
/**
 * Claude Code settings an agent may inherit: credentials/provider selection
 * and config location. Other CLAUDE_* variables can carry a parent session's
 * state when the pipeline itself runs under Claude Code, so they are dropped.
 */
const CLAUDE_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];
/** Outbound network settings, for processes that call APIs. */
const NETWORK_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS"];

function pick(keep: (key: string) => boolean, source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    // Empty values (e.g. unset CI variables) are dropped rather than passed as "".
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "" && keep(entry[0])),
  );
}

/** For running the design system's own scripts: no credentials at all. */
export function verifyEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return pick((key) => BASE_KEYS.includes(key), source);
}

/** For the Claude Code process: the base set plus Anthropic/Claude configuration. */
export function agentEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return pick(
    (key) => BASE_KEYS.includes(key) || NETWORK_KEYS.includes(key) || CLAUDE_KEYS.includes(key) || key.startsWith("ANTHROPIC_"),
    source,
  );
}

/** Base environment plus the given variables, for an MCP server process. */
export function serverEnv(extra: Record<string, string | undefined>, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = pick((key) => BASE_KEYS.includes(key) || NETWORK_KEYS.includes(key), source);
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}
