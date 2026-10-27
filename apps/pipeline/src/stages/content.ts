import {
  CONTENT_TOOLS,
  CONTENTFUL,
  contentfulServer,
  CONTENTFUL_ENTRY_EDIT_TOOLS,
  CONTENTFUL_READ_TOOLS,
  contentfulScope,
  contentTools,
  PIPELINE,
  runStage,
  STORYBOOK,
  storybookServer,
  STORYBOOK_DOCS_TOOLS,
  type ContentStageState,
  type StageResult,
} from "@storypage/agents";
import type { ContentfulConfig, PromoteOptions, ReleaseTarget } from "@storypage/contentful";
import type { Registry } from "@storypage/schema";
import { z } from "zod";

export const ContentReport = z.object({
  promoted: z.boolean(),
  migrated: z.array(
    z.object({
      contentType: z.string(),
      from: z.string(),
      to: z.string().nullable(),
      entries: z.number().int(),
      how: z.string().describe("How values were converted"),
    }),
  ),
  needsHumanAttention: z.array(z.string()).describe("Content you could not migrate safely, pages using removed components, anything an editor should check"),
  summary: z.string(),
});
export type ContentReport = z.infer<typeof ContentReport>;

function instructions(target: ReleaseTarget, alias: string): string {
  return `
You are the content migration engineer in an automated Figma → Storybook → Contentful pipeline. A new
design-system version was merged and deployed. Bring the Contentful content model and the existing content
along with it, in environment "${target.environment}", then make it live.

Nothing you do is visible to readers until promote_environment moves the "${alias}" alias${
    target.previousEnvironment ? ` (now on "${target.previousEnvironment}", which stays as the rollback)` : ""
  }.

Your tools:
- pipeline: plan_content_model, apply_content_model, list_pending_migrations, markdown_to_rich_text,
  validate_environment, promote_environment. Content types change only through apply_content_model.
- contentful (scoped to "${target.environment}"): read content types, entries and assets; update_entry and
  publish_entry to migrate content. You cannot create or delete content types, entries or environments.
- storybook: docs-list / docs-show to understand what each component and prop means.

How to work:
1. plan_content_model, then apply_content_model.
2. For every pending migration of a kind change, move each entry's old value into the new field,
   converting it to the new type (text → rich text with markdown_to_rich_text, enum values to the
   closest new option, and so on). Fetch the entry with get_entry, send the full updated entry with
   update_entry, and publish_entry it again if it was published before. Never discard content.
3. Removed props and removed components: don't delete anything. Note where editors should check.
4. validate_environment, fix what you can (for example props that no longer validate), and repeat.
5. promote_environment. If it refuses, fix what it lists and try again. If something can't be fixed
   safely, don't promote: explain why in the report.
`.trim();
}

export interface ContentStageOptions {
  repoRoot: string;
  config: ContentfulConfig;
  target: ReleaseTarget;
  registry: Registry;
  promote: PromoteOptions;
  /** Storybook docs MCP (served from the deployed Storybook), if available. */
  storybookDocsUrl?: string | undefined;
  log?: (line: string) => void;
}

export async function runContentStage(
  options: ContentStageOptions,
): Promise<{ result: StageResult<ContentReport>; state: ContentStageState }> {
  const log = options.log ?? ((line: string) => console.log(`[content] ${line}`));
  const pipeline = contentTools({
    config: options.config,
    target: options.target,
    registry: options.registry,
    promote: options.promote,
  });
  const result = await runStage({
    name: "content",
    cwd: options.repoRoot,
    instructions: instructions(options.target, options.config.environment),
    prompt: `Release design-system ${options.registry.version} to Contentful.${options.promote.changelog ? ` Changelog: ${options.promote.changelog}` : ""}`,
    mcpServers: {
      [PIPELINE]: pipeline.server,
      [CONTENTFUL]: contentfulServer({
        managementToken: options.config.managementToken,
        spaceId: options.config.spaceId,
        environment: options.target.environment,
        // With the alias strategy the live environment is read-only to the agent.
        protectedEnvironments:
          options.target.strategy === "alias" && options.target.environment !== options.target.previousEnvironment
            ? [options.config.environment, ...(options.target.previousEnvironment ? [options.target.previousEnvironment] : [])]
            : [],
      }),
      ...(options.storybookDocsUrl ? { [STORYBOOK]: storybookServer(options.storybookDocsUrl) } : {}),
    },
    tools: [
      ...Object.values(CONTENT_TOOLS),
      ...CONTENTFUL_READ_TOOLS,
      ...CONTENTFUL_ENTRY_EDIT_TOOLS,
      ...(options.storybookDocsUrl ? STORYBOOK_DOCS_TOOLS : []),
    ],
    checks: contentfulScope(options.config.spaceId, options.target.environment),
    output: ContentReport,
    effort: "high",
    maxTurns: 300,
    log,
  });
  return { result, state: pipeline.state };
}
