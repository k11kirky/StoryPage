import type { ComponentSpec, LayoutNode, Placement, PropKind, PropSpec } from "./manifest.js";

/**
 * Pure helpers the Figma plugin uses to turn Figma component properties into
 * prop specs, and to resolve which components a designer chose to publish.
 * They live here (not in the plugin) so they are unit-tested.
 *
 * Designers normally make their choices in the plugin's UI, which stores them
 * in the Figma file (see `ComponentSelection`). Older files may instead
 * annotate a component's description, which is still read:
 *
 *   A full-width hero with a headline and call to action.
 *   @placement section
 *   @category Marketing
 *   @prop body: richText -- Supporting copy under the headline
 *   @prop image: image required
 *   @prop eyebrow: text optional
 *   @prop cta: slot Button
 *   @prop features: slot[] FeatureCard
 *   @prop state: internal
 */

/** Subset of Figma's ComponentPropertyDefinitions entry. */
export interface FigmaPropertyDefinition {
  type: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "VARIANT" | "SLOT";
  defaultValue: string | boolean;
  variantOptions?: string[];
  /** Component names resolved from `preferredValues` by the plugin. */
  preferredComponentNames?: string[];
}

export interface PropAnnotation {
  name: string;
  kind?: PropKind;
  multiple?: boolean;
  required?: boolean;
  internal?: boolean;
  allowedComponents?: string[];
  description?: string;
}

export interface ParsedDescription {
  description: string;
  placement?: Placement;
  category?: string;
  props: Map<string, PropAnnotation>;
}

const KINDS: PropKind[] = ["text", "longText", "richText", "number", "boolean", "enum", "image", "link", "slot"];
const INTERNAL_VARIANTS = new Set(["state", "interaction", "interactionState"]);

export function toCamelCase(raw: string): string {
  const words = raw
    .replace(/#[^#]*$/, "") // Figma suffixes non-variant property names with "#<id>"
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const camel = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
  return /^[0-9]/.test(camel) ? `v${camel}` : camel;
}

export function toPascalCase(raw: string): string {
  const camel = toCamelCase(raw);
  return camel ? camel[0]!.toUpperCase() + camel.slice(1) : camel;
}

/** "Marketing/Hero Banner" → { name: "HeroBanner", category: "Marketing" } */
export function splitComponentName(figmaName: string): { name: string; category: string } {
  const parts = figmaName.split("/").map((p) => p.trim()).filter(Boolean);
  const last = parts.pop() ?? figmaName;
  return { name: toPascalCase(last), category: parts.length ? parts.join(" / ") : "Components" };
}

export function parseDescription(raw: string): ParsedDescription {
  const lines = raw.split(/\r?\n/);
  const text: string[] = [];
  const props = new Map<string, PropAnnotation>();
  let placement: Placement | undefined;
  let category: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    const directive = /^@(\w+)\s*(.*)$/.exec(trimmed);
    if (!directive) {
      text.push(line);
      continue;
    }
    const [, key, value = ""] = directive;
    if (key === "placement" && ["section", "block", "none"].includes(value.trim())) {
      placement = value.trim() as Placement;
    } else if (key === "category" && value.trim()) {
      category = value.trim();
    } else if (key === "prop") {
      const [spec = "", description] = value.split(/\s+--\s+/, 2);
      const match = /^([A-Za-z][\w ]*?)\s*:\s*(.*)$/.exec(spec.trim());
      if (!match) continue;
      const name = toCamelCase(match[1]!);
      const annotation: PropAnnotation = { name };
      if (description) annotation.description = description.trim();
      for (const token of match[2]!.split(/\s+/).filter(Boolean)) {
        const kindToken = token.replace(/\[\]$/, "");
        if ((KINDS as string[]).includes(kindToken)) {
          annotation.kind = kindToken as PropKind;
          if (token.endsWith("[]")) annotation.multiple = true;
        } else if (token === "required" || token === "optional") {
          annotation.required = token === "required";
        } else if (token === "internal") {
          annotation.internal = true;
        } else if (/^[A-Z]/.test(token)) {
          annotation.allowedComponents = token.split("|").map(toPascalCase);
        }
      }
      props.set(name, annotation);
    }
  }
  const result: ParsedDescription = { description: text.join("\n").trim(), props };
  if (placement) result.placement = placement;
  if (category) result.category = category;
  return result;
}

const normalizeOption = (o: string) => toCamelCase(o) || o;
const BOOLEAN_PAIRS = [
  ["true", "false"],
  ["yes", "no"],
  ["on", "off"],
];

function isBooleanVariant(options: string[]): boolean {
  const lower = options.map((o) => o.toLowerCase()).sort();
  return BOOLEAN_PAIRS.some((pair) => JSON.stringify([...pair].sort()) === JSON.stringify(lower));
}

/**
 * Builds prop specs from Figma component properties, then applies annotations.
 * Annotations can also declare props Figma has no property type for (images,
 * links, rich text).
 */
