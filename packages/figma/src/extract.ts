import type { GetFileResponse } from "@figma/rest-api-spec";
import {
  boxShadow,
  colorToHex,
  convertTextStyle,
  convertVariables,
  isVariableAlias,
  parseDescription,
  propsFromFigma,
  splitComponentName,
  suggestTier,
  type CollectionLike,
  type ComponentDraft,
  type ComponentSelection,
  type ConvertedVariables,
  type FigmaPropertyDefinition,
  type ShadowLike,
  type VariableLike,
  type VariableSnapshot,
} from "@storypage/schema/figma";
import type { DesignSystemManifestInput, EffectStyle, LayoutNode, Placement, TextStyle } from "@storypage/schema";
import type { FigmaClient } from "./client.js";

/**
 * Reads a published Figma library through the REST API: the same drafts,
 * choices and tokens the plugin produces, so a library published with Figma's
 * own "Publish library" flows through StoryPage without opening the plugin.
 */

export const PLUGIN_DATA_NAMESPACE = "storypage";

export type VariablesSource = "rest" | "snapshot" | "none";

export interface LibraryScan {
  manifest: DesignSystemManifestInput;
  drafts: ComponentDraft[];
  selections: Record<string, ComponentSelection>;
  suggestions: Record<string, Placement>;
  /** Where token values came from: the Enterprise variables API, the plugin's saved snapshot, or nowhere. */
  variablesSource: VariablesSource;
  variablesSavedAt?: string | undefined;
  warnings: string[];
}

/** The parts of a REST node this reads; the full node types are much larger unions. */
interface RestNode {
  id: string;
  name: string;
  type: string;
  children?: RestNode[];
  description?: string;
  componentPropertyDefinitions?: Record<
    string,
    { type: FigmaPropertyDefinition["type"]; defaultValue: unknown; variantOptions?: string[]; preferredValues?: { type: string; key: string }[] }
  >;
  absoluteBoundingBox?: { width: number; height: number } | null;
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutWrap?: "NO_WRAP" | "WRAP";
  cornerRadius?: number;
  fills?: Paint[];
  strokes?: Paint[];
  boundVariables?: Record<string, unknown>;
  characters?: string;
  styles?: Record<string, string>;
  componentId?: string;
  sharedPluginData?: Record<string, Record<string, string>>;
}

interface Paint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a: number };
  boundVariables?: { color?: { id: string } };
}

const isPrivate = (name: string) => /^[._]/.test(name);

function walk(node: RestNode, visit: (node: RestNode, parent: RestNode | null) => void, parent: RestNode | null = null) {
  visit(node, parent);
  for (const child of node.children ?? []) walk(child, visit, node);
}

/** Reassembles the variables snapshot the plugin saved on the document (chunked). */
export function readVariableSnapshot(document: RestNode): VariableSnapshot | null {
  const data = document.sharedPluginData?.[PLUGIN_DATA_NAMESPACE];
  const count = Number(data?.["variables:count"] ?? 0);
  if (!data || !count) return null;
  try {
    return JSON.parse(Array.from({ length: count }, (_, i) => data[`variables:${i}`] ?? "").join("")) as VariableSnapshot;
  } catch {
    return null;
  }
}

interface LayoutContext {
  variableNames: Map<string, string>;
  /** Component node id → published component name (sets for variants). */
  componentNames: Map<string, string>;
  textStyleNames: Map<string, string>;
}

function paintNames(paints: Paint[] | undefined, ctx: LayoutContext): string[] | undefined {
  if (!paints?.length) return undefined;
  return paints
    .filter((p) => p.visible !== false)
    .map((p) => {
      if (p.type !== "SOLID" || !p.color) return p.type.toLowerCase();
      const bound = p.boundVariables?.color?.id;
      return (bound && ctx.variableNames.get(bound)) ?? colorToHex({ ...p.color, a: p.opacity ?? p.color.a });
    });
}

