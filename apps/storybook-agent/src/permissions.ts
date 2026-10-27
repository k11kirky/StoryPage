import path from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { COMPONENTS_DIR } from "./paths.js";

/**
 * The agent runs unattended in CI, so every write and shell command goes
 * through this policy instead of a human prompt: edits only under the
 * components directory, and only the design system's own pnpm scripts.
 */
const ALLOWED_COMMANDS = [
  /^pnpm (--filter|-F) @storypage\/design-system (verify|typecheck|test|build-storybook)( [\w\-=./ ]*)?$/,
  /^pnpm (--filter|-F) @storypage\/design-system exec vitest run( [\w\-=./ ]*)?$/,
];

export function isAllowedWrite(repoRoot: string, filePath: string): boolean {
  const componentsRoot = path.resolve(repoRoot, COMPONENTS_DIR);
  const target = path.resolve(repoRoot, filePath);
  const relative = path.relative(componentsRoot, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isAllowedCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  // One command at a time: no chaining, redirection or substitution.
  if (/[;&|><`$]/.test(normalized)) return false;
  return ALLOWED_COMMANDS.some((pattern) => pattern.test(normalized));
}

export function createPermissionPolicy(repoRoot: string): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    const deny = (message: string): PermissionResult => ({ behavior: "deny", message });
    switch (toolName) {
      case "Read":
      case "Glob":
      case "Grep":
        return { behavior: "allow", updatedInput: input };
      case "Write":
      case "Edit":
      case "MultiEdit": {
        const filePath = String(input.file_path ?? "");
        return isAllowedWrite(repoRoot, filePath)
          ? { behavior: "allow", updatedInput: input }
          : deny(`Writes are limited to ${COMPONENTS_DIR}/. Generated files and manifests are read-only.`);
      }
      case "Bash": {
        const command = String(input.command ?? "");
        return isAllowedCommand(command)
          ? { behavior: "allow", updatedInput: input }
          : deny(
              "Only the design system's scripts may run, one at a time, e.g. `pnpm --filter @storypage/design-system verify`. Use Read/Glob/Grep to inspect files.",
            );
      }
      default:
        return deny(`${toolName} is not available in this pipeline.`);
    }
  };
}
