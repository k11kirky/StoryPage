import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createContentfulClient, loadPage, publishPage, syncDesignSystem, upsertPage, validateEnvironment, type ContentfulConfig } from "@storypage/contentful";
import { FigmaClient, scanLibrary } from "@storypage/figma";
import { contentTypeIdFor, parseManifest, resolveSelection, toRegistry, type DesignSystemManifest } from "@storypage/schema";
import seedJson from "../../packages/design-system/manifests/1.0.0.json" with { type: "json" };
import { FakeContentful, LOCALE, SPACE_ID, TOKEN } from "../src/fake-contentful.js";
import { FakeFigma, FILE_KEY, TOKEN as FIGMA_TOKEN } from "../src/fake-figma.js";
import { git, LocalGitRepoStore } from "../src/git-repo.js";
import { contractDifferences } from "../src/library.js";
import { listen, type Listening } from "../src/listen.js";
import { addTestimonial, HOME_PAGE } from "../src/scenario.js";

const seed = parseManifest(seedJson);
const servers: Listening[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

async function figmaFor(variables: "rest" | "snapshot") {
  const figma = new FakeFigma(structuredClone(seed), { fileName: "StoryPage Design System", variables, snapshotSavedAt: "2026-10-28T10:00:00.000Z" });
  const client = new FigmaClient({ token: FIGMA_TOKEN, baseUrl: "http://figma.test", fetch: async (input, init) => figma.app.fetch(new Request(input, init)) });
  figma.baseUrl = "http://figma.test";
  return { figma, client };
}

async function scan(client: FigmaClient): Promise<DesignSystemManifest> {
  const result = await scanLibrary(client, FILE_KEY);
  const resolved = resolveSelection(result.drafts, result.selections);
  return parseManifest({ ...result.manifest, components: resolved.components, version: "1.0.0" });
}

describe("fake Figma library", () => {
  it.each(["rest", "snapshot"] as const)("reproduces the design system through the real extractor (variables via %s)", async (variables) => {
    const { client } = await figmaFor(variables);
    expect(contractDifferences(seed, await scan(client))).toEqual([]);
  });

  it("serves designer edits and PNG renders", async () => {
    const { figma, client } = await figmaFor("snapshot");
    figma.edit(addTestimonial);
    const manifest = await scan(client);
    expect(manifest.components.find((c) => c.name === "Testimonial")).toMatchObject({ placement: "section", props: expect.arrayContaining([expect.objectContaining({ name: "avatar", kind: "image" })]) });
    const pngs = await client.renderPngs(FILE_KEY, ["20:1"]);
    expect(Buffer.from(pngs["20:1"]!, "base64").subarray(1, 4).toString()).toBe("PNG");
  });

  it("rejects requests without the token", async () => {
    const { client } = await figmaFor("rest");
    const wrong = new FigmaClient({ token: "nope", baseUrl: "http://figma.test", fetch: (input, init) => (client as unknown as { fetchImpl: typeof fetch }).fetchImpl(input, init) });
    await expect(wrong.getFile(FILE_KEY)).rejects.toThrow(/403/);
  });
});

describe("fake Contentful", () => {
  it("runs the real sync, page and validation code through the Management API client", async () => {
    const fake = new FakeContentful();
    const server = await listen(fake.app);
    servers.push(server);
    const config: ContentfulConfig = { managementToken: TOKEN, spaceId: SPACE_ID, environment: "master", locale: LOCALE, host: server.url.replace("http://", ""), insecure: true };

    const v1 = toRegistry(seed);
    await syncDesignSystem({ config, registry: v1, log: () => {} });
    expect(fake.aliasTarget()).toBe("ds-1-0-0");
    const client = createContentfulClient(config);
    const home = await upsertPage(client, HOME_PAGE, v1, LOCALE);
    expect(await publishPage(client, home.pageId)).toBe(6);

    // A second release clones the live environment, migrates the clone and moves the alias.
    const v2 = toRegistry(parseManifest({ ...addTestimonial(structuredClone(seed)), schemaVersion: 1, version: "1.1.0", publishedAt: seed.publishedAt, publishedBy: seed.publishedBy, source: seed.source, changelog: "" }));
    const result = await syncDesignSystem({ config, registry: v2, log: () => {} });
    expect(result.changes.find((c) => c.id === contentTypeIdFor("Testimonial"))?.action).toBe("create");
    expect(fake.aliasTarget()).toBe("ds-1-1-0");
    expect(fake.environments.get("ds-1-0-0")?.contentTypes.has(contentTypeIdFor("Testimonial"))).toBe(false);
    expect((await loadPage(client, "home", v2, LOCALE))?.sections).toHaveLength(2);
    expect(await validateEnvironment(config, { environment: "ds-1-1-0", previousEnvironment: "ds-1-0-0", strategy: "alias" }, v2)).toEqual({ pages: 1, issues: [] });
  });

  it("enforces versions and content types like Contentful", async () => {
    const fake = new FakeContentful();
    const server = await listen(fake.app);
    servers.push(server);
    const client = createContentfulClient({ managementToken: TOKEN, spaceId: SPACE_ID, environment: "master", locale: LOCALE, host: server.url.replace("http://", ""), insecure: true });
    await expect(client.entry.create({ contentTypeId: "nope" }, { fields: {} })).rejects.toThrow(/doesn't exist or isn't published/);
    const type = await client.contentType.createWithId({ contentTypeId: "note" }, { name: "Note", fields: [{ id: "title", name: "Title", type: "Symbol", required: true, localized: false }] });
    await client.contentType.publish({ contentTypeId: "note" }, type);
    await expect(client.entry.create({ contentTypeId: "note" }, { fields: { body: { [LOCALE]: "x" } } })).rejects.toThrow(/"name": "unknown"/);
    const entry = await client.entry.create({ contentTypeId: "note" }, { fields: {} });
    await expect(client.entry.publish({ entryId: entry.sys.id }, entry)).rejects.toThrow(/"name": "required"/);
    await client.entry.update({ entryId: entry.sys.id }, { ...entry, fields: { title: { [LOCALE]: "Hi" } } });
    await expect(client.entry.update({ entryId: entry.sys.id }, { ...entry, fields: {} })).rejects.toThrow(/Version mismatch/);
  });
});

describe("local git repository", () => {
  it("commits release branches, records pull requests and merges them", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "storypage-e2e-git-"));
    const work = path.join(root, "work");
    const bare = path.join(root, "origin.git");
    git(root, ["init", "--quiet", "-b", "main", work]);
    writeFileSync(path.join(work, "README.md"), "hello\n");
    git(work, ["add", "."]);
    git(work, ["commit", "--quiet", "-m", "init"]);
    git(root, ["init", "--quiet", "--bare", "-b", "main", bare]);
    git(work, ["-c", "push.negotiate=false", "push", "--quiet", bare, "main"]);

    const repo = new LocalGitRepoStore(bare, "main", (n) => `http://gateway/e2e/pulls/${n}`);
    await repo.commitToNewBranch("design-system/v1.1.0", [{ path: "a/b.json", content: "{}\n", encoding: "utf-8" }, { path: "a/c.png", content: Buffer.from("png").toString("base64"), encoding: "base64" }], "Publish 1.1.0");
    expect(await repo.branchExists("design-system/v1.1.0")).toBe(true);
    expect(await repo.readFile("a/b.json")).toBeNull();
    const url = await repo.openPullRequest({ branch: "design-system/v1.1.0", title: "Design system 1.1.0", body: "body", draft: false });
    expect(url).toBe("http://gateway/e2e/pulls/1");
    repo.merge(repo.pullRequests[0]!);
    expect(await repo.readFile("a/b.json")).toBe("{}\n");
    expect(await repo.readFile("README.md")).toBe("hello\n");
    expect(repo.pullRequests[0]!.state).toBe("merged");
  });
});
