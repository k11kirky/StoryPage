import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { createStorybookMcpHandler } from "@storybook/mcp";
import { verifyEnv } from "./env.js";

export interface RunningStorybook {
  url: string;
  /** addon-mcp endpoint: docs plus story-writing tools. */
  mcpUrl: string;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts `storybook dev` for the design system. It hot-reloads the agent's
 * edits and serves Storybook's MCP endpoint at /mcp. It compiles code the
 * agent wrote, so it runs without credentials.
 */
export async function startStorybookDev(repoRoot: string, port = 6006, timeoutMs = 180_000): Promise<RunningStorybook> {
  const child: ChildProcess = spawn(
    "pnpm",
    ["--filter", "@storypage/design-system", "exec", "storybook", "dev", "-p", String(port), "--ci", "--no-open", "--quiet"],
    { cwd: repoRoot, env: verifyEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let output = "";
  child.stdout?.on("data", (d: Buffer) => (output = (output + d.toString()).slice(-4000)));
  child.stderr?.on("data", (d: Buffer) => (output = (output + d.toString()).slice(-4000)));

  const url = `http://localhost:${port}`;
  const stop = async () => {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM"); // the whole process group: pnpm, storybook, vite
      } catch {
        child.kill("SIGTERM");
      }
    }
  };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`storybook dev exited (${child.exitCode}):\n${output}`);
    try {
      const response = await fetch(`${url}/index.json`);
      if (response.ok) return { url, mcpUrl: `${url}/mcp`, stop };
    } catch {
      // not listening yet
    }
    await sleep(1000);
  }
  await stop();
  throw new Error(`storybook dev did not start within ${timeoutMs / 1000}s:\n${output}`);
}

export interface DocsServer {
  url: string;
  close(): Promise<void>;
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method ?? "GET",
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
}

async function send(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) Readable.fromWeb(response.body as never).pipe(res);
  else res.end();
}

/**
 * Serves Storybook's documentation MCP (docs-list / docs-show / docs-show-story)
 * on 127.0.0.1 for a *deployed* static Storybook, reading the component
 * manifests it publishes. For agents that run away from a dev server: the
 * content stage and the Slack bot.
 */
export async function serveStorybookDocs(storybookUrl: string): Promise<DocsServer> {
  const base = `${storybookUrl.replace(/\/$/, "")}/`;
  const handler = await createStorybookMcpHandler({
    manifestProvider: async (_request, manifestPath) => {
      const response = await fetch(new URL(manifestPath.replace(/^\.\//, ""), base));
      if (!response.ok) throw new Error(`Could not load ${manifestPath} from ${base} (${response.status})`);
      return response.text();
    },
  });
  const server: Server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
    toRequest(req, origin)
      .then((request) => (new URL(request.url).pathname === "/mcp" ? handler(request) : new Response("Not found", { status: 404 })))
      .then((response) => send(res, response))
      .catch((error: unknown) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
