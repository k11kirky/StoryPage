/**
 * Reads the design system out of the open Figma file: variables → tokens,
 * text/effect styles, and components (with properties, annotations, a trimmed
 * layout tree and a PNG preview). Runs in the plugin's main thread.
 */
import {
  parseDescription,
  propsFromFigma,
  splitComponentName,
  type FigmaPropertyDefinition,
} from "@storypage/schema/figma";
import type {
  ComponentSpec,
  DesignSystemManifestInput,
  EffectStyle,
  LayoutNode,
  TextStyle,
  Token,
  TokenCollection,
  TokenType,
  TokenValue,
} from "@storypage/schema";

export interface ExtractResult {
  manifest: DesignSystemManifestInput;
  /** Base64 PNG per component name. */
  previews: Record<string, string>;
  warnings: string[];
}

const DIMENSION_SCOPES = new Set<VariableScope>([
  "CORNER_RADIUS",
  "WIDTH_HEIGHT",
  "GAP",
  "STROKE_FLOAT",
  "FONT_SIZE",
  "LINE_HEIGHT",
  "LETTER_SPACING",
  "PARAGRAPH_SPACING",
  "PARAGRAPH_INDENT",
  "EFFECT_FLOAT",
  "ALL_SCOPES",
]);

const FONT_WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

export function fontWeightFromStyle(style: string): number {
  return FONT_WEIGHTS.find(([pattern]) => pattern.test(style))?.[1] ?? 400;
}

const hex = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0").toUpperCase();

