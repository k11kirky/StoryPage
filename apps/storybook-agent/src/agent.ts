import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createPermissionPolicy } from "./permissions.js";
import { SYSTEM_APPEND } from "./prompt.js";

export interface AgentRunOptions {
  repoRoot: string;
  prompt: string;
  /** Continue an earlier session (used to feed verification failures back). */
  resume?: string | undefined;
  model?: string;
  maxBudgetUsd?: number;
  log?: (line: string) => void;
}

export interface AgentRunResult {
  sessionId: string | null;
  success: boolean;
  summary: string;
  costUsd: number;
  turns: number;
}

function describeToolUse(message: SDKMessage): string[] {
  if (message.type !== "assistant") return [];
  const lines: string[] = [];
  for (const block of message.message.content) {
    if (block.type === "tool_use") {
      const input = block.input as Record<string, unknown>;
      const detail = input.file_path ?? input.command ?? input.pattern ?? "";
      lines.push(`  → ${block.name} ${String(detail)}`);
    } else if (block.type === "text" && block.text.trim()) {
      lines.push(`  ${block.text.trim().split("\n")[0]}`);
    }
  }
  return lines;
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const stream = query({
    prompt: options.prompt,
    options: {
      cwd: options.repoRoot,
      model: options.model ?? process.env.STORYPAGE_AGENT_MODEL ?? "claude-opus-5-5",
      effort: "high",
      systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND, snapshot: true },
      // Loads the repo's CLAUDE.md files (including packages/design-system/CLAUDE.md).
      settingSources: ["project"],
      tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
      permissionMode: "default",
      canUseTool: createPermissionPolicy(options.repoRoot),
      maxTurns: 200,
      maxBudgetUsd: options.maxBudgetUsd ?? Number(process.env.STORYPAGE_AGENT_MAX_BUDGET_USD ?? 25),
      ...(options.resume ? { resume: options.resume } : {}),
    },
  });

  let sessionId: string | null = options.resume ?? null;
  for await (const message of stream) {
    if ("session_id" in message && typeof message.session_id === "string") sessionId = message.session_id;
    for (const line of describeToolUse(message)) log(line);
    if (message.type === "result") {
      const success = message.subtype === "success" && !message.is_error;
      return {
        sessionId,
        success,
        summary: message.subtype === "success" ? message.result : `Agent stopped: ${message.subtype}`,
        costUsd: message.total_cost_usd,
        turns: message.num_turns,
      };
    }
  }
  return { sessionId, success: false, summary: "Agent ended without a result.", costUsd: 0, turns: 0 };
}
