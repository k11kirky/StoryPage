import type { tool } from "@anthropic-ai/claude-agent-sdk";

/** The MCP tool result type, as the Agent SDK's `tool()` handlers return it. */
export type CallToolResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>;

export const text = (value: string | object): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export const failure = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

export const image = (png: Buffer, caption: string): CallToolResult => ({
  content: [
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    { type: "text", text: caption },
  ],
});

/** Runs a tool body, turning thrown errors into tool errors the agent can read. */
export async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}
