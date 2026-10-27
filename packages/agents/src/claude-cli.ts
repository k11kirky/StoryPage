import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * The Claude Code binary the Agent SDK runs (shipped as a platform package of
 * @anthropic-ai/claude-agent-sdk). Used for one-time setup such as signing in
 * to Figma's MCP server; falls back to `claude` on PATH.
 */
export function claudeExecutable(): string {
  try {
    const require = createRequire(import.meta.url);
    const sdk = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const musl = process.platform === "linux" && !report?.header?.glibcVersionRuntime ? "-musl" : "";
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${musl}`;
    const binary = path.join(path.dirname(sdk.resolve(`${pkg}/package.json`)), process.platform === "win32" ? "claude.exe" : "claude");
    if (existsSync(binary)) return binary;
  } catch {
    // fall through
  }
  return "claude";
}
