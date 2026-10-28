import type { TextStyle, Token, TokenCollection, TokenType, TokenValue } from "./manifest.js";

/**
 * Figma variables → design tokens, shared by the plugin (Plugin API) and the
 * server-side extractor (REST API). Both APIs describe variables with the same
 * fields, so these pure functions take that common shape.
 */

export interface VariableLike {
  id: string;
  name: string;
  resolvedType: string;
  valuesByMode: Record<string, unknown>;
  scopes?: readonly string[];
  description?: string;
  hiddenFromPublishing?: boolean;
  variableCollectionId: string;
  /** From another library (REST marks these; the plugin includes alias targets this way). */
  remote?: boolean;
}

export interface CollectionLike {
  id: string;
  name: string;
  modes: readonly { modeId: string; name: string }[];
  defaultModeId: string;
  variableIds: readonly string[];
  remote?: boolean;
  hiddenFromPublishing?: boolean;
}

/**
 * Raw variables as the plugin saves them in the file, for Figma plans where
 * the REST variables API isn't available (it is Enterprise-only).
 */
export interface VariableSnapshot {
  savedAt: string;
  savedBy?: string | undefined;
  collections: CollectionLike[];
  variables: VariableLike[];
}

export interface ConvertedVariables {
  collections: TokenCollection[];
  tokens: Token[];
  /** Variable id → token name, for resolving bound variables on nodes. */
  names: Map<string, string>;
  warnings: string[];
}