export function restLayout(node: RestNode, ctx: LayoutContext, depth = 0): LayoutNode {
  const out: LayoutNode = { name: node.name, type: node.type };
  if (node.absoluteBoundingBox) {
    out.width = Math.round(node.absoluteBoundingBox.width);
    out.height = Math.round(node.absoluteBoundingBox.height);
  }
  if (node.layoutMode && node.layoutMode !== "NONE") {
    out.layout = {
      mode: node.layoutMode,
      gap: node.itemSpacing ?? 0,
      padding: [node.paddingTop ?? 0, node.paddingRight ?? 0, node.paddingBottom ?? 0, node.paddingLeft ?? 0],
      align: node.counterAxisAlignItems,
      justify: node.primaryAxisAlignItems,
      wrap: node.layoutWrap === "WRAP",
    };
  }
  if (node.cornerRadius) out.radius = node.cornerRadius;
  const fills = paintNames(node.fills, ctx);
  if (fills?.length) out.fills = fills;
  const strokes = paintNames(node.strokes, ctx);
  if (strokes?.length) out.strokes = strokes;
  if (node.boundVariables) {
    const tokens: Record<string, string> = {};
    for (const [property, binding] of Object.entries(node.boundVariables)) {
      const first: unknown = Array.isArray(binding) ? binding[0] : binding;
      const name = isVariableAlias(first) ? ctx.variableNames.get(first.id) : undefined;
      if (name) tokens[property] = name;
    }
    if (Object.keys(tokens).length) out.tokens = tokens;
  }
  if (node.type === "TEXT") {
    if (node.characters) out.characters = node.characters.slice(0, 120);
    const styleId = node.styles?.text;
    if (styleId && ctx.textStyleNames.has(styleId)) out.textStyle = ctx.textStyleNames.get(styleId);
  }
  if (node.type === "INSTANCE") {
    out.instanceOf = (node.componentId && ctx.componentNames.get(node.componentId)) || node.name;
    return out;
  }
  if (node.children && depth < 5) out.children = node.children.slice(0, 25).map((child) => restLayout(child, ctx, depth + 1));
  return out;
}

async function variables(client: FigmaClient, fileKey: string, document: RestNode, warnings: string[]) {
  const rest = await client.getLocalVariables(fileKey);
  let converted: ConvertedVariables | null = null;
  let source: VariablesSource = "none";
  let savedAt: string | undefined;
  if (rest) {
    converted = convertVariables(
      Object.values(rest.variableCollections) as unknown as CollectionLike[],
      Object.values(rest.variables) as unknown as VariableLike[],
    );
    source = "rest";
  } else {
    const snapshot = readVariableSnapshot(document);
    if (snapshot) {
      converted = convertVariables(snapshot.collections, snapshot.variables);
      source = "snapshot";
      savedAt = snapshot.savedAt;
    } else {
      warnings.push(
        "Variable values can't be read: Figma's variables API needs an Enterprise plan. Open the StoryPage plugin in the library file once to save them.",
      );
    }
  }
  if (converted) warnings.push(...converted.warnings);
  return { converted, source, savedAt };
}

async function styles(client: FigmaClient, fileKey: string, file: GetFileResponse) {
  const local = Object.entries(file.styles).filter(([, style]) => !style.remote);
  const textStyles: TextStyle[] = [];
  const effectStyles: EffectStyle[] = [];
  const textStyleNames = new Map(local.filter(([, s]) => s.styleType === "TEXT").map(([id, s]) => [id, s.name]));
  const ids = local.filter(([, s]) => s.styleType === "TEXT" || s.styleType === "EFFECT").map(([id]) => id);
  if (!ids.length) return { textStyles, effectStyles, textStyleNames };
  const { nodes } = await client.getNodes(fileKey, ids);
  for (const [id, style] of local) {
    const node = nodes[id]?.document as unknown as
      | { style?: Record<string, unknown>; effects?: ShadowLike[] }
      | undefined;
    if (style.styleType === "TEXT" && node?.style) {
      const s = node.style as {
        fontFamily: string;
        fontWeight: number;
        fontSize: number;
        lineHeightUnit?: string;
        lineHeightPx?: number;
        lineHeightPercentFontSize?: number;
        letterSpacing?: number;
        textCase?: string;
      };
      textStyles.push(
        convertTextStyle(style.name, {
          fontFamily: s.fontFamily,
          fontWeight: s.fontWeight,
          fontSize: s.fontSize,
          lineHeight:
            s.lineHeightUnit === "PIXELS"
              ? { unit: "PIXELS", value: s.lineHeightPx ?? s.fontSize }
              : s.lineHeightUnit === "FONT_SIZE_%"
                ? { unit: "PERCENT", value: s.lineHeightPercentFontSize ?? 100 }
                : { unit: "AUTO" },
          letterSpacing: { unit: "PIXELS", value: s.letterSpacing ?? 0 },
          textCase: s.textCase,
        }),
      );
    } else if (style.styleType === "EFFECT" && node?.effects) {
      const shadow = boxShadow(node.effects);
      if (shadow) effectStyles.push({ name: style.name, boxShadow: shadow });
    }
  }
  return { textStyles, effectStyles, textStyleNames };
}

