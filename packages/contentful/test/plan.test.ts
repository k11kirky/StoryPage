import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseManifest, toRegistry, type DesignSystemManifest, type Registry } from "@storypage/schema";
import { planContentModel, type ExistingContentType } from "../src/plan.js";

const seed = parseManifest(
  JSON.parse(readFileSync(new URL("../../design-system/manifests/1.0.0.json", import.meta.url), "utf8")),
);
const options = { locale: "en-US" };

/** Simulates the content model after a sync: what Contentful would return. */
function applied(registry: Registry, existing: ExistingContentType[] = []): ExistingContentType[] {
  const byId = new Map(existing.map((ct) => [ct.sys.id, ct]));
  for (const change of planContentModel(registry, existing, options)) {
    byId.set(change.id, { sys: { id: change.id }, ...change.definition });
  }
  return [...byId.values()];
}

function release(mutate: (m: DesignSystemManifest) => void, version: string): Registry {
  const manifest = structuredClone(seed);
  manifest.version = version;
  mutate(manifest);
  return toRegistry(manifest);
}

describe("planContentModel", () => {
  const v1 = toRegistry(seed);

  it("creates every content type in an empty space", () => {
    const plan = planContentModel(v1, [], options);
    expect(plan.map((c) => [c.id, c.action])).toEqual([
      ["dsButton", "create"],
      ["dsFeatureCard", "create"],
      ["dsFeatureGrid", "create"],
      ["dsHero", "create"],
      ["dsRichTextSection", "create"],
      ["page", "create"],
      ["dsRelease", "create"],
    ]);
  });

  it("is idempotent once applied (apart from the version stamp)", () => {
    const plan = planContentModel(v1, applied(v1), options);
    expect(plan.every((c) => c.action === "unchanged")).toBe(true);
  });

  it("adds new props as fields", () => {
    const v2 = release((m) => {
      m.components[0]!.props.push({ name: "icon", kind: "image", required: false, editable: true });
    }, "1.1.0");
    const plan = planContentModel(v2, applied(v1), options);
    const button = plan.find((c) => c.id === "dsButton")!;
    expect(button.action).toBe("update");
    expect(button.notes).toContain("added field icon");
    expect(button.definition.fields.find((f) => f.id === "icon")).toMatchObject({ type: "Link", linkType: "Asset" });
  });

  it("hides removed props instead of deleting content", () => {
    const v2 = release((m) => {
      m.components[0]!.props = m.components[0]!.props.filter((p) => p.name !== "size");
    }, "2.0.0");
    const button = planContentModel(v2, applied(v1), options).find((c) => c.id === "dsButton")!;
    expect(button.definition.fields.find((f) => f.id === "size")).toMatchObject({ omitted: true, disabled: true, required: false });
  });

  it("re-creates fields whose type changes as <prop>V<major>", () => {
    const v2 = release((m) => {
      const body = m.components[1]!.props.find((p) => p.name === "body")!;
      body.kind = "richText";
    }, "2.0.0");
    const card = planContentModel(v2, applied(v1), options).find((c) => c.id === "dsFeatureCard")!;
    expect(card.definition.fields.find((f) => f.id === "body")).toMatchObject({ type: "Text", omitted: true });
    expect(card.definition.fields.find((f) => f.id === "bodyV2")).toMatchObject({ type: "RichText" });
  });

  it("deprecates removed components and drops them from page sections", () => {
    const v2 = release((m) => {
      m.components = m.components.filter((c) => c.name !== "RichTextSection");
    }, "2.0.0");
    const plan = planContentModel(v2, applied(v1), options);
    expect(plan.find((c) => c.id === "dsRichTextSection")).toMatchObject({ action: "deprecate" });
    expect(plan.find((c) => c.id === "dsRichTextSection")!.definition.name).toMatch(/^\[Deprecated\]/);
    const sections = plan.find((c) => c.id === "page")!.definition.fields.find((f) => f.id === "sections")!;
    expect(sections.items?.validations).toEqual([{ linkContentType: ["dsFeatureGrid", "dsHero"] }]);
  });

  it("leaves content types it doesn't own alone", () => {
    const foreign: ExistingContentType = {
      sys: { id: "blogPost" },
      name: "Blog post",
      displayField: "title",
      fields: [{ id: "title", name: "Title", type: "Symbol", required: true, localized: false }],
    };
    const plan = planContentModel(v1, [...applied(v1), foreign], options);
    expect(plan.find((c) => c.id === "blogPost")).toBeUndefined();
  });
});
