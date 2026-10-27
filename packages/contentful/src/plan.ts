import {
  contentTypeFor,
  contentTypeIdFor,
  INTERNAL_NAME_FIELD,
  pageContentType,
  releaseContentType,
  resolveFieldId,
  versionedFieldId,
  COMPONENT_CONTENT_TYPE_PREFIX,
  type ContentfulFieldDefinition,
  type ContentTypeDefinition,
  type Registry,
} from "@storypage/schema";

/**
 * Plans how to move the Contentful content model to a registry version without
 * losing content. Never deletes: removed props become omitted+disabled fields,
 * removed components become deprecated content types, and fields whose type
 * changes are re-created as `<prop>V<major>` (Contentful can't change a field's
 * type in place).
 */

export interface ExistingContentType {
  sys: { id: string; version?: number };
  name: string;
  description?: string;
  displayField: string;
  fields: ContentfulFieldDefinition[];
}

export type ContentTypeAction = "create" | "update" | "deprecate" | "unchanged";

export interface ContentTypeChange {
  id: string;
  action: ContentTypeAction;
  definition: ContentTypeDefinition;
  notes: string[];
}

export interface PlanOptions {
  locale: string;
  storybookUrl?: string | undefined;
}

const DEPRECATED_PREFIX = "[Deprecated] ";

/** Order-insensitive comparison key that ignores unset/false flags. */
function fieldKey(field: ContentfulFieldDefinition): string {
  return JSON.stringify(
    Object.entries(field)
      .filter(([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Whether Contentful allows changing `from` into `to` in place. */
export function isCompatible(from: ContentfulFieldDefinition, to: ContentfulFieldDefinition): boolean {
  return from.type === to.type && from.linkType === to.linkType && from.items?.type === to.items?.type && from.items?.linkType === to.items?.linkType;
}

function majorOf(version: string): number {
  return Number(version.split(".")[0]);
}

function retire(field: ContentfulFieldDefinition): ContentfulFieldDefinition {
  const name = field.name.endsWith(" (deprecated)") ? field.name : `${field.name} (deprecated)`;
  return { ...field, name, omitted: true, disabled: true, required: false };
}

/** Merges the desired definition into an existing content type. */
export function mergeContentType(
  existing: ExistingContentType,
  desired: ContentTypeDefinition,
  registryVersion: string,
): { definition: ContentTypeDefinition; notes: string[] } {
  const notes: string[] = [];
  const desiredByProp = new Map(desired.fields.map((f) => [f.id, f]));
  const result = new Map<string, ContentfulFieldDefinition>();
  for (const field of existing.fields) result.set(field.id, field);

  // Fields that no longer correspond to a desired prop are retired.
  const claimed = new Set<string>();
  for (const [prop, want] of desiredByProp) {
    const liveId = resolveFieldId(existing.fields, prop);
    const live = liveId ? existing.fields.find((f) => f.id === liveId) : undefined;
    if (live && isCompatible(live, want)) {
      const next = { ...want, id: live.id, omitted: false, disabled: want.disabled ?? false };
      if (fieldKey(live) !== fieldKey(next)) notes.push(`updated field ${live.id}`);
      result.set(live.id, next);
      claimed.add(live.id);
      continue;
    }
    // A previously retired field with the plain prop id can be revived if compatible.
    const retired = existing.fields.find((f) => f.id === prop && f.omitted);
    if (!live && retired && isCompatible(retired, want)) {
      result.set(retired.id, { ...want, omitted: false, disabled: want.disabled ?? false });
      claimed.add(retired.id);
      notes.push(`restored field ${prop}`);
      continue;
    }
    let newId = live || retired ? versionedFieldId(prop, majorOf(registryVersion)) : prop;
    if (result.has(newId)) newId = `${newId}x${result.size}`;
    if (live) {
      result.set(live.id, retire(live));
      claimed.add(live.id);
      notes.push(`field ${live.id} changed type ${live.type} → ${want.type}; created ${newId}, old field kept but hidden`);
    } else {
      notes.push(`added field ${newId}`);
    }
    result.set(newId, { ...want, id: newId });
    claimed.add(newId);
  }

  for (const field of existing.fields) {
    if (!claimed.has(field.id) && !field.omitted) {
      result.set(field.id, retire(field));
      notes.push(`field ${field.id} removed from the component; hidden and kept for existing content`);
    }
  }

  return {
    definition: { ...desired, fields: [...result.values()] },
    notes,
  };
}

const normalize = (ct: { name: string; description?: string; displayField: string; fields: ContentfulFieldDefinition[] }) =>
  JSON.stringify({
    name: ct.name,
    description: ct.description ?? "",
    displayField: ct.displayField,
    fields: ct.fields.map(fieldKey),
  });

export function desiredContentTypes(registry: Registry, options: PlanOptions): ContentTypeDefinition[] {
  return [
    ...registry.components.map((c) => contentTypeFor(c, registry, options)),
    pageContentType(registry),
    releaseContentType(),
  ];
}

export function planContentModel(
  registry: Registry,
  existing: ExistingContentType[],
  options: PlanOptions,
): ContentTypeChange[] {
  const existingById = new Map(existing.map((ct) => [ct.sys.id, ct]));
  const changes: ContentTypeChange[] = [];
  const desired = desiredContentTypes(registry, options);

  for (const definition of desired) {
    const current = existingById.get(definition.id);
    if (!current) {
      changes.push({ id: definition.id, action: "create", definition, notes: ["new content type"] });
      continue;
    }
    const merged = mergeContentType(current, definition, registry.version);
    const unchanged = normalize(current) === normalize(merged.definition);
    changes.push({
      id: definition.id,
      action: unchanged ? "unchanged" : "update",
      definition: merged.definition,
      notes: unchanged ? [] : merged.notes.length ? merged.notes : ["metadata updated"],
    });
  }

  const desiredIds = new Set(desired.map((d) => d.id));
  for (const current of existing) {
    const isComponentType =
      current.sys.id.startsWith(COMPONENT_CONTENT_TYPE_PREFIX) && /^[A-Z]/.test(current.sys.id.slice(2));
    if (!isComponentType || desiredIds.has(current.sys.id) || current.name.startsWith(DEPRECATED_PREFIX)) continue;
    changes.push({
      id: current.sys.id,
      action: "deprecate",
      definition: {
        id: current.sys.id,
        name: `${DEPRECATED_PREFIX}${current.name}`.slice(0, 50),
        description: `Removed in design-system@${registry.version}. Existing entries still render until migrated. ${current.description ?? ""}`.slice(0, 500),
        displayField: current.displayField,
        fields: current.fields,
      },
      notes: ["component removed from the design system; content type kept for existing entries"],
    });
  }
  return changes;
}

/** Strips entry-link validations so new types can be created before the types they reference. */
export function withoutLinkValidations(definition: ContentTypeDefinition): ContentTypeDefinition {
  return {
    ...definition,
    fields: definition.fields.map((f) => {
      if (f.type === "Link" && f.linkType === "Entry") return { ...f, validations: [] };
      if (f.type === "Array" && f.items?.linkType === "Entry") return { ...f, items: { ...f.items, validations: [] } };
      return f;
    }),
  };
}

export { contentTypeIdFor, INTERNAL_NAME_FIELD };
