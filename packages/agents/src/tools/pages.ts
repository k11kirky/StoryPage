import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  entryEditorUrl,
  loadPage,
  PageValidationError,
  signPreview,
  upsertPage,
  type LiveRelease,
  type PlainClientAPI,
} from "@storypage/contentful";
import { PageDocumentSchema, validatePage, type PageDocument } from "@storypage/schema";
import { mcpTool, PIPELINE } from "../mcp.js";
import { guarded, text } from "./result.js";

export interface SavedDraft {
  pageId: string;
  slug: string;
  title: string;
  designSystemVersion: string;
}

export interface PageToolsOptions {
  contentful: PlainClientAPI;
  release: LiveRelease;
  spaceId: string;
  environment: string;
  locale: string;
  previewSigningSecret: string;
  onSaved?: (draft: SavedDraft) => void;
}

export const PAGE_TOOLS = {
  save: mcpTool(PIPELINE, "save_page_draft"),
  load: mcpTool(PIPELINE, "load_page"),
  searchAssets: mcpTool(PIPELINE, "search_assets"),
};

/** A signed, expiring link to a draft rendered by Storybook's preview story. */
export function previewUrl(storybookUrl: string, slug: string, signingSecret: string): string {
  const { exp, sig } = signPreview(slug, signingSecret);
  const url = new URL("iframe.html", `${storybookUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("id", "pages-contentful-preview--page");
  url.searchParams.set("viewMode", "story");
  url.searchParams.set("slug", slug);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return url.toString();
}

const sectionShape = {
  component: z.string().describe("Component name from the design system"),
  props: z
    .record(z.string(), z.unknown())
    .describe("Prop values. Slot props hold nested { component, props } blocks (or a list of them)."),
};

const formatIssues = (issues: { path: string; message: string }[]) =>
  `Not saved. Fix these problems and call save_page_draft again:\n${issues.map((i) => `- ${i.path}: ${i.message}`).join("\n")}`;

/**
 * The only way the composer writes to Contentful: pages are validated against
 * the live design system before any entry is created, and saved as drafts.
 */
export function pageTools(options: PageToolsOptions) {
  const { release } = options;

  async function save(input: unknown) {
    const parsed = PageDocumentSchema.safeParse(input);
    if (!parsed.success) {
      return text(formatIssues(parsed.error.issues.map((i) => ({ path: i.path.join(".") || "page", message: i.message }))));
    }
    const page = parsed.data as PageDocument;
    const issues = validatePage(page, release.registry);
    if (issues.length) return text(formatIssues(issues));
    try {
      const result = await upsertPage(options.contentful, page, release.registry, options.locale);
      options.onSaved?.({ pageId: result.pageId, slug: page.slug, title: page.title, designSystemVersion: release.version });
      return text({
        saved: true,
        status: "draft",
        created: result.created,
        pageId: result.pageId,
        previewUrl: release.storybookUrl ? previewUrl(release.storybookUrl, page.slug, options.previewSigningSecret) : null,
        contentfulUrl: entryEditorUrl(options.spaceId, options.environment, result.pageId),
      });
    } catch (error) {
      if (error instanceof PageValidationError) return text(`Not saved. ${error.message}`);
      throw error;
    }
  }

  const server = createSdkMcpServer({
    name: PIPELINE,
    version: "1.0.0",
    tools: [
      tool(
        "save_page_draft",
        "Validate a page against the design system and save it to Contentful as a draft. Creates the page, or updates the page with this slug. Returns problems to fix, or the saved draft.",
        {
          title: z.string(),
          slug: z.string().describe("kebab-case path without a leading slash, e.g. 'pricing' or 'events/summit-2026'"),
          description: z.string().optional().describe("SEO description, under 160 characters"),
          sections: z.array(z.object(sectionShape)).min(1),
        },
        async (input) => guarded(() => save(input)),
        { alwaysLoad: true },
      ),
      tool(
        "load_page",
        "Load an existing page, drafts included, in the same shape save_page_draft takes.",
        { slug: z.string() },
        async ({ slug }) =>
          guarded(async () => {
            const page = await loadPage(options.contentful, slug, release.registry, options.locale);
            return text(page ?? `No page with slug "${slug}".`);
          }),
        { alwaysLoad: true },
      ),
      tool(
        "search_assets",
        "Search images already in Contentful. Returns asset ids to use as { assetId, alt } image values.",
        { query: z.string().describe("Words to search titles and descriptions for") },
        async ({ query }) =>
          guarded(async () => {
            const result = await options.contentful.asset.getMany({
              query: { query, "fields.file.contentType[match]": "image", limit: 10 },
            });
            if (!result.items.length) return text("No matching images.");
            return text(
              result.items.map((asset) => {
                const size = asset.fields.file?.[options.locale]?.details?.image as { width: number; height: number } | undefined;
                return {
                  assetId: asset.sys.id,
                  title: asset.fields.title?.[options.locale],
                  description: asset.fields.description?.[options.locale],
                  size: size ? `${size.width}x${size.height}` : undefined,
                };
              }),
            );
          }),
        { alwaysLoad: true },
      ),
    ],
  });
  return { server, save };
}
