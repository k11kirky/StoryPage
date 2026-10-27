import type { ContentTypeProps, EntryProps, PlainClientAPI } from "contentful-management";
import {
  contentTypeIdFor,
  editableProps,
  findComponent,
  INTERNAL_NAME_FIELD,
  PAGE_CONTENT_TYPE_ID,
  pageFromDelivery,
  RELEASE_CONTENT_TYPE_ID,
  resolveFieldId,
  toRichTextDocument,
  validatePage,
  type Block,
  type DeliveryAsset,
  type DeliveryEntry,
  type ImageValue,
  type PageDocument,
  type Registry,
} from "@storypage/schema";

type Link<T extends "Entry" | "Asset"> = { sys: { type: "Link"; linkType: T; id: string } };
const link = <T extends "Entry" | "Asset">(linkType: T, id: string): Link<T> => ({ sys: { type: "Link", linkType, id } });

export interface LiveRelease {
  version: string;
  registry: Registry;
  storybookUrl: string;
  environment: string;
}

/** The design-system release currently synced into this environment. */
export async function getLiveRelease(client: PlainClientAPI, locale: string): Promise<LiveRelease | null> {
  const result = await client.entry.getMany({
    query: { content_type: RELEASE_CONTENT_TYPE_ID, order: "-sys.createdAt", limit: 1 },
  });
  const entry = result.items[0];
  if (!entry) return null;
  const get = (field: string) => (entry.fields[field] as Record<string, unknown> | undefined)?.[locale];
  return {
    version: String(get("version")),
    registry: get("registry") as Registry,
    storybookUrl: String(get("storybookUrl") ?? ""),
    environment: String(get("environment") ?? ""),
  };
}

export class PageValidationError extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(`Page does not match the design system:\n${issues.map((i) => `- ${i.path}: ${i.message}`).join("\n")}`);
    this.name = "PageValidationError";
  }
}

export interface UpsertPageResult {
  pageId: string;
  created: boolean;
  entryIds: string[];
}

interface WriteContext {
  client: PlainClientAPI;
  registry: Registry;
  locale: string;
  slug: string;
  contentTypes: Map<string, Promise<ContentTypeProps>>;
  entryIds: string[];
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

async function writeImage(ctx: WriteContext, image: ImageValue): Promise<Link<"Asset">> {
  if (image.assetId) return link("Asset", image.assetId);
  const url = new URL(image.url!);
  const fileName = url.pathname.split("/").pop() || "image";
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const loc = <T>(value: T) => ({ [ctx.locale]: value });
  const asset = await ctx.client.asset.create(
    {},
    {
      fields: {
        title: loc(image.alt || fileName),
        description: loc(image.alt),
        file: loc({ contentType: MIME_BY_EXTENSION[extension] ?? "image/jpeg", fileName, upload: url.toString() }),
      },
    },
  );
  const processed = await ctx.client.asset.processForAllLocales({}, asset);
  await ctx.client.asset.publish({ assetId: processed.sys.id }, processed);
  return link("Asset", processed.sys.id);
}

async function writeBlock(ctx: WriteContext, block: Block, label: string): Promise<Link<"Entry">> {
  const contract = findComponent(ctx.registry, block.component);
  if (!contract) throw new Error(`Unknown component ${block.component}`);
  const contentTypeId = contentTypeIdFor(contract.name);
  if (!ctx.contentTypes.has(contentTypeId)) {
    ctx.contentTypes.set(contentTypeId, ctx.client.contentType.get({ contentTypeId }));
  }
  const contentType = await ctx.contentTypes.get(contentTypeId)!;
  const loc = <T>(value: T) => ({ [ctx.locale]: value });

  const fields: Record<string, Record<string, unknown>> = {
    [INTERNAL_NAME_FIELD]: loc(`${ctx.slug} › ${label}`.slice(0, 255)),
  };
  for (const prop of editableProps(contract)) {
    const value = block.props[prop.name];
    if (value === undefined || value === null) continue;
    const fieldId = resolveFieldId(contentType.fields, prop.name);
    if (!fieldId) {
      throw new Error(`Content type ${contentTypeId} has no field for ${prop.name}; run the Contentful sync for design-system@${ctx.registry.version}`);
    }
    switch (prop.kind) {
      case "slot":
        if (Array.isArray(value)) {
          const links: Link<"Entry">[] = [];
          for (const [i, child] of value.entries()) links.push(await writeBlock(ctx, child, `${label} › ${prop.name}[${i}]`));
          fields[fieldId] = loc(links);
        } else {
          fields[fieldId] = loc(await writeBlock(ctx, value as Block, `${label} › ${prop.name}`));
        }
        break;
      case "image":
        fields[fieldId] = loc(await writeImage(ctx, value as ImageValue));
        break;
      case "richText":
        fields[fieldId] = loc(toRichTextDocument(String(value)));
        break;
      default:
        fields[fieldId] = loc(value);
    }
  }

  const entry = await ctx.client.entry.create({ contentTypeId }, { fields });
  ctx.entryIds.push(entry.sys.id);
  return link("Entry", entry.sys.id);
}

/**
 * Writes a page as draft entries (blocks first, then the page). An existing
 * page with the same slug is updated to point at the new blocks. Nothing is
 * published, so the page is only visible through the Preview API until a
 * human approves it.
 */
export async function upsertPage(
  client: PlainClientAPI,
  page: PageDocument,
  registry: Registry,
  locale: string,
): Promise<UpsertPageResult> {
  const issues = validatePage(page, registry);
  if (issues.length) throw new PageValidationError(issues);

  const ctx: WriteContext = { client, registry, locale, slug: page.slug, contentTypes: new Map(), entryIds: [] };
  const sections: Link<"Entry">[] = [];
  for (const [i, section] of page.sections.entries()) {
    sections.push(await writeBlock(ctx, section, `${i + 1}. ${section.component}`));
  }

  const loc = <T>(value: T) => ({ [locale]: value });
  const fields = {
    title: loc(page.title),
    slug: loc(page.slug),
    ...(page.description ? { description: loc(page.description) } : {}),
    sections: loc(sections),
    designSystemVersion: loc(registry.version),
  };
  const existing = await client.entry.getMany({
    query: { content_type: PAGE_CONTENT_TYPE_ID, "fields.slug": page.slug, limit: 1 },
  });
  const current = existing.items[0];
  const entry = current
    ? await client.entry.update({ entryId: current.sys.id }, { ...current, fields: { ...current.fields, ...fields } })
    : await client.entry.create({ contentTypeId: PAGE_CONTENT_TYPE_ID }, { fields });
  return { pageId: entry.sys.id, created: !current, entryIds: ctx.entryIds };
}

function linkedIds(entry: EntryProps, linkType: "Entry" | "Asset"): string[] {
  const ids: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const sys = (value as Link<"Entry">).sys;
      if (sys?.type === "Link" && sys.linkType === linkType) ids.push(sys.id);
      else Object.values(value).forEach(visit);
    }
  };
  visit(entry.fields);
  return ids;
}

