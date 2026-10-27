import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import {
  entryEditorUrl,
  loadPage,
  PageValidationError,
  upsertPage,
  type LiveRelease,
  type PlainClientAPI,
} from "@storypage/contentful";
import { PageDocumentSchema, validatePage, type PageDocument } from "@storypage/schema";
import type { Draft } from "./conversations.js";
import { previewUrl } from "./release.js";

const INSTRUCTIONS = `You are StoryPage, a page-building assistant in Slack. You create and edit web pages in Contentful using only the components of the company design system. Every component is designed in Figma and implemented and tested in Storybook, so a page made of them is on-brand by construction.

How to work:
- Work out what the person wants: the page's purpose, audience, key messages, call to action and URL slug. If the request is too vague to produce a useful page (for example, no topic at all), ask up to three short questions instead of guessing. Otherwise make sensible assumptions and mention them briefly.
- A page is a list of sections. Only components with placement "section" can be sections. A slot prop accepts only the components in its allowedComponents and contains nested blocks shaped like { "component": "...", "props": { ... } }; a slot with multiple: true takes a list of them. Fill every required prop, use enum options exactly as listed, and leave out props that are not editable.
- Write real, specific copy in the company's voice, never placeholder text. Keep headlines short. "text" props are limited to 255 characters. "richText" props take Markdown (## to #### headings, lists, bold, italic, links).
- Images: call search_assets and reference a suitable asset by its assetId. Use an image URL only if the person gave you one. Never invent image URLs; leave optional images out when nothing fits.
- Links: use site-relative paths such as /pricing unless the person gave a full URL.
- To change an existing page, call load_page first and keep everything the person did not ask to change.
- Save with save_page_draft. If it reports validation problems, fix them and save again. Saving creates a draft; a person publishes it with the Publish button, so never say the page is live.
- After saving, reply in Slack mrkdwn: one sentence on what you built, then a bullet per section. Don't include links; the app adds Preview, Contentful and Publish buttons.`;

function systemPrompt(release: LiveRelease): Anthropic.Beta.BetaTextBlockParam[] {
  return [
    { type: "text", text: INSTRUCTIONS },
    {
      type: "text",
      text: `Design system ${release.registry.name}@${release.version}. Components:\n${JSON.stringify(release.registry.components)}`,
      // The registry only changes on a design-system release, so cache everything up to here.
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
}

const BlockInput = z
  .object({
    component: z.string().describe("Component name from the design system"),
    props: z
      .record(z.string(), z.unknown())
      .describe("Prop values. Slot props hold nested { component, props } blocks (or a list of them)."),
  })
  .describe("A component block");

export const SavePageInput = z.object({
  title: z.string().describe("Page title"),
  slug: z.string().describe("kebab-case URL path without a leading slash, e.g. 'pricing' or 'events/summit-2026'"),
  description: z.string().optional().describe("SEO meta description, under 160 characters"),
  sections: z.array(BlockInput).min(1),
});

export interface ComposeContext {
  anthropic: Anthropic;
  contentful: PlainClientAPI;
  release: LiveRelease;
  spaceId: string;
  environment: string;
  locale: string;
  model: string;
}

export interface ComposeResult {
  reply: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  draft?: Draft | undefined;
}

export function createTools(ctx: ComposeContext, onSaved: (draft: Draft) => void) {
  const { release } = ctx;

  const savePageDraft = betaZodTool({
    name: "save_page_draft",
    description:
      "Validate the page against the design system and save it to Contentful as a draft. Creates the page, or updates the page that already has this slug. Returns validation problems to fix, or the saved draft.",
    inputSchema: SavePageInput,
    run: async (input) => {
      const parsed = PageDocumentSchema.safeParse(input);
      if (!parsed.success) {
        return `Not saved. Fix these problems and call save_page_draft again:\n${parsed.error.issues
          .map((i) => `- ${i.path.join(".") || "page"}: ${i.message}`)
          .join("\n")}`;
      }
      const page = parsed.data as PageDocument;
      const issues = validatePage(page, release.registry);
      if (issues.length) {
        return `Not saved. Fix these problems and call save_page_draft again:\n${issues.map((i) => `- ${i.path}: ${i.message}`).join("\n")}`;
      }
      try {
        const result = await upsertPage(ctx.contentful, page, release.registry, ctx.locale);
        onSaved({ pageId: result.pageId, slug: page.slug, title: page.title, designSystemVersion: release.version });
        return JSON.stringify({
          saved: true,
          status: "draft",
          created: result.created,
          pageId: result.pageId,
          previewUrl: release.storybookUrl ? previewUrl(release.storybookUrl, page.slug) : null,
          contentfulUrl: entryEditorUrl(ctx.spaceId, ctx.environment, result.pageId),
        });
      } catch (error) {
        if (error instanceof PageValidationError) return `Not saved. ${error.message}`;
        throw error;
      }
    },
  });

  const loadPageTool = betaZodTool({
    name: "load_page",
    description: "Load an existing page (including drafts) by slug, as the same structure save_page_draft takes.",
    inputSchema: z.object({ slug: z.string() }),
    run: async ({ slug }) => {
      const page = await loadPage(ctx.contentful, slug, release.registry, ctx.locale);
      return page ? JSON.stringify(page) : `No page with slug "${slug}".`;
    },
  });

  const searchAssets = betaZodTool({
    name: "search_assets",
    description: "Search images already uploaded to Contentful. Returns asset ids to use as { assetId, alt } image values.",
    inputSchema: z.object({ query: z.string().describe("Words to search titles and descriptions for") }),
    run: async ({ query }) => {
      const result = await ctx.contentful.asset.getMany({
        query: { query, "fields.file.contentType[match]": "image", limit: 10 },
      });
      if (!result.items.length) return "No matching images.";
      return JSON.stringify(
        result.items.map((asset) => {
          const image = asset.fields.file?.[ctx.locale]?.details?.image as { width: number; height: number } | undefined;
          return {
            assetId: asset.sys.id,
            title: asset.fields.title?.[ctx.locale],
            description: asset.fields.description?.[ctx.locale],
            size: image ? `${image.width}x${image.height}` : undefined,
          };
        }),
      );
    },
  });

  return [savePageDraft, loadPageTool, searchAssets];
}

function finalText(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Runs one Slack turn: the thread's history plus the new message, through
 * Claude with the page tools, until Claude replies.
 */
export async function compose(
  ctx: ComposeContext,
  history: Anthropic.Beta.BetaMessageParam[],
  userMessage: string,
): Promise<ComposeResult> {
  let draft: Draft | undefined;
  const runner = ctx.anthropic.beta.messages.toolRunner({
    model: ctx.model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    // Medium keeps Slack replies quick; raise to "high" if page quality needs it.
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: systemPrompt(ctx.release),
    tools: createTools(ctx, (saved) => {
      draft = saved;
    }),
    messages: [...history, { role: "user", content: userMessage }],
    max_iterations: 12,
    // Send the full history each turn: the Slack thread, not the API, owns the conversation.
    thread: false,
  });
  const final = await runner.runUntilDone();

  const messages = [...runner.params.messages];
  const last = messages.at(-1);
  if (last?.role !== "assistant") messages.push({ role: "assistant", content: final.content });

  let reply: string;
  if (final.stop_reason === "refusal") {
    reply = "Sorry, I can't help with that request.";
  } else {
    reply = finalText(final) || (draft ? `Saved a draft of *${draft.title}*.` : "Done.");
  }
  return { reply, messages, draft };
}
