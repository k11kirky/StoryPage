import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkVersionBump,
  contentProps,
  contentTypeFor,
  diffManifests,
  lintManifest,
  pageContentType,
  parseManifest,
  resolveSelection,
  suggestTier,
  toRegistry,
  validatePage,
  type ComponentDraft,
  type ComponentSelection,
  type DesignSystemManifest,
} from "../src/index.js";

const seed = parseManifest(
  JSON.parse(readFileSync(new URL("../../design-system/manifests/1.0.0.json", import.meta.url), "utf8")),
);

/** The seed's components as the plugin would scan them, plus a small Icon primitive used inside FeatureCard. */
function drafts(): ComponentDraft[] {
  const list: ComponentDraft[] = structuredClone(seed.components).map((c) => ({ ...c, placement: "block" as const }));
  list.push({
    figmaKey: "icon-key",
    name: "Icon",
    figmaName: "Primitives/Icon",
    description: "",
    category: "Primitives",
    placement: "block",
    variantCount: 1,
    props: [{ name: "glyph", kind: "enum", options: ["bolt", "star"], default: "bolt", required: false, editable: true }],
    layout: { name: "Icon", type: "COMPONENT", width: 24, height: 24 },
  });
  list.find((c) => c.name === "FeatureCard")!.layout!.children!.unshift({ name: "Glyph", type: "INSTANCE", instanceOf: "Icon" });
  return list;
}

const key = (name: string) => drafts().find((d) => d.name === name)!.figmaKey;
const pick = (choices: Record<string, ComponentSelection["tier"]>): Record<string, ComponentSelection> =>
  Object.fromEntries(Object.entries(choices).map(([name, tier]) => [key(name), { tier }]));

describe("resolveSelection", () => {
  it("publishes only what was picked, plus what it needs", () => {
    const result = resolveSelection(drafts(), pick({ Hero: "section", FeatureGrid: "section" }));
    const tiers = Object.fromEntries(result.components.map((c) => [c.name, c.placement]));
    expect(tiers).toEqual({ Button: "block", FeatureCard: "block", Hero: "section", FeatureGrid: "section", Icon: "none" });
    expect(result.included).toEqual(
      expect.arrayContaining([
        { name: "Button", tier: "block", reason: "editors can put it in Hero's cta" },
        { name: "FeatureCard", tier: "block", reason: "editors can put it in FeatureGrid's features" },
        { name: "Icon", tier: "none", reason: "FeatureCard uses it" },
      ]),
    );
    expect(tiers).not.toHaveProperty("RichTextSection");
  });

  it("keeps a designer's explicit Storybook-only choice, which makes the slot a design decision", () => {
    const result = resolveSelection(drafts(), pick({ Hero: "section", Button: "none" }));
    const button = result.components.find((c) => c.name === "Button")!;
    expect(button.placement).toBe("none");
    const registry = toRegistry({ ...seed, components: result.components });
    const hero = registry.components.find((c) => c.name === "Hero")!;
    expect(contentProps(hero, registry).map((p) => p.name)).not.toContain("cta");
  });

  it("builds a Not-published component for Storybook anyway when a chosen one contains it", () => {
    const result = resolveSelection(drafts(), pick({ FeatureGrid: "section", FeatureCard: "off" }));
    expect(result.components.find((c) => c.name === "FeatureCard")!.placement).toBe("none");
    expect(result.warnings).toContain(
      'FeatureCard is set to "Not published", but FeatureGrid uses it, so it will be published to Storybook only.',
    );
  });

  it("drops slot options a designer chose not to publish", () => {
    const all = drafts();
    // Hero's CTA slot may also offer FeatureCard, which Hero's layout doesn't contain.
    all.find((d) => d.name === "Hero")!.props.find((p) => p.name === "cta")!.allowedComponents = ["Button", "FeatureCard"];
    const result = resolveSelection(all, pick({ Hero: "section", FeatureCard: "off" }));
    expect(result.components.find((c) => c.name === "FeatureCard")).toBeUndefined();
    expect(result.components.find((c) => c.name === "Hero")!.props.find((p) => p.name === "cta")!.allowedComponents).toEqual(["Button"]);
    expect(result.warnings).toContain("Hero.cta can't offer FeatureCard: not published.");
  });

  it("applies field choices and extra fields", () => {
    const selections: Record<string, ComponentSelection> = {
      [key("Hero")]: {
        tier: "section",
        category: "Landing",
        props: { body: { kind: "richText" }, align: { editable: false } },
        extraProps: [{ name: "background", kind: "image", required: false, editable: true }],
      },
    };
    const hero = resolveSelection(drafts(), selections).components.find((c) => c.name === "Hero")!;
    expect(hero.category).toBe("Landing");
    expect(hero.props.find((p) => p.name === "body")!.kind).toBe("richText");
    expect(hero.props.find((p) => p.name === "align")!.editable).toBe(false);
    expect(hero.props.find((p) => p.name === "background")!.kind).toBe("image");
  });

  it("suggests sections by size and name, blocks by slot use", () => {
    const all = drafts();
    const tier = (name: string) => suggestTier(all.find((d) => d.name === name)!, all);
    expect(tier("Hero")).toBe("section");
    expect(tier("Button")).toBe("block");
    expect(tier("Icon")).toBe("none");
  });
});

describe("tiers in Contentful", () => {
  const resolved = resolveSelection(drafts(), pick({ Hero: "section", FeatureGrid: "section", RichTextSection: "section" }));
  const manifest: DesignSystemManifest = { ...seed, components: resolved.components };
  const registry = toRegistry(manifest);

  it("creates no content type for Storybook-only components and keeps them out of pages", () => {
    const icon = registry.components.find((c) => c.name === "Icon")!;
    expect(() => contentTypeFor(icon, registry, { locale: "en-US" })).toThrow(/Storybook-only/);
    const sections = pageContentType(registry).fields.find((f) => f.id === "sections")!;
    expect(sections.items?.validations).toEqual([{ linkContentType: ["dsFeatureGrid", "dsHero", "dsRichTextSection"] }]);
    const issues = validatePage(
      { title: "x", slug: "x", sections: [{ component: "FeatureGrid", props: { heading: "h", features: [{ component: "Icon", props: {} }] } }] },
      registry,
    );
    expect(issues[0]!.message).toBe("Icon is not allowed here; use one of: FeatureCard");
  });

  it("rejects a required content slot nobody can fill", () => {
    const strict = structuredClone(manifest);
    strict.components.find((c) => c.name === "Hero")!.props.find((p) => p.name === "cta")!.required = true;
    strict.components.find((c) => c.name === "Button")!.placement = "none";
    expect(lintManifest(strict).join()).toMatch(/Hero\.cta is required content, but it only accepts Storybook-only components \(Button\)/);
  });

  it("versions tier changes: promoting is minor, demoting is major", () => {
    const promoted = structuredClone(manifest);
    promoted.version = "1.1.0";
    promoted.components.find((c) => c.name === "Icon")!.placement = "block";
    expect(diffManifests(manifest, promoted).requiredBump).toBe("minor");
    expect(checkVersionBump(diffManifests(manifest, promoted))).toBeNull();

    const demoted = structuredClone(manifest);
    demoted.version = "1.1.0";
    demoted.components.find((c) => c.name === "Button")!.placement = "none";
    const diff = diffManifests(manifest, demoted);
    expect(diff.requiredBump).toBe("major");
    expect(diff.breakingReasons.join()).toContain("placement Content block → Storybook only");
  });
});
