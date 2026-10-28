import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalRunner, pipelineEnvFrom } from "../src/runners/local.js";
import { FakeRepo } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

/** A bare "GitHub" repo with main and a published design-system branch. */
function remote(): string {
  const root = mkdtempSync(path.join(tmpdir(), "storypage-runner-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  git(root, "init", "--bare", "-b", "main", bare);
  git(root, "init", "-b", "main", seed);
  mkdirSync(path.join(seed, "packages/design-system/manifests"), { recursive: true });
  writeFileSync(path.join(seed, ".gitignore"), "node_modules/\n.storypage/\nstorybook-static/\n");
  writeFileSync(path.join(seed, "packages/design-system/manifests/1.0.0.json"), "{}\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "origin", "main");
  git(seed, "checkout", "-b", "design-system/v1.1.0");
  writeFileSync(path.join(seed, "packages/design-system/manifests/1.1.0.json"), "{}\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "Publish design system 1.1.0 from Figma");
  git(seed, "push", "origin", "design-system/v1.1.0");
  return bare;
}

/** Stand-ins for `pnpm … pipeline build/release` that leave the same traces. */
const node = (code: string) => [process.execPath, "-e", code];
const commands = {
  install: null,
  build: (version: string) =>
    node(`
      const fs = require("fs");
      fs.mkdirSync("packages/design-system/src/components/Hero", { recursive: true });
      fs.writeFileSync("packages/design-system/src/components/Hero/Hero.tsx", "export const Hero = () => null;\\n");
      fs.mkdirSync(".storypage", { recursive: true });
      fs.writeFileSync(".storypage/release.json", JSON.stringify({ verified: true, tasks: ["create Hero"], version: "${version}" }));
      // Records whether the gateway's own secrets reached the pipeline.
      fs.writeFileSync(".storypage/pr-body.md", "## Design system ${version}\\ngithub token: " + (process.env.GITHUB_TOKEN ? "leaked" : "none") + "\\n");
    `),
  storybook: node(`
    const fs = require("fs");
    fs.mkdirSync("packages/design-system/storybook-static", { recursive: true });
    fs.writeFileSync("packages/design-system/storybook-static/index.html", "<title>" + process.env.STORYBOOK_PREVIEW_API_URL + "</title>");
  `),
  release: (storybookUrl: string) =>
    node(`require("fs").writeFileSync(".storypage-release.json", JSON.stringify({ storybookUrl: "${storybookUrl}", contentful: Boolean(process.env.CONTENTFUL_MANAGEMENT_TOKEN) }))`),
};

describe("LocalRunner (hosted)", () => {
  it("builds on the published branch, pushes the agents' work and opens the PR", async () => {
    const bare = remote();
    const repo = new FakeRepo();
    const workDir = mkdtempSync(path.join(tmpdir(), "storypage-work-"));
    const runner = new LocalRunner({
      workDir,
      repoUrl: bare,
      baseBranch: "main",
      repo,
      publicUrl: "https://storypage.example.com",
      pipelineEnv: pipelineEnvFrom({ PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_TOKEN: "must-not-leak", ANTHROPIC_API_KEY: "sk" }),
      commands,
      log: () => {},
    });

    const { statusUrl } = await runner.build({ version: "1.1.0", branch: "design-system/v1.1.0" });
    expect(statusUrl).toMatch(/^https:\/\/storypage\.example\.com\/jobs\/build-1\.1\.0-/);
    await runner.idle();

    const job = runner.jobs[0]!;
    expect(job).toMatchObject({ kind: "build", status: "succeeded", pullRequestUrl: "https://github.com/acme/site/pull/1" });
    expect(git(bare, "log", "-1", "--format=%s", "design-system/v1.1.0")).toBe("Build design system 1.1.0 in Storybook");
    expect(git(bare, "show", "design-system/v1.1.0:packages/design-system/src/components/Hero/Hero.tsx")).toContain("Hero");
    expect(repo.pullRequests).toEqual([{ branch: "design-system/v1.1.0", title: "Design system 1.1.0", body: "## Design system 1.1.0\ngithub token: none\n", draft: false }]);
  });

  it("releases from main: builds and serves Storybook, then runs the content stage", async () => {
    const bare = remote();
    const workDir = mkdtempSync(path.join(tmpdir(), "storypage-work-"));
    const runner = new LocalRunner({
      workDir,
      repoUrl: bare,
      baseBranch: "main",
      repo: new FakeRepo(),
      publicUrl: "https://storypage.example.com/",
      pipelineEnv: { PATH: process.env.PATH ?? "", CONTENTFUL_MANAGEMENT_TOKEN: "cfm" },
      commands,
      log: () => {},
    });
    await runner.release("1.1.0");
    await runner.idle();

    expect(runner.jobs[0]).toMatchObject({ kind: "release", status: "succeeded" });
    expect(readFileSync(path.join(runner.storybookDir, "index.html"), "utf8")).toBe("<title>https://storypage.example.com/</title>");
    expect(JSON.parse(readFileSync(path.join(workDir, "repo", ".storypage-release.json"), "utf8"))).toEqual({
      storybookUrl: "https://storypage.example.com/storybook/",
      contentful: true,
    });
  });

  it("gives pipeline commands only pipeline settings", () => {
    const env = pipelineEnvFrom({ PATH: "/bin", ANTHROPIC_API_KEY: "sk", FIGMA_MCP: "official", CONTENTFUL_SPACE_ID: "s", GITHUB_TOKEN: "ghs", GATEWAY_PUBLISH_TOKEN: "p", SLACK_NOTIFY_WEBHOOK_URL: "u" });
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "sk", FIGMA_MCP: "official", CONTENTFUL_SPACE_ID: "s" });
  });
});
