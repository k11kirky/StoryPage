import { beforeEach, describe, expect, it } from "vitest";
import { parseManifest, renderTokensCss } from "@storypage/schema";
import { colorToHex, extractDesignSystem, fontWeightFromStyle } from "../src/extract";

/** A tiny fake of the Figma plugin API: two color modes, a spacing scale, a text style and two components. */
function installFakeFigma() {
  const variables = {
    "v:blue": { id: "v:blue", name: "palette/blue", resolvedType: "COLOR", scopes: ["ALL_SCOPES"], description: "", hiddenFromPublishing: false, variableCollectionId: "c:palette", valuesByMode: { m0: { r: 0.145, g: 0.341, b: 0.839, a: 1 } } },
    "v:primary": { id: "v:primary", name: "color/brand/primary", resolvedType: "COLOR", scopes: ["ALL_FILLS"], description: "Primary", hiddenFromPublishing: false, variableCollectionId: "c:color", valuesByMode: { light: { type: "VARIABLE_ALIAS", id: "v:blue" }, dark: { r: 1, g: 1, b: 1, a: 0.5 } } },
    "v:space": { id: "v:space", name: "space/4", resolvedType: "FLOAT", scopes: ["GAP"], description: "", hiddenFromPublishing: false, variableCollectionId: "c:spacing", valuesByMode: { s0: 16 } },
    "v:ease": { id: "v:ease", name: "motion/ease", resolvedType: "EASING", scopes: [], description: "", hiddenFromPublishing: false, variableCollectionId: "c:spacing", valuesByMode: { s0: { type: "EASE_IN" } } },
  } as Record<string, unknown>;
  const collections = [
    { id: "c:palette", name: "Palette", modes: [{ modeId: "m0", name: "Default" }], defaultModeId: "m0", variableIds: ["v:blue"] },
    { id: "c:color", name: "Color", modes: [{ modeId: "light", name: "Light" }, { modeId: "dark", name: "Dark" }], defaultModeId: "light", variableIds: ["v:primary"] },
    { id: "c:spacing", name: "Spacing", modes: [{ modeId: "s0", name: "Default" }], defaultModeId: "s0", variableIds: ["v:space", "v:ease"] },
  ];
  const label = { type: "TEXT", name: "Label", characters: "Get started", textStyleId: "ts:label", width: 80, height: 16, fills: [] };
  const variant = {
    type: "COMPONENT",
    name: "Variant=Primary",
    width: 120,
    height: 40,
    layoutMode: "HORIZONTAL",
    itemSpacing: 16,
    paddingTop: 10,
    paddingRight: 16,
    paddingBottom: 10,
    paddingLeft: 16,
    counterAxisAlignItems: "CENTER",
    primaryAxisAlignItems: "CENTER",
    layoutWrap: "NO_WRAP",
    cornerRadius: 8,
    fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "v:primary" } } }],
    strokes: [],
    boundVariables: { itemSpacing: { type: "VARIABLE_ALIAS", id: "v:space" } },
    children: [label],
  };
  const button = {
    type: "COMPONENT_SET",
    id: "1:1",
    key: "key-button",
    name: "Actions/Button",
    description: "Main call to action.\n@prop href: link required",
    width: 300,
    height: 100,
    defaultVariant: variant,
    children: [variant, { ...variant, name: "Variant=Secondary" }],
    componentPropertyDefinitions: {
      "Label#1:0": { type: "TEXT", defaultValue: "Get started" },
      Variant: { type: "VARIANT", defaultValue: "Primary", variantOptions: ["Primary", "Secondary"] },
    },
    exportAsync: async () => new Uint8Array([137, 80, 78, 71]),
  };
  const hero = {
    type: "COMPONENT",
    id: "2:1",
    key: "key-hero",
    name: "Marketing/Hero",
    description: "@placement section\n@prop body: richText",
    width: 1280,
    height: 600,
    parent: { type: "PAGE" },
    componentPropertyDefinitions: {
      "Headline#2:0": { type: "TEXT", defaultValue: "Hello" },
      "CTA#2:1": { type: "INSTANCE_SWAP", defaultValue: "1:1", preferredValues: [{ type: "COMPONENT_SET", key: "key-button" }] },
    },
    children: [{ type: "INSTANCE", name: "CTA", getMainComponentAsync: async () => ({ key: "v", name: "Variant=Primary", parent: { type: "COMPONENT_SET", key: "key-button" } }) }],
    exportAsync: async () => new Uint8Array([137, 80, 78, 71]),
  };
  const privateComponent = { ...hero, key: "key-private", name: "_Internal" };

  (globalThis as unknown as { figma: unknown }).figma = {
    mixed: Symbol("mixed"),
    root: { name: "Acme Design System", findAllWithCriteria: () => [button, hero, privateComponent] },
    fileKey: "FILE123",
    currentUser: { id: "u1", name: "Dana Designer" },
    loadAllPagesAsync: async () => {},
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      getVariableByIdAsync: async (id: string) => variables[id] ?? null,
      getVariableCollectionByIdAsync: async (id: string) => collections.find((c) => c.id === id) ?? null,
    },
    getLocalTextStylesAsync: async () => [
      {
        id: "ts:label",
        name: "label",
        fontName: { family: "Inter", style: "Semi Bold" },
        fontSize: 14,
        lineHeight: { unit: "PERCENT", value: 100 },
        letterSpacing: { unit: "PIXELS", value: 0.2 },
        textCase: "ORIGINAL",
      },
    ],
    getLocalEffectStylesAsync: async () => [
      { name: "card", effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0 }] },
    ],
    base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
  };
}