/** Publishes a page and every entry it references, children first. */
export async function publishPage(client: PlainClientAPI, pageId: string): Promise<number> {
  const seen = new Set<string>();
  let published = 0;
  const publish = async (entryId: string) => {
    if (seen.has(entryId)) return;
    seen.add(entryId);
    const entry = await client.entry.get({ entryId });
    for (const child of linkedIds(entry, "Entry")) await publish(child);
    const isPublished = entry.sys.publishedVersion !== undefined && entry.sys.version === (entry.sys.publishedVersion ?? 0) + 1;
    if (!isPublished) {
      await client.entry.publish({ entryId }, entry);
      published += 1;
    }
  };
  await publish(pageId);
  return published;
}

const delocalize = (fields: Record<string, unknown>, locale: string) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (v as Record<string, unknown>)[locale]]));

/** Loads a page (including drafts) by slug through the Management API. */
export async function loadPage(
  client: PlainClientAPI,
  slug: string,
  registry: Registry,
  locale: string,
): Promise<PageDocument | null> {
  const pages = await client.entry.getMany({ query: { content_type: PAGE_CONTENT_TYPE_ID, "fields.slug": slug, limit: 1 } });
  const page = pages.items[0];
  if (!page) return null;

  const entries: DeliveryEntry[] = [];
  const assetIds = new Set<string>();
  let frontier = linkedIds(page, "Entry");
  const seen = new Set<string>();
  for (const id of linkedIds(page, "Asset")) assetIds.add(id);
  while (frontier.length) {
    const batch = frontier.filter((id) => !seen.has(id)).slice(0, 100);
    frontier = frontier.filter((id) => !batch.includes(id));
    if (!batch.length) continue;
    batch.forEach((id) => seen.add(id));
    const result = await client.entry.getMany({ query: { "sys.id[in]": batch.join(","), limit: 100 } });
    for (const entry of result.items) {
      entries.push({ sys: { id: entry.sys.id, contentType: entry.sys.contentType }, fields: delocalize(entry.fields, locale) });
      frontier.push(...linkedIds(entry, "Entry"));
      linkedIds(entry, "Asset").forEach((id) => assetIds.add(id));
    }
  }
  const assets: DeliveryAsset[] = [];
  if (assetIds.size) {
    const result = await client.asset.getMany({ query: { "sys.id[in]": [...assetIds].join(","), limit: 100 } });
    for (const asset of result.items) {
      assets.push({ sys: { id: asset.sys.id }, fields: delocalize(asset.fields, locale) as DeliveryAsset["fields"] });
    }
  }
  return pageFromDelivery(
    {
      items: [{ sys: { id: page.sys.id, contentType: page.sys.contentType }, fields: delocalize(page.fields, locale) }],
      includes: { Entry: entries, Asset: assets },
    },
    registry,
  );
}

export function entryEditorUrl(spaceId: string, environment: string, entryId: string): string {
  const env = environment === "master" ? "" : `/environments/${environment}`;
  return `https://app.contentful.com/spaces/${spaceId}${env}/entries/${entryId}`;
}
