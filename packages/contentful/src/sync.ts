import type { ContentTypeProps, CreateContentTypeProps, PlainClientAPI } from "contentful-management";
import {
  PAGE_CONTENT_TYPE_ID,
  RELEASE_CONTENT_TYPE_ID,
  validatePage,
  type ContentTypeDefinition,
  type Registry,
} from "@storypage/schema";
import { createContentfulClient, type ContentfulConfig } from "./client.js";
import { loadPage } from "./pages.js";
import {
  planContentModel,
  withoutLinkValidations,
  type ContentTypeChange,
  type ExistingContentType,
  type FieldMigration,
} from "./plan.js";

/**
 * A design-system release moves Contentful in steps, each usable on its own
 * (the content-stage agent calls them as tools) or chained by
 * `syncDesignSystem` for a run without an agent:
 *
 *   prepareEnvironment → planRelease → applyContentModel
 *     → findPendingMigrations / (agent migrates content) → validateEnvironment
 *     → promoteEnvironment
 *
 * Nothing readers see changes until `promoteEnvironment` moves the alias.
 */

export type Strategy = "alias" | "in-place";
type Log = (line: string) => void;

export interface ReleaseTarget {
  /** The environment being migrated (`ds-<version>` with the alias strategy). */
  environment: string;
  /** Where the alias pointed before this release; the rollback target. */
  previousEnvironment: string | null;
  strategy: Strategy;
}

export const environmentIdFor = (version: string) => `ds-${version.replace(/[^0-9A-Za-z]+/g, "-")}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEnvironment(client: PlainClientAPI, environmentId: string, timeoutMs = 10 * 60_000) {
  const started = Date.now();
  for (;;) {
    const environment = await client.environment.get({ environmentId });
    const status = environment.sys.status?.sys.id;
    if (status === "ready") return;
    if (status === "failed") throw new Error(`Environment ${environmentId} failed to clone`);
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for environment ${environmentId}`);
    await sleep(3000);
  }
}

/** Clones the alias target into `ds-<version>` (alias strategy) and waits for it. */
export async function prepareEnvironment(
  config: ContentfulConfig,
  version: string,
  options: { strategy?: Strategy; dryRun?: boolean; log?: Log } = {},
): Promise<ReleaseTarget> {
  const strategy = options.strategy ?? "alias";
  const log = options.log ?? (() => {});
  if (strategy === "in-place") return { environment: config.environment, previousEnvironment: null, strategy };

  const spaceClient = createContentfulClient(config);
  const alias = await spaceClient.environmentAlias.get({ environmentAliasId: config.environment });
  const previousEnvironment = alias.environment.sys.id;
  const environment = environmentIdFor(version);
  if (environment === previousEnvironment) {
    log(`alias ${config.environment} already points at ${environment}; re-applying in place`);
  } else if (!options.dryRun) {
    const existing = await spaceClient.environment.getMany({ query: { limit: 100 } });
    if (existing.items.some((e) => e.sys.id === environment)) {
      log(`reusing environment ${environment}`);
    } else {
      log(`cloning ${previousEnvironment} → ${environment}`);
      await spaceClient.environment.createWithId(
        { environmentId: environment, sourceEnvironmentId: previousEnvironment },
        { name: `Design system ${version}` },
      );
    }
    await waitForEnvironment(spaceClient, environment);
  }
  return { environment, previousEnvironment, strategy };
}

/** In a dry run the new environment may not exist yet, so read the current one. */
function readEnvironment(target: ReleaseTarget, dryRun?: boolean): string {
  return dryRun && target.previousEnvironment ? target.previousEnvironment : target.environment;
}

export async function planRelease(
  config: ContentfulConfig,
  target: ReleaseTarget,
  registry: Registry,
  options: { storybookUrl?: string | undefined; dryRun?: boolean } = {},
): Promise<ContentTypeChange[]> {
  const client = createContentfulClient(config, readEnvironment(target, options.dryRun));
  const existing = await client.contentType.getMany({ query: { limit: 1000 } });
  return planContentModel(registry, existing.items as unknown as ExistingContentType[], {
    locale: config.locale,
    storybookUrl: options.storybookUrl,
  });
}

function toCreateProps(definition: ContentTypeDefinition): CreateContentTypeProps {
  return {
    name: definition.name,
    description: definition.description,
    displayField: definition.displayField,
    fields: definition.fields as CreateContentTypeProps["fields"],
  };
}

