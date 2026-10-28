/**
 * A Figma library file, as Figma's REST API returns it, built from a design
 * (a manifest-shaped description of what the designer drew). It is what the
 * fake Figma API serves: variables, text and effect styles, components with
 * their properties, and the choices the StoryPage plugin saves in the file.
 */
import { deflateSync, crc32 } from "node:zlib";
import type { ComponentSelection, PropOverride } from "@storypage/schema/figma";
import type { ComponentSpec, DesignSystemManifest, LayoutNode, PropSpec, Token, TokenValue } from "@storypage/schema";

/** What the designer has in Figma: a manifest minus the release metadata. */
export type Design = Pick<DesignSystemManifest, "name" | "collections" | "tokens" | "textStyles" | "effectStyles" | "components">;

export interface FigmaLibrary {
  /** GET /v1/files/:key */
  file: Record<string, unknown>;
  /** GET /v1/files/:key/variables/local (Enterprise plans) */
  variables: { variables: Record<string, unknown>; variableCollections: Record<string, unknown> };
  /** GET /v1/files/:key/nodes for style ids */
  styleNodes: Record<string, { document: Record<string, unknown> }>;
  /** Node id → fill color for the fake PNG renders. */
  renderColors: Record<string, string>;
}

export interface LibraryOptions {
  fileName: string;
  /**
   * Where token values come from: the Enterprise variables API, or the
   * snapshot the StoryPage plugin saves in the file (every other plan).
   */
  variables: "rest" | "snapshot";
  /** When the plugin last saved the variables snapshot. */
  snapshotSavedAt: string;
}

type Rgba = { r: number; g: number; b: number; a: number };
const ALIAS = (id: string) => ({ type: "VARIABLE_ALIAS", id });

export function hexToRgba(hex: string): Rgba {
  const h = hex.replace("#", "");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length >= 8 ? n(6) : 1 };
}

const SCOPES: Record<Token["type"], { resolvedType: string; scopes: string[] }> = {
  color: { resolvedType: "COLOR", scopes: ["ALL_SCOPES"] },
  dimension: { resolvedType: "FLOAT", scopes: ["ALL_SCOPES"] },
  number: { resolvedType: "FLOAT", scopes: ["OPACITY"] },
  fontWeight: { resolvedType: "FLOAT", scopes: ["FONT_WEIGHT"] },
  fontFamily: { resolvedType: "STRING", scopes: ["FONT_FAMILY"] },
  string: { resolvedType: "STRING", scopes: ["ALL_SCOPES"] },
  boolean: { resolvedType: "BOOLEAN", scopes: ["ALL_SCOPES"] },
};

function buildVariables(design: Design) {
  const collections: Record<string, { id: string; name: string; key: string; modes: { modeId: string; name: string }[]; defaultModeId: string; remote: boolean; hiddenFromPublishing: boolean; variableIds: string[] }> = {};
  const modeIds = new Map<string, string>();
  design.collections.forEach((collection, i) => {
    const id = `VariableCollectionId:${i + 1}`;
    const modes = collection.modes.map((name, j) => ({ modeId: `${i + 1}:${j}`, name }));
    for (const mode of modes) modeIds.set(`${collection.name}/${mode.name}`, mode.modeId);
    collections[id] = {
      id,
      name: collection.name,
      key: `collection-${i + 1}`,
      modes,
      defaultModeId: modes.find((m) => m.name === collection.defaultMode)?.modeId ?? modes[0]!.modeId,
      remote: false,
      hiddenFromPublishing: false,
      variableIds: [],
    };
  });
  const collectionIds = new Map(Object.values(collections).map((c) => [c.name, c.id]));
  const ids = new Map(design.tokens.map((token, i) => [token.name, `VariableID:${i + 1}`]));
  const value = (token: Token, raw: TokenValue): unknown => {
    if (typeof raw === "object") return ALIAS(ids.get(raw.alias) ?? raw.alias);
    if (token.type === "color" && typeof raw === "string") return hexToRgba(raw);
    return raw;
  };
  const variables: Record<string, unknown> = {};
  for (const token of design.tokens) {
    const id = ids.get(token.name)!;
    const collectionId = collectionIds.get(token.collection)!;
    collections[collectionId]!.variableIds.push(id);
    variables[id] = {
      id,
      name: token.name,
      key: `variable-${id.split(":")[1]}`,
      variableCollectionId: collectionId,
      ...SCOPES[token.type],
      description: token.description ?? "",
      hiddenFromPublishing: false,
      remote: false,
      valuesByMode: Object.fromEntries(Object.entries(token.values).map(([mode, raw]) => [modeIds.get(`${token.collection}/${mode}`), value(token, raw)])),
    };
  }
  return { variables, variableCollections: collections, ids };
}