describe("extractDesignSystem", () => {
  beforeEach(installFakeFigma);

  it("produces a manifest that passes the schema", async () => {
    const { manifest, previews, warnings } = await extractDesignSystem();
    const parsed = parseManifest({ ...manifest, version: "1.0.0" });

    expect(parsed.name).toBe("Acme");
    expect(parsed.publishedBy.name).toBe("Dana Designer");
    expect(parsed.tokens.map((t) => t.name)).toEqual(["palette/blue", "color/brand/primary", "space/4"]);
    expect(parsed.tokens[1]!.values).toEqual({ Light: { alias: "palette/blue" }, Dark: "#FFFFFF80" });
    expect(parsed.tokens[2]).toMatchObject({ type: "dimension", values: { Default: 16 } });
    expect(parsed.textStyles[0]).toMatchObject({ fontWeight: 600, lineHeight: "100%" });
    expect(parsed.effectStyles[0]!.boxShadow).toBe("0px 4px 12px 0px rgba(0, 0, 0, 0.1)");

    expect(parsed.components.map((c) => c.name)).toEqual(["Button", "Hero"]);
    const [button, hero] = parsed.components;
    expect(button).toMatchObject({ category: "Actions", variantCount: 2, description: "Main call to action." });
    expect(button!.props.map((p) => [p.name, p.kind])).toEqual([
      ["label", "text"],
      ["variant", "enum"],
      ["href", "link"],
    ]);
    expect(button!.layout).toMatchObject({
      layout: { mode: "HORIZONTAL", gap: 16, padding: [10, 16, 10, 16] },
      fills: ["color/brand/primary"],
      tokens: { itemSpacing: "space/4" },
      children: [{ type: "TEXT", textStyle: "label" }],
    });
    expect(hero).toMatchObject({ placement: "section", category: "Marketing" });
    expect(hero!.props.find((p) => p.name === "cta")).toMatchObject({ kind: "slot", allowedComponents: ["Button"] });
    expect(hero!.layout!.children![0]).toMatchObject({ instanceOf: "Button" });

    expect(Object.keys(previews)).toEqual(["Button", "Hero"]);
    expect(warnings).toEqual([]);
    expect(renderTokensCss(parsed)).toContain("--color-brand-primary: var(--palette-blue);");
  });

  it("maps style names and colors", () => {
    expect(fontWeightFromStyle("Extra Bold Italic")).toBe(800);
    expect(fontWeightFromStyle("Regular")).toBe(400);
    expect(colorToHex({ r: 1, g: 0.5, b: 0 })).toBe("#FF8000");
  });
});
