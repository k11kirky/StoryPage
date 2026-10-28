/** A small published library, as Figma's REST API returns it, plus a fake API serving it. */
import { FigmaClient } from "../src/client.js";

/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

export const KEY = "AbCdEf1234567890";

const variables = {
  "v:blue": { id: "v:blue", name: "palette/blue", key: "k1", resolvedType: "COLOR", scopes: ["ALL_SCOPES"], description: "", hiddenFromPublishing: false, variableCollectionId: "c:palette", remote: false, valuesByMode: { m0: { r: 0.145, g: 0.341, b: 0.839, a: 1 } } },
  "v:primary": { id: "v:primary", name: "color/brand/primary", key: "k2", resolvedType: "COLOR", scopes: ["ALL_FILLS"], description: "Primary", hiddenFromPublishing: false, variableCollectionId: "c:color", remote: false, valuesByMode: { light: { type: "VARIABLE_ALIAS", id: "v:blue" }, dark: { r: 1, g: 1, b: 1, a: 0.5 } } },
  "v:space": { id: "v:space", name: "space/4", key: "k3", resolvedType: "FLOAT", scopes: ["GAP"], description: "", hiddenFromPublishing: false, variableCollectionId: "c:spacing", remote: false, valuesByMode: { s0: 16 } },
};
const collections = {
  "c:palette": { id: "c:palette", name: "Palette", key: "c1", modes: [{ modeId: "m0", name: "Default" }], defaultModeId: "m0", remote: false, hiddenFromPublishing: false, variableIds: ["v:blue"] },
  "c:color": { id: "c:color", name: "Color", key: "c2", modes: [{ modeId: "light", name: "Light" }, { modeId: "dark", name: "Dark" }], defaultModeId: "light", remote: false, hiddenFromPublishing: false, variableIds: ["v:primary"] },
  "c:spacing": { id: "c:spacing", name: "Spacing", key: "c3", modes: [{ modeId: "s0", name: "Default" }], defaultModeId: "s0", remote: false, hiddenFromPublishing: false, variableIds: ["v:space"] },
};

const variant = (id: string, name: string) => ({
  id,
  name,
  type: "COMPONENT",
  absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 40 },
  layoutMode: "HORIZONTAL",
  itemSpacing: 16,
  paddingTop: 10,
  paddingRight: 16,
  paddingBottom: 10,
  paddingLeft: 16,
  counterAxisAlignItems: "CENTER",
  primaryAxisAlignItems: "CENTER",
  cornerRadius: 8,
  fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "v:primary" } } }],
  boundVariables: { itemSpacing: { type: "VARIABLE_ALIAS", id: "v:space" } },
  children: [{ id: `${id}-label`, name: "Label", type: "TEXT", characters: "Get started", styles: { text: "S:label" } }],
});

export function file(withSnapshot: boolean) {
  const snapshot = JSON.stringify({ savedAt: "2026-10-28T10:00:00Z", collections: Object.values(collections), variables: Object.values(variables) });
  return {
    name: "Acme Design System",
    version: "1",
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      ...(withSnapshot ? { sharedPluginData: { storypage: { "variables:count": "2", "variables:0": snapshot.slice(0, 500), "variables:1": snapshot.slice(500) } } } : {}),
      children: [
        {
          id: "0:1",
          name: "Components",
          type: "CANVAS",
          children: [
            {
              id: "1:1",
              name: "Actions/Button",
              type: "COMPONENT_SET",
              componentPropertyDefinitions: {
                "Label#1:0": { type: "TEXT", defaultValue: "Get started" },
                Variant: { type: "VARIANT", defaultValue: "Primary", variantOptions: ["Primary", "Secondary"] },
              },
              children: [variant("1:2", "Variant=Primary"), variant("1:3", "Variant=Secondary")],
            },
            {
              id: "2:1",
              name: "Marketing/Hero",
              type: "COMPONENT",
              absoluteBoundingBox: { x: 0, y: 0, width: 1280, height: 600 },
              sharedPluginData: { storypage: { selection: JSON.stringify({ tier: "section", props: { body: { kind: "richText" } } }) } },
              componentPropertyDefinitions: {
                "Headline#2:0": { type: "TEXT", defaultValue: "Hello" },
                "Body#2:2": { type: "TEXT", defaultValue: "" },
                "CTA#2:1": { type: "INSTANCE_SWAP", defaultValue: "1:2", preferredValues: [{ type: "COMPONENT_SET", key: "key-button" }] },
              },
              children: [{ id: "2:5", name: "CTA", type: "INSTANCE", componentId: "1:2" }],
            },
            { id: "3:1", name: "_Internal", type: "COMPONENT", children: [] },
          ],
        },
      ],
    },
    components: {
      "1:2": { key: "kv1", name: "Variant=Primary", description: "", componentSetId: "1:1", documentationLinks: [], remote: false },
      "1:3": { key: "kv2", name: "Variant=Secondary", description: "", componentSetId: "1:1", documentationLinks: [], remote: false },
      "2:1": { key: "key-hero", name: "Marketing/Hero", description: "", documentationLinks: [], remote: false },
      "3:1": { key: "key-internal", name: "_Internal", description: "", documentationLinks: [], remote: false },
    },
    componentSets: { "1:1": { key: "key-button", name: "Actions/Button", description: "Main call to action.\n@prop href: link required" } },
    styles: {
      "S:label": { key: "s1", name: "label", description: "", remote: false, styleType: "TEXT" },
      "S:card": { key: "s2", name: "card", description: "", remote: false, styleType: "EFFECT" },
    },
  };
}

export function fakeFigma(options: { enterprise: boolean; snapshot: boolean; selections?: boolean }) {
  const fetchImpl = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === `/v1/files/${KEY}`) {
      const body = file(options.snapshot);
      if (options.selections === false) delete (body.document.children[0]!.children[1] as { sharedPluginData?: unknown }).sharedPluginData;
      return json(body);
    }
    if (url.pathname === `/v1/images/${KEY}`) {
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      return json({ err: null, images: Object.fromEntries(ids.map((id) => [id, `https://figma-renders.example.com/${id}.png`])) });
    }
    if (url.hostname === "figma-renders.example.com") return new Response(PNG);
    if (url.pathname === `/v1/files/${KEY}/variables/local`) {
      return options.enterprise ? json({ status: 200, error: false, meta: { variables, variableCollections: collections } }) : json({ message: "Forbidden" }, 403);
    }
    if (url.pathname === `/v1/files/${KEY}/nodes`) {
      return json({
        nodes: {
          "S:label": { document: { id: "S:label", type: "TEXT", style: { fontFamily: "Inter", fontWeight: 600, fontSize: 14, lineHeightUnit: "FONT_SIZE_%", lineHeightPercentFontSize: 100, letterSpacing: 0.2 } } },
          "S:card": { document: { id: "S:card", type: "RECTANGLE", effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0 }] } },
        },
      });
    }
    return json({ message: "not found" }, 404);
  };
  return new FigmaClient({ token: "figd_test", fetch: fetchImpl as typeof fetch });
}