/** Resolves a token to a literal color, following aliases through default modes. */
function resolveColor(design: Design, name: string, depth = 0): string | undefined {
  const token = design.tokens.find((t) => t.name === name);
  if (!token || depth > 10) return undefined;
  const collection = design.collections.find((c) => c.name === token.collection);
  const raw = token.values[collection?.defaultMode ?? ""] ?? Object.values(token.values)[0];
  if (raw && typeof raw === "object") return resolveColor(design, raw.alias, depth + 1);
  return typeof raw === "string" && raw.startsWith("#") ? raw : undefined;
}

/** "0 1px 2px rgba(17,24,39,0.06), …" → Figma drop-shadow effects. */
export function effectsFromBoxShadow(css: string) {
  return css.split(/,(?![^(]*\))/).map((part) => {
    const inset = /\binset\b/.test(part);
    const color = /rgba?\(([^)]+)\)/.exec(part)?.[1]?.split(",").map((n) => Number(n.trim())) ?? [0, 0, 0, 1];
    const [x = 0, y = 0, radius = 0, spread = 0] = part.replace(/rgba?\([^)]*\)|inset/g, "").trim().split(/\s+/).map((n) => parseFloat(n));
    return {
      type: inset ? "INNER_SHADOW" : "DROP_SHADOW",
      visible: true,
      color: { r: color[0]! / 255, g: color[1]! / 255, b: color[2]! / 255, a: color[3] ?? 1 },
      offset: { x, y },
      radius,
      spread,
    };
  });
}

function propertyDefinitions(component: ComponentSpec, design: Design) {
  const definitions: Record<string, Record<string, unknown>> = {};
  for (const prop of component.props) {
    if (!prop.figmaName) continue;
    if (prop.kind === "enum") {
      definitions[prop.figmaName] = { type: "VARIANT", defaultValue: String(prop.default ?? prop.options?.[0] ?? ""), variantOptions: prop.options ?? [] };
    } else if (prop.kind === "boolean") {
      definitions[prop.figmaName] = { type: "BOOLEAN", defaultValue: Boolean(prop.default) };
    } else if (prop.kind === "slot") {
      const targets = design.components.filter((c) => prop.allowedComponents?.includes(c.name));
      definitions[prop.figmaName] = {
        type: "INSTANCE_SWAP",
        defaultValue: targets[0]?.figmaNodeId ?? "",
        preferredValues: targets.map((t) => ({ type: isSet(t) ? "COMPONENT_SET" : "COMPONENT", key: t.figmaKey })),
      };
    } else {
      definitions[prop.figmaName] = { type: "TEXT", defaultValue: "" };
    }
  }
  return definitions;
}

const isSet = (component: ComponentSpec) => component.variantCount > 1 || component.props.some((p) => p.figmaName && p.kind === "enum");

/**
 * What the designer chose in the StoryPage plugin: the component's tier, plus
 * the content fields Figma has no property for. Saved on the component.
 */
export function selectionFor(component: ComponentSpec): ComponentSelection {
  const props: Record<string, PropOverride> = {};
  const extraProps: PropSpec[] = [];
  for (const prop of component.props) {
    if (!prop.figmaName) {
      extraProps.push(prop);
      continue;
    }
    props[prop.name] = {
      kind: prop.kind,
      required: prop.required,
      editable: prop.editable,
      ...(prop.description ? { description: prop.description } : {}),
      ...(prop.kind === "slot" ? { allowedComponents: prop.allowedComponents ?? [], ...(prop.multiple ? { multiple: true } : {}) } : {}),
    };
  }
  return { tier: component.placement, category: component.category, props, ...(extraProps.length ? { extraProps } : {}) };
}

