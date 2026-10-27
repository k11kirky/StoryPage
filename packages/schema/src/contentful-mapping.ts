import type { PropSpec } from "./manifest.js";
import type { Block, ImageValue, PageDocument, PropValue } from "./page.js";
import {
  contentProps,
  sectionComponents,
  slotTargets,
  storybookDocsId,
  type ComponentContract,
  type Registry,
} from "./registry.js";

/**
 * Pure mapping between registry contracts and Contentful content types/entries.
 * No Contentful SDK here, so the design system's Storybook preview can use the
 * same entry → block conversion in the browser.
 */

export const PAGE_CONTENT_TYPE_ID = "page";
export const RELEASE_CONTENT_TYPE_ID = "dsRelease";
export const COMPONENT_CONTENT_TYPE_PREFIX = "ds";
export const INTERNAL_NAME_FIELD = "internalName";

export function contentTypeIdFor(componentName: string): string {
  const id = `${COMPONENT_CONTENT_TYPE_PREFIX}${componentName}`;
  if (id.length > 64) throw new Error(`Content type id "${id}" exceeds Contentful's 64 character limit`);
  return id;
}

export function componentNameFor(contentTypeId: string): string | null {
  if (!contentTypeId.startsWith(COMPONENT_CONTENT_TYPE_PREFIX)) return null;
  const rest = contentTypeId.slice(COMPONENT_CONTENT_TYPE_PREFIX.length);
  return /^[A-Z]/.test(rest) && contentTypeId !== RELEASE_CONTENT_TYPE_ID ? rest : null;
}

/**
 * Contentful field types can't change in place, so a breaking kind change
 * re-creates the field as `<prop>V<major>` and omits the old one. Readers and
 * writers resolve the live field id from the content type definition.
 */
export function versionedFieldId(propName: string, major: number): string {
  return `${propName}V${major}`;
}

export interface FieldLike {
  id: string;
  omitted?: boolean | undefined;
  deleted?: boolean | undefined;
}

export function resolveFieldId(fields: FieldLike[], propName: string): string | null {
  const live = fields.filter((f) => !f.omitted && !f.deleted);
  const pattern = new RegExp(`^${propName}V(\\d+)$`);
  let best: { id: string; major: number } | null = null;
  for (const field of live) {
    const match = pattern.exec(field.id);
    if (match) {
      const major = Number(match[1]);
      if (!best || major > best.major) best = { id: field.id, major };
    }
  }
  if (best) return best.id;
  return live.some((f) => f.id === propName) ? propName : null;
}

/** The subset of the Contentful field definition this pipeline manages. */
export interface ContentfulFieldDefinition {
  id: string;
  name: string;
  type: "Symbol" | "Text" | "RichText" | "Integer" | "Number" | "Boolean" | "Link" | "Array" | "Object";
  linkType?: "Entry" | "Asset";
  items?: { type: "Link" | "Symbol"; linkType?: "Entry" | "Asset"; validations?: Record<string, unknown>[] };
  required: boolean;
  localized: boolean;
  disabled?: boolean;
  omitted?: boolean;
  validations?: Record<string, unknown>[];
  defaultValue?: Record<string, unknown>;
}

export interface ContentTypeDefinition {
  id: string;
  name: string;
  description: string;
  displayField: string;
  fields: ContentfulFieldDefinition[];
}

export interface MappingOptions {
  locale: string;
  storybookUrl?: string | undefined;
}

const titleCase = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

/** Field shape (type, link, validations) for a prop, without id/name. */
export function fieldShapeFor(
  prop: PropSpec,
  registry: Registry,
): Omit<ContentfulFieldDefinition, "id" | "name" | "required" | "localized"> {
  switch (prop.kind) {
    case "text":
      return { type: "Symbol", validations: [{ size: { max: 255 } }] };
    case "longText":
      return { type: "Text" };
    case "richText":
      return {
        type: "RichText",
        validations: [
          {
            enabledNodeTypes: [
              "heading-2",
              "heading-3",
              "heading-4",
              "ordered-list",
              "unordered-list",
              "hyperlink",
              "blockquote",
              "hr",
            ],
          },
          { enabledMarks: ["bold", "italic", "underline", "code"] },
        ],
      };
    case "number":
      return { type: "Number" };
    case "boolean":
      return { type: "Boolean" };
    case "enum":
      return { type: "Symbol", validations: [{ in: prop.options ?? [] }] };
    case "link":
      return {
        type: "Symbol",
        validations: [{ regexp: { pattern: "^(https?://|/|mailto:|#).*" } }],
      };
    case "image":
      return { type: "Link", linkType: "Asset", validations: [{ linkMimetypeGroup: ["image"] }] };
    case "slot": {
      // Only components with a Contentful type can be linked; Storybook-only ones are left out.
      const validations = [{ linkContentType: slotTargets(prop, registry).map(contentTypeIdFor) }];
      return prop.multiple
        ? { type: "Array", items: { type: "Link", linkType: "Entry", validations } }
        : { type: "Link", linkType: "Entry", validations };
    }
  }
}

