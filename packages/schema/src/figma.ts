import type { Placement, PropKind, PropSpec } from "./manifest.js";

/**
 * Pure helpers the Figma plugin uses to turn Figma component properties and
 * description annotations into prop specs. They live here (not in the plugin)
 * so they are unit-tested and shared with the gateway's validation.
 *
 * Designers annotate a component's description in Figma:
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
        prop = { name, figmaName: rawName, kind: "text", required: true, editable: true };
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
