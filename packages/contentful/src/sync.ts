import type { ContentTypeProps, CreateContentTypeProps, PlainClientAPI } from "contentful-management";
import { RELEASE_CONTENT_TYPE_ID, type ContentTypeDefinition, type Registry } from "@storypage/schema";
import { createContentfulClient, type ContentfulConfig } from "./client.js";
import { planContentModel, withoutLinkValidations, type ContentTypeChange, type ExistingContentType } from "./plan.js";

export interface SyncOptions {
  config: ContentfulConfig;
  registry: Registry;
  changelog?: string;
  diffSummary?: string;
  storybookUrl?: string;
  /**
   * `alias` (default): clone the environment the alias points at into
   * `ds-<version>`, migrate it, then move the alias — instant rollback by
   * pointing the alias back. `in-place`: migrate `config.environment` directly
   * (for spaces without environment aliases).
   */
  strategy?: "alias" | "in-place";
  /**
   * Delete older `ds-*` environments so at most this many remain (alias
   * strategy). Unset keeps everything; spaces have environment limits, so
   * production setups usually set 3.
   */
  keepEnvironments?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface SyncResult {
  environment: string;
  previousEnvironment: string | null;
  changes: ContentTypeChange[];
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

function toCreateProps(definition: ContentTypeDefinition): CreateContentTypeProps {
  return {
    name: definition.name,
    description: definition.description,
    displayField: definition.displayField,
    fields: definition.fields as CreateContentTypeProps["fields"],
  };
}

async function applyChanges(client: PlainClientAPI, changes: ContentTypeChange[], log: (line: string) => void) {
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

async function recordRelease(client: PlainClientAPI, options: SyncOptions, environment: string) {
  const { registry, config } = options;
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

async function pruneEnvironments(client: PlainClientAPI, keep: number, protect: Set<string>, log: (line: string) => void) {
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

/** Syncs Contentful content types to a design-system registry version. */
export async function syncDesignSystem(options: SyncOptions): Promise<SyncResult> {
  const { config, registry } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const strategy = options.strategy ?? "alias";
  const spaceClient = createContentfulClient(config);

  let targetEnvironment = config.environment;
  let previousEnvironment: string | null = null;

  if (strategy === "alias") {
    const alias = await spaceClient.environmentAlias.get({ environmentAliasId: config.environment });
    previousEnvironment = alias.environment.sys.id;
    targetEnvironment = environmentIdFor(registry.version);
    if (targetEnvironment === previousEnvironment) {
      log(`alias ${config.environment} already points at ${targetEnvironment}; re-applying in place`);
    } else if (!options.dryRun) {
      const existing = await spaceClient.environment.getMany({ query: { limit: 100 } });
      if (existing.items.some((e) => e.sys.id === targetEnvironment)) {
        log(`reusing environment ${targetEnvironment}`);
      } else {
        log(`cloning ${previousEnvironment} → ${targetEnvironment}`);
        await spaceClient.environment.createWithId(
          { environmentId: targetEnvironment, sourceEnvironmentId: previousEnvironment },
          { name: `Design system ${registry.version}` },
        );
      }
      await waitForEnvironment(spaceClient, targetEnvironment);
    }
  }

  // In a dry run the new environment doesn't exist yet; plan against the current one.
  const readEnvironment = options.dryRun && previousEnvironment ? previousEnvironment : targetEnvironment;
  const client = createContentfulClient(config, readEnvironment);
  const existing = await client.contentType.getMany({ query: { limit: 1000 } });
  const changes = planContentModel(registry, existing.items as unknown as ExistingContentType[], {
    locale: config.locale,
    storybookUrl: options.storybookUrl,
  });
  for (const change of changes.filter((c) => c.action !== "unchanged")) {
    log(`${options.dryRun ? "[dry run] " : ""}${change.action} ${change.id}: ${change.notes.join("; ")}`);
  }
  if (options.dryRun) return { environment: targetEnvironment, previousEnvironment, changes };

  await applyChanges(client, changes, log);
  await recordRelease(client, options, targetEnvironment);

  if (strategy === "alias" && targetEnvironment !== previousEnvironment) {
    const alias = await spaceClient.environmentAlias.get({ environmentAliasId: config.environment });
    await spaceClient.environmentAlias.update(
      { environmentAliasId: config.environment },
      { ...alias, environment: { sys: { type: "Link", linkType: "Environment", id: targetEnvironment } } },
    );
    log(`alias ${config.environment} → ${targetEnvironment} (rollback: point it back at ${previousEnvironment})`);
    if (options.keepEnvironments !== undefined) {
      const protect = new Set([targetEnvironment, ...(previousEnvironment ? [previousEnvironment] : [])]);
      await pruneEnvironments(spaceClient, options.keepEnvironments, protect, log);
    }
  }
  return { environment: targetEnvironment, previousEnvironment, changes };
}
