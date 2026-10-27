import path from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/**
 * Every agent runs unattended, so tool use is decided by a per-stage policy
 * rather than a person: an explicit tool allowlist, file writes confined to
 * given directories, an allowlist of shell commands, and per-tool input checks
 * (for example, where the Figma server may save images).
 */
export interface PolicyOptions {
  repoRoot: string;
  /** Tool names the stage may use: built-ins (`Read`, `Edit`, …) and `mcp__server__tool`. */
  tools: string[];
  /** Directories (relative to repoRoot) that Write/Edit may change. */
  writeRoots?: string[];
  /** Shell commands allowed for the Bash tool, matched against the whole command. */
  commands?: RegExp[];
  /** Extra checks per tool; return a reason to deny. */
  checks?: Record<string, (input: Record<string, unknown>) => string | null>;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function isInside(repoRoot: string, root: string, filePath: string): boolean {
  const base = path.resolve(repoRoot, root);
  const relative = path.relative(base, path.resolve(repoRoot, filePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isAllowedCommand(command: string, allowed: RegExp[]): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  // One command at a time: no chaining, redirection or substitution.
  if (/[;&|><`$\n]/.test(normalized)) return false;
  return allowed.some((pattern) => pattern.test(normalized));
}

export function createPolicy(options: PolicyOptions): CanUseTool {
  const allowed = new Set(options.tools);
  return async (toolName, input): Promise<PermissionResult> => {
    const deny = (message: string): PermissionResult => ({ behavior: "deny", message });
    const allow: PermissionResult = { behavior: "allow", updatedInput: input };
    if (!allowed.has(toolName)) return deny(`${toolName} is not available in this stage of the pipeline.`);

    if (WRITE_TOOLS.has(toolName)) {
      const filePath = String(input.file_path ?? input.notebook_path ?? "");
      const roots = options.writeRoots ?? [];
      if (!roots.some((root) => isInside(options.repoRoot, root, filePath))) {
        return deny(`Writes are limited to ${roots.join(", ") || "nothing"} in this stage.`);
      }
    }
    if (toolName === "Bash" && !isAllowedCommand(String(input.command ?? ""), options.commands ?? [])) {
      return deny("That command is not allowed here. Run one allowed command at a time; use Read/Glob/Grep to inspect files.");
    }
    const reason = options.checks?.[toolName]?.(input);
    if (reason) return deny(reason);
    return allow;
  };
}
