import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PlainClientAPI } from "contentful-management";
import { contentTypeFor, parseManifest, toRegistry } from "@storypage/schema";
import type { ContentfulConfig } from "../src/client.js";
import { findPendingMigrations, validateEnvironment, type ReleaseTarget } from "../src/sync.js";

const registry = toRegistry(
  parseManifest(JSON.parse(readFileSync(new URL("../../design-system/manifests/1.0.0.json", import.meta.url), "utf8"))),
);

type Entry = { sys: { id: string; contentType: { sys: { id: string } }; publishedVersion?: number }; fields: Record<string, Record<string, unknown>> };
const link = (id: string) => ({ sys: { type: "Link", linkType: "Entry", id } });
const entry = (id: string, type: string, fields: Record<string, unknown>, published = false): Entry => ({
  sys: { id, contentType: { sys: { id: type } }, ...(published ? { publishedVersion: 1 } : {}) },
  fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { "en-US": v }])),
});

function fakeConfig(entries: Entry[]): ContentfulConfig {
  const matches = (e: Entry, query: Record<string, unknown>) =>
    Object.entries(query).every(([key, value]) => {
      if (key === "content_type") return e.sys.contentType.sys.id === value;
      if (key === "sys.id[in]") return String(value).split(",").includes(e.sys.id);
      if (key === "fields.slug") return e.fields.slug?.["en-US"] === value;
      const exists = /^fields\.(\w+)\[exists\]$/.exec(key);
      if (exists) return e.fields[exists[1]!] !== undefined;
      return true;
    });
  const client = {
    entry: {
      getMany: async ({ query }: { query: Record<string, unknown> }) => ({
        items: entries.filter((e) => matches(e, query)).slice(Number(query.skip ?? 0), Number(query.skip ?? 0) + Number(query.limit ?? 100)),
      }),
    },
    asset: { getMany: async () => ({ items: [] }) },
    contentType: {
      get: async ({ contentTypeId }: { contentTypeId: string }) =>
        contentTypeFor(registry.components.find((c) => `ds${c.name}` === contentTypeId)!, registry, { locale: "en-US" }),
    },
  } as unknown as PlainClientAPI;
  return { managementToken: "x", spaceId: "s", environment: "master", locale: "en-US", clientFor: () => client };
}

const target: ReleaseTarget = { environment: "ds-2-0-0", previousEnvironment: "ds-1-0-0", strategy: "alias" };

describe("findPendingMigrations", () => {
  it("lists entries whose content is stranded in a retired field", async () => {
    const config = fakeConfig([
      entry("c1", "dsFeatureCard", { title: "A", body: "Old copy" }, true),
      entry("c2", "dsFeatureCard", { title: "B", body: "Done", bodyV2: { nodeType: "document" } }),
      entry("c3", "dsFeatureCard", { title: "C" }),
    ]);
    const pending = await findPendingMigrations(config, target, [
      { contentTypeId: "dsFeatureCard", prop: "body", fromField: "body", fromType: "Text", toField: "bodyV2", toType: "RichText", reason: "kindChanged" },
    ]);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.entries).toEqual([{ id: "c1", published: true, value: "Old copy" }]);
  });
});

describe("validateEnvironment", () => {
  it("reports sections that no longer render and props that no longer validate", async () => {
    const config = fakeConfig([
      entry("p1", "page", { title: "Home", slug: "home", sections: [link("h1"), link("old1")] }),
      entry("h1", "dsHero", { internalName: "Hero", headline: "Hi", align: "diagonal" }),
      entry("old1", "dsCarousel", { internalName: "Carousel" }),
    ]);
    const report = await validateEnvironment(config, target, registry);
    expect(report.pages).toBe(1);
    expect(report.issues).toEqual([
      { slug: "home", path: "sections", message: "1 section(s) use components that are no longer in the design system and will not render" },
      { slug: "home", path: "sections[0].align", message: "expected one of: left, center" },
    ]);
  });
});