export function colorToHex(color: RGB | RGBA): string {
  const alpha = "a" in color && color.a < 1 ? hex(color.a) : "";
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}${alpha}`;
}

/** Null for variable types with no CSS token equivalent (easing, timing). */
function tokenType(variable: Variable): TokenType | null {
  switch (variable.resolvedType) {
    case "COLOR":
      return "color";
    case "BOOLEAN":
      return "boolean";
    case "STRING":
      return variable.scopes.includes("FONT_FAMILY") ? "fontFamily" : "string";
    case "FLOAT":
      if (variable.scopes.includes("FONT_WEIGHT")) return "fontWeight";
      return variable.scopes.some((s) => DIMENSION_SCOPES.has(s)) ? "dimension" : "number";
    default:
      return null;
  }
}

const isAlias = (value: unknown): value is VariableAlias =>
  typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS";

/** A literal variable value as a token value; null for values we can't express. */
function literal(value: VariableValue): string | number | boolean | null {
  if (typeof value !== "object") return value;
  if ("r" in value) return colorToHex(value);
  // Composed color with a literal color and an aliased opacity: keep the color.
  if ("color" in value && !isAlias(value.color)) return colorToHex(value.color);
  return null;
}

async function extractTokens(warnings: string[]) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = new Map<string, Variable>();
  for (const collection of collections) {
    for (const id of collection.variableIds) {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (variable) variables.set(id, variable);
    }
  }

  // Aliases to variables outside this file (libraries) are flattened to values.
  const resolveRemote = async (alias: VariableAlias, depth = 0): Promise<TokenValue | null> => {
    const target = await figma.variables.getVariableByIdAsync(alias.id);
    if (!target || depth > 10) return null;
    const collection = await figma.variables.getVariableCollectionByIdAsync(target.variableCollectionId);
    const value = collection ? target.valuesByMode[collection.defaultModeId] : undefined;
    if (value === undefined) return null;
    if (isAlias(value)) return resolveRemote(value, depth + 1);
    return literal(value);
  };

  const tokenCollections: TokenCollection[] = [];
  const tokens: Token[] = [];
  for (const collection of collections) {
    const modeNames = new Map(collection.modes.map((m) => [m.modeId, m.name]));
    tokenCollections.push({
      name: collection.name,
      modes: collection.modes.map((m) => m.name),
      defaultMode: modeNames.get(collection.defaultModeId) ?? collection.modes[0]!.name,
    });
    for (const id of collection.variableIds) {
      const variable = variables.get(id);
      if (!variable || variable.hiddenFromPublishing) continue;
      const type = tokenType(variable);
      if (!type) continue;
      const values: Record<string, TokenValue> = {};
      for (const [modeId, value] of Object.entries(variable.valuesByMode)) {
        const mode = modeNames.get(modeId);
        if (!mode) continue;
        if (isAlias(value)) {
          const local = variables.get(value.id);
          const resolved = local ? { alias: local.name } : await resolveRemote(value);
          if (resolved === null) warnings.push(`Could not resolve alias in ${variable.name} (${mode})`);
          else values[mode] = resolved;
        } else {
          const resolved = literal(value);
          if (resolved === null) warnings.push(`Skipped unsupported value in ${variable.name} (${mode})`);
          else values[mode] = resolved;
        }
      }
      tokens.push({
        name: variable.name,
        type,
        collection: collection.name,
        ...(variable.description ? { description: variable.description } : {}),
        values,
      });
    }
  }
  return { collections: tokenCollections, tokens, variables };
}

async function extractTextStyles(): Promise<TextStyle[]> {
  const styles = await figma.getLocalTextStylesAsync();
  return styles.map((style) => {
    const lineHeight =
      style.lineHeight.unit === "PIXELS"
        ? style.lineHeight.value
        : style.lineHeight.unit === "PERCENT"
          ? `${Math.round(style.lineHeight.value)}%`
          : "normal";
    const letterSpacing =
      style.letterSpacing.unit === "PIXELS"
        ? Math.round(style.letterSpacing.value * 100) / 100
        : `${Math.round(style.letterSpacing.value * 100) / 10000}em`;
    const textCase: TextStyle["textCase"] =
      style.textCase === "UPPER" ? "upper" : style.textCase === "LOWER" ? "lower" : style.textCase === "TITLE" ? "title" : "none";
    return {
      name: style.name,
      fontFamily: style.fontName.family,
      fontWeight: fontWeightFromStyle(style.fontName.style),
      fontSize: style.fontSize,
      lineHeight,
      letterSpacing,
      textCase,
    };
  });
}

async function extractEffectStyles(): Promise<EffectStyle[]> {
  const styles = await figma.getLocalEffectStylesAsync();
  const result: EffectStyle[] = [];
  for (const style of styles) {
    const shadows = style.effects
      .filter((e): e is DropShadowEffect | InnerShadowEffect => (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") && e.visible)
      .map((e) => {
        const { r, g, b, a } = e.color;
        const color = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Math.round(a * 100) / 100})`;
        return `${e.type === "INNER_SHADOW" ? "inset " : ""}${e.offset.x}px ${e.offset.y}px ${e.radius}px ${e.spread ?? 0}px ${color}`;
      });
    if (shadows.length) result.push({ name: style.name, boxShadow: shadows.join(", ") });
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

  const { collections, tokens, variables } = await extractTokens(warnings);
  const textStyles = await extractTextStyles();
  const effectStyles = await extractEffectStyles();

  const nodes = figma.root
    .findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })
    .filter(isPublishable);

  const componentNames = new Map(nodes.map((n) => [n.key, splitComponentName(n.name).name]));
  const ctx: LayoutContext = {
    variableNames: new Map([...variables].map(([id, v]) => [id, v.name])),
    componentNames,
    textStyleNames: new Map((await figma.getLocalTextStylesAsync()).map((s) => [s.id, s.name])),
  };

  const components: ComponentSpec[] = [];
  const previews: Record<string, string> = {};
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
    components.push({
      figmaKey: node.key,
      figmaNodeId: node.id,
      name,
      figmaName: node.name,
      description: parsed.description,
      category: parsed.category ?? category,
      placement: parsed.placement ?? "block",
      props: propsFromFigma(definitions, parsed.props),
      variantCount: node.type === "COMPONENT_SET" ? node.children.length : 1,
      layout: await layoutTree(defaultVariant, ctx),
    });
    try {
      // The whole set shows every variant, which is what the build agent needs to see.
      const scale = node.width * node.height > 4_000_000 ? 0.5 : node.type === "COMPONENT_SET" ? 1 : 2;
      const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
      previews[name] = figma.base64Encode(bytes);
    } catch (error) {
      warnings.push(`Could not export a preview for ${name}: ${String(error)}`);
    }
  }

  const duplicates = components.map((c) => c.name).filter((n, i, all) => all.indexOf(n) !== i);
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
      components,
    },
    previews,
    warnings,
  };
}
