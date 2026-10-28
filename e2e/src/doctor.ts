/**
 * Checks a real StoryPage setup before a live run: every credential and
 * connection the gateway, the agents and the Slack bot use, with what to do
 * about each problem. Read-only: it never writes to Figma, GitHub,
 * Contentful or Slack. Reads the same environment variables as the services.
 *
 *   pnpm e2e:doctor                       # with the services' .env loaded
 *   node --env-file=.env …/doctor.ts
 */
import { spawnSync } from "node:child_process";
import { claudeExecutable } from "@storypage/agents";
import { configFromEnv, createContentfulClient, getLiveRelease } from "@storypage/contentful";
import { FigmaClient } from "@storypage/figma";

const env = process.env;
type Outcome = "ok" | "problem" | "skipped";
const results: { area: string; outcome: Outcome; message: string }[] = [];
const icon: Record<Outcome, string> = { ok: "✔", problem: "✘", skipped: "–" };

function report(area: string, outcome: Outcome, message: string) {
  results.push({ area, outcome, message });
  console.log(`${icon[outcome]} ${area}: ${message}`);
}

async function check(area: string, run: () => Promise<string | null>) {
  try {
    const message = await run();
    if (message !== null) report(area, "ok", message);
  } catch (error) {
    report(area, "problem", error instanceof Error ? error.message : String(error));
  }
}

async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

const missing = (area: string, names: string[], hint: string) => {
  const unset = names.filter((n) => !env[n]);
  if (unset.length === names.length) {
    report(area, "skipped", `${unset.join(", ")} not set (${hint})`);
    return true;
  }
  if (unset.length) {
    report(area, "problem", `${unset.join(", ")} not set`);
    return true;
  }
  return false;
};

const publicUrl = env.STORYPAGE_PUBLIC_URL?.replace(/\/$/, "");
const runner = env.STORYPAGE_RUNNER ?? "github";
console.log(`StoryPage doctor (runner: ${runner})\n`);

