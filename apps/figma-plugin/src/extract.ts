/**
 * Reads the design system out of the open Figma file: variables → tokens,
 * text/effect styles, and components (with properties, annotations, a trimmed
 * layout tree and a PNG preview). Runs in the plugin's main thread.
 */
import {
  boxShadow,
  colorToHex,
  convertTextStyle,
  convertVariables,
  fontWeightFromStyle,
  isVariableAlias,
  parseDescription,
  propsFromFigma,
  splitComponentName,
  suggestTier,
  type CollectionLike,
  type VariableLike,
  type VariableSnapshot,
  type ComponentDraft,
  type ComponentSelection,
  type FigmaPropertyDefinition,
} from "@storypage/schema/figma";
import type {
  DesignSystemManifestInput,
  Placement,
  EffectStyle,
  LayoutNode,
  TextStyle,
  Token,
  TokenCollection,
  TokenType,
  TokenValue,
} from "@storypage/schema";

export interface ExtractResult {
  /** Everything except the components, which the designer chooses from `drafts`. */
  manifest: DesignSystemManifestInput;
  /** Every component in the file, before the designer's choices are applied. */
  drafts: ComponentDraft[];
  /** Choices saved in the file, by component key. */
  selections: Record<string, ComponentSelection>;
  /** A suggested tier per component key, for components without a saved choice. */
  suggestions: Record<string, Placement>;
  warnings: string[];
}

/** Where the picker's choices are stored on each component, shared by everyone using the file. */
export const PLUGIN_DATA_NAMESPACE = "storypage";
export const SELECTION_KEY = "selection";

export function readSelection(node: BaseNode): ComponentSelection | null {
  const raw = node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, SELECTION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ComponentSelection;
  } catch {
    return null;
  }
}

