/**
 * The agent writes code that the verify step executes, and its input (the
 * manifest) is designer-authored text, so treat both as untrusted: child
 * processes get an allowlisted environment instead of the CI job's.
 */
const BASE_KEYS = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "CI", "PNPM_HOME", "NODE_OPTIONS"];

function pick(keys: (key: string) => boolean, source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined && keys(entry[0])),
  );
}

/** For running the design system's own scripts: no credentials at all. */
export function verifyEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return pick((key) => BASE_KEYS.includes(key), source);
}

/** For the Claude Code process: the base set plus Anthropic/Claude configuration. */
export function agentEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return pick(
    (key) => BASE_KEYS.includes(key) || key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_"),
    source,
  );
}