export function fieldFor(prop: PropSpec, registry: Registry, options: MappingOptions): ContentfulFieldDefinition {
  const field: ContentfulFieldDefinition = {
    id: prop.name,
    name: titleCase(prop.name),
    required: prop.required && prop.default === undefined,
    localized: ["text", "longText", "richText", "image"].includes(prop.kind),
    ...fieldShapeFor(prop, registry),
  };
  if (prop.default !== undefined && ["enum", "boolean", "number", "text"].includes(prop.kind)) {
    field.defaultValue = { [options.locale]: prop.default };
  }
  return field;
}

function storybookLink(contract: ComponentContract, options: MappingOptions): string {
  if (!options.storybookUrl) return "";
  return ` Storybook: ${options.storybookUrl.replace(/\/$/, "")}/?path=/docs/${storybookDocsId(contract)}`;
}

/** The Contentful type for a Content block or Page section (not for Storybook-only components). */
export function contentTypeFor(
  contract: ComponentContract,
  registry: Registry,
  options: MappingOptions,
): ContentTypeDefinition {
  if (contract.placement === "none") throw new Error(`${contract.name} is Storybook-only and has no content type`);
  const description = `${contract.description || contract.name} [design-system@${registry.version}]${storybookLink(contract, options)}`;
  return {
    id: contentTypeIdFor(contract.name),
    name: `${contract.category} / ${contract.name}`.slice(0, 50),
    description: description.slice(0, 500),
    displayField: INTERNAL_NAME_FIELD,
    fields: [
      {
        id: INTERNAL_NAME_FIELD,
        name: "Internal name",
        type: "Symbol",
        required: true,
        localized: false,
      },
      ...contentProps(contract, registry).map((p) => fieldFor(p, registry, options)),
    ],
  };
}