export function buildLibrary(design: Design, options: LibraryOptions): FigmaLibrary {
  const { variables, variableCollections, ids } = buildVariables(design);

  const styles: Record<string, Record<string, unknown>> = {};
  const styleNodes: FigmaLibrary["styleNodes"] = {};
  const textStyleIds = new Map<string, string>();
  design.textStyles.forEach((style, i) => {
    const id = `S:text${i + 1}`;
    textStyleIds.set(style.name, id);
    styles[id] = { key: `text-style-${i + 1}`, name: style.name, description: "", remote: false, styleType: "TEXT" };
    const lineHeight =
      typeof style.lineHeight === "number"
        ? { lineHeightUnit: "PIXELS", lineHeightPx: style.lineHeight }
        : style.lineHeight.endsWith("%")
          ? { lineHeightUnit: "FONT_SIZE_%", lineHeightPercentFontSize: parseFloat(style.lineHeight) }
          : { lineHeightUnit: "INTRINSIC_%" };
    styleNodes[id] = {
      document: {
        id,
        type: "TEXT",
        style: {
          fontFamily: style.fontFamily,
          fontWeight: style.fontWeight,
          fontSize: style.fontSize,
          letterSpacing: typeof style.letterSpacing === "number" ? style.letterSpacing : 0,
          ...(style.textCase !== "none" ? { textCase: style.textCase.toUpperCase() } : {}),
          ...lineHeight,
        },
      },
    };
  });
  design.effectStyles.forEach((style, i) => {
    const id = `S:effect${i + 1}`;
    styles[id] = { key: `effect-style-${i + 1}`, name: style.name, description: "", remote: false, styleType: "EFFECT" };
    styleNodes[id] = { document: { id, type: "RECTANGLE", effects: effectsFromBoxShadow(style.boxShadow) } };
  });

  const defaultVariantId = (c: ComponentSpec) => (isSet(c) ? `${c.figmaNodeId}:v0` : c.figmaNodeId!);
  const byName = new Map(design.components.map((c) => [c.name, c]));
  const renderColors: Record<string, string> = {};

  let counter = 0;
  const paint = (name: string) => {
    if (name.startsWith("#")) return { type: "SOLID", visible: true, color: hexToRgba(name) };
    const id = ids.get(name);
    if (!id) return { type: name.toUpperCase(), visible: true };
    return { type: "SOLID", visible: true, color: hexToRgba(resolveColor(design, name) ?? "#000000"), boundVariables: { color: ALIAS(id) } };
  };
  /** A REST node for a layout tree: the inverse of the extractor's `restLayout`. */
  const node = (layout: LayoutNode, id: string): Record<string, unknown> => {
    const out: Record<string, unknown> = { id, name: layout.name, type: layout.type };
    if (layout.width !== undefined || layout.height !== undefined) {
      out.absoluteBoundingBox = { x: 0, y: 0, width: layout.width ?? 0, height: layout.height ?? 0 };
    }
    if (layout.layout) {
      const [top, right, bottom, left] = layout.layout.padding ?? [0, 0, 0, 0];
      Object.assign(out, {
        layoutMode: layout.layout.mode,
        itemSpacing: layout.layout.gap ?? 0,
        paddingTop: top,
        paddingRight: right,
        paddingBottom: bottom,
        paddingLeft: left,
        ...(layout.layout.align ? { counterAxisAlignItems: layout.layout.align } : {}),
        ...(layout.layout.justify ? { primaryAxisAlignItems: layout.layout.justify } : {}),
        ...(layout.layout.wrap ? { layoutWrap: "WRAP" } : {}),
      });
    }
    if (layout.radius) out.cornerRadius = layout.radius;
    if (layout.fills) out.fills = layout.fills.map(paint);
    if (layout.strokes) out.strokes = layout.strokes.map(paint);
    if (layout.tokens) {
      out.boundVariables = Object.fromEntries(
        Object.entries(layout.tokens).flatMap(([property, token]) => (ids.has(token) ? [[property, ALIAS(ids.get(token)!)]] : [])),
      );
    }
    if (layout.characters) out.characters = layout.characters;
    if (layout.textStyle && textStyleIds.has(layout.textStyle)) out.styles = { text: textStyleIds.get(layout.textStyle) };
    if (layout.instanceOf) {
      out.type = "INSTANCE";
      const target = byName.get(layout.instanceOf);
      if (target) out.componentId = defaultVariantId(target);
    }
    if (layout.children) out.children = layout.children.map((child) => node(child, `${id.split(":")[0]}:${1000 + ++counter}`));
    return out;
  };

  const components: Record<string, unknown> = {};
  const componentSets: Record<string, unknown> = {};
  const pages = new Map<string, Record<string, unknown>[]>();
  for (const component of design.components) {
    const nodeId = component.figmaNodeId!;
    const layout = component.layout ?? { name: component.figmaName, type: "COMPONENT" };
    const fill = layout.fills?.[0];
    renderColors[nodeId] = fill ? (fill.startsWith("#") ? fill : resolveColor(design, fill) ?? "#CCCCCC") : "#F3F4F6";
    const sharedPluginData = { storypage: { selection: JSON.stringify(selectionFor(component)) } };
    const definitions = propertyDefinitions(component, design);
    let root: Record<string, unknown>;
    if (isSet(component)) {
      const variants = Array.from({ length: Math.max(1, component.variantCount) }, (_, i) => {
        const id = `${nodeId}:v${i}`;
        const variant = i === 0 ? node({ ...layout, type: "COMPONENT" }, id) : { ...node({ ...layout, type: "COMPONENT", children: [] }, id), name: `Variant ${i + 1}` };
        components[id] = { key: `${component.figmaKey}-v${i}`, name: variant.name, description: "", componentSetId: nodeId, documentationLinks: [], remote: false };
        return variant;
      });
      root = { id: nodeId, name: component.figmaName, type: "COMPONENT_SET", componentPropertyDefinitions: definitions, sharedPluginData, children: variants };
      componentSets[nodeId] = { key: component.figmaKey, name: component.figmaName, description: component.description };
    } else {
      root = { ...node({ ...layout, type: "COMPONENT" }, nodeId), name: component.figmaName, componentPropertyDefinitions: definitions, sharedPluginData };
      components[nodeId] = { key: component.figmaKey, name: component.figmaName, description: component.description, documentationLinks: [], remote: false };
    }
    // One Figma page per category, as design teams usually organize libraries.
    const page = component.category;
    pages.set(page, [...(pages.get(page) ?? []), root]);
  }

  const snapshot = JSON.stringify({
    savedAt: options.snapshotSavedAt,
    savedBy: "E2E Designer",
    collections: Object.values(variableCollections),
    variables: Object.values(variables),
  });
  const chunks = snapshot.match(/[\s\S]{1,90000}/g) ?? [];
  const document = {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    ...(options.variables === "snapshot"
      ? { sharedPluginData: { storypage: { "variables:count": String(chunks.length), ...Object.fromEntries(chunks.map((c, i) => [`variables:${i}`, c])) } } }
      : {}),
    children: [...pages].map(([name, children], i) => ({ id: `0:${i + 1}`, name, type: "CANVAS", children })),
  };

  return {
    file: { name: options.fileName, version: "1", lastModified: options.snapshotSavedAt, document, components, componentSets, styles, schemaVersion: 0 },
    variables: { variables, variableCollections },
    styleNodes,
    renderColors,
  };
}