const DIMENSION_SCOPES = new Set([
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

const hex = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0").toUpperCase();

export function colorToHex(color: { r: number; g: number; b: number; a?: number }): string {
  const alpha = color.a !== undefined && color.a < 1 ? hex(color.a) : "";
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}${alpha}`;
}

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

export const isVariableAlias = (value: unknown): value is { type: "VARIABLE_ALIAS"; id: string } =>
  typeof value === "object" && value !== null && "type" in value && (value as { type: unknown }).type === "VARIABLE_ALIAS";

/** Null for variable types with no CSS token equivalent (easing, timing). */
export function tokenTypeFor(variable: Pick<VariableLike, "resolvedType" | "scopes">): TokenType | null {
  const scopes = variable.scopes ?? [];
  switch (variable.resolvedType) {
    case "COLOR":
      return "color";
    case "BOOLEAN":
      return "boolean";
    case "STRING":
      return scopes.includes("FONT_FAMILY") ? "fontFamily" : "string";
    case "FLOAT":
      if (scopes.includes("FONT_WEIGHT")) return "fontWeight";
      return scopes.some((s) => DIMENSION_SCOPES.has(s)) ? "dimension" : "number";
    default:
      return null;
  }
}

/** A literal variable value as a token value; null for values tokens can't express. */
export function literalValue(value: unknown): string | number | boolean | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object" || value === null) return null;
  if ("r" in value) return colorToHex(value as { r: number; g: number; b: number; a?: number });
  // Composed color with a literal color and an aliased opacity: keep the color.
  const color = (value as { color?: unknown }).color;
  if (color && typeof color === "object" && "r" in color) return colorToHex(color as { r: number; g: number; b: number });
  return null;
}

export function convertVariables(collections: readonly CollectionLike[], variables: readonly VariableLike[]): ConvertedVariables {
  const warnings: string[] = [];
  const byId = new Map(variables.map((v) => [v.id, v]));
  const collectionById = new Map(collections.map((c) => [c.id, c]));
  const localCollections = collections.filter((c) => !c.remote);
  const isLocal = (v: VariableLike) => !v.remote && !collectionById.get(v.variableCollectionId)?.remote;

  // Aliases to variables from other libraries are flattened to their default value.
  const resolveRemote = (id: string, depth = 0): TokenValue | null => {
    const target = byId.get(id);
    if (!target || depth > 10) return null;
    const collection = collectionById.get(target.variableCollectionId);
    const value = collection ? target.valuesByMode[collection.defaultModeId] : Object.values(target.valuesByMode)[0];
    if (isVariableAlias(value)) return resolveRemote(value.id, depth + 1);
    return literalValue(value);
  };

  const tokenCollections: TokenCollection[] = [];
  const tokens: Token[] = [];
  const names = new Map<string, string>();
  for (const variable of variables) names.set(variable.id, variable.name);

  for (const collection of localCollections) {
    if (collection.hiddenFromPublishing) continue;
    const modeNames = new Map(collection.modes.map((m) => [m.modeId, m.name]));
    tokenCollections.push({
      name: collection.name,
      modes: collection.modes.map((m) => m.name),
      defaultMode: modeNames.get(collection.defaultModeId) ?? collection.modes[0]!.name,
    });
    for (const id of collection.variableIds) {
      const variable = byId.get(id);
      if (!variable || variable.hiddenFromPublishing) continue;
      const type = tokenTypeFor(variable);
      if (!type) continue;
      const values: Record<string, TokenValue> = {};
      for (const [modeId, value] of Object.entries(variable.valuesByMode)) {
        const mode = modeNames.get(modeId);
        if (!mode) continue;
        if (isVariableAlias(value)) {
          const target = byId.get(value.id);
          const resolved = target && isLocal(target) ? { alias: target.name } : resolveRemote(value.id);
          if (resolved === null) warnings.push(`Could not resolve alias in ${variable.name} (${mode})`);
          else values[mode] = resolved;
        } else {
          const resolved = literalValue(value);
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
  return { collections: tokenCollections, tokens, names, warnings };
}

/** Text style values in the shape both APIs can be mapped to. */
export interface TextStyleValues {
  fontFamily: string;
  /** Numeric weight, or the font's style name ("Semi Bold"). */
  fontWeight: number | string;
  fontSize: number;
  lineHeight: { unit: "PIXELS" | "PERCENT" | "AUTO"; value?: number };
  letterSpacing: { unit: "PIXELS" | "PERCENT"; value: number };
  textCase?: string | undefined;
}

export function convertTextStyle(name: string, style: TextStyleValues): TextStyle {
  const lineHeight =
    style.lineHeight.unit === "PIXELS"
      ? style.lineHeight.value ?? "normal"
      : style.lineHeight.unit === "PERCENT"
        ? `${Math.round(style.lineHeight.value ?? 100)}%`
        : "normal";
  const letterSpacing =
    style.letterSpacing.unit === "PIXELS"
      ? Math.round(style.letterSpacing.value * 100) / 100
      : `${Math.round(style.letterSpacing.value * 100) / 10000}em`;
  const textCase: TextStyle["textCase"] =
    style.textCase === "UPPER" ? "upper" : style.textCase === "LOWER" ? "lower" : style.textCase === "TITLE" ? "title" : "none";
  return {
    name,
    fontFamily: style.fontFamily,
    fontWeight: typeof style.fontWeight === "number" ? style.fontWeight : fontWeightFromStyle(style.fontWeight),
    fontSize: style.fontSize,
    lineHeight,
    letterSpacing,
    textCase,
  };
}

export interface ShadowLike {
  type: string;
  visible?: boolean;
  color: { r: number; g: number; b: number; a: number };
  offset: { x: number; y: number };
  radius: number;
  spread?: number;
}

/** CSS box-shadow for a Figma effect style; null if it has no visible shadows. */
export function boxShadow(effects: readonly ShadowLike[]): string | null {
  const shadows = effects
    .filter((e) => (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") && e.visible !== false)
    .map((e) => {
      const { r, g, b, a } = e.color;
      const color = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Math.round(a * 100) / 100})`;
      return `${e.type === "INNER_SHADOW" ? "inset " : ""}${e.offset.x}px ${e.offset.y}px ${e.radius}px ${e.spread ?? 0}px ${color}`;
    });
  return shadows.length ? shadows.join(", ") : null;
}
