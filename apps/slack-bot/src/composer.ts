import {
  CONTENTFUL,
  contentfulScope,
  contentfulServer,
  CONTENTFUL_READ_TOOLS,
  PAGE_TOOLS,
  pageTools,
  PIPELINE,
  runStage,
  STORYBOOK,
  storybookServer,
  STORYBOOK_DOCS_TOOLS,
  type SavedDraft,
} from "@storypage/agents";
import type { ContentfulConfig, LiveRelease, PlainClientAPI } from "@storypage/contentful";

const INSTRUCTIONS = `You are StoryPage, a page-building assistant in Slack. You create and edit web pages in Contentful using only the components of the company design system. Every component is designed in Figma and implemented and tested in Storybook, so a page made of them is on-brand by construction.

Your tools:
- pipeline: save_page_draft (the only way to write a page), load_page, search_assets.
- storybook: docs-list / docs-show / docs-show-story, to see what each component looks like in use, its props and good examples. Check them before choosing components you haven't used in this conversation.
- contentful (read-only, live content): search_entries, get_entry and friends, to look at existing pages and content when the person refers to them.

How to work:
- Work out what the person wants: the page's purpose, audience, key messages, call to action and URL slug. If the request is too vague to produce a useful page (for example, no topic at all), ask up to three short questions instead of guessing. Otherwise make sensible assumptions and mention them briefly.
- A page is a list of sections. Only components with placement "section" can be sections. A slot prop accepts only the components in its allowedComponents and holds nested blocks shaped like { "component": "...", "props": { ... } }; a slot with multiple: true takes a list. Fill every required prop, use enum options exactly as listed, and leave out props that are not editable.
- Write real, specific copy in the company's voice, never placeholder text. Keep headlines short. "text" props are limited to 255 characters. "richText" props take Markdown (## to #### headings, lists, bold, italic, links).
- Images: search_assets and reference a suitable asset by assetId. Use an image URL only if the person gave you one. Never invent image URLs; leave optional images out when nothing fits.
- Links: use site-relative paths such as /pricing unless the person gave a full URL.
- To change an existing page, load_page first and keep everything the person did not ask to change.
- Save with save_page_draft. If it reports problems, fix them and save again. Saving creates a draft; a person publishes it with the Publish button, so never say the page is live.
- After saving, reply in Slack mrkdwn: one sentence on what you built, then a bullet per section. Don't include links; the app adds Preview, Contentful and Publish buttons.`;

export interface ComposeContext {
  contentful: PlainClientAPI;
  config: ContentfulConfig;
  release: LiveRelease;
  previewSigningSecret: string;
  /** Storybook docs MCP for the release's Storybook, if it could be started. */
  storybookDocsUrl?: string | undefined;
  /** Directory the agent sessions run in (and are resumed from). */
  workDir: string;
  model?: string | undefined;
}

export interface ComposeResult {
  reply: string;
  sessionId: string | null;
  draft?: SavedDraft | undefined;
}

/**
 * One Slack turn: a new or resumed Agent SDK session with the design system's
 * tools. Contentful is reachable read-only through its MCP server; writes go
 * only through save_page_draft, which validates against the live design system.
 */
export async function compose(ctx: ComposeContext, sessionId: string | undefined, userMessage: string): Promise<ComposeResult> {
  let draft: SavedDraft | undefined;
  const pages = pageTools({
    contentful: ctx.contentful,
    release: ctx.release,
    spaceId: ctx.config.spaceId,
    environment: ctx.config.environment,
    locale: ctx.config.locale,
    previewSigningSecret: ctx.previewSigningSecret,
    onSaved: (saved) => {
      draft = saved;
    },
  });

  const result = await runStage({
    name: "compose",
    persona: "custom",
    cwd: ctx.workDir,
    instructions: `${INSTRUCTIONS}\n\nDesign system ${ctx.release.registry.name}@${ctx.release.version}. Components:\n${JSON.stringify(ctx.release.registry.components)}`,
    prompt: userMessage,
    resume: sessionId,
    mcpServers: {
      [PIPELINE]: pages.server,
      [CONTENTFUL]: contentfulServer({
        managementToken: ctx.config.managementToken,
        spaceId: ctx.config.spaceId,
        environment: ctx.config.environment,
        protectedEnvironments: [ctx.config.environment, ...(ctx.release.environment ? [ctx.release.environment] : [])],
      }),
      ...(ctx.storybookDocsUrl ? { [STORYBOOK]: storybookServer(ctx.storybookDocsUrl) } : {}),
    },
    tools: [...Object.values(PAGE_TOOLS), ...CONTENTFUL_READ_TOOLS, ...(ctx.storybookDocsUrl ? STORYBOOK_DOCS_TOOLS : [])],
    checks: contentfulScope(ctx.config.spaceId, ctx.config.environment),
    ...(ctx.model ? { model: ctx.model } : {}),
    // Medium keeps Slack replies quick; raise it if page quality needs it.
    effort: "medium",
    maxTurns: 40,
    maxBudgetUsd: 3,
    log: () => {},
  });

  const reply = result.success
    ? result.summary || (draft ? `Saved a draft of *${draft.title}*.` : "Done.")
    : `Sorry, I couldn't finish that (${result.summary}).${draft ? ` The last saved draft is *${draft.title}*.` : ""}`;
  return { reply, sessionId: result.sessionId, draft };
}
