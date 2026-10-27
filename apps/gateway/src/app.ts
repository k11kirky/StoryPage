import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  checkVersionBump,
  diffManifests,
  DesignSystemManifestSchema,
  lintManifest,
  ManifestError,
  parseManifest,
  suggestNextVersion,
  summarizeDiff,
  type DesignSystemManifest,
  type Registry,
} from "@storypage/schema";
import { verifyPreview } from "@storypage/contentful";
import type { PageDocument } from "@storypage/schema";
import type { RepoFile, RepoStore } from "./repo.js";

export const MANIFESTS_DIR = "packages/design-system/manifests";
export const REGISTRY_PATH = "packages/design-system/src/generated/registry.json";
export const DISPATCH_EVENT = "design-system-published";

const PNG_BASE64_PREFIX = "iVBORw0KGgo";

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

export interface GatewayOptions {
  repo: RepoStore;
  /** Shared secret the Figma plugin sends as a bearer token. */
  publishToken: string;
  /** Enables `GET /preview/pages/<slug>` for the Storybook preview story. */
  preview?: PreviewOptions | undefined;
}

function authorized(c: Context, token: string): boolean {
  const header = c.req.header("authorization") ?? "";
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function currentManifest(repo: RepoStore): Promise<DesignSystemManifest | null> {
  const registryJson = await repo.readFile(REGISTRY_PATH);
  if (!registryJson) return null;
  const { version } = JSON.parse(registryJson) as Registry;
  const manifestJson = await repo.readFile(`${MANIFESTS_DIR}/${version}.json`);
  return manifestJson ? parseManifest(JSON.parse(manifestJson)) : null;
}

export const branchFor = (version: string) => `design-system/v${version}`;

export function createApp({ repo, publishToken, preview }: GatewayOptions) {
  const app = new Hono();

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

  // The Figma plugin UI runs in a sandboxed iframe with a null origin.
  app.use("/api/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST"] }));
  app.use("/api/*", bodyLimit({ maxSize: 40 * 1024 * 1024 }));
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    if (!authorized(c, publishToken)) return c.json({ error: "Invalid publish token" }, 401);
    return next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/api/design-system/current", async (c) => {
    const manifest = await currentManifest(repo);
    return manifest ? c.json(manifest) : c.json({ error: "No design system has been published yet" }, 404);
  });

  /** Dry run for the plugin: what changed, which bump it needs, and any problems. */
  app.post("/api/design-system/diff", async (c) => {
    const body = PublishRequestSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const parsed = DesignSystemManifestSchema.safeParse(body.data.manifest);
    if (!parsed.success) return c.json({ error: "Invalid manifest", problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 422);
    const previous = await currentManifest(repo);
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

    const previous = await currentManifest(repo);
    const diff = diffManifests(previous, manifest);
    if (diff.isEmpty) return c.json({ error: "Nothing changed since the last published version." }, 409);
    const versionProblem = checkVersionBump(diff);
    if (versionProblem) {
      return c.json({ error: versionProblem, suggestedVersion: suggestNextVersion(diff.from, diff.requiredBump) }, 409);
    }
    const branch = branchFor(manifest.version);
    if ((await repo.branchExists(branch)) || (await repo.readFile(`${MANIFESTS_DIR}/${manifest.version}.json`))) {
      return c.json({ error: `Version ${manifest.version} has already been published.` }, 409);
    }

    const files: RepoFile[] = [];
    const componentNames = new Set(manifest.components.map((component) => component.name));
    for (const [name, png] of Object.entries(body.data.previews)) {
      if (!componentNames.has(name)) continue;
      if (!png.startsWith(PNG_BASE64_PREFIX)) return c.json({ error: `Preview for ${name} is not a PNG` }, 400);
      const previewPath = `${manifest.version}/previews/${name}.png`;
      files.push({ path: `${MANIFESTS_DIR}/${previewPath}`, content: png, encoding: "base64" });
      manifest.components.find((component) => component.name === name)!.preview = previewPath;
    }
    files.unshift({
      path: `${MANIFESTS_DIR}/${manifest.version}.json`,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      encoding: "utf-8",
    });

    const message = [
      `Publish design system ${manifest.version} from Figma`,
      "",
      `Published by ${manifest.publishedBy.name} from "${manifest.source.figmaFileName}".`,
      ...(manifest.changelog ? ["", manifest.changelog] : []),
    ].join("\n");
    const sha = await repo.commitToNewBranch(branch, files, message);
    await repo.dispatch(DISPATCH_EVENT, { version: manifest.version, branch });

    return c.json(
      {
        version: manifest.version,
        branch,
        commit: sha,
        requiredBump: diff.requiredBump,
        summary: summarizeDiff(diff),
        statusUrl: repo.actionsUrl(),
      },
      202,
    );
  });

  return app;
}