/** A solid-color PNG, so component previews are real images. */
export function solidPng(hex: string, width = 240, height = 120): Buffer {
  const { r, g, b } = hexToRgba(hex);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Differences between two manifests in what developers and editors rely on:
 * components (name, placement, category, description, props) and tokens.
 * Layout trees and shadow formatting aren't compared; they don't round-trip
 * through Figma byte for byte.
 */
export function contractDifferences(expected: DesignSystemManifest, actual: DesignSystemManifest): string[] {
  const problems: string[] = [];
  const contract = (c: ComponentSpec) =>
    JSON.stringify([c.name, c.placement, c.category, c.description, c.variantCount, [...c.props].sort((a, b) => a.name.localeCompare(b.name))]);
  const actualByKey = new Map(actual.components.map((c) => [c.figmaKey, c]));
  for (const component of expected.components) {
    const other = actualByKey.get(component.figmaKey);
    if (!other) problems.push(`${component.name} is missing`);
    else if (contract(other) !== contract(component)) problems.push(`${component.name} differs:\n  expected ${contract(component)}\n  actual   ${contract(other)}`);
  }
  for (const component of actual.components) if (!expected.components.some((c) => c.figmaKey === component.figmaKey)) problems.push(`unexpected ${component.name}`);
  if (JSON.stringify(actual.tokens) !== JSON.stringify(expected.tokens)) problems.push("tokens differ");
  if (JSON.stringify(actual.collections) !== JSON.stringify(expected.collections)) problems.push("variable collections differ");
  if (JSON.stringify(actual.textStyles) !== JSON.stringify(expected.textStyles)) problems.push("text styles differ");
  return problems;
}
