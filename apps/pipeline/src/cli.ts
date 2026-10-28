/**
 * The agentic design-system pipeline. Each command chains deterministic steps
 * with Claude Agent SDK stages that work through the Figma, Storybook and
 * Contentful MCP servers.
 *
 *   pnpm --filter @storypage/pipeline pipeline build --version 1.2.0
 *     codegen → build agent → independent review agent (→ fixes) → verify → PR body
 *
 *   pnpm --filter @storypage/pipeline pipeline release --storybook-url https://…
 *     clone Contentful environment → content agent (schema + content migration)
 *     → validated promotion of the alias
 *
 *   pnpm --filter @storypage/pipeline pipeline figma-connect [--no-browser]
 *     one-time sign-in to Figma's official MCP server on the machine that runs the agents
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import semver from "semver";
import {
  claudeExecutable,
  FIGMA,
  FIGMA_OFFICIAL_URL,
  serveStorybookDocs,
  startStorybookDev,
  StoryCamera,
  verifyDesignSystem,
  verifyEnv,
  type DocsServer,
} from "@storypage/agents";
import { configFromEnv, prepareEnvironment, syncDesignSystem, type Strategy } from "@storypage/contentful";
import {
  checkVersionBump,
  diffManifests,
  parseManifest,
  summarizeDiff,
  type DesignSystemManifest,
  type Registry,
} from "@storypage/schema";
import { DESIGN_SYSTEM_DIR, findRepoRoot, MANIFESTS_DIR, OUTPUT_DIR } from "./paths.js";
import { planTasks, releasePlan } from "./plan.js";
import { buildBody, contentBody, type StageCost } from "./report.js";
import { runBuildStage, type BuildReport } from "./stages/build.js";
import { runContentStage } from "./stages/content.js";
import { runReviewStage, type ReviewReport } from "./stages/review.js";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    version: { type: "string" },
    "max-review-rounds": { type: "string", default: "2" },
    "skip-agents": { type: "boolean", default: false },
    "storybook-url": { type: "string" },
    strategy: { type: "string", default: "alias" },
    "keep-environments": { type: "string" },
    "no-browser": { type: "boolean", default: false },
  },
});

const repoRoot = findRepoRoot();
const readJson = <T>(file: string): T => JSON.parse(readFileSync(path.join(repoRoot, file), "utf8")) as T;
const loadManifest = (version: string): DesignSystemManifest => parseManifest(readJson(`${MANIFESTS_DIR}/${version}.json`));
const registryPath = `${DESIGN_SYSTEM_DIR}/src/generated/registry.json`;

function writeOutput(name: string, content: string) {
  mkdirSync(path.join(repoRoot, OUTPUT_DIR), { recursive: true });
  writeFileSync(path.join(repoRoot, OUTPUT_DIR, name), content);
}

/** The highest published manifest version below `version`, if any. */
function previousVersion(version: string): string | null {
  const versions = readdirSync(path.join(repoRoot, MANIFESTS_DIR))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((v) => semver.valid(v) && semver.lt(v, version))
    .sort(semver.rcompare);
  return versions[0] ?? null;
}

async function build() {
  if (!values.version) throw new Error("--version is required");
  const next = loadManifest(values.version);
  const currentVersion = existsSync(path.join(repoRoot, registryPath)) ? readJson<Registry>(registryPath).version : null;
  const previous =
    currentVersion && currentVersion !== next.version && existsSync(path.join(repoRoot, MANIFESTS_DIR, `${currentVersion}.json`))
      ? loadManifest(currentVersion)
      : null;
  const diff = diffManifests(previous, next);
  const versionProblem = checkVersionBump(diff);
  if (versionProblem) throw new Error(versionProblem);
  const diffSummary = summarizeDiff(diff);
  console.log(diffSummary);

  // Step 1 (deterministic): tokens and registry are generated, never written by an agent.
  const generated = spawnSync("pnpm", ["--filter", "@storypage/design-system", "generate", `manifests/${next.version}.json`], {
    cwd: repoRoot,
    env: verifyEnv(),
    encoding: "utf8",
  });
  if (generated.status !== 0) throw new Error(`Code generation failed:\n${generated.stdout}${generated.stderr}`);

  const tasks = planTasks(diff, next);
  const plan = releasePlan(next, diff, tasks, diffSummary, MANIFESTS_DIR);
  writeOutput("release-plan.json", `${JSON.stringify(plan, null, 2)}\n`);

  const costs: StageCost[] = [];
  let figmaNote: string | null = null;
  let buildReport: BuildReport | null = null;
  let buildSummary = "No component changes; tokens were regenerated deterministically.";
  const reviews: ReviewReport[] = [];

  if (tasks.length && !values["skip-agents"]) {
    const storybook = await startStorybookDev(repoRoot, Number(process.env.STORYBOOK_PORT ?? 6006));
    const camera = new StoryCamera(storybook.url);
    try {
      // Step 2: the build agent implements the release against Figma and Storybook.
      let built = await runBuildStage({ repoRoot, plan, storybook, camera });
      costs.push({ stage: "build", costUsd: built.costUsd, turns: built.turns });
      figmaNote = built.figmaProblem;

      // Step 3: an independent reviewer checks it; blocking findings go back to the builder.
      const maxRounds = Number(values["max-review-rounds"]);
      for (let round = 1; round <= maxRounds; round++) {
        const review = await runReviewStage({ repoRoot, plan, storybook, camera, round });
        costs.push({ stage: `review ${round}`, costUsd: review.costUsd, turns: review.turns });
        if (!review.output) {
          console.warn(`Review ${round} did not produce a report: ${review.summary}`);
          break;
        }
        reviews.push(review.output);
        const blocking = review.output.findings.filter((f) => f.severity === "blocking");
        if (review.output.verdict === "approve" || !blocking.length || round === maxRounds || !built.sessionId) break;
        built = await runBuildStage({ repoRoot, plan, storybook, camera, resume: { sessionId: built.sessionId, findings: blocking } });
        costs.push({ stage: `fix ${round}`, costUsd: built.costUsd, turns: built.turns });
      }
      buildReport = built.output;
      buildSummary = built.summary;
    } finally {
      await camera.close();
      await storybook.stop();
    }
  }

  // Step 4 (deterministic): the gate the PR is judged on, whatever the agents reported.
  const verify = verifyDesignSystem(repoRoot);
  const lastReview = reviews.at(-1) ?? null;
  const release = {
    version: next.version,
    previousVersion: diff.from,
    bump: diff.requiredBump,
    breaking: diff.breakingReasons,
    tasks: tasks.map((t) => (t.type === "remove" ? `remove ${t.name}` : `${t.type} ${t.component.name}`)),
    verified: verify.passed,
    review: lastReview?.verdict ?? null,
    costs,
    costUsd: Number(costs.reduce((sum, c) => sum + c.costUsd, 0).toFixed(2)),
  };
  writeOutput("release.json", `${JSON.stringify(release, null, 2)}\n`);
  writeOutput(
    "pr-body.md",
    buildBody({
      manifest: next,
      diffSummary,
      buildReport,
      buildSummary,
      reviews,
      verify,
      costs,
      figmaNote,
      changedFiles: spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout.trimEnd(),
    }),
  );
  console.log(JSON.stringify(release, null, 2));
}