/** Applies a plan to the target environment. Never deletes fields, types or entries. */
export async function applyContentModel(
  config: ContentfulConfig,
  target: ReleaseTarget,
  changes: ContentTypeChange[],
  log: Log = () => {},
): Promise<void> {
  const client = createContentfulClient(config, target.environment);
  const live = new Map<string, ContentTypeProps>();

  // Pass 1: create new types without entry-link validations, so types can
  // reference each other (and themselves) regardless of creation order.
  for (const change of changes.filter((c) => c.action === "create")) {
    const created = await client.contentType.createWithId(
      { contentTypeId: change.id },
      toCreateProps(withoutLinkValidations(change.definition)),
    );
    live.set(change.id, await client.contentType.publish({ contentTypeId: change.id }, created));
    log(`created ${change.id}`);
  }

  // Pass 2: bring every changed type to its full definition.
  for (const change of changes.filter((c) => c.action !== "unchanged")) {
    const current = live.get(change.id) ?? (await client.contentType.get({ contentTypeId: change.id }));
    const updated = await client.contentType.update(
      { contentTypeId: change.id },
      { ...current, ...toCreateProps(change.definition) },
    );
    await client.contentType.publish({ contentTypeId: change.id }, updated);
    log(`${change.action === "create" ? "linked" : change.action === "deprecate" ? "deprecated" : "updated"} ${change.id}${change.notes.length ? ` (${change.notes.join("; ")})` : ""}`);
  }
}

export interface PendingMigration extends FieldMigration {
  /** Entries with content in `fromField` and (for kind changes) nothing in `toField` yet. */
  entries: { id: string; published: boolean; value: unknown }[];
}

const hasValue = (value: unknown) =>
  value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);

/**
 * Lists the entries whose content a schema change stranded in a hidden field.
 * For `kindChanged` migrations, an entry is done once its new field has a value.
 */
export async function findPendingMigrations(
  config: ContentfulConfig,
  target: ReleaseTarget,
  migrations: FieldMigration[],
): Promise<PendingMigration[]> {
  const client = createContentfulClient(config, target.environment);
  const pending: PendingMigration[] = [];
  for (const migration of migrations) {
    const entries: PendingMigration["entries"] = [];
    for (let skip = 0; ; skip += 100) {
      const page = await client.entry.getMany({
        query: { content_type: migration.contentTypeId, [`fields.${migration.fromField}[exists]`]: true, limit: 100, skip },
      });
      for (const entry of page.items) {
        const from = entry.fields[migration.fromField]?.[config.locale];
        const to = migration.toField ? entry.fields[migration.toField]?.[config.locale] : undefined;
        if (hasValue(from) && !hasValue(to)) {
          entries.push({ id: entry.sys.id, published: entry.sys.publishedVersion !== undefined, value: from });
        }
      }
      if (page.items.length < 100) break;
    }
    if (entries.length) pending.push({ ...migration, entries });
  }
  return pending;
}

export interface EnvironmentReport {
  pages: number;
  issues: { slug: string; path: string; message: string }[];
}

/** Loads every page in the environment and validates it against the registry. */
export async function validateEnvironment(
  config: ContentfulConfig,
  target: ReleaseTarget,
  registry: Registry,
): Promise<EnvironmentReport> {
  const client = createContentfulClient(config, target.environment);
  const report: EnvironmentReport = { pages: 0, issues: [] };
  for (let skip = 0; ; skip += 100) {
    const pages = await client.entry.getMany({ query: { content_type: PAGE_CONTENT_TYPE_ID, limit: 100, skip } });
    for (const entry of pages.items) {
      const slug = String(entry.fields.slug?.[config.locale] ?? entry.sys.id);
      report.pages += 1;
      const page = await loadPage(client, slug, registry, config.locale);
      if (!page) continue;
      const declared = Array.isArray(entry.fields.sections?.[config.locale]) ? entry.fields.sections[config.locale].length : 0;
      if (page.sections.length < declared) {
        report.issues.push({
          slug,
          path: "sections",
          message: `${declared - page.sections.length} section(s) use components that are no longer in the design system and will not render`,
        });
      }
      if (page.sections.length) {
        for (const issue of validatePage(page, registry)) report.issues.push({ slug, ...issue });
      }
    }
    if (pages.items.length < 100) break;
  }
  return report;
}

