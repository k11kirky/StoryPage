import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { WebhookLibraryPublishPayload } from "@figma/rest-api-spec";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { verifyPreview } from "@storypage/contentful";
import type { FigmaClient } from "@storypage/figma";
import {
  DesignSystemManifestSchema,
  diffManifests,
  lintManifest,
  ManifestError,
  parseManifest,
  suggestNextVersion,
  summarizeDiff,
  type DesignSystemManifest,
  type PageDocument,
} from "@storypage/schema";
import { PublishError, type ReleaseService } from "./releases.js";
import { LocalRunner } from "./runners/local.js";
import type { Runner } from "./runners/types.js";

export { branchFor, MANIFESTS_DIR, REGISTRY_PATH } from "./releases.js";
export { DISPATCH_EVENT } from "./runners/github.js";

const PublishRequestSchema = z.object({
  manifest: z.unknown(),
  /** Base64 PNG previews keyed by component name. */
  previews: z.record(z.string().regex(/^[A-Z][A-Za-z0-9]*$/), z.string().max(8_000_000)).default({}),
});

export interface PreviewOptions {
  /** HMAC secret shared with the Slack bot, which signs preview links. */
  signingSecret: string;
  /** Loads a page, drafts included, with the live design-system registry. */
  loadPage(slug: string): Promise<PageDocument | null>;
}

export interface FigmaWebhookOptions {
  client: FigmaClient;
  /** The passcode given when the webhook was registered. */
  passcode: string;
  /** Library files StoryPage builds; publishes of other files are ignored. */
  fileKeys: string[];
}

export interface GatewayOptions {
  releases: ReleaseService;
  runner: Runner;
  /** Shared secret the Figma plugin sends as a bearer token. */
  publishToken: string;
  /** Enables `GET /preview/pages/<slug>` for the Storybook preview story. */
  preview?: PreviewOptions | undefined;
  /** Enables `POST /webhooks/figma`: releases start from Figma's own "Publish library". */
  figma?: FigmaWebhookOptions | undefined;
  /** Enables `POST /webhooks/github` (hosted runner): merged design-system PRs are released. */
  githubWebhookSecret?: string | undefined;
}

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const authorized = (c: Context, token: string) => sameSecret((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""), token);

