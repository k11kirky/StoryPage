/**
 * Manual smoke test against the real design system: starts `storybook dev`,
 * lists its MCP tools, screenshots a story, then serves the docs MCP for a
 * static build.
 *
 *   pnpm --filter @storypage/design-system build-storybook
 *   npx serve packages/design-system/storybook-static -l 6199   (any static server)
 *   pnpm --filter @storypage/agents smoke:storybook http://127.0.0.1:6199 /tmp
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { StoryCamera } from "../src/screenshot.js";
import { serveStorybookDocs, startStorybookDev } from "../src/storybook.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const [staticUrl, outDir] = process.argv.slice(2);

async function rpc(url: string, method: string, params: unknown, session?: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? text;
  return { session: response.headers.get("mcp-session-id") ?? session, body: JSON.parse(data) };
}

async function listTools(url: string) {
  const init = await rpc(url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  const tools = await rpc(url, "tools/list", {}, init.session ?? undefined);
  return (tools.body.result.tools as { name: string }[]).map((t) => t.name);
}

const dev = await startStorybookDev(repoRoot, 6107);
try {
  console.log("dev mcp tools:", (await listTools(dev.mcpUrl)).join(", "));
  const camera = new StoryCamera(dev.url);
  const png = await camera.capture("marketing-hero--left", { width: 1280 });
  writeFileSync(path.join(outDir!, "hero.png"), png);
  console.log("screenshot bytes:", png.length);
  await camera.close();
} finally {
  await dev.stop();
}

const docs = await serveStorybookDocs(staticUrl!);
try {
  console.log("docs mcp tools:", (await listTools(docs.url)).join(", "));
  const init = await rpc(docs.url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  const shown = await rpc(docs.url, "tools/call", { name: "docs-show", arguments: { id: "content-featurecard" } }, init.session ?? undefined);
  console.log(String(shown.body.result.content[0].text).slice(0, 300));
} finally {
  await docs.close();
}
