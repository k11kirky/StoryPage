import type { DesignSystemManifest, TextStyle, Token, TokenValue } from "./manifest.js";

/**
 * Deterministic code generation from the manifest. Tokens never go through the
 * AI agent: CSS custom properties and the typed token map are generated here so
 * they are always an exact match of Figma.
 */

export const slugify = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

export const cssVarName = (tokenName: string) => `--${tokenName.split("/").map(slugify).join("-")}`;

function cssValue(token: Token, value: TokenValue): string {
  if (typeof value === "object") return `var(${cssVarName(value.alias)})`;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (token.type === "dimension") return value === 0 ? "0" : `${value}px`;
    return String(value);
  }
  if (token.type === "fontFamily") return /[\s,]/.test(value) && !value.includes(",") ? `"${value}"` : value;
  return value;
}

function lineHeight(style: TextStyle): string {
  if (typeof style.lineHeight === "number") return `${style.lineHeight}px`;
  return style.lineHeight === "auto" ? "normal" : style.lineHeight;
}

function letterSpacing(style: TextStyle): string {
  return typeof style.letterSpacing === "number" ? `${style.letterSpacing}px` : style.letterSpacing;
}

const textTransform: Record<TextStyle["textCase"], string> = {
  none: "none",
  upper: "uppercase",
  lower: "lowercase",
  title: "capitalize",
};

export function renderTokensCss(manifest: DesignSystemManifest): string {
  const header = `/* Generated from Figma by @storypage/schema — design-system@${manifest.version}. Do not edit. */\n`;
  const blocks: string[] = [];

  const rootLines: string[] = [];
  const modeBlocks = new Map<string, string[]>();
  for (const collection of manifest.collections) {
    const tokens = manifest.tokens.filter((t) => t.collection === collection.name);
    for (const token of tokens) {
      const defaultValue = token.values[collection.defaultMode] ?? Object.values(token.values)[0];
      if (defaultValue === undefined) continue;
      rootLines.push(`  ${cssVarName(token.name)}: ${cssValue(token, defaultValue)};`);
      for (const mode of collection.modes) {
        if (mode === collection.defaultMode) continue;
        const value = token.values[mode];
        if (value === undefined || JSON.stringify(value) === JSON.stringify(defaultValue)) continue;
        const selector = `[data-${slugify(collection.name)}="${slugify(mode)}"]`;
        const lines = modeBlocks.get(selector) ?? [];
        lines.push(`  ${cssVarName(token.name)}: ${cssValue(token, value)};`);
        modeBlocks.set(selector, lines);
      }
    }
  }
  for (const style of manifest.effectStyles) {
    rootLines.push(`  ${cssVarName(`shadow/${style.name}`)}: ${style.boxShadow};`);
  }
  for (const style of manifest.textStyles) {
    const base = cssVarName(`text/${style.name}`);
    rootLines.push(
      `  ${base}-font: ${style.fontWeight} ${style.fontSize}px/${lineHeight(style)} ${JSON.stringify(style.fontFamily)};`,
      `  ${base}-letter-spacing: ${letterSpacing(style)};`,
    );
  }
  blocks.push(`:root {\n${rootLines.join("\n")}\n}`);
  for (const [selector, lines] of modeBlocks) blocks.push(`${selector} {\n${lines.join("\n")}\n}`);

  for (const style of manifest.textStyles) {
    const base = cssVarName(`text/${style.name}`);
    blocks.push(
      `.ds-text-${base.slice("--text-".length)} {\n` +
        `  font: var(${base}-font);\n` +
        `  letter-spacing: var(${base}-letter-spacing);\n` +
        `  text-transform: ${textTransform[style.textCase]};\n}`,
    );
  }
  return `${header}\n${blocks.join("\n\n")}\n`;
}

type TokenTree = { [key: string]: string | TokenTree };

function setPath(tree: TokenTree, path: string[], value: string) {
  let node = tree;
  path.forEach((rawKey, i) => {
    const key = rawKey.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""));
    const safeKey = /^[0-9]/.test(key) ? `_${key}` : key || "_";
    if (i === path.length - 1) {
      node[safeKey] = value;
    } else {
      const next = node[safeKey];
      if (typeof next === "object") {
        node = next;
      } else {
        const created: TokenTree = {};
        node[safeKey] = created;
        node = created;
      }
    }
  });
}

export function renderTokensTs(manifest: DesignSystemManifest): string {
  const tree: TokenTree = {};
  for (const token of manifest.tokens) {
    setPath(tree, token.name.split("/"), `var(${cssVarName(token.name)})`);
  }
  for (const style of manifest.effectStyles) {
    setPath(tree, ["shadow", ...style.name.split("/")], `var(${cssVarName(`shadow/${style.name}`)})`);
  }
  const textStyles = Object.fromEntries(
    manifest.textStyles.map((s) => [s.name, `ds-text-${cssVarName(`text/${s.name}`).slice("--text-".length)}`]),
  );
  return [
    `// Generated from Figma by @storypage/schema — design-system@${manifest.version}. Do not edit.`,
    `export const designSystemVersion = ${JSON.stringify(manifest.version)};`,
    ``,
    `/** CSS custom-property references for every Figma variable. */`,
    `export const tokens = ${JSON.stringify(tree, null, 2)} as const;`,
    ``,
    `/** Class names for Figma text styles, keyed by style name. */`,
    `export const textStyles = ${JSON.stringify(textStyles, null, 2)} as const;`,
    ``,
    `export type TextStyleName = keyof typeof textStyles;`,
    ``,
  ].join("\n");
}