export function createApp(options: GatewayOptions) {
  const { releases, runner, publishToken, preview } = options;
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, runner: runner.kind }));

  // Draft pages for the Storybook preview story, authorized by a signed link
  // from the Slack bot instead of a token baked into the Storybook bundle.
  app.use("/preview/*", cors({ origin: "*", allowMethods: ["GET"] }));
  app.get("/preview/pages/:slug{.+}", async (c) => {
    if (!preview) return c.json({ error: "Previews are not configured" }, 404);
    const slug = c.req.param("slug");
    const valid = verifyPreview(slug, { exp: Number(c.req.query("exp")), sig: c.req.query("sig") ?? "" }, preview.signingSecret);
    if (!valid) return c.json({ error: "This preview link is invalid or has expired. Ask the Slack bot for a new one." }, 403);
    const page = await preview.loadPage(slug);
    c.header("cache-control", "private, no-store");
    return page ? c.json(page) : c.json({ error: `No page with slug "${slug}"` }, 404);
  });

  // ---------------------------------------------------------------------------
  // Figma: designers publish their library as usual; this starts a release.
  // ---------------------------------------------------------------------------
  app.post("/webhooks/figma", async (c) => {
    if (!options.figma) return c.json({ error: "Figma webhooks are not configured" }, 404);
    const event = (await c.req.json()) as { event_type?: string; passcode?: string; file_key?: string };
    if (!sameSecret(event.passcode ?? "", options.figma.passcode)) return c.json({ error: "Invalid passcode" }, 401);
    if (event.event_type !== "LIBRARY_PUBLISH") return c.json({ ok: true });
    if (options.figma.fileKeys.length && !options.figma.fileKeys.includes(event.file_key ?? "")) return c.json({ ok: true, ignored: true });
    // Figma expects a quick answer; the release runs in the background and reports to Slack.
    void releases.publishLibrary(event as WebhookLibraryPublishPayload, options.figma.client).catch((error: unknown) => {
      console.error("Library publish failed", error);
    });
    return c.json({ ok: true, accepted: true }, 202);
  });

  // ---------------------------------------------------------------------------
  // GitHub (hosted runner): release a design-system PR once it's merged.
  // ---------------------------------------------------------------------------
  app.post("/webhooks/github", async (c) => {
    if (!options.githubWebhookSecret || !runner.release) return c.json({ error: "GitHub webhooks are not configured" }, 404);
    const raw = await c.req.text();
    const signature = `sha256=${createHmac("sha256", options.githubWebhookSecret).update(raw).digest("hex")}`;
    if (!sameSecret(c.req.header("x-hub-signature-256") ?? "", signature)) return c.json({ error: "Invalid signature" }, 401);
    if (c.req.header("x-github-event") !== "pull_request") return c.json({ ok: true });
    const event = JSON.parse(raw) as { action?: string; pull_request?: { merged?: boolean; head?: { ref?: string } } };
    const version = /^design-system\/v(.+)$/.exec(event.pull_request?.head?.ref ?? "")?.[1];
    if (event.action !== "closed" || !event.pull_request?.merged || !version) return c.json({ ok: true });
    const { statusUrl } = await runner.release(version);
    return c.json({ ok: true, statusUrl }, 202);
  });

  // ---------------------------------------------------------------------------
  // Hosted runner: job status, and the deployed Storybook.
  // ---------------------------------------------------------------------------
  const local = runner instanceof LocalRunner ? runner : null;
  app.get("/jobs/:id", (c) => {
    const job = local?.jobs.find((j) => j.id === c.req.param("id"));
    if (!job) return c.json({ error: "No such job" }, 404);
    const { log, ...summary } = job;
    // Logs only for the team (they can mention file paths and agent output).
    return c.json(authorized(c, publishToken) ? job : { ...summary, logLines: log.length });
  });
  if (local) {
    app.use(
      "/storybook/*",
      serveStatic({
        root: path.relative(process.cwd(), local.storybookDir),
        rewriteRequestPath: (p) => p.replace(/^\/storybook/, "") || "/index.html",
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Plugin API (bearer token). The plugin UI runs in a sandboxed iframe with a null origin.
  // ---------------------------------------------------------------------------
  app.use("/api/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST"] }));
  app.use("/api/*", bodyLimit({ maxSize: 40 * 1024 * 1024 }));
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    if (!authorized(c, publishToken)) return c.json({ error: "Invalid publish token" }, 401);
    return next();
  });

  app.get("/api/design-system/current", async (c) => {
    const manifest = await releases.currentManifest();
    return manifest ? c.json(manifest) : c.json({ error: "No design system has been published yet" }, 404);
  });

  /** Dry run for the plugin: what changed, which bump it needs, and any problems. */
  app.post("/api/design-system/diff", async (c) => {
    const body = PublishRequestSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const parsed = DesignSystemManifestSchema.safeParse(body.data.manifest);
    if (!parsed.success) return c.json({ error: "Invalid manifest", problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 422);
    const previous = await releases.currentManifest();
    const diff = diffManifests(previous, parsed.data);
    return c.json({
      currentVersion: previous?.version ?? null,
      suggestedVersion: suggestNextVersion(previous?.version ?? null, diff.requiredBump),
      requiredBump: diff.requiredBump,
      breaking: diff.breakingReasons,
      summary: summarizeDiff(diff),
      isEmpty: diff.isEmpty,
      problems: lintManifest(parsed.data),
    });
  });

  app.post("/api/design-system/publish", async (c) => {
    const body = PublishRequestSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    let manifest: DesignSystemManifest;
    try {
      manifest = parseManifest(body.data.manifest);
    } catch (error) {
      if (error instanceof ManifestError) return c.json({ error: "Invalid manifest", problems: error.problems }, 422);
      if (error instanceof z.ZodError) {
        return c.json({ error: "Invalid manifest", problems: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 422);
      }
      throw error;
    }
    try {
      return c.json(await releases.publish(manifest, body.data.previews), 202);
    } catch (error) {
      if (error instanceof PublishError) return c.json({ error: error.message, ...error.details }, error.status);
      throw error;
    }
  });

  return app;
}
