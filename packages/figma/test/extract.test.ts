import { describe, expect, it } from "vitest";
import { parseManifest, renderTokensCss } from "@storypage/schema";
import { resolveSelection } from "@storypage/schema/figma";
import { scanLibrary } from "../src/extract.js";
import { fakeFigma, KEY } from "./fixture.js";

describe("scanLibrary (REST)", () => {
  it("reads components, the designer's choices, styles and variables", async () => {
    const scan = await scanLibrary(fakeFigma({ enterprise: true, snapshot: false }), KEY);
    expect(scan.variablesSource).toBe("rest");
    expect(scan.drafts.map((d) => d.name)).toEqual(["Button", "Hero"]);
    expect(scan.selections).toEqual({ "key-hero": { tier: "section", props: { body: { kind: "richText" } } } });

    const resolved = resolveSelection(scan.drafts, scan.selections);
    expect(resolved.included).toEqual([{ name: "Button", tier: "block", reason: "editors can put it in Hero's cta" }]);
    const manifest = parseManifest({ ...scan.manifest, components: resolved.components, version: "1.0.0" });

    const [button, hero] = manifest.components;
    expect(button).toMatchObject({ figmaKey: "key-button", category: "Actions", variantCount: 2, description: "Main call to action." });
    expect(button!.props.map((p) => [p.name, p.kind])).toEqual([
      ["label", "text"],
      ["variant", "enum"],
      ["href", "link"],
    ]);
    expect(button!.layout).toMatchObject({
      width: 120,
      layout: { mode: "HORIZONTAL", gap: 16, padding: [10, 16, 10, 16] },
      fills: ["color/brand/primary"],
      tokens: { itemSpacing: "space/4" },
      children: [{ type: "TEXT", textStyle: "label" }],
    });
    expect(hero!.props.find((p) => p.name === "body")!.kind).toBe("richText");
    expect(hero!.layout!.children![0]).toMatchObject({ instanceOf: "Button" });
    expect(manifest.textStyles[0]).toMatchObject({ name: "label", fontWeight: 600, lineHeight: "100%", letterSpacing: 0.2 });
    expect(manifest.effectStyles[0]!.boxShadow).toBe("0px 4px 12px 0px rgba(0, 0, 0, 0.1)");
    expect(renderTokensCss(manifest)).toContain("--color-brand-primary: var(--palette-blue);");
  });

  it("falls back to the plugin's saved variables without Figma Enterprise", async () => {
    const scan = await scanLibrary(fakeFigma({ enterprise: false, snapshot: true }), KEY);
    expect(scan.variablesSource).toBe("snapshot");
    expect(scan.variablesSavedAt).toBe("2026-10-28T10:00:00Z");
    expect(scan.manifest.tokens.map((t) => t.name)).toEqual(["palette/blue", "color/brand/primary", "space/4"]);
  });

  it("says how to get variables when neither is available", async () => {
    const scan = await scanLibrary(fakeFigma({ enterprise: false, snapshot: false }), KEY);
    expect(scan.variablesSource).toBe("none");
    expect(scan.warnings.join()).toMatch(/Open the StoryPage plugin in the library file once/);
  });
});
