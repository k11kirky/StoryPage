import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkVersionBump,
  contentTypeFor,
  diffManifests,
  markdownToRichText,
  pageContentType,
  pageFromDelivery,
  parseDescription,
  parseManifest,
  propsFromFigma,
  renderTokensCss,
  renderTokensTs,
  resolveFieldId,
  splitComponentName,
  suggestNextVersion,
  toRegistry,
  validatePage,
  type DesignSystemManifest,
  type PageDocument,
} from "../src/index.js";

const seed = parseManifest(
  JSON.parse(readFileSync(new URL("../../design-system/manifests/1.0.0.json", import.meta.url), "utf8")),
);
const clone = (m: DesignSystemManifest): DesignSystemManifest => structuredClone(m);
const registry = toRegistry(seed);

describe("manifest", () => {
  it("parses the seed manifest", () => {
    expect(seed.components.map((c) => c.name)).toEqual([
      "Button",
      "FeatureCard",
      "Hero",
      "FeatureGrid",
      "RichTextSection",
    ]);
  });

  it("rejects slots that reference unknown components", () => {
    const bad = clone(seed);
    bad.components[2]!.props.find((p) => p.name === "cta")!.allowedComponents = ["Nope"];
    expect(() => parseManifest(bad)).toThrow(/unknown component "Nope"/);
  });
});

describe("diff + versioning", () => {
  it("treats the first release as 1.0.0", () => {
    const diff = diffManifests(null, seed);
    expect(diff.components.added).toHaveLength(5);
    expect(checkVersionBump(diff)).toBeNull();
  });

  it("requires a minor bump for an added prop", () => {
    const next = clone(seed);
    next.version = "1.0.1";
    next.components[0]!.props.push({ name: "icon", kind: "image", required: false, editable: true });
    const diff = diffManifests(seed, next);
    expect(diff.requiredBump).toBe("minor");
    expect(checkVersionBump(diff)).toMatch(/minor bump \(1\.1\.0\)/);
    next.version = "1.1.0";
    expect(checkVersionBump(diffManifests(seed, next))).toBeNull();
  });

  it("requires a major bump for a removed enum option", () => {
    const next = clone(seed);
    next.version = "1.1.0";
    next.components[0]!.props.find((p) => p.name === "variant")!.options = ["primary"];
    const diff = diffManifests(seed, next);
    expect(diff.requiredBump).toBe("major");
    expect(diff.breakingReasons.join()).toMatch(/options removed: secondary/);
    expect(suggestNextVersion("1.0.0", "major")).toBe("2.0.0");
  });

  it("matches components by Figma key so renames are breaking changes, not add+remove", () => {
    const next = clone(seed);
    next.version = "2.0.0";
    next.components[0]!.name = "ActionButton";
    const diff = diffManifests(seed, next);
    expect(diff.components.added).toHaveLength(0);
    expect(diff.components.changed[0]!.otherChanges[0]).toBe("renamed Button → ActionButton");
    expect(diff.requiredBump).toBe("major");
  });

  it("allows a patch for token value changes", () => {
    const next = clone(seed);
    next.version = "1.0.1";
    next.tokens.find((t) => t.name === "color/text/muted")!.values.Light = "#374151";
    const diff = diffManifests(seed, next);
    expect(diff.requiredBump).toBe("patch");
    expect(checkVersionBump(diff)).toBeNull();
  });
});

describe("codegen", () => {
  it("renders CSS variables with aliases and modes", () => {
    const css = renderTokensCss(seed);
    expect(css).toContain("--color-brand-primary: var(--palette-blue-600);");
    expect(css).toMatch(/\[data-color="dark"\] \{[^}]*--color-brand-primary: var\(--palette-blue-400\);/);
    expect(css).toContain("--space-4: 16px;");
    expect(css).toContain(".ds-text-heading-lg {");
  });

  it("renders a typed token map", () => {
    const ts = renderTokensTs(seed);
    expect(ts).toContain('"primary": "var(--color-brand-primary)"');
    expect(ts).toContain('"heading/lg": "ds-text-heading-lg"');
  });
});

describe("figma helpers", () => {
  it("splits categories from component names", () => {
    expect(splitComponentName("Marketing/Hero Banner")).toEqual({ name: "HeroBanner", category: "Marketing" });
  });

  it("merges Figma properties with description annotations", () => {
    const parsed = parseDescription(
      [
        "Hero section.",
        "@placement section",
        "@prop body: richText -- Supporting copy",
        "@prop image: image required",
        "@prop items: slot[] FeatureCard",
      ].join("\n"),
    );
    expect(parsed.placement).toBe("section");
    expect(parsed.description).toBe("Hero section.");
    const props = propsFromFigma(
      {
        "Headline#1:0": { type: "TEXT", defaultValue: "Hello" },
        Size: { type: "VARIANT", defaultValue: "Large", variantOptions: ["Small", "Large"] },
        State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover"] },
        "Has Icon": { type: "VARIANT", defaultValue: "False", variantOptions: ["True", "False"] },
        "Body#1:1": { type: "TEXT", defaultValue: "" },
      },
      parsed.props,
    );
    const byName = Object.fromEntries(props.map((p) => [p.name, p]));
    expect(byName.headline).toMatchObject({ kind: "text", required: true });
    expect(byName.size).toMatchObject({ kind: "enum", options: ["small", "large"], default: "large" });
    expect(byName.state).toMatchObject({ editable: false });
    expect(byName.hasIcon).toMatchObject({ kind: "boolean", default: false });
    expect(byName.body).toMatchObject({ kind: "richText", description: "Supporting copy" });
    expect(byName.image).toMatchObject({ kind: "image", required: true });
    expect(byName.items).toMatchObject({ kind: "slot", multiple: true, allowedComponents: ["FeatureCard"] });
  });
});

