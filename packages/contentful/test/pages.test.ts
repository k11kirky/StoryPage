import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PlainClientAPI } from "contentful-management";
import { contentTypeFor, parseManifest, toRegistry, type PageDocument } from "@storypage/schema";
import { loadPage, PageValidationError, publishPage, upsertPage } from "../src/pages.js";

const registry = toRegistry(
  parseManifest(JSON.parse(readFileSync(new URL("../../design-system/manifests/1.0.0.json", import.meta.url), "utf8"))),
);

interface FakeEntry {
  sys: { id: string; contentType: { sys: { id: string } }; version: number; publishedVersion?: number };
  fields: Record<string, Record<string, unknown>>;
}

/** Just enough of the plain client for the page write/read path. */
function fakeClient() {
  const entries = new Map<string, FakeEntry>();
  let nextId = 1;
  const contentTypes = new Map(
    registry.components.map((c) => [`ds${c.name}`, contentTypeFor(c, registry, { locale: "en-US" })]),
  );
  const matches = (entry: FakeEntry, query: Record<string, unknown>) =>
    (!query.content_type || entry.sys.contentType.sys.id === query.content_type) &&
    (!query["fields.slug"] || entry.fields.slug?.["en-US"] === query["fields.slug"]) &&
    (!query["sys.id[in]"] || String(query["sys.id[in]"]).split(",").includes(entry.sys.id));
  const client = {
    contentType: { get: async ({ contentTypeId }: { contentTypeId: string }) => contentTypes.get(contentTypeId) },
    entry: {
      create: async ({ contentTypeId }: { contentTypeId: string }, { fields }: { fields: FakeEntry["fields"] }) => {
        const entry: FakeEntry = { sys: { id: `e${nextId++}`, contentType: { sys: { id: contentTypeId } }, version: 1 }, fields };
        entries.set(entry.sys.id, entry);
        return entry;
      },
      update: async ({ entryId }: { entryId: string }, data: FakeEntry) => {
        const entry = { ...data, sys: { ...data.sys, version: data.sys.version + 1 } };
        entries.set(entryId, entry);
        return entry;
      },
      get: async ({ entryId }: { entryId: string }) => entries.get(entryId),
      getMany: async ({ query }: { query: Record<string, unknown> }) => ({
        items: [...entries.values()].filter((e) => matches(e, query)),
      }),
      publish: async ({ entryId }: { entryId: string }, entry: FakeEntry) => {
        const published = { ...entry, sys: { ...entry.sys, publishedVersion: entry.sys.version, version: entry.sys.version + 1 } };
        entries.set(entryId, published);
        return published;
      },
    },
    asset: { getMany: async () => ({ items: [] }) },
  };
  return { client: client as unknown as PlainClientAPI, entries };
}

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
    { component: "RichTextSection", props: { content: "## Why\n\nBecause **it works**." } },
  ],
};

describe("upsertPage", () => {
  it("writes blocks bottom-up as draft entries linked from the page", async () => {
    const { client, entries } = fakeClient();
    const result = await upsertPage(client, page, registry, "en-US");
    expect(result.created).toBe(true);
    expect(result.entryIds).toHaveLength(3);

    const pageEntry = entries.get(result.pageId)!;
    expect(pageEntry.fields.designSystemVersion).toEqual({ "en-US": "1.0.0" });
    const [heroLink] = pageEntry.fields.sections!["en-US"] as { sys: { id: string } }[];
    const hero = entries.get(heroLink!.sys.id)!;
    expect(hero.fields.internalName).toEqual({ "en-US": "launch › 1. Hero" });
    const button = entries.get((hero.fields.cta!["en-US"] as { sys: { id: string } }).sys.id)!;
    expect(button.fields.label).toEqual({ "en-US": "Try it" });
    const richText = [...entries.values()].find((e) => e.sys.contentType.sys.id === "dsRichTextSection")!;
    expect(richText.fields.content!["en-US"]).toMatchObject({ nodeType: "document" });
  });

  it("updates the existing page for a slug and round-trips through loadPage", async () => {
    const { client } = fakeClient();
    const first = await upsertPage(client, page, registry, "en-US");
    const second = await upsertPage(client, { ...page, title: "Launch v2" }, registry, "en-US");
    expect(second).toMatchObject({ pageId: first.pageId, created: false });
    const loaded = await loadPage(client, "launch", registry, "en-US");
    expect(loaded?.title).toBe("Launch v2");
    expect(loaded?.sections.map((s) => s.component)).toEqual(["Hero", "RichTextSection"]);
    expect(loaded?.sections[0]!.props.cta).toMatchObject({ component: "Button", props: { label: "Try it" } });
  });

  it("refuses pages that don't match the design system", async () => {
    const { client } = fakeClient();
    const bad = { ...page, sections: [{ component: "Carousel", props: {} }] };
    await expect(upsertPage(client, bad, registry, "en-US")).rejects.toBeInstanceOf(PageValidationError);
  });

  it("publishes children before the page", async () => {
    const { client, entries } = fakeClient();
    const { pageId } = await upsertPage(client, page, registry, "en-US");
    expect(await publishPage(client, pageId)).toBe(4);
    expect([...entries.values()].every((e) => e.sys.publishedVersion !== undefined)).toBe(true);
    expect(await publishPage(client, pageId)).toBe(0);
  });
});