export async function scanLibrary(client: FigmaClient, fileKey: string): Promise<LibraryScan> {
  const warnings: string[] = [];
  const file = await client.getFile(fileKey);
  const document = file.document as unknown as RestNode;
  const vars = await variables(client, fileKey, document, warnings);
  const { textStyles, effectStyles, textStyleNames } = await styles(client, fileKey, file);

  // Published components: sets, and components that aren't variants of a set.
  const roots: RestNode[] = [];
  walk(document, (node, parent) => {
    if (isPrivate(node.name)) return;
    if (node.type === "COMPONENT_SET" || (node.type === "COMPONENT" && parent?.type !== "COMPONENT_SET")) roots.push(node);
  });
  const keyOf = (node: RestNode) => (node.type === "COMPONENT_SET" ? file.componentSets[node.id]?.key : file.components[node.id]?.key) ?? node.id;
  const nameByKey = new Map(roots.map((n) => [keyOf(n), splitComponentName(n.name).name]));
  const componentNames = new Map<string, string>();
  for (const root of roots) {
    componentNames.set(root.id, splitComponentName(root.name).name);
    for (const variant of root.type === "COMPONENT_SET" ? root.children ?? [] : []) componentNames.set(variant.id, splitComponentName(root.name).name);
  }
  const ctx: LayoutContext = { variableNames: vars.converted?.names ?? new Map(), componentNames, textStyleNames };

  const drafts: ComponentDraft[] = [];
  const selections: Record<string, ComponentSelection> = {};
  for (const node of roots) {
    const { name, category } = splitComponentName(node.name);
    const description = (node.type === "COMPONENT_SET" ? file.componentSets[node.id]?.description : file.components[node.id]?.description) ?? node.description ?? "";
    const parsed = parseDescription(description);
    const definitions: Record<string, FigmaPropertyDefinition> = {};
    for (const [property, def] of Object.entries(node.componentPropertyDefinitions ?? {})) {
      const preferred = def.preferredValues?.map((v) => nameByKey.get(v.key)).filter((n): n is string => Boolean(n));
      definitions[property] = {
        type: def.type,
        defaultValue: typeof def.defaultValue === "string" || typeof def.defaultValue === "boolean" ? def.defaultValue : "",
        ...(def.variantOptions ? { variantOptions: def.variantOptions } : {}),
        ...(preferred?.length ? { preferredComponentNames: preferred } : {}),
      };
    }
    // The REST API doesn't flag the default variant; Figma treats the first one as default.
    const defaultVariant = node.type === "COMPONENT_SET" ? node.children?.[0] ?? node : node;
    const key = keyOf(node);
    drafts.push({
      figmaKey: key,
      figmaNodeId: node.id,
      name,
      figmaName: node.name,
      description: parsed.description,
      category: parsed.category ?? category,
      placement: parsed.placement ?? "block",
      annotatedPlacement: parsed.placement,
      props: propsFromFigma(definitions, parsed.props),
      variantCount: node.type === "COMPONENT_SET" ? node.children?.length ?? 1 : 1,
      layout: restLayout(defaultVariant, ctx),
    });
    const saved = node.sharedPluginData?.[PLUGIN_DATA_NAMESPACE]?.selection;
    if (saved) {
      try {
        selections[key] = JSON.parse(saved) as ComponentSelection;
      } catch {
        warnings.push(`Ignored unreadable StoryPage settings on ${name}.`);
      }
    }
  }
  const duplicates = drafts.map((d) => d.name).filter((n, i, all) => all.indexOf(n) !== i);
  for (const duplicate of new Set(duplicates)) warnings.push(`Two components are named ${duplicate}; rename one in Figma.`);

  return {
    manifest: {
      schemaVersion: 1,
      name: file.name.replace(/\s*[-–]?\s*design system$/i, "") || file.name,
      version: "0.0.0",
      changelog: "",
      publishedAt: new Date().toISOString(),
      publishedBy: { name: "Figma" },
      source: { figmaFileKey: fileKey, figmaFileName: file.name },
      collections: vars.converted?.collections ?? [],
      tokens: vars.converted?.tokens ?? [],
      textStyles,
      effectStyles,
      components: [],
    },
    drafts,
    selections,
    suggestions: Object.fromEntries(drafts.map((d) => [d.figmaKey, suggestTier(d, drafts)])),
    variablesSource: vars.source,
    variablesSavedAt: vars.savedAt,
    warnings,
  };
}