// --- Claude --------------------------------------------------------------
await check("Claude API", async () => {
  if (env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY) return "using a cloud provider's credentials (not checked here)";
  if (missing("Claude API", ["ANTHROPIC_API_KEY"], "needed by every agent stage and the Slack composer")) return null;
  const models = await json<{ data: { id: string }[] }>(`${env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/models?limit=100`, {
    headers: { "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
  });
  const model = env.STORYPAGE_AGENT_MODEL ?? "claude-opus-5-5";
  if (!models.data.some((m) => m.id === model)) throw new Error(`the key works, but ${model} isn't available to it; set STORYPAGE_AGENT_MODEL`);
  return `key works; ${model} available`;
});

// --- Figma (gateway: webhook + REST) --------------------------------------
const figmaToken = env.FIGMA_WEBHOOK_TOKEN ?? env.FIGMA_API_KEY;
const fileKeys = (env.FIGMA_FILE_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
const figmaHeaders: Record<string, string> = figmaToken ? (env.FIGMA_WEBHOOK_TOKEN_TYPE === "oauth" ? { authorization: `Bearer ${figmaToken}` } : { "x-figma-token": figmaToken }) : {};

await check("Figma API", async () => {
  if (!figmaToken) {
    report("Figma API", "skipped", "FIGMA_API_KEY / FIGMA_WEBHOOK_TOKEN not set (needed for releases from Figma's Publish library)");
    return null;
  }
  const me = await json<{ handle: string; email?: string }>("https://api.figma.com/v1/me", { headers: figmaHeaders });
  return `token belongs to ${me.handle}`;
});

for (const fileKey of figmaToken ? fileKeys : []) {
  await check(`Figma file ${fileKey}`, async () => {
    const file = await json<{ name: string; document: { sharedPluginData?: Record<string, Record<string, string>> } }>(
      `https://api.figma.com/v1/files/${fileKey}?depth=1&plugin_data=shared`,
      { headers: figmaHeaders },
    );
    const published = await json<{ meta: { components: unknown[] } }>(`https://api.figma.com/v1/files/${fileKey}/components`, { headers: figmaHeaders });
    if (!published.meta.components.length) throw new Error(`"${file.name}" has no published components yet: publish it as a library (Assets → Publish library)`);
    const client = new FigmaClient({ token: figmaToken!, oauth: env.FIGMA_WEBHOOK_TOKEN_TYPE === "oauth" });
    const variablesApi = (await client.getLocalVariables(fileKey)) !== null;
    const snapshot = file.document.sharedPluginData?.storypage?.["variables:count"];
    const variables = variablesApi
      ? "variables read through the Enterprise API"
      : snapshot
        ? "variables from the StoryPage plugin's saved snapshot"
        : null;
    if (!variables) throw new Error(`"${file.name}": no variables API on this plan and the StoryPage plugin hasn't saved variables yet. Open the plugin in the file once.`);
    return `"${file.name}": ${published.meta.components.length} published components; ${variables}`;
  });

  await check(`Figma webhook ${fileKey}`, async () => {
    if (!publicUrl) throw new Error("STORYPAGE_PUBLIC_URL not set, so the webhook endpoint is unknown");
    if (!env.FIGMA_WEBHOOK_PASSCODE) throw new Error("FIGMA_WEBHOOK_PASSCODE not set");
    const { webhooks } = await json<{ webhooks: { event_type: string; endpoint: string; status: string }[] }>(
      `https://api.figma.com/v2/webhooks?context=file&context_id=${fileKey}`,
      { headers: figmaHeaders },
    );
    const ours = webhooks.find((w) => w.event_type === "LIBRARY_PUBLISH" && w.endpoint === `${publicUrl}/webhooks/figma`);
    if (!ours) throw new Error("no LIBRARY_PUBLISH webhook to this gateway: run pnpm --filter @storypage/gateway figma:webhook");
    if (ours.status !== "ACTIVE") throw new Error(`the webhook is ${ours.status}; Figma pauses webhooks after repeated failed deliveries`);
    return "LIBRARY_PUBLISH webhook active";
  });
}
if (figmaToken && !fileKeys.length) report("Figma file", "problem", "FIGMA_FILE_KEYS not set: the gateway would build any file's publish");

// --- Figma MCP (agents) ---------------------------------------------------
await check("Figma MCP for agents", async () => {
  const mode = env.FIGMA_MCP || (env.FIGMA_MCP_URL ? "url" : env.FIGMA_API_KEY ? "framelink" : "official");
  if (mode === "off") return "off: agents work from the manifest only";
  if (mode === "framelink") return env.FIGMA_API_KEY ? "Framelink with FIGMA_API_KEY" : null;
  if (mode === "url") return env.FIGMA_MCP_URL ? `server at ${env.FIGMA_MCP_URL} (not checked)` : null;
  const result = spawnSync(claudeExecutable(), ["mcp", "get", "figma"], { encoding: "utf8", timeout: 60_000, env: { ...env } });
  const output = `${result.stdout}${result.stderr}`;
  const where = `${env.CLAUDE_CONFIG_DIR ?? "~/.claude"} (run this check on the machine that runs the agents)`;
  if (result.status !== 0) throw new Error(`Figma's MCP server isn't registered in ${where}: run pnpm --filter @storypage/pipeline pipeline figma-connect`);
  if (/needs auth|not authenticated|authentication required/i.test(output)) throw new Error(`Figma's MCP server needs signing in again in ${where}: run pnpm --filter @storypage/pipeline pipeline figma-connect`);
  if (/failed|error/i.test(output)) throw new Error(output.trim().split("\n").slice(-2).join(" "));
  return `official server signed in (${env.CLAUDE_CONFIG_DIR ?? "~/.claude"})`;
});

// --- GitHub ---------------------------------------------------------------
await check("GitHub", async () => {
  if (missing("GitHub", ["GITHUB_TOKEN", "GITHUB_REPOSITORY"], "needed by the gateway")) return null;
  const headers = { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "storypage-doctor" };
  const repo = await json<{ full_name: string; default_branch: string; permissions?: { push?: boolean } }>(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}`, { headers });
  if (repo.permissions && !repo.permissions.push) throw new Error(`the token can't push to ${repo.full_name}`);
  const base = env.GITHUB_BASE_BRANCH ?? "main";
  if (repo.default_branch !== base) throw new Error(`GITHUB_BASE_BRANCH is ${base} but the repository's default branch is ${repo.default_branch}`);
  if (runner === "github") {
    for (const workflow of ["design-system-build.yml", "design-system-release.yml"]) {
      const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/contents/.github/workflows/${workflow}`, { headers });
      if (response.status === 404) throw new Error(`.github/workflows/${workflow} isn't on ${repo.default_branch}`);
    }
  } else if (!env.GITHUB_WEBHOOK_SECRET) {
    throw new Error("GITHUB_WEBHOOK_SECRET not set: the hosted runner releases merged pull requests from GitHub's webhook");
  }
  return `${repo.full_name} (${repo.default_branch}), push access${runner === "github" ? ", workflows present" : ""}`;
});

// --- Contentful -------------------------------------------------------------
await check("Contentful", async () => {
  if (missing("Contentful", ["CONTENTFUL_MANAGEMENT_TOKEN", "CONTENTFUL_SPACE_ID"], "needed for releases, the Slack bot and previews")) return null;
  const config = configFromEnv();
  const client = createContentfulClient(config);
  const space = await client.space.get({ spaceId: config.spaceId });
  let target: string;
  try {
    const alias = await client.environmentAlias.get({ environmentAliasId: config.environment });
    target = alias.environment.sys.id;
  } catch {
    throw new Error(`"${config.environment}" isn't an environment alias in ${space.name}; the default alias strategy needs one (or use --strategy in-place)`);
  }
  const locales = await client.locale.getMany({ query: {} });
  if (!locales.items.some((l) => l.code === config.locale)) throw new Error(`locale ${config.locale} doesn't exist (CONTENTFUL_LOCALE)`);
  const live = await getLiveRelease(client, config.locale).catch(() => null);
  return `${space.name}: alias ${config.environment} → ${target}; ${live ? `design system ${live.version} live` : "no release synced yet"}`;
});

// --- Gateway --------------------------------------------------------------
await check("Gateway", async () => {
  if (!publicUrl) {
    report("Gateway", "skipped", "STORYPAGE_PUBLIC_URL not set");
    return null;
  }
  const health = await json<{ ok: boolean; runner: string }>(`${publicUrl}/health`);
  if (health.runner !== runner) throw new Error(`the gateway runs the ${health.runner} runner, but STORYPAGE_RUNNER here is ${runner}`);
  const unset = ["GATEWAY_PUBLISH_TOKEN", "PREVIEW_SIGNING_SECRET"].filter((n) => !env[n]);
  if (unset.length) throw new Error(`reachable, but ${unset.join(", ")} not set`);
  return `${publicUrl} is up (runner: ${health.runner})`;
});

// --- Slack ------------------------------------------------------------------
await check("Slack bot", async () => {
  if (missing("Slack bot", ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"], "needed by the Slack bot")) return null;
  const auth = await json<{ ok: boolean; error?: string; team?: string; user?: string }>("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  if (!auth.ok) throw new Error(`Slack rejected the bot token: ${auth.error}`);
  return `@${auth.user} in ${auth.team}${env.SLACK_APP_TOKEN ? " (Socket Mode)" : ""}`;
});
if (!env.SLACK_NOTIFY_WEBHOOK_URL) report("Slack notifications", "skipped", "SLACK_NOTIFY_WEBHOOK_URL not set: release updates go to the gateway's log");

const problems = results.filter((r) => r.outcome === "problem").length;
console.log(`\n${problems ? `${problems} problem(s) to fix before a live run.` : "Ready for a live run (see docs/testing.md)."}`);
process.exit(problems ? 1 : 0);