async function release() {
  const registry = readJson<Registry>(registryPath);
  const manifest = loadManifest(registry.version);
  const previous = previousVersion(registry.version);
  const diffSummary = summarizeDiff(diffManifests(previous ? loadManifest(previous) : null, manifest));
  const config = configFromEnv();
  const strategy = values.strategy as Strategy;
  if (strategy !== "alias" && strategy !== "in-place") throw new Error("--strategy must be alias or in-place");
  const promote = {
    changelog: manifest.changelog,
    diffSummary,
    storybookUrl: values["storybook-url"],
    keepEnvironments: values["keep-environments"] ? Number(values["keep-environments"]) : undefined,
    log: (line: string) => console.log(`[contentful] ${line}`),
  };

  if (values["skip-agents"]) {
    await syncDesignSystem({ config, registry, strategy, ...promote });
    writeOutput("content-report.md", `Synced content types for design-system@${registry.version} without content migration.\n`);
    return;
  }

  // Step 1 (deterministic): a private copy of the live environment to work in.
  const target = await prepareEnvironment(config, registry.version, { strategy, log: promote.log });

  // Step 2: the content agent migrates schema and content, then promotes through a validated tool.
  let docs: DocsServer | null = null;
  if (values["storybook-url"]) {
    try {
      docs = await serveStorybookDocs(values["storybook-url"]);
    } catch (error) {
      console.warn(`Storybook docs MCP unavailable: ${String(error)}`);
    }
  }
  try {
    const { result, state } = await runContentStage({
      repoRoot,
      config,
      target,
      registry,
      promote,
      storybookDocsUrl: docs?.url,
    });
    writeOutput("content-report.md", contentBody({ registry, target, result, promoted: state.promoted }));
    if (!state.promoted) {
      console.error(`Not promoted: ${result.output?.summary ?? result.summary}`);
      process.exitCode = 1;
    }
  } finally {
    await docs?.close();
  }
}

/**
 * One-time sign-in to Figma's official MCP server for the machine that runs
 * the agents. The grant is stored in CLAUDE_CONFIG_DIR (default ~/.claude),
 * so set the same CLAUDE_CONFIG_DIR for the pipeline runs.
 */
async function figmaConnect() {
  const claude = claudeExecutable();
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? "~", ".claude");
  console.log(`Connecting Figma for agents using ${configDir}`);
  const added = spawnSync(claude, ["mcp", "add", "--scope", "user", "--transport", "http", FIGMA, FIGMA_OFFICIAL_URL], { encoding: "utf8" });
  if (added.status !== 0 && !/already exists/i.test(`${added.stdout}${added.stderr}`)) {
    throw new Error(`Could not register Figma's MCP server:\n${added.stdout}${added.stderr}`);
  }
  console.log("Sign in with the Figma account the agents should use (it needs view access to the design-system file).");
  const login = spawnSync(claude, ["mcp", "login", FIGMA, ...(values["no-browser"] ? ["--no-browser"] : [])], { stdio: "inherit" });
  if (login.status !== 0) throw new Error("Figma sign-in did not complete.");
  const status = spawnSync(claude, ["mcp", "get", FIGMA], { encoding: "utf8" });
  console.log(status.stdout.trim());
  console.log(`\nDone. Run the pipeline with CLAUDE_CONFIG_DIR=${configDir} and FIGMA_MCP=official (the default).`);
}

const commands: Record<string, () => Promise<void>> = { build, release, "figma-connect": figmaConnect };
const run = command ? commands[command] : undefined;
if (!run) {
  console.error("Usage: pipeline build --version <x.y.z> | pipeline release --storybook-url <url> | pipeline figma-connect [--no-browser]");
  process.exit(2);
}
run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