describe("pages", () => {
  const page: PageDocument = {
    title: "Launch",
    slug: "launch",
    sections: [
      {
        component: "Hero",
        props: {
          headline: "Ship pages from Slack",
          cta: { component: "Button", props: { label: "Try it", href: "/signup" } },
        },
      },
      {
        component: "FeatureGrid",
        props: {
          heading: "Why",
          features: [{ component: "FeatureCard", props: { title: "Fast", body: "Really fast." } }],
        },
      },
    ],
  };

  it("accepts a valid page", () => {
    expect(validatePage(page, registry)).toEqual([]);
  });

  it("explains what is wrong with an invalid page", () => {
    const bad = structuredClone(page);
    bad.sections[0]!.props.cta = { component: "FeatureCard", props: {} };
    bad.sections.push({ component: "Button", props: { label: "x", href: "nope" } });
    const issues = validatePage(bad, registry);
    expect(issues).toContainEqual({
      path: "sections[0].cta",
      message: "FeatureCard is not allowed here; use one of: Button",
    });
    expect(issues).toContainEqual({ path: "sections[2]", message: "Button cannot be used as a top-level section" });
    expect(issues).toContainEqual({ path: "sections[2].href", message: "expected a URL or site-relative path" });
  });
});

describe("contentful mapping", () => {
  it("maps contracts to content types", () => {
    const hero = contentTypeFor(registry.components.find((c) => c.name === "Hero")!, registry, { locale: "en-US" });
    expect(hero.id).toBe("dsHero");
    const cta = hero.fields.find((f) => f.id === "cta")!;
    expect(cta).toMatchObject({ type: "Link", linkType: "Entry", validations: [{ linkContentType: ["dsButton"] }] });
    expect(hero.fields.find((f) => f.id === "align")).toMatchObject({ defaultValue: { "en-US": "left" } });
    const button = contentTypeFor(registry.components.find((c) => c.name === "Button")!, registry, { locale: "en-US" });
    expect(button.fields.map((f) => f.id)).not.toContain("state");
    const sections = pageContentType(registry).fields.find((f) => f.id === "sections")!;
    expect(sections.items?.validations).toEqual([
      { linkContentType: ["dsFeatureGrid", "dsHero", "dsRichTextSection"] },
    ]);
  });

  it("resolves versioned field ids", () => {
    expect(resolveFieldId([{ id: "size" }], "size")).toBe("size");
    expect(resolveFieldId([{ id: "size", omitted: true }, { id: "sizeV2" }, { id: "sizeV3" }], "size")).toBe("sizeV3");
    expect(resolveFieldId([{ id: "other" }], "size")).toBeNull();
  });

  it("converts delivery responses into page documents", () => {
    const link = (id: string, linkType: "Entry" | "Asset" = "Entry") => ({ sys: { type: "Link", linkType, id } });
    const doc = pageFromDelivery(
      {
        items: [
          {
            sys: { id: "p1", contentType: { sys: { id: "page" } } },
            fields: { title: "Launch", slug: "launch", sections: [link("h1")], designSystemVersion: "1.0.0" },
          },
        ],
        includes: {
          Entry: [
            {
              sys: { id: "h1", contentType: { sys: { id: "dsHero" } } },
              fields: { internalName: "Hero", headline: "Hi", cta: link("b1"), image: link("a1", "Asset") },
            },
            { sys: { id: "b1", contentType: { sys: { id: "dsButton" } } }, fields: { label: "Go", href: "/go" } },
          ],
          Asset: [
            { sys: { id: "a1" }, fields: { title: "Shot", file: { url: "//images.ctfassets.net/x.png" } } },
          ],
        },
      },
      registry,
    );
    expect(doc?.sections[0]).toEqual({
      component: "Hero",
      id: "h1",
      props: {
        headline: "Hi",
        cta: { component: "Button", id: "b1", props: { label: "Go", href: "/go" } },
        image: { assetId: "a1", url: "https://images.ctfassets.net/x.png", alt: "Shot", width: undefined, height: undefined },
      },
    });
  });
});

describe("rich text", () => {
  it("converts markdown", () => {
    const doc = markdownToRichText("## Title\n\nSome **bold** and [a link](https://x.dev).\n\n- one\n- two");
    expect(doc.content.map((n) => n.nodeType)).toEqual(["heading-2", "paragraph", "unordered-list"]);
    const paragraph = doc.content[1]!;
    expect(paragraph.content[1]).toMatchObject({ value: "bold", marks: [{ type: "bold" }] });
    expect(paragraph.content[3]).toMatchObject({ nodeType: "hyperlink", data: { uri: "https://x.dev" } });
  });
});
