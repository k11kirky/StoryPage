import path from "node:path";
import { serve } from "@hono/node-server";
import { configFromEnv, createContentfulClient, getLiveRelease, loadPage } from "@storypage/contentful";
import { FigmaClient } from "@storypage/figma";
import { createApp, type FigmaWebhookOptions, type PreviewOptions } from "./app.js";
import { ConsoleNotifier, SlackWebhookNotifier } from "./notify.js";
import { ReleaseService } from "./releases.js";
import { GitHubRepoStore } from "./repo.js";
import { GitHubActionsRunner } from "./runners/github.js";
import { LocalRunner, pipelineEnvFrom } from "./runners/local.js";
import type { Runner } from "./runners/types.js";

const env = process.env;
const required = (name: string) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const [owner, repoName] = required("GITHUB_REPOSITORY").split("/");
if (!owner || !repoName) throw new Error("GITHUB_REPOSITORY must look like owner/repo");
const baseBranch = env.GITHUB_BASE_BRANCH ?? "main";
const repo = new GitHubRepoStore({ token: required("GITHUB_TOKEN"), owner, repo: repoName, baseBranch });

/**
 * STORYPAGE_RUNNER=github (default): GitHub Actions runs the agents (open source, nothing to host).
 * STORYPAGE_RUNNER=local: this process runs them (hosted, or one self-hosted box).
 */
function createRunner(): Runner {
  if ((env.STORYPAGE_RUNNER ?? "github") === "github") return new GitHubActionsRunner(repo);
  const workDir = path.resolve(env.STORYPAGE_WORKDIR ?? ".storypage-worker");
  return new LocalRunner({
    workDir,
    repoUrl: `https://github.com/${owner}/${repoName}.git`,
    gitToken: env.GITHUB_TOKEN,
    baseBranch,
    repo,
    publicUrl: required("STORYPAGE_PUBLIC_URL"),
    // Claude's config (and the Figma MCP sign-in) persists next to the checkout.
    pipelineEnv: { CLAUDE_CONFIG_DIR: path.join(workDir, "claude"), ...pipelineEnvFrom(env) },
  });
}

function previewOptions(): PreviewOptions | undefined {
  const signingSecret = env.PREVIEW_SIGNING_SECRET;
  if (!signingSecret || !env.CONTENTFUL_MANAGEMENT_TOKEN) return undefined;
  const contentful = configFromEnv();
  const client = createContentfulClient(contentful);
  return {
    signingSecret,
    async loadPage(slug) {
      const release = await getLiveRelease(client, contentful.locale);
      return release ? loadPage(client, slug, release.registry, contentful.locale) : null;
    },
  };
}

function figmaOptions(): FigmaWebhookOptions | undefined {
  const token = env.FIGMA_WEBHOOK_TOKEN ?? env.FIGMA_API_KEY;
  if (!token || !env.FIGMA_WEBHOOK_PASSCODE) return undefined;
  return {
    client: new FigmaClient({ token, oauth: env.FIGMA_WEBHOOK_TOKEN_TYPE === "oauth" }),
    passcode: env.FIGMA_WEBHOOK_PASSCODE,
    fileKeys: (env.FIGMA_FILE_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean),
  };
}

const runner = createRunner();
const notifier = env.SLACK_NOTIFY_WEBHOOK_URL ? new SlackWebhookNotifier(env.SLACK_NOTIFY_WEBHOOK_URL) : new ConsoleNotifier();
const app = createApp({
  releases: new ReleaseService(repo, runner, notifier),
  runner,
  publishToken: required("GATEWAY_PUBLISH_TOKEN"),
  preview: previewOptions(),
  figma: figmaOptions(),
  githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
});

const port = Number(env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`StoryPage gateway listening on :${port} (runner: ${runner.kind})`);