export interface PromoteOptions {
  changelog?: string | undefined;
  diffSummary?: string | undefined;
  storybookUrl?: string | undefined;
  /** Delete older `ds-*` environments so at most this many remain. Unset keeps all. */
  keepEnvironments?: number | undefined;
  log?: Log;
}

async function recordRelease(client: PlainClientAPI, config: ContentfulConfig, registry: Registry, environment: string, options: PromoteOptions) {
  const field = <T>(value: T) => ({ [config.locale]: value });
  const existing = await client.entry.getMany({
    query: { content_type: RELEASE_CONTENT_TYPE_ID, "fields.version": registry.version, limit: 1 },
  });
  const fields = {
    version: field(registry.version),
    changelog: field(options.changelog ?? ""),
    diff: field(options.diffSummary ?? ""),
    storybookUrl: field(options.storybookUrl ?? ""),
    environment: field(environment),
    registry: field(registry),
  };
  const entry = existing.items[0]
    ? await client.entry.update({ entryId: existing.items[0].sys.id }, { ...existing.items[0], fields })
    : await client.entry.create({ contentTypeId: RELEASE_CONTENT_TYPE_ID }, { fields });
  await client.entry.publish({ entryId: entry.sys.id }, entry);
}

async function pruneEnvironments(client: PlainClientAPI, keep: number, protect: Set<string>, log: Log) {
  const environments = await client.environment.getMany({ query: { limit: 100 } });
  const ours = environments.items
    .filter((e) => e.sys.id.startsWith("ds-") && !protect.has(e.sys.id))
    .sort((a, b) => b.sys.createdAt.localeCompare(a.sys.createdAt));
  const protectedCount = [...protect].filter((id) => id.startsWith("ds-")).length;
  for (const environment of ours.slice(Math.max(0, keep - protectedCount))) {
    await client.environment.delete({ environmentId: environment.sys.id });
    log(`deleted old environment ${environment.sys.id}`);
  }
}

/** Records the release in the target environment and points the alias at it. */
export async function promoteEnvironment(
  config: ContentfulConfig,
  target: ReleaseTarget,
  registry: Registry,
  options: PromoteOptions = {},
): Promise<void> {
  const log = options.log ?? (() => {});
  await recordRelease(createContentfulClient(config, target.environment), config, registry, target.environment, options);
  if (target.strategy !== "alias" || target.environment === target.previousEnvironment) return;

  const spaceClient = createContentfulClient(config);
  const alias = await spaceClient.environmentAlias.get({ environmentAliasId: config.environment });
  await spaceClient.environmentAlias.update(
    { environmentAliasId: config.environment },
    { ...alias, environment: { sys: { type: "Link", linkType: "Environment", id: target.environment } } },
  );
  log(`alias ${config.environment} → ${target.environment} (rollback: point it back at ${target.previousEnvironment})`);
  if (options.keepEnvironments !== undefined) {
    const protect = new Set([target.environment, ...(target.previousEnvironment ? [target.previousEnvironment] : [])]);
    await pruneEnvironments(spaceClient, options.keepEnvironments, protect, log);
  }
}

export interface SyncOptions extends PromoteOptions {
  config: ContentfulConfig;
  registry: Registry;
  strategy?: Strategy;
  dryRun?: boolean;
}

export interface SyncResult extends ReleaseTarget {
  changes: ContentTypeChange[];
}

/**
 * The whole release without an agent: schema changes only, no content
 * migration. Stranded content stays in hidden fields for a human to move.
 */
export async function syncDesignSystem(options: SyncOptions): Promise<SyncResult> {
  const { config, registry } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const target = await prepareEnvironment(config, registry.version, {
    ...(options.strategy ? { strategy: options.strategy } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    log,
  });
  const changes = await planRelease(config, target, registry, { storybookUrl: options.storybookUrl, dryRun: options.dryRun ?? false });
  for (const change of changes.filter((c) => c.action !== "unchanged")) {
    log(`${options.dryRun ? "[dry run] " : ""}${change.action} ${change.id}: ${change.notes.join("; ")}`);
  }
  if (options.dryRun) return { ...target, changes };
  await applyContentModel(config, target, changes, log);
  await promoteEnvironment(config, target, registry, { ...options, log });
  return { ...target, changes };
}
