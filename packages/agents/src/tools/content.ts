import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  applyContentModel,
  findPendingMigrations,
  planRelease,
  promoteEnvironment,
  validateEnvironment,
  type ContentfulConfig,
  type ContentTypeChange,
  type FieldMigration,
  type PromoteOptions,
  type ReleaseTarget,
} from "@storypage/contentful";
import { markdownToRichText, type Registry } from "@storypage/schema";
import { mcpTool, PIPELINE } from "../mcp.js";
import { guarded, text } from "./result.js";

export interface ContentToolsOptions {
  config: ContentfulConfig;
  target: ReleaseTarget;
  registry: Registry;
  promote: PromoteOptions;
}

/** What the content stage did, read by the harness after the agent finishes. */
export interface ContentStageState {
  applied: ContentTypeChange[] | null;
  promoted: boolean;
}

export const CONTENT_TOOLS = {
  plan: mcpTool(PIPELINE, "plan_content_model"),
  apply: mcpTool(PIPELINE, "apply_content_model"),
  pending: mcpTool(PIPELINE, "list_pending_migrations"),
  richText: mcpTool(PIPELINE, "markdown_to_rich_text"),
  validate: mcpTool(PIPELINE, "validate_environment"),
  promote: mcpTool(PIPELINE, "promote_environment"),
};

const summarize = (changes: ContentTypeChange[]) =>
  changes
    .filter((c) => c.action !== "unchanged")
    .map((c) => ({ contentType: c.id, action: c.action, notes: c.notes, migrations: c.migrations }));

/**
 * Pipeline tools for the content stage. Schema changes only happen through
 * the deterministic planner here (the Contentful MCP server's content-type
 * tools are not available to the agent), and the alias only moves through
 * `promote_environment`, which refuses while content is stranded or pages
 * don't validate.
 */
export function contentTools(options: ContentToolsOptions) {
  const { config, target, registry } = options;
  const state: ContentStageState = { applied: null, promoted: false };
  // Migrations come from diffing the *live* environment against the registry,
  // so a re-run still finds content stranded by an earlier, interrupted run.
  let liveMigrations: Promise<FieldMigration[]> | null = null;
  const migrations = (): Promise<FieldMigration[]> => {
    if (!target.previousEnvironment || target.previousEnvironment === target.environment) {
      return Promise.resolve((state.applied ?? []).flatMap((c) => c.migrations));
    }
    liveMigrations ??= planRelease(config, target, registry, { dryRun: true }).then((changes) => changes.flatMap((c) => c.migrations));
    return liveMigrations;
  };

  const server = createSdkMcpServer({
    name: PIPELINE,
    version: "1.0.0",
    tools: [
      tool(
        "plan_content_model",
        `Preview the content-type changes design-system@${registry.version} needs in environment ${target.environment}, without changing anything.`,
        {},
        async () => guarded(async () => text(summarize(await planRelease(config, target, registry, { storybookUrl: options.promote.storybookUrl })))),
        { alwaysLoad: true },
      ),
      tool(
        "apply_content_model",
        `Apply the content-type changes to environment ${target.environment}. Never deletes: removed props become hidden fields and type changes get a new <prop>V<major> field. Safe to call again.`,
        {},
        async () =>
          guarded(async () => {
            const changes = await planRelease(config, target, registry, { storybookUrl: options.promote.storybookUrl });
            await applyContentModel(config, target, changes);
            state.applied = changes;
            return text({ applied: summarize(changes), pendingMigrations: await findPendingMigrations(config, target, await migrations()) });
          }),
        { alwaysLoad: true },
      ),
      tool(
        "list_pending_migrations",
        "Entries whose content a schema change left in a hidden field: for kind changes, entries whose new field is still empty; for removed props, entries that still hold a value. Includes each old value and whether the entry was published.",
        {},
        async () =>
          guarded(async () => {
            if (!state.applied) return text("Call apply_content_model first.");
            return text(await findPendingMigrations(config, target, await migrations()));
          }),
        { alwaysLoad: true },
      ),
      tool(
        "markdown_to_rich_text",
        "Convert Markdown (or plain text) into a Contentful Rich Text document, for moving text into a RichText field.",
        { markdown: z.string() },
        async ({ markdown }) => text(markdownToRichText(markdown)),
        { alwaysLoad: true },
      ),
      tool(
        "validate_environment",
        "Load every page in the environment and check it against the design system: props that no longer validate, and sections whose component was removed.",
        {},
        async () => guarded(async () => text(await validateEnvironment(config, target, registry))),
        { alwaysLoad: true },
      ),
      tool(
        "promote_environment",
        `Make ${target.environment} live: record the release and point the "${config.environment}" alias at it. Refused while kind-change migrations are pending or pages fail validation.`,
        {},
        async () =>
          guarded(async () => {
            if (!state.applied) return text("Not promoted: call apply_content_model first.");
            const pending = (await findPendingMigrations(config, target, await migrations())).filter((m) => m.reason === "kindChanged");
            const report = await validateEnvironment(config, target, registry);
            const blocking = report.issues.filter((i) => !i.message.includes("no longer in the design system"));
            if (pending.length || blocking.length) {
              return text({
                promoted: false,
                reason: "Content would be lost or pages would break. Fix these, then try again.",
                pendingMigrations: pending.map((m) => ({ contentType: m.contentTypeId, from: m.fromField, to: m.toField, entries: m.entries.map((e) => e.id) })),
                invalidPages: blocking,
              });
            }
            await promoteEnvironment(config, target, registry, options.promote);
            state.promoted = true;
            return text({ promoted: true, environment: target.environment, rollback: target.previousEnvironment, warnings: report.issues });
          }),
        { alwaysLoad: true },
      ),
    ],
  });
  return { server, state };
}
