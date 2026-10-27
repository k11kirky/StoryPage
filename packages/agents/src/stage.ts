import { query, type McpServerConfig, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { agentEnv } from "./env.js";
import { CONTENTFUL, CONTENTFUL_ALL_TOOLS } from "./mcp.js";
import { createPolicy, type PolicyOptions } from "./policy.js";

/**
 * One step of the agentic pipeline: a Claude Agent SDK session with a fixed
 * set of MCP servers and tools, a permission policy instead of a human, a
 * budget, and (optionally) a structured result the next step can rely on.
 */
export interface StageOptions<Output extends z.ZodType = z.ZodType> {
  name: string;
  prompt: string;
  /** Stage-specific instructions. Appended to Claude Code's prompt for coding stages. */
  instructions: string;
  /** `coding`: Claude Code's system prompt + instructions. `custom`: instructions only (chat agents). */
  persona?: "coding" | "custom";
  cwd: string;
  mcpServers: Record<string, McpServerConfig>;
  /** Allowed tools: built-ins (`Read`, `Bash`, …) and MCP tools (`mcp__server__tool`). */
  tools: string[];
  writeRoots?: string[];
  commands?: RegExp[];
  checks?: PolicyOptions["checks"];
  /** Loads CLAUDE.md files from the repo (coding stages). */
  projectSettings?: boolean;
  output?: Output;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Continue an earlier session of this stage, e.g. to fix review findings. */
  resume?: string | undefined;
  log?: (line: string) => void;
}

export interface StageResult<Output> {
  sessionId: string | null;
  success: boolean;
  /** The agent's final message. */
  summary: string;
  /** The validated structured result, when `output` was given and the run succeeded. */
  output: Output | null;
  costUsd: number;
  turns: number;
  /** Connection status of each MCP server when the session started (`connected`, `needs-auth`, `failed`, …). */
  mcpStatus: Record<string, string>;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

function describe(message: SDKMessage): string[] {
  if (message.type !== "assistant") return [];
  const lines: string[] = [];
  for (const block of message.message.content) {
    if (block.type === "tool_use") {
      const input = block.input as Record<string, unknown>;
      const detail = input.file_path ?? input.command ?? input.nodeId ?? input.id ?? input.storyId ?? input.query ?? "";
      lines.push(`→ ${block.name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`.trim());
    } else if (block.type === "text" && block.text.trim()) {
      lines.push(block.text.trim().split("\n")[0]!);
    }
  }
  return lines;
}

/**
 * JSON Schema for a structured result. Claude Code validates `--json-schema`
 * as draft-07, so zod's default 2020-12 `$schema` declaration is dropped.
 */
export function outputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return rest;
}

/** Hides every tool a stage may not use, so the model never sees it. */
export function disallowedFor(servers: string[], allowed: string[]): string[] {
  const known = servers.includes(CONTENTFUL) ? CONTENTFUL_ALL_TOOLS : [];
  return known.filter((tool) => !allowed.includes(tool));
}

export async function runStage<Output extends z.ZodType>(options: StageOptions<Output>): Promise<StageResult<z.infer<Output>>> {
  const log = options.log ?? ((line: string) => console.log(`[${options.name}] ${line}`));
  const builtins = options.tools.filter((t) => !t.startsWith("mcp__"));
  const stream = query({
    prompt: options.prompt,
    options: {
      cwd: options.cwd,
      model: options.model ?? process.env.STORYPAGE_AGENT_MODEL ?? DEFAULT_MODEL,
      effort: options.effort ?? "high",
      systemPrompt:
        (options.persona ?? "coding") === "coding"
          ? { type: "preset", preset: "claude_code", append: options.instructions, snapshot: true }
          : { type: "custom", prompt: options.instructions, snapshot: true },
      settingSources: options.projectSettings ? ["project"] : [],
      tools: builtins,
      mcpServers: options.mcpServers,
      strictMcpConfig: true,
      disallowedTools: disallowedFor(Object.keys(options.mcpServers), options.tools),
      permissionMode: "default",
      canUseTool: createPolicy({
        repoRoot: options.cwd,
        tools: options.tools,
        ...(options.writeRoots ? { writeRoots: options.writeRoots } : {}),
        ...(options.commands ? { commands: options.commands } : {}),
        ...(options.checks ? { checks: options.checks } : {}),
      }),
      env: agentEnv(),
      maxTurns: options.maxTurns ?? 150,
      maxBudgetUsd: options.maxBudgetUsd ?? Number(process.env.STORYPAGE_AGENT_MAX_BUDGET_USD ?? 25),
      ...(options.output ? { outputFormat: { type: "json_schema", schema: outputSchema(options.output) } } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
    },
  });

  let sessionId: string | null = options.resume ?? null;
  const mcpStatus: Record<string, string> = {};
  for await (const message of stream) {
    if ("session_id" in message && typeof message.session_id === "string") sessionId = message.session_id;
    if (message.type === "system" && message.subtype === "init") {
      for (const server of message.mcp_servers) {
        mcpStatus[server.name] = server.status;
        if (server.status !== "connected") log(`MCP server "${server.name}" is ${server.status}; its tools are unavailable this run`);
      }
    }
    for (const line of describe(message)) log(line);
    if (message.type !== "result") continue;
    const success = message.subtype === "success" && !message.is_error;
    let output: z.infer<Output> | null = null;
    if (success && options.output) {
      const parsed = options.output.safeParse(message.structured_output);
      if (parsed.success) output = parsed.data;
      else log(`structured output did not match the schema: ${parsed.error.message}`);
    }
    return {
      sessionId,
      success: success && (!options.output || output !== null),
      summary: message.subtype === "success" ? message.result : `Stopped: ${message.subtype}`,
      output,
      costUsd: message.total_cost_usd,
      turns: message.num_turns,
      mcpStatus,
    };
  }
  return { sessionId, success: false, summary: "The agent ended without a result.", output: null, costUsd: 0, turns: 0, mcpStatus };
}