export async function saveSelection(nodeId: string, selection: ComponentSelection | null): Promise<void> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Component ${nodeId} no longer exists`);
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, SELECTION_KEY, selection ? JSON.stringify(selection) : "");
}

/** PNG previews (base64) for the components being published, by name. */
export async function exportPreviews(components: { name: string; nodeId: string }[], warnings: string[]): Promise<Record<string, string>> {
  const previews: Record<string, string> = {};
  for (const { name, nodeId } of components) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node || !("exportAsync" in node)) continue;
    try {
      // The whole set shows every variant, which is what the build agent needs to see.
      const scene = node as SceneNode;
      const scale = scene.width * scene.height > 4_000_000 ? 0.5 : scene.type === "COMPONENT_SET" ? 1 : 2;
      const bytes = await scene.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
      previews[name] = figma.base64Encode(bytes);
    } catch (error) {
      warnings.push(`Could not export a preview for ${name}: ${String(error)}`);
    }
  }
  return previews;
}

export { colorToHex, fontWeightFromStyle };

const isAlias = isVariableAlias;

/** Plugin data key prefix for the variables snapshot (chunked: plugin data entries are limited in size). */
export const VARIABLES_KEY = "variables";
const CHUNK = 90_000;

/**
 * Reads local variables plus the library variables they alias, as a raw
 * snapshot. Saved in the file so the server can build tokens on Figma plans
 * whose REST API has no variables endpoint.
 */
async function variableSnapshot(): Promise<VariableSnapshot> {
  const collections: CollectionLike[] = [];
  const variables = new Map<string, VariableLike>();
  const toLike = (v: Variable): VariableLike => ({
    id: v.id,
    name: v.name,
    resolvedType: v.resolvedType,
    valuesByMode: v.valuesByMode as Record<string, unknown>,
    scopes: v.scopes,
    description: v.description,
    hiddenFromPublishing: v.hiddenFromPublishing,
    variableCollectionId: v.variableCollectionId,
    remote: v.remote,
  });
  const visit = async (id: string, depth = 0): Promise<void> => {
    if (variables.has(id) || depth > 10) return;
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (!variable) return;
    variables.set(id, toLike(variable));
    for (const value of Object.values(variable.valuesByMode)) {
      if (isAlias(value)) await visit(value.id, depth + 1);
    }
  };
  for (const collection of await figma.variables.getLocalVariableCollectionsAsync()) {
    collections.push({
      id: collection.id,
      name: collection.name,
      modes: collection.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
      defaultModeId: collection.defaultModeId,
      variableIds: [...collection.variableIds],
      hiddenFromPublishing: collection.hiddenFromPublishing,
    });
    for (const id of collection.variableIds) await visit(id);
  }
  // Collections of aliased library variables, so their default values resolve.
  for (const variable of variables.values()) {
    if (collections.some((c) => c.id === variable.variableCollectionId)) continue;
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    if (collection) {
      collections.push({
        id: collection.id,
        name: collection.name,
        modes: collection.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
        defaultModeId: collection.defaultModeId,
        variableIds: [...collection.variableIds],
        remote: true,
      });
    }
  }
  return { savedAt: new Date().toISOString(), savedBy: figma.currentUser?.name, collections, variables: [...variables.values()] };
}

export function saveVariableSnapshot(snapshot: VariableSnapshot): void {
  const json = JSON.stringify(snapshot);
  const chunks = Math.ceil(json.length / CHUNK);
  for (let i = 0; i < chunks; i++) {
    figma.root.setSharedPluginData(PLUGIN_DATA_NAMESPACE, `${VARIABLES_KEY}:${i}`, json.slice(i * CHUNK, (i + 1) * CHUNK));
  }
  figma.root.setSharedPluginData(PLUGIN_DATA_NAMESPACE, `${VARIABLES_KEY}:count`, String(chunks));
}

async function extractTextStyles(): Promise<TextStyle[]> {
  const styles = await figma.getLocalTextStylesAsync();
  return styles.map((style) =>
    convertTextStyle(style.name, {
      fontFamily: style.fontName.family,
      fontWeight: style.fontName.style,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight.unit === "AUTO" ? { unit: "AUTO" } : style.lineHeight,
      letterSpacing: style.letterSpacing,
      textCase: style.textCase,
    }),
  );
}

async function extractEffectStyles(): Promise<EffectStyle[]> {
  const result: EffectStyle[] = [];
  for (const style of await figma.getLocalEffectStylesAsync()) {
    const shadow = boxShadow(style.effects.filter((e): e is DropShadowEffect | InnerShadowEffect => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"));
    if (shadow) result.push({ name: style.name, boxShadow: shadow });
  }
  return result;
}

interface LayoutContext {
  variableNames: Map<string, string>;
  componentNames: Map<string, string>;
  textStyleNames: Map<string, string>;
}

function paintNames(paints: readonly Paint[] | typeof figma.mixed, ctx: LayoutContext): string[] | undefined {
  if (paints === figma.mixed || !paints.length) return undefined;
  return paints
    .filter((p) => p.visible !== false)
    .map((p) => {
      if (p.type !== "SOLID") return p.type.toLowerCase();
      const bound = p.boundVariables?.color;
      return (bound && ctx.variableNames.get(bound.id)) ?? colorToHex({ ...p.color, a: p.opacity ?? 1 });
    });
}

async function layoutTree(node: SceneNode, ctx: LayoutContext, depth = 0): Promise<LayoutNode> {
  const out: LayoutNode = { name: node.name, type: node.type };
  if ("width" in node) {
    out.width = Math.round(node.width);
    out.height = Math.round(node.height);
  }
  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    out.layout = {
      mode: node.layoutMode,
      gap: node.itemSpacing,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
      align: node.counterAxisAlignItems,
      justify: node.primaryAxisAlignItems,
      wrap: node.layoutWrap === "WRAP",
    };
  }
  if ("cornerRadius" in node && typeof node.cornerRadius === "number" && node.cornerRadius > 0) out.radius = node.cornerRadius;
  if ("fills" in node) {
    const fills = paintNames(node.fills, ctx);
    if (fills?.length) out.fills = fills;
  }
  if ("strokes" in node) {
    const strokes = paintNames(node.strokes, ctx);
    if (strokes?.length) out.strokes = strokes;
  }
  if ("boundVariables" in node && node.boundVariables) {
    const tokens: Record<string, string> = {};
    for (const [property, binding] of Object.entries(node.boundVariables)) {
      const first: unknown = Array.isArray(binding) ? binding[0] : binding;
      const name = isAlias(first) ? ctx.variableNames.get(first.id) : undefined;
      if (name) tokens[property] = name;
    }
    if (Object.keys(tokens).length) out.tokens = tokens;
  }
  if (node.type === "TEXT") {
    out.characters = node.characters.slice(0, 120);
    if (typeof node.textStyleId === "string" && node.textStyleId) {
      const name = ctx.textStyleNames.get(node.textStyleId);
      if (name) out.textStyle = name;
    }
  }
  if (node.type === "INSTANCE") {
    const main = await node.getMainComponentAsync();
    const key = main?.parent?.type === "COMPONENT_SET" ? main.parent.key : main?.key;
    out.instanceOf = (key && ctx.componentNames.get(key)) ?? main?.name;
    return out; // the instance's own component describes its internals
  }
  if ("children" in node && depth < 5) {
    out.children = await Promise.all(node.children.slice(0, 25).map((child) => layoutTree(child, ctx, depth + 1)));
  }
  return out;
}

const isPublishable = (node: ComponentNode | ComponentSetNode) =>
  !/^[._]/.test(node.name) && !(node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET");

export async function extractDesignSystem(): Promise<ExtractResult> {
  const warnings: string[] = [];
  await figma.loadAllPagesAsync();

  const snapshot = await variableSnapshot();
  saveVariableSnapshot(snapshot);
  const converted = convertVariables(snapshot.collections, snapshot.variables);
  warnings.push(...converted.warnings);
  const { collections, tokens } = converted;
  const textStyles = await extractTextStyles();
  const effectStyles = await extractEffectStyles();

  const nodes = figma.root
    .findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })
    .filter(isPublishable);

  const componentNames = new Map(nodes.map((n) => [n.key, splitComponentName(n.name).name]));
  const ctx: LayoutContext = {
    variableNames: converted.names,
    componentNames,
    textStyleNames: new Map((await figma.getLocalTextStylesAsync()).map((s) => [s.id, s.name])),
  };

  const drafts: ComponentDraft[] = [];
  const selections: Record<string, ComponentSelection> = {};
  for (const node of nodes) {
    const { name, category } = splitComponentName(node.name);
    const parsed = parseDescription(node.description);
    const definitions: Record<string, FigmaPropertyDefinition> = {};
    for (const [property, def] of Object.entries(node.componentPropertyDefinitions)) {
      const preferred = def.preferredValues
        ?.map((v) => componentNames.get(v.key))
        .filter((n): n is string => Boolean(n));
      definitions[property] = {
        type: def.type,
        defaultValue: isAlias(def.defaultValue) ? "" : def.defaultValue,
        ...(def.variantOptions ? { variantOptions: def.variantOptions } : {}),
        ...(preferred?.length ? { preferredComponentNames: preferred } : {}),
      };
    }
    const defaultVariant = node.type === "COMPONENT_SET" ? node.defaultVariant : node;
    drafts.push({
      figmaKey: node.key,
      figmaNodeId: node.id,
      name,
      figmaName: node.name,
      description: parsed.description,
      category: parsed.category ?? category,
      placement: parsed.placement ?? "block",
      annotatedPlacement: parsed.placement,
      props: propsFromFigma(definitions, parsed.props),
      variantCount: node.type === "COMPONENT_SET" ? node.children.length : 1,
      layout: await layoutTree(defaultVariant, ctx),
    });
    const saved = readSelection(node);
    if (saved) selections[node.key] = saved;
  }
  const suggestions = Object.fromEntries(drafts.map((d) => [d.figmaKey, suggestTier(d, drafts)]));

  const duplicates = drafts.map((c) => c.name).filter((n, i, all) => all.indexOf(n) !== i);
  for (const duplicate of new Set(duplicates)) warnings.push(`Two components are named ${duplicate}; rename one in Figma.`);

  return {
    manifest: {
      schemaVersion: 1,
      name: figma.root.name.replace(/\s*[-–]?\s*design system$/i, "") || figma.root.name,
      version: "0.0.0",
      changelog: "",
      publishedAt: new Date().toISOString(),
      publishedBy: {
        name: figma.currentUser?.name ?? "Unknown designer",
        ...(figma.currentUser?.id ? { figmaUserId: figma.currentUser.id } : {}),
      },
      source: { figmaFileKey: figma.fileKey ?? "unknown", figmaFileName: figma.root.name },
      collections,
      tokens,
      textStyles,
      effectStyles,
      components: [],
    },
    drafts,
    selections,
    suggestions,
    warnings,
  };
}
