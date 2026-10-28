/**
 * End-to-end run of the whole pipeline on this machine:
 *
 *   designer publishes the Figma library → gateway webhook → release branch
 *   → hosted runner builds it (pipeline build) → pull request → merge
 *   → GitHub webhook → Storybook deployed + Contentful migrated (pipeline release)
 *   → Slack composer saves a draft page → signed preview renders in Storybook
 *
 * The gateway, runner, pipeline, Storybook and Contentful code are the real
 * ones. Figma, GitHub and Contentful are local stand-ins (see the fake-*.ts
 * files), so the run needs no accounts. Claude is used only with
 * --with-agents (needs ANTHROPIC_API_KEY): the designer then also adds a new
 * section, which the build, review, content and composer agents handle.
 *
 *   pnpm e2e                 # no accounts, no model; about 5 minutes
 *   pnpm e2e --with-agents   # also runs every agent stage against Claude
 *   pnpm e2e --serve         # keep everything running afterwards to click around
 */
import { createHmac, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { WebhookLibraryPublishPayload } from "@figma/rest-api-spec";
import { Hono } from "hono";
import { chromium } from "playwright-core";
import { pageTools, previewUrl, serveStorybookDocs, type DocsServer } from "@storypage/agents";
import {
  createContentfulClient,
  getLiveRelease,
  loadPage,
  publishPage,
  syncDesignSystem,
  upsertPage,
  validateEnvironment,
  type ContentfulConfig,
} from "@storypage/contentful";
import { FigmaClient, scanLibrary } from "@storypage/figma";
import { createApp, LocalRunner, pipelineEnvFrom, ReleaseService, type Notifier, type PublishResult } from "@storypage/gateway";
import {
  PAGE_CONTENT_TYPE_ID,
  parseManifest,
  renderTokensCss,
  renderTokensTs,
  resolveSelection,
  toRegistry,
  type DesignSystemManifest,
  type Registry,
} from "@storypage/schema";
import { compose } from "@storypage/slack-bot/composer";
import { FakeContentful, LOCALE, SPACE_ID, TOKEN as CONTENTFUL_TOKEN } from "./fake-contentful.js";
import { FakeFigma, FILE_KEY, TOKEN as FIGMA_TOKEN } from "./fake-figma.js";
import { git, LocalGitRepoStore } from "./git-repo.js";
import { contractDifferences, type Design } from "./library.js";
import { listen, type Listening } from "./listen.js";
import { addTestimonial, BRAND_COLOR, changeBrandColor, HOME_PAGE, LAUNCH_PAGE, LAUNCH_REQUEST } from "./scenario.js";

const { values: args } = parseArgs({
  options: {
    "with-agents": { type: "boolean", default: false },
    serve: { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const withAgents = args["with-agents"];
if (withAgents && !process.env.ANTHROPIC_API_KEY) {
  console.error("--with-agents needs ANTHROPIC_API_KEY (the agents run Claude through the Claude Agent SDK).");
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runDir = path.resolve(args.out ?? path.join(repoRoot, ".storypage-e2e", new Date().toISOString().replace(/[:.]/g, "-")));
mkdirSync(runDir, { recursive: true });

// ---------------------------------------------------------------------------
// Steps and reporting
// ---------------------------------------------------------------------------

type Status = "passed" | "failed" | "skipped";
interface StepResult {
  name: string;
  status: Status;
  seconds: number;
  notes: string[];
}
const steps: StepResult[] = [];
let failed = false;

async function step(name: string, run: (note: (line: string) => void) => Promise<void>) {
  if (failed) {
    steps.push({ name, status: "skipped", seconds: 0, notes: [] });
    return;
  }
  console.log(`\n▶ ${name}`);
  const notes: string[] = [];
  const note = (line: string) => {
    notes.push(line);
    console.log(`  ${line}`);
  };
  const started = Date.now();
  try {
    await run(note);
    steps.push({ name, status: "passed", seconds: (Date.now() - started) / 1000, notes });
    console.log(`✔ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    failed = true;
    note(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    steps.push({ name, status: "failed", seconds: (Date.now() - started) / 1000, notes });
    console.log(`✘ ${name}`);
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Notifications the gateway would post in the design team's Slack channel. */
class RecordingNotifier implements Notifier {
  readonly messages: string[] = [];
  async send(text: string) {
    this.messages.push(text);
    console.log(`  [slack] ${text.split("\n")[0]}`);
  }
}

/** Lets the run wait for the webhook's background work, which Figma doesn't. */
class ObservedReleases extends ReleaseService {
  last: Promise<PublishResult | null> = Promise.resolve(null);
  override publishLibrary(event: WebhookLibraryPublishPayload, figma: FigmaClient) {
    this.last = super.publishLibrary(event, figma);
    return this.last;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const secret = () => randomBytes(16).toString("hex");

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const servers: Listening[] = [];
const notifier = new RecordingNotifier();
const previewSecret = secret();
const passcode = secret();
const githubSecret = secret();
const publishToken = secret();

let figma!: FakeFigma;
let figmaClient!: FigmaClient;
let baseline!: DesignSystemManifest;
let repo!: LocalGitRepoStore;
let contentful!: FakeContentful;
let contentfulConfig!: ContentfulConfig;
let releases!: ObservedReleases;
let runner!: LocalRunner;
let gatewayUrl = "";
let published: PublishResult | null = null;
let draftSlug = "";
let previewLink = "";
const docs: { server: DocsServer | null } = { server: null };

const seedRegistry = JSON.parse(readFileSync(path.join(repoRoot, "packages/design-system/src/generated/registry.json"), "utf8")) as Registry;
const seed = parseManifest(JSON.parse(readFileSync(path.join(repoRoot, `packages/design-system/manifests/${seedRegistry.version}.json`), "utf8")));
const expectedVersion = withAgents ? "1.1.0" : "1.0.1";

console.log(`StoryPage end-to-end run${withAgents ? " with agents" : ""}\nWorking directory: ${runDir}`);

await step("Figma: a library file built from the design system", async (note) => {
  const design: Design = { name: seed.name, collections: seed.collections, tokens: seed.tokens, textStyles: seed.textStyles, effectStyles: seed.effectStyles, components: seed.components };
  // Most teams aren't on Figma Enterprise, so variables come from the plugin's saved snapshot.
  figma = new FakeFigma(structuredClone(design), { fileName: `${seed.name} Design System`, variables: "snapshot", snapshotSavedAt: new Date().toISOString() });
  const server = await listen(figma.app);
  servers.push(server);
  figma.baseUrl = server.url;
  figmaClient = new FigmaClient({ token: FIGMA_TOKEN, baseUrl: server.url });
  note(`Fake Figma API at ${server.url}, file ${FILE_KEY}: ${design.components.length} components, ${design.tokens.length} variables`);
});

await step("Baseline: what StoryPage reads from the library is the current release", async (note) => {
  const scan = await scanLibrary(figmaClient, FILE_KEY);
  const resolved = resolveSelection(scan.drafts, scan.selections);
  check(scan.variablesSource === "snapshot", `variables came from ${scan.variablesSource}, expected the plugin's snapshot`);
  baseline = parseManifest({
    ...scan.manifest,
    components: resolved.components,
    version: seed.version,
    changelog: seed.changelog,
    publishedAt: seed.publishedAt,
    publishedBy: seed.publishedBy,
  });
  // The designer's choices in the plugin must reproduce the published contract exactly.
  const problems = contractDifferences(seed, baseline);
  check(!problems.length, `what StoryPage reads from Figma doesn't match the published design system:\n${problems.join("\n")}`);
  note(`${baseline.components.length} components with their props, ${baseline.tokens.length} tokens and ${baseline.textStyles.length} text styles match the published release`);
});

await step("GitHub: a repository with the design system at that release", async (note) => {
  const work = path.join(runDir, "seed-repo");
  const files = git(repoRoot, ["ls-files", "-co", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  for (const file of files) {
    if (!existsSync(path.join(repoRoot, file))) continue;
    mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    cpSync(path.join(repoRoot, file), path.join(work, file));
  }
  // The baseline release, with its generated files, as the pipeline would have committed it.
  const ds = path.join(work, "packages/design-system");
  writeFileSync(path.join(ds, `manifests/${baseline.version}.json`), `${JSON.stringify(baseline, null, 2)}\n`);
  writeFileSync(path.join(ds, "src/generated/tokens.css"), renderTokensCss(baseline));
  writeFileSync(path.join(ds, "src/generated/tokens.ts"), renderTokensTs(baseline));
  writeFileSync(path.join(ds, "src/generated/registry.json"), `${JSON.stringify(toRegistry(baseline), null, 2)}\n`);
  git(work, ["init", "--quiet", "-b", "main"]);
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", `Design system ${baseline.version}`]);
  const bare = path.join(runDir, "origin.git");
  git(runDir, ["init", "--quiet", "--bare", "-b", "main", bare]);
  git(work, ["-c", "push.negotiate=false", "push", "--quiet", bare, "main"]);
  const port = await freePort();
  gatewayUrl = `http://127.0.0.1:${port}`;
  repo = new LocalGitRepoStore(bare, "main", (n) => `${gatewayUrl}/e2e/pulls/${n}`);
  note(`${files.length} files from this checkout (uncommitted changes included) → ${bare}`);
});

await step("Contentful: a space with the current release and a published page", async (note) => {
  contentful = new FakeContentful();
  const server = await listen(contentful.app);
  servers.push(server);
  contentfulConfig = { managementToken: CONTENTFUL_TOKEN, spaceId: SPACE_ID, environment: "master", locale: LOCALE, host: server.url.replace("http://", ""), insecure: true };
  const registry = toRegistry(baseline);
  await syncDesignSystem({ config: contentfulConfig, registry, strategy: "alias", changelog: baseline.changelog, log: () => {} });
  const client = createContentfulClient(contentfulConfig);
  const home = await upsertPage(client, HOME_PAGE, registry, LOCALE);
  await publishPage(client, home.pageId);
  note(`Fake Content Management API at ${server.url}: alias master → ${contentful.aliasTarget()}, ${contentful.environment("master").contentTypes.size} content types, page /home published`);
});

await step("Gateway: running with the hosted runner", async (note) => {
  const outside = pipelineEnvFrom(process.env);
  for (const key of Object.keys(outside)) {
    // The run's own Figma and Contentful stand-ins replace any real settings; Claude only with --with-agents.
    if (key.startsWith("FIGMA_") || key.startsWith("CONTENTFUL_") || (!withAgents && key.startsWith("ANTHROPIC_"))) delete outside[key];
  }
  const pipelineEnv = {
    ...outside,
    CLAUDE_CONFIG_DIR: path.join(runDir, "claude"),
    FIGMA_MCP: "off",
    CONTENTFUL_MANAGEMENT_TOKEN: contentfulConfig.managementToken,
    CONTENTFUL_SPACE_ID: contentfulConfig.spaceId,
    CONTENTFUL_ENVIRONMENT: contentfulConfig.environment,
    CONTENTFUL_HOST: contentfulConfig.host!,
    CONTENTFUL_INSECURE: "true",
  };
  runner = new LocalRunner({
    workDir: path.join(runDir, "worker"),
    repoUrl: repo.bare,
    baseBranch: "main",
    repo,
    publicUrl: gatewayUrl,
    pipelineEnv,
    // Without a model, the content stage runs its deterministic path.
    ...(withAgents
      ? {}
      : { commands: { release: (url: string) => ["pnpm", "--filter", "@storypage/pipeline", "pipeline", "release", "--storybook-url", url, "--skip-agents"] } }),
    log: (line) => console.log(`  [runner] ${line}`),
  });
  releases = new ObservedReleases(repo, runner, notifier);
  const contentfulClient = createContentfulClient(contentfulConfig);
  const gateway = createApp({
    releases,
    runner,
    publishToken,
    figma: { client: figmaClient, passcode, fileKeys: [FILE_KEY] },
    githubWebhookSecret: githubSecret,
    preview: {
      signingSecret: previewSecret,
      async loadPage(slug) {
        const live = await getLiveRelease(contentfulClient, LOCALE);
        return live ? loadPage(contentfulClient, slug, live.registry, LOCALE) : null;
      },
    },
  });
  const app = new Hono();
  // Pull requests of the GitHub stand-in, linked from the run's report.
  app.get("/e2e/pulls/:n", (c) => {
    const pr = repo.pullRequests[Number(c.req.param("n")) - 1];
    return pr ? c.text(`# ${pr.title}${pr.draft ? " (draft)" : ""}\n${pr.branch} · ${pr.state}\n\n${pr.body}`) : c.notFound();
  });
  app.route("/", gateway);
  servers.push(await listen(app, Number(new URL(gatewayUrl).port)));
  const health = (await (await fetch(`${gatewayUrl}/health`)).json()) as { runner: string };
  check(health.runner === "local", "gateway isn't using the hosted runner");
  note(`Gateway at ${gatewayUrl} (runner: ${health.runner})`);
});

async function postFigmaWebhook(event: WebhookLibraryPublishPayload) {
  const response = await fetch(`${gatewayUrl}/webhooks/figma`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
  check(response.status === 202, `the Figma webhook got ${response.status}: ${await response.text()}`);
  return releases.last;
}

/** Waits for the runner, printing progress so long builds don't look stuck. */
async function waitForRunner(note: (line: string) => void) {
  let done = false;
  const ticker = setInterval(() => {
    const job = runner.jobs.find((j) => j.status === "running");
    if (job) console.log(`  … ${job.id}: ${job.log.at(-1)?.slice(0, 140) ?? "starting"}`);
  }, 20_000);
  try {
    await runner.idle();
    done = true;
  } finally {
    clearInterval(ticker);
    for (const job of runner.jobs) writeFileSync(path.join(runDir, `${job.id}.log`), `${job.log.join("\n")}\n`);
  }
  const job = runner.jobs[0]!;
  note(`${job.id} ${job.status} (log: ${path.join(runDir, `${job.id}.log`)})`);
  check(done && job.status === "succeeded", `${job.id} failed: ${job.error ?? ""}\n${job.log.slice(-25).join("\n")}`);
  return job;
}

await step("Designer publishes the library without changes: nothing to build", async (note) => {
  const result = await postFigmaWebhook(figma.publishEvent(passcode, "Tidied up layer names"));
  check(result === null, `expected no release, got ${result?.version}`);
  check(!(await repo.branchExists(`design-system/v1.0.1`)), "a release branch was created");
  note("Webhook accepted; no release branch, no job");
});

await step(`Designer ${withAgents ? "changes the brand color, adds a Testimonial section" : "changes the brand color"} and publishes the library`, async (note) => {
  figma.edit(changeBrandColor);
  const changes: Parameters<FakeFigma["publishEvent"]>[2] = { modified_variables: [{ key: "variable-1", name: BRAND_COLOR.token }] };
  if (withAgents) {
    figma.edit(addTestimonial);
    changes.created_components = [{ key: "t1u2v3testimonial", name: "Marketing/Testimonial" }];
  }
  published = await postFigmaWebhook(figma.publishEvent(passcode, withAgents ? "Darker brand blue and a new Testimonial section" : "Darker brand blue for contrast", changes));
  check(published, `no release was started; Slack said: ${notifier.messages.at(-1) ?? "nothing"}`);
  check(published.version === expectedVersion, `expected version ${expectedVersion}, got ${published.version} (${published.requiredBump})`);
  note(`Release ${published.version} (${published.requiredBump}) committed to ${published.branch}; status ${published.statusUrl}`);
  const manifest = parseManifest(JSON.parse((await gitShow(published.branch, `packages/design-system/manifests/${published.version}.json`))!));
  check(manifest.tokens.find((t) => t.name === BRAND_COLOR.token)?.values.Default === BRAND_COLOR.value, "the manifest doesn't carry the new color");
  check(manifest.components.every((c) => !c.figmaNodeId || c.preview), "some components have no Figma preview image");
});

function gitShow(ref: string, file: string): Promise<string | null> {
  try {
    return Promise.resolve(git(repo.bare, ["show", `${ref}:${file}`]));
  } catch {
    return Promise.resolve(null);
  }
}

await step(`Runner builds ${expectedVersion} and opens a pull request`, async (note) => {
  await waitForRunner(note);
  const pr = repo.pullRequests[0];
  check(pr, "no pull request was opened");
  writeFileSync(path.join(runDir, "pull-request.md"), pr.body);
  check(!pr.draft, "the pull request is a draft: verification failed (see its body)");
  const css = await gitShow(pr.branch, "packages/design-system/src/generated/tokens.css");
  check(css?.includes(BRAND_COLOR.value), "regenerated tokens.css doesn't have the new color");
  const release = JSON.parse(readFileSync(path.join(runDir, "worker/repo/.storypage/release.json"), "utf8")) as { verified: boolean; tasks: string[]; costUsd: number };
  if (withAgents) {
    check(await gitShow(pr.branch, "packages/design-system/src/components/Testimonial/Testimonial.tsx"), "the build agent didn't create the Testimonial component");
  }
  note(`${pr.url}: "${pr.title}", verified, tasks: ${release.tasks.join(", ") || "none (tokens only)"}${release.costUsd ? `, agents $${release.costUsd}` : ""}`);
});

await step("Reviewer merges the pull request; the runner releases it", async (note) => {
  const pr = repo.pullRequests[0]!;
  repo.merge(pr);
  const payload = JSON.stringify({ action: "closed", pull_request: { merged: true, head: { ref: pr.branch } } });
  const response = await fetch(`${gatewayUrl}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${createHmac("sha256", githubSecret).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  check(response.status === 202, `the GitHub webhook got ${response.status}: ${await response.text()}`);
  note(`Merged ${pr.branch} into main; release job started`);
  await waitForRunner(note);
});

await step("Storybook is deployed and Contentful moved to the new release", async (note) => {
  const storybook = await fetch(`${gatewayUrl}/storybook/index.html`);
  check(storybook.ok, `Storybook isn't served (${storybook.status})`);
  check(contentful.aliasTarget() === `ds-${expectedVersion.replaceAll(".", "-")}`, `alias master points at ${contentful.aliasTarget()}`);
  const client = createContentfulClient(contentfulConfig);
  const live = await getLiveRelease(client, LOCALE);
  check(live?.version === expectedVersion, `live release is ${live?.version}`);
  check(live.storybookUrl === `${gatewayUrl}/storybook/`, `release records Storybook at ${live.storybookUrl}`);
  const report = await validateEnvironment(contentfulConfig, { environment: contentful.aliasTarget(), previousEnvironment: null, strategy: "alias" }, live.registry);
  check(report.pages === 1 && report.issues.length === 0, `existing pages don't validate: ${JSON.stringify(report.issues)}`);
  const home = await loadPage(client, "home", live.registry, LOCALE);
  check(home?.sections.length === HOME_PAGE.sections.length, "the /home page lost sections");
  if (withAgents) check(live.registry.components.some((c) => c.name === "Testimonial"), "Testimonial isn't in the live registry");
  note(`Storybook at ${gatewayUrl}/storybook/; alias master → ${contentful.aliasTarget()} (rollback: ds-1-0-0); /home still valid`);
});

await step(withAgents ? "Slack: the composer agent writes a page" : "Slack: the composer saves a page draft", async (note) => {
  const client = createContentfulClient(contentfulConfig);
  const live = await getLiveRelease(client, LOCALE);
  check(live, "no live release");
  if (withAgents) {
    docs.server = await serveStorybookDocs(live.storybookUrl).catch(() => null);
    const result = await compose(
      { contentful: client, config: contentfulConfig, release: live, previewSigningSecret: previewSecret, storybookDocsUrl: docs.server?.url, workDir: path.join(runDir, "bot") },
      undefined,
      `${LAUNCH_REQUEST} Include a customer testimonial.`,
    );
    note(`Composer replied: ${result.reply.split("\n")[0]}`);
    check(result.draft, "the composer didn't save a draft");
    draftSlug = result.draft.slug;
  } else {
    // The composer's save tool, called with the page a model would write.
    const { save } = pageTools({ contentful: client, release: live, spaceId: SPACE_ID, environment: "master", locale: LOCALE, previewSigningSecret: previewSecret });
    const saved = JSON.parse(((await save(LAUNCH_PAGE)).content[0] as { text: string }).text) as { saved?: boolean; pageId: string; previewUrl: string };
    check(saved.saved, `not saved: ${JSON.stringify(saved)}`);
    draftSlug = LAUNCH_PAGE.slug;
  }
  previewLink = previewUrl(live.storybookUrl, draftSlug, previewSecret);
  const page = await loadPage(client, draftSlug, live.registry, LOCALE);
  check(page, `no page ${draftSlug}`);
  const entry = (await client.entry.getMany({ query: { content_type: PAGE_CONTENT_TYPE_ID, "fields.slug": draftSlug } })).items[0]!;
  check(entry.sys.publishedVersion === undefined, "the page was published; the composer must only save drafts");
  note(`Draft /${draftSlug} with ${page.sections.map((s) => s.component).join(", ")}`);
});

await step("Preview: the signed link renders the draft in the deployed Storybook", async (note) => {
  const url = new URL(previewLink);
  const tampered = await fetch(`${gatewayUrl}/preview/pages/${draftSlug}?exp=${url.searchParams.get("exp")}&sig=forged`);
  check(tampered.status === 403, `a forged preview signature got ${tampered.status}`);
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(previewLink, { waitUntil: "networkidle" });
    const client = createContentfulClient(contentfulConfig);
    const live = (await getLiveRelease(client, LOCALE))!;
    const draft = (await loadPage(client, draftSlug, live.registry, LOCALE))!;
    const headline = String(draft.sections.map((s) => s.props.headline ?? s.props.heading).find(Boolean) ?? "");
    await page.getByText(headline, { exact: false }).first().waitFor({ timeout: 20_000 });
    const screenshot = path.join(runDir, "preview.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    note(`Rendered "${headline}"; screenshot ${screenshot}`);
    note(`Preview link: ${previewLink}`);
  } finally {
    await browser.close();
  }
});

await step("Slack: an editor presses Publish", async (note) => {
  const client = createContentfulClient(contentfulConfig);
  const entry = (await client.entry.getMany({ query: { content_type: PAGE_CONTENT_TYPE_ID, "fields.slug": draftSlug } })).items[0]!;
  const count = await publishPage(client, entry.sys.id);
  const after = await client.entry.get({ entryId: entry.sys.id });
  check(after.sys.publishedVersion !== undefined, "the page isn't published");
  note(`Published /${draftSlug} and ${count - 1} entries it references`);
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const icon = { passed: "✔", failed: "✘", skipped: "–" };
const lines = [
  `# StoryPage end-to-end run${withAgents ? " (with agents)" : ""}`,
  "",
  `${new Date().toISOString()} · ${steps.filter((s) => s.status === "passed").length}/${steps.length} steps passed`,
  "",
  ...steps.flatMap((s) => [`## ${icon[s.status]} ${s.name}${s.status === "skipped" ? " (skipped)" : ` (${s.seconds.toFixed(1)}s)`}`, "", ...s.notes.map((n) => `    ${n.replace(/\n/g, "\n    ")}`), ""]),
  "## Slack notifications",
  "",
  ...notifier.messages.map((m) => `- ${m.replace(/\n/g, " ")}`),
  "",
  "## Stand-in traffic",
  "",
  `- Figma API requests: ${figma?.requests.length ?? 0}`,
  `- Contentful writes: ${contentful?.writes.length ?? 0}`,
  `- Pull requests: ${repo?.pullRequests.map((p) => `${p.url} (${p.state})`).join(", ") || "none"}`,
  "",
];
writeFileSync(path.join(runDir, "report.md"), lines.join("\n"));

console.log(`\n${"-".repeat(72)}`);
for (const s of steps) console.log(`${icon[s.status]} ${s.name}${s.status === "passed" ? ` (${s.seconds.toFixed(1)}s)` : s.status === "skipped" ? " (skipped)" : ""}`);
console.log(`\nReport: ${path.join(runDir, "report.md")}`);

if (args.serve && gatewayUrl) {
  console.log(`
Everything is still running (Ctrl+C to stop):
  Storybook        ${gatewayUrl}/storybook/
  Draft preview    ${previewLink || "(none)"}
  Pull request     ${gatewayUrl}/e2e/pulls/1
  Gateway          ${gatewayUrl}  (publish token for the Figma plugin: ${publishToken})`);
  await new Promise(() => {});
}

await docs.server?.close();
for (const server of servers) await server.close();
process.exit(failed ? 1 : 0);
