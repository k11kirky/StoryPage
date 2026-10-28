import { beforeEach, describe, expect, it } from "vitest";
import { signPreview } from "@storypage/contentful";
import type { DesignSystemManifest } from "@storypage/schema";
import { createApp, DISPATCH_EVENT, MANIFESTS_DIR } from "../src/app.js";
import { FakeRepo, gatewayFor, PNG, seed, seededRepo, TOKEN } from "./helpers.js";

function nextVersion(version: string, mutate: (m: DesignSystemManifest) => void = () => {}) {
  const manifest = structuredClone(seed);
  manifest.version = version;
  mutate(manifest);
  return manifest;
}

describe("gateway", () => {
  let repo: FakeRepo;
  let app: ReturnType<typeof createApp>;
  const post = (path: string, body: unknown, token = TOKEN) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    repo = seededRepo();
    app = gatewayFor(repo);
  });

  it("rejects requests without the publish token", async () => {
    const response = await post("/api/design-system/publish", {}, "wrong");
    expect(response.status).toBe(401);
  });

  it("returns the current manifest", async () => {
    const response = await app.request("/api/design-system/current", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as DesignSystemManifest).version).toBe("1.0.0");
  });

  it("suggests the next version in a dry run", async () => {
    const manifest = nextVersion("0.0.0", (m) => {
      m.components[0]!.props.push({ name: "icon", kind: "image", required: false, editable: true });
    });
    const response = await post("/api/design-system/diff", { manifest });
    expect(await response.json()).toMatchObject({ currentVersion: "1.0.0", suggestedVersion: "1.1.0", requiredBump: "minor" });
  });

  it("refuses an under-bumped version with the version it needs", async () => {
    const manifest = nextVersion("1.0.1", (m) => {
      m.components = m.components.filter((c) => c.name !== "RichTextSection");
    });
    const response = await post("/api/design-system/publish", { manifest });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ suggestedVersion: "2.0.0" });
  });

  it("refuses a publish with no changes", async () => {
    const response = await post("/api/design-system/publish", { manifest: nextVersion("1.0.1") });
    expect(response.status).toBe(409);
  });

  it("commits the manifest and previews to a release branch and starts the build", async () => {
    const manifest = nextVersion("1.1.0", (m) => {
      m.changelog = "Buttons can have icons";
      m.components[0]!.props.push({ name: "icon", kind: "image", required: false, editable: true });
    });
    const response = await post("/api/design-system/publish", { manifest, previews: { Button: PNG, Unknown: PNG } });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ version: "1.1.0", branch: "design-system/v1.1.0" });

    const files = repo.branches.get("design-system/v1.1.0")!;
    expect(files.map((f) => f.path)).toEqual([
      `${MANIFESTS_DIR}/1.1.0.json`,
      `${MANIFESTS_DIR}/1.1.0/previews/Button.png`,
    ]);
    const committed = JSON.parse(files[0]!.content) as DesignSystemManifest;
    expect(committed.components[0]!.preview).toBe("1.1.0/previews/Button.png");
    expect(repo.dispatches).toEqual([
      { eventType: DISPATCH_EVENT, payload: { version: "1.1.0", branch: "design-system/v1.1.0" } },
    ]);

    const again = await post("/api/design-system/publish", { manifest });
    expect(again.status).toBe(409);
  });

  it("explains invalid manifests", async () => {
    const manifest = nextVersion("1.1.0", (m) => {
      m.components[2]!.props.find((p) => p.name === "cta")!.allowedComponents = ["Ghost"];
    });
    const response = await post("/api/design-system/publish", { manifest });
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain('unknown component \\"Ghost\\"');
  });

  it("serves draft pages only for signed, unexpired preview links", async () => {
    const page = { title: "Launch", slug: "events/launch", sections: [] };
    const previewApp = gatewayFor(repo, {
      preview: { signingSecret: "s3cret", loadPage: async (slug) => (slug === page.slug ? page : null) },
    });
    const { exp, sig } = signPreview(page.slug, "s3cret");
    const ok = await previewApp.request(`/preview/pages/events/launch?exp=${exp}&sig=${sig}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(page);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");

    const forged = await previewApp.request(`/preview/pages/events/other?exp=${exp}&sig=${sig}`);
    expect(forged.status).toBe(403);
    const unsigned = await previewApp.request("/preview/pages/events/launch");
    expect(unsigned.status).toBe(403);
  });
});
