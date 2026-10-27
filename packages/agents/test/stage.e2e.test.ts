/**
 * Runs a real Claude Agent SDK session (the Claude Code binary) against a
 * local, scripted stand-in for the Messages API, to prove the wiring end to
 * end: in-process MCP tools are reachable, the policy denies what it should,
 * and the stage result comes back. No API key or network needed.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { designSystemTools, DESIGN_SYSTEM_TOOLS, PIPELINE, runStage } from "../src/index.js";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
interface ApiRequest {
  tools?: { name: string }[];
  messages: { role: string; content: string | { type: string; content?: unknown; is_error?: boolean }[] }[];
  stream?: boolean;
}

function sse(blocks: Block[], stopReason: string): string {
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

describe("runStage (real Agent SDK session, scripted model)", () => {
  let server: Server;
  const seen: ApiRequest[] = [];
  let repoRoot: string;
  // What the scripted "model" does, one step per main-loop request.
  const script: { blocks: Block[]; stop: string }[] = [];

  beforeAll(async () => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "storypage-e2e-"));
    writeFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "packages: []\n");
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        if (!req.url?.startsWith("/v1/messages")) {
          res.writeHead(404).end();
          return;
        }
        if (req.url.startsWith("/v1/messages/count_tokens")) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }));
          return;
        }
        const request = JSON.parse(body) as ApiRequest;
        const isMainLoop = request.tools?.some((t) => t.name === DESIGN_SYSTEM_TOOLS.plan);
        if (isMainLoop) seen.push(request);
        const step = isMainLoop ? (script.shift() ?? { blocks: [{ type: "text", text: "Done." }], stop: "end_turn" }) : { blocks: [{ type: "text", text: "ok" }] as Block[], stop: "end_turn" };
        if (request.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(step.blocks, step.stop));
        } else {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5-5", content: step.blocks, stop_reason: step.stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "storypage-claude-"));
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  });

  afterAll(() => {
    server?.close();
  });

  it("calls pipeline tools over in-process MCP, enforces the policy and returns structured output", async () => {
    script.push(
      // 1. Try to write outside the allowed directory: the policy must refuse.
      { blocks: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: path.join(repoRoot, "README.md"), content: "hijacked" } }], stop: "tool_use" },
      // 2. Read the release plan through the in-process MCP server.
      { blocks: [{ type: "tool_use", id: "toolu_2", name: DESIGN_SYSTEM_TOOLS.plan, input: {} }], stop: "tool_use" },
      // 3. Return the structured report, which ends the session.
      { blocks: [{ type: "tool_use", id: "toolu_3", name: "StructuredOutput", input: { built: ["Hero"] } }], stop: "tool_use" },
    );
    const result = await runStage({
      name: "e2e",
      cwd: repoRoot,
      instructions: "Test stage.",
      prompt: "Build the release.",
      mcpServers: { [PIPELINE]: designSystemTools({ repoRoot, plan: { version: "9.9.9", components: ["Hero"] } }) },
      tools: ["Read", "Write", DESIGN_SYSTEM_TOOLS.plan],
      writeRoots: ["packages/design-system/src/components"],
      output: z.object({ built: z.array(z.string()) }),
      model: "claude-opus-5-5",
      maxTurns: 10,
      log: () => {},
    });

    expect(result).toMatchObject({ success: true, output: { built: ["Hero"] } });
    // Each request's newest user turn carries the previous step's tool result.
    const results = seen.flatMap((r) => {
      const last = r.messages.findLast((m) => m.role === "user");
      return Array.isArray(last?.content) ? last.content.filter((b) => b.type === "tool_result") : [];
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ is_error: true });
    expect(JSON.stringify(results[0])).toContain("Writes are limited to packages/design-system/src/components");
    expect(JSON.stringify(results[1])).toContain("9.9.9");
    // The agent sees only what the stage gives it, not the host's session context.
    expect(JSON.stringify(seen[0]!.messages)).not.toContain("system-reminder");
  }, 120_000);
});