export function propsFromFigma(
  definitions: Record<string, FigmaPropertyDefinition>,
  annotations: Map<string, PropAnnotation>,
): PropSpec[] {
  const props = new Map<string, PropSpec>();

  for (const [rawName, def] of Object.entries(definitions)) {
    const name = toCamelCase(rawName);
    if (!name) continue;
    let prop: PropSpec;
    switch (def.type) {
      case "VARIANT": {
        const options = def.variantOptions ?? [];
        if (isBooleanVariant(options)) {
          prop = {
            name,
            figmaName: rawName,
            kind: "boolean",
            required: false,
            editable: true,
            default: ["true", "yes", "on"].includes(String(def.defaultValue).toLowerCase()),
          };
        } else {
          prop = {
            name,
            figmaName: rawName,
            kind: "enum",
            options: options.map(normalizeOption),
            default: normalizeOption(String(def.defaultValue)),
            required: false,
            editable: !INTERNAL_VARIANTS.has(name),
          };
        }
        break;
      }
      case "BOOLEAN":
        prop = { name, figmaName: rawName, kind: "boolean", default: Boolean(def.defaultValue), required: false, editable: true };
        break;
      case "TEXT":
        prop = { name, figmaName: rawName, kind: suggestTextKind(name), required: true, editable: true };
        break;
      case "INSTANCE_SWAP":
      case "SLOT":
        prop = {
          name,
          figmaName: rawName,
          kind: "slot",
          required: false,
          editable: true,
          ...(def.preferredComponentNames?.length ? { allowedComponents: def.preferredComponentNames } : {}),
        };
        break;
    }
    props.set(name, prop);
  }

  for (const annotation of annotations.values()) {
    const existing = props.get(annotation.name);
    const kind = annotation.kind ?? existing?.kind ?? "text";
    const merged: PropSpec = {
      ...(existing ?? { name: annotation.name, required: false, editable: true }),
      kind,
    };
    if (existing?.kind === "enum" && kind !== "enum") delete merged.options;
    if (kind !== "slot") {
      delete merged.allowedComponents;
      delete merged.multiple;
    }
    if (annotation.multiple) merged.multiple = true;
    if (annotation.required !== undefined) merged.required = annotation.required;
    if (annotation.internal) merged.editable = false;
    if (annotation.allowedComponents) merged.allowedComponents = annotation.allowedComponents;
    if (annotation.description) merged.description = annotation.description;
    if (!existing && annotation.kind === undefined && annotation.internal) {
      // "@prop state: internal" on a prop Figma doesn't define is a no-op.
      continue;
    }
    props.set(annotation.name, merged);
  }

  return [...props.values()];
}

/** A better default than plain text for common Figma text property names. */
export function suggestTextKind(propName: string): PropKind {
  if (/(href|url|link)$/i.test(propName)) return "link";
  if (/(body|description|copy|intro|paragraph|summary|content)$/i.test(propName)) return "longText";
  return "text";
}

// ---------------------------------------------------------------------------
// Choosing what to publish
// ---------------------------------------------------------------------------

/** `off`: not published. Otherwise the component's placement (see PlacementSchema). */
export type Tier = "off" | Placement;

export interface PropOverride {
  kind?: PropKind;
  /** Whether content editors fill this in Contentful (false = a design decision in code). */
  editable?: boolean;
  required?: boolean;
  multiple?: boolean;
  allowedComponents?: string[];
  description?: string;
}

/**
 * What a designer chose for one component in the plugin. Stored on the
 * component in the Figma file (shared plugin data), so choices are shared by
 * the whole team and travel with the file.
 */
export interface ComponentSelection {
  tier: Tier;
  category?: string;
  /** Overrides of what was derived from the Figma component properties. */
  props?: Record<string, PropOverride>;
  /** Content fields Figma has no property type for: images, links, rich text. */
  extraProps?: PropSpec[];
}

/** A component as scanned from Figma, before the designer's choices are applied. */
export interface ComponentDraft extends ComponentSpec {
  /** The placement a description annotation asked for, in files from before the picker. */
  annotatedPlacement?: Placement | undefined;
}

export interface IncludedDependency {
  name: string;
  tier: Placement;
  reason: string;
}

export interface ResolvedSelection {
  components: ComponentSpec[];
  /** Components published because a chosen component needs them. */
  included: IncludedDependency[];
  warnings: string[];
}

const SECTION_NAME = /(section|hero|header|footer|banner|grid|testimonial|pricing|faq|cta|features?|showcase|gallery)$/i;

function instanceNames(node: LayoutNode | undefined, out = new Set<string>()): Set<string> {
  if (!node) return out;
  if (node.instanceOf) out.add(node.instanceOf);
  for (const child of node.children ?? []) instanceNames(child, out);
  return out;
}