export function pageContentType(registry: Registry): ContentTypeDefinition {
  return {
    id: PAGE_CONTENT_TYPE_ID,
    name: "Page",
    description: `A page composed of design-system sections [design-system@${registry.version}]`,
    displayField: "title",
    fields: [
      { id: "title", name: "Title", type: "Symbol", required: true, localized: true },
      {
        id: "slug",
        name: "Slug",
        type: "Symbol",
        required: true,
        localized: false,
        validations: [{ unique: true }, { regexp: { pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$" } }],
      },
      { id: "description", name: "SEO description", type: "Text", required: false, localized: true },
      {
        id: "sections",
        name: "Sections",
        type: "Array",
        required: true,
        localized: false,
        items: {
          type: "Link",
          linkType: "Entry",
          validations: [{ linkContentType: sectionComponents(registry).map((c) => contentTypeIdFor(c.name)) }],
        },
      },
      {
        id: "designSystemVersion",
        name: "Design system version",
        type: "Symbol",
        required: false,
        localized: false,
        disabled: true,
      },
    ],
  };
}

export function releaseContentType(): ContentTypeDefinition {
  return {
    id: RELEASE_CONTENT_TYPE_ID,
    name: "Design system release",
    description: "Audit log of design-system versions synced from Figma via Storybook.",
    displayField: "version",
    fields: [
      { id: "version", name: "Version", type: "Symbol", required: true, localized: false, validations: [{ unique: true }] },
      { id: "changelog", name: "Changelog", type: "Text", required: false, localized: false },
      { id: "diff", name: "Diff summary", type: "Text", required: false, localized: false },
      { id: "storybookUrl", name: "Storybook URL", type: "Symbol", required: false, localized: false },
      { id: "environment", name: "Environment", type: "Symbol", required: false, localized: false },
      { id: "registry", name: "Registry", type: "Object", required: false, localized: false },
    ],
  };
}

// ---------------------------------------------------------------------------
// Entries → PageDocument (read path, used by previews and the Slack bot)
// ---------------------------------------------------------------------------

/** Minimal shape of a Contentful Delivery/Preview API entry with links resolved. */
export interface DeliveryEntry {
  sys: { id: string; contentType: { sys: { id: string } } };
  fields: Record<string, unknown>;
}

export interface DeliveryAsset {
  sys: { id: string };
  fields: {
    title?: string;
    description?: string;
    file?: { url: string; details?: { image?: { width: number; height: number } } };
  };
}

export interface DeliveryResponse {
  items: DeliveryEntry[];
  includes?: { Entry?: DeliveryEntry[]; Asset?: DeliveryAsset[] };
}

interface Link {
  sys: { type: "Link"; linkType: "Entry" | "Asset"; id: string };
}

const isLink = (v: unknown): v is Link =>
  typeof v === "object" && v !== null && (v as Link).sys?.type === "Link";

/**
 * Converts a delivery-API page (non-localized response, `include` depth ≥ the
 * nesting depth) into a PageDocument. Unknown content types are skipped so a
 * page keeps rendering while a component is being deprecated.
 */
export function pageFromDelivery(response: DeliveryResponse, registry: Registry): PageDocument | null {
  const page = response.items[0];
  if (!page) return null;
  const entries = new Map((response.includes?.Entry ?? []).map((e) => [e.sys.id, e]));
  for (const item of response.items) entries.set(item.sys.id, item);
  const assets = new Map((response.includes?.Asset ?? []).map((a) => [a.sys.id, a]));

  const toImage = (link: Link): ImageValue | null => {
    const asset = assets.get(link.sys.id);
    const file = asset?.fields.file;
    if (!file) return null;
    return {
      assetId: link.sys.id,
      url: file.url.startsWith("//") ? `https:${file.url}` : file.url,
      alt: asset.fields.description || asset.fields.title || "",
      width: file.details?.image?.width,
      height: file.details?.image?.height,
    };
  };

  const toBlock = (link: Link, depth: number): Block | null => {
    if (depth > 10) return null;
    const entry = entries.get(link.sys.id);
    if (!entry) return null;
    const name = componentNameFor(entry.sys.contentType.sys.id);
    const contract = name ? registry.components.find((c) => c.name === name) : undefined;
    // Content of a component that became Storybook-only is no longer rendered.
    if (!contract || contract.placement === "none") return null;
    const fieldIds = Object.keys(entry.fields).map((id) => ({ id }));
    const props: Record<string, PropValue> = {};
    for (const prop of contentProps(contract, registry)) {
      const fieldId = resolveFieldId(fieldIds, prop.name);
      if (!fieldId) continue;
      const raw = entry.fields[fieldId];
      if (raw === undefined || raw === null) continue;
      if (prop.kind === "image" && isLink(raw)) {
        const image = toImage(raw);
        if (image) props[prop.name] = image;
      } else if (prop.kind === "slot") {
        if (Array.isArray(raw)) {
          props[prop.name] = raw.filter(isLink).map((l) => toBlock(l, depth + 1)).filter((b): b is Block => b !== null);
        } else if (isLink(raw)) {
          const child = toBlock(raw, depth + 1);
          if (child) props[prop.name] = child;
        }
      } else if (prop.kind === "richText") {
        props[prop.name] = JSON.stringify(raw);
      } else {
        props[prop.name] = raw as PropValue;
      }
    }
    return { component: contract.name, id: entry.sys.id, props };
  };

  const sections = Array.isArray(page.fields.sections) ? page.fields.sections.filter(isLink) : [];
  return {
    title: String(page.fields.title ?? ""),
    slug: String(page.fields.slug ?? ""),
    description: typeof page.fields.description === "string" ? page.fields.description : undefined,
    designSystemVersion:
      typeof page.fields.designSystemVersion === "string" ? page.fields.designSystemVersion : undefined,
    sections: sections.map((l) => toBlock(l, 0)).filter((b): b is Block => b !== null),
  };
}
