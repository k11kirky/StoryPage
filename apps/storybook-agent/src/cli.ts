/**
 * Builds a published design-system version into Storybook.
 *
 *   pnpm --filter @storypage/storybook-agent start --version 1.2.0
 *
 * 1. Diffs the new manifest against the version currently in the registry.
 * 2. Regenerates tokens + registry deterministically.
 * 3. Runs a Claude agent to create/update/remove components and stories.
 * 4. Verifies (typecheck, contract tests, Storybook build), feeding failures
 *    back to the same agent session until it passes or attempts run out.
 * 5. Writes `.storypage/release.json` and `.storypage/pr-body.md` for CI.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  checkVersionBump,
  diffManifests,
  parseManifest,
  summarizeDiff,
  type DesignSystemManifest,
  type Registry,
} from "@storypage/schema";
import { runAgent } from "./agent.js";
import { verifyEnv } from "./env.js";
import { DESIGN_SYSTEM_DIR, findRepoRoot, MANIFESTS_DIR, OUTPUT_DIR } from "./paths.js";
import { planTasks } from "./plan.js";
import { buildFixPrompt, buildPrompt } from "./prompt.js";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    "max-attempts": { type: "string", default: "3" },
    "skip-agent": { type: "boolean", default: false },
  },
});

const repoRoot = findRepoRoot();
const readJson = <T>(file: string): T => JSON.parse(readFileSync(path.join(repoRoot, file), "utf8")) as T;

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: verifyEnv(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function loadManifest(version: string): DesignSystemManifest {
  return parseManifest(readJson(`${MANIFESTS_DIR}/${version}.json`));
}

async function main() {
  if (!values.version) throw new Error("--version is required");
  const next = loadManifest(values.version);

  const registryPath = `${DESIGN_SYSTEM_DIR}/src/generated/registry.json`;
  const currentVersion = existsSync(path.join(repoRoot, registryPath))
    ? readJson<Registry>(registryPath).version
    : null;
  const previous =
    currentVersion && currentVersion !== next.version && existsSync(path.join(repoRoot, MANIFESTS_DIR, `${currentVersion}.json`))
      ? loadManifest(currentVersion)
      : null;

  const diff = diffManifests(previous, next);
  const versionProblem = checkVersionBump(diff);
  if (versionProblem) throw new Error(versionProblem);
  console.log(summarizeDiff(diff));

  const generated = run("pnpm", ["--filter", "@storypage/design-system", "generate", `manifests/${next.version}.json`]);
  if (!generated.ok) throw new Error(`Code generation failed:\n${generated.output}`);

  const tasks = planTasks(diff, next);
  const maxAttempts = Number(values["max-attempts"]);
  let agentSummary = "No component changes; tokens were regenerated deterministically.";
  let costUsd = 0;
  let verify = run("pnpm", ["--filter", "@storypage/design-system", "verify"]);
  let attempts = 0;

  if (tasks.length > 0 && !values["skip-agent"]) {
    console.log(`Running agent for ${tasks.length} task(s)…`);
    let result = await runAgent({ repoRoot, prompt: buildPrompt(next, diff, tasks) });
    attempts = 1;
    costUsd += result.costUsd;
    verify = run("pnpm", ["--filter", "@storypage/design-system", "verify"]);
    while (!verify.ok && attempts < maxAttempts && result.sessionId) {
      console.log(`Verification failed; asking the agent to fix it (attempt ${attempts + 1}/${maxAttempts})…`);
      result = await runAgent({ repoRoot, prompt: buildFixPrompt(verify.output), resume: result.sessionId });
      attempts += 1;
      costUsd += result.costUsd;
      verify = run("pnpm", ["--filter", "@storypage/design-system", "verify"]);
    }
    agentSummary = result.summary;
  }

  const changedFiles = run("git", ["status", "--porcelain"]).output.trim();
  const release = {
    version: next.version,
    previousVersion: diff.from,
    bump: diff.requiredBump,
    breaking: diff.breakingReasons,
    tasks: tasks.map((t) => (t.type === "remove" ? `remove ${t.name}` : `${t.type} ${t.component.name}`)),
    verified: verify.ok,
    attempts,
    costUsd: Number(costUsd.toFixed(2)),
  };

  const body = [
    `## Design system ${next.version}`,
    "",
    `Published from Figma file **${next.source.figmaFileName}** by ${next.publishedBy.name}.`,
    next.changelog ? `\n> ${next.changelog.split("\n").join("\n> ")}` : "",
    "",
    summarizeDiff(diff),
    "",
    "## Agent summary",
    "",
    agentSummary,
    "",
    "## Verification",
    "",
    verify.ok
      ? "✅ typecheck, contract tests and Storybook build pass."
      : `❌ Verification still failing after ${attempts} attempt(s). Do not merge until fixed:\n\n\`\`\`\n${verify.output.split("\n").slice(-60).join("\n")}\n\`\`\``,
    "",
    "## After merge",
    "",
    "The release workflow deploys Storybook, then syncs Contentful content types into a new",
    `environment \`ds-${next.version.replace(/\./g, "-")}\` and moves the \`master\` alias to it.`,
    "",
    `<details><summary>Changed files</summary>\n\n\`\`\`\n${changedFiles}\n\`\`\`\n</details>`,
    "",
    `_Agent attempts: ${attempts}, estimated cost: $${release.costUsd}_`,
  ].join("\n");

  mkdirSync(path.join(repoRoot, OUTPUT_DIR), { recursive: true });
  writeFileSync(path.join(repoRoot, OUTPUT_DIR, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  writeFileSync(path.join(repoRoot, OUTPUT_DIR, "pr-body.md"), `${body}\n`);
  console.log(JSON.stringify(release, null, 2));
  // A failing verification still produces a (draft) PR so a human can take over.
  if (!verify.ok) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