/**
 * A starting point for the picker: wide or section-named components look like
 * page sections, components other components accept in slots look like
 * content blocks, everything else like a Storybook-only building block.
 */
export function suggestTier(draft: ComponentDraft, drafts: ComponentDraft[]): Placement {
  if (draft.annotatedPlacement) return draft.annotatedPlacement;
  const width = draft.layout?.width ?? 0;
  if (width >= 960 || (width >= 600 && SECTION_NAME.test(draft.name))) return "section";
  const isSlotTarget = drafts.some((d) => d.props.some((p) => p.kind === "slot" && p.allowedComponents?.includes(draft.name)));
  return isSlotTarget ? "block" : "none";
}

/** Applies a selection's prop overrides and extra fields to a scanned component. */
export function applyPropChoices(draft: ComponentDraft, selection: ComponentSelection | undefined): PropSpec[] {
  const props = draft.props.map((prop): PropSpec => {
    const override = selection?.props?.[prop.name];
    if (!override) return prop;
    const merged: PropSpec = { ...prop };
    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
    }
    if (merged.kind !== "slot") {
      delete merged.allowedComponents;
      delete merged.multiple;
    }
    return merged;
  });
  const names = new Set(props.map((p) => p.name));
  for (const extra of selection?.extraProps ?? []) {
    if (!names.has(extra.name)) props.push(extra);
  }
  return props;
}

const RANK: Record<Placement, number> = { section: 2, block: 1, none: 0 };

/**
 * Turns the designer's choices into the components to publish. Designers can
 * pick just the sections they want; everything those need comes along:
 * components used inside them are published to Storybook, and components
 * their content slots accept become content blocks (unless the designer chose
 * otherwise for them).
 */
export function resolveSelection(
  drafts: ComponentDraft[],
  selections: Record<string, ComponentSelection | undefined>,
): ResolvedSelection {
  const byName = new Map(drafts.map((d) => [d.name, d]));
  const warnings: string[] = [];
  const explicit = new Map<string, Tier>();
  for (const draft of drafts) {
    const tier = selections[draft.figmaKey]?.tier ?? draft.annotatedPlacement;
    if (tier) explicit.set(draft.name, tier);
  }

  const tiers = new Map<string, Placement>();
  const reasons = new Map<string, string>();
  for (const [name, tier] of explicit) if (tier !== "off") tiers.set(name, tier);

  const props = new Map(drafts.map((d) => [d.name, applyPropChoices(d, selections[d.figmaKey])]));
  // Raise a dependency to at least `tier`, unless the designer chose its tier themselves.
  const require = (name: string, tier: Placement, reason: string): boolean => {
    if (!byName.has(name)) return false;
    const chosen = explicit.get(name);
    if (chosen === "off") {
      // A slot can simply stop offering it; but a component a published one is built from must exist in code.
      if (tier !== "none" || tiers.has(name)) return false;
      warnings.push(`${name} is set to "Not published", but ${reason}, so it will be published to Storybook only.`);
      tiers.set(name, "none");
      reasons.set(name, reason);
      return true;
    }
    if (chosen) return false;
    const current = tiers.get(name);
    if (current !== undefined && RANK[current] >= RANK[tier]) return false;
    tiers.set(name, tier);
    reasons.set(name, reason);
    return true;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, tier] of [...tiers]) {
      const draft = byName.get(name)!;
      for (const used of instanceNames(draft.layout)) {
        if (used !== name && require(used, "none", `${name} uses it`)) changed = true;
      }
      if (tier === "none") continue;
      for (const prop of props.get(name)!) {
        if (prop.kind !== "slot" || !prop.editable) continue;
        for (const target of prop.allowedComponents ?? []) {
          if (require(target, "block", `editors can put it in ${name}'s ${prop.name}`)) changed = true;
        }
      }
    }
  }

  const components: ComponentSpec[] = [];
  for (const draft of drafts) {
    const tier = tiers.get(draft.name);
    if (!tier) continue;
    const selection = selections[draft.figmaKey];
    const { annotatedPlacement: _annotated, ...spec } = draft;
    const resolvedProps = props.get(draft.name)!.map((prop): PropSpec => {
      if (prop.kind !== "slot" || !prop.allowedComponents) return prop;
      const kept = prop.allowedComponents.filter((target) => tiers.has(target));
      const dropped = prop.allowedComponents.filter((target) => !tiers.has(target));
      if (dropped.length) warnings.push(`${draft.name}.${prop.name} can't offer ${dropped.join(", ")}: not published.`);
      return { ...prop, allowedComponents: kept };
    });
    components.push({
      ...spec,
      placement: tier,
      ...(selection?.category ? { category: selection.category } : {}),
      props: resolvedProps,
    });
  }

  const included = [...reasons].map(([name, reason]) => ({ name, tier: tiers.get(name)!, reason }));
  return { components, included, warnings: [...new Set(warnings)] };
}
