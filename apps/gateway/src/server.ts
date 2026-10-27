import { serve } from "@hono/node-server";
import { configFromEnv, createContentfulClient, getLiveRelease, loadPage } from "@storypage/contentful";
import { createApp, type PreviewOptions } from "./app.js";
import { GitHubRepoStore } from "./repo.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const [owner, repo] = required("GITHUB_REPOSITORY").split("/");
if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must look like owner/repo");

function previewOptions(): PreviewOptions | undefined {
  const signingSecret = process.env.PREVIEW_SIGNING_SECRET;
  if (!signingSecret || !process.env.CONTENTFUL_MANAGEMENT_TOKEN) return undefined;
  const contentful = configFromEnv();
  const client = createContentfulClient(contentful);
  return {
    signingSecret,
    async loadPage(slug) {
      const release = await getLiveRelease(client, contentful.locale);
      if (!release) return null;
      return loadPage(client, slug, release.registry, contentful.locale);
    },
  };
}

const app = createApp({
  repo: new GitHubRepoStore({
    token: required("GITHUB_TOKEN"),
    owner,
    repo,
    baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
  }),
  publishToken: required("GATEWAY_PUBLISH_TOKEN"),
  preview: previewOptions(),
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`StoryPage gateway listening on :${port}`);
