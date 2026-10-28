import { createHmac } from "node:crypto";
import type { WebhookLibraryPublishPayload } from "@figma/rest-api-spec";
import { describe, expect, it } from "vitest";
import { parseManifest, type DesignSystemManifest } from "@storypage/schema";
import { fakeFigma, KEY } from "../../../packages/figma/test/fixture.js";
import { MANIFESTS_DIR } from "../src/app.js";
import { ReleaseService } from "../src/releases.js";
import { GitHubActionsRunner } from "../src/runners/github.js";
import type { Runner } from "../src/runners/types.js";
import { gatewayFor, RecordingNotifier, seededRepo } from "./helpers.js";

const PASSCODE = "figma-passcode";

function libraryPublish(overrides: Partial<WebhookLibraryPublishPayload> = {}): WebhookLibraryPublishPayload {
  return {
    event_type: "LIBRARY_PUBLISH",
    passcode: PASSCODE,
    timestamp: "2026-10-28T12:00:00Z",
    webhook_id: "wh1",
    file_key: KEY,
    file_name: "Acme Design System",
    description: "New hero and button styles",
    triggered_by: { id: "u1", handle: "Dana", img_url: "" },
    library_item: { key: KEY, name: "Acme Design System" },
    created_components: [{ key: "key-hero", name: "Marketing/Hero" }],
    modified_components: [],
    deleted_components: [],
    created_styles: [],
    modified_styles: [],
    deleted_styles: [],
    created_variables: [],
    modified_variables: [],
    deleted_variables: [],
    ...overrides,
  } as WebhookLibraryPublishPayload;
}

function setup() {
  const repo = seededRepo();
  const notifier = new RecordingNotifier();
  const runner = new GitHubActionsRunner(repo);
  return { repo, notifier, releases: new ReleaseService(repo, runner, notifier), runner };
}

describe("Figma's Publish library → release", () => {
  it("builds what the designer chose, versions it automatically and reports to Slack", async () => {
    const { repo, notifier, releases } = setup();
    const result = await releases.publishLibrary(libraryPublish(), fakeFigma({ enterprise: true, snapshot: false }));

    // The seed's five components were replaced by the library's two: a breaking change.
    expect(result).toMatchObject({ version: "2.0.0", branch: "design-system/v2.0.0", requiredBump: "major" });
    const files = repo.branches.get("design-system/v2.0.0")!;
    const manifest = parseManifest(JSON.parse(files[0]!.content)) as DesignSystemManifest;
    expect(manifest).toMatchObject({ changelog: "New hero and button styles", publishedBy: { name: "Dana" }, source: { figmaFileKey: KEY } });
    expect(manifest.components.map((c) => [c.name, c.placement])).toEqual([
      ["Button", "block"],
      ["Hero", "section"],
    ]);
    expect(files.map((f) => f.path)).toEqual([
      `${MANIFESTS_DIR}/2.0.0.json`,
      `${MANIFESTS_DIR}/2.0.0/previews/Button.png`,
      `${MANIFESTS_DIR}/2.0.0/previews/Hero.png`,
    ]);
    expect(repo.dispatches).toEqual([{ eventType: "design-system-published", payload: { version: "2.0.0", branch: "design-system/v2.0.0" } }]);
    expect(notifier.messages[0]).toMatch(/Dana published \*Acme Design System\*: design system \*2\.0\.0\* \(major release\)/);
  });

  it("ignores Figma's retries of the same delivery", async () => {
    const { repo, releases } = setup();
    const figma = fakeFigma({ enterprise: true, snapshot: false });
    await releases.publishLibrary(libraryPublish(), figma);
    expect(await releases.publishLibrary(libraryPublish(), figma)).toBeNull();
    expect(repo.dispatches).toHaveLength(1);
  });

  it("asks designers to choose components when none are set up", async () => {
    const { repo, notifier, releases } = setup();
    await releases.publishLibrary(libraryPublish(), fakeFigma({ enterprise: true, snapshot: false, selections: false }));
    expect(repo.branches.size).toBe(0);
    expect(notifier.messages[0]).toMatch(/no components are set up for StoryPage yet\. Open the StoryPage plugin/);
  });

  it("won't build with variable values saved before the last release on plans without the variables API", async () => {
    const { repo, notifier, releases } = setup();
    // The seed release was published on 2026-10-27.
    await releases.publishLibrary(
      libraryPublish({ modified_variables: [{ key: "k2", name: "color/brand/primary" }] }),
      fakeFigma({ enterprise: false, snapshot: true, savedAt: "2026-10-26T09:00:00Z" }),
    );
    expect(repo.branches.size).toBe(0);
    expect(notifier.messages[0]).toMatch(/saved variable values are from 2026-10-26, before the last release\. Open the StoryPage plugin/);
  });

  it("builds variable changes from a snapshot saved since the last release", async () => {
    const { repo, releases } = setup();
    const result = await releases.publishLibrary(
      libraryPublish({ modified_variables: [{ key: "k2", name: "color/brand/primary" }] }),
      fakeFigma({ enterprise: false, snapshot: true }),
    );
    expect(result?.version).toBe("2.0.0");
    expect(repo.branches.has("design-system/v2.0.0")).toBe(true);
  });

  it("checks the passcode and only builds the configured library", async () => {
    const { repo, releases, runner } = setup();
    const app = gatewayFor(repo, { releases, runner, figma: { client: fakeFigma({ enterprise: true, snapshot: false }), passcode: PASSCODE, fileKeys: [KEY] } });
    const post = (body: unknown) => app.request("/webhooks/figma", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ ...libraryPublish(), passcode: "wrong" })).status).toBe(401);
    expect((await post({ event_type: "PING", passcode: PASSCODE })).status).toBe(200);
    expect(await (await post({ ...libraryPublish(), file_key: "SomeOtherFile123" })).json()).toEqual({ ok: true, ignored: true });
    expect((await post(libraryPublish())).status).toBe(202);
  });
});

describe("GitHub webhook (hosted runner)", () => {
  const secret = "gh-secret";
  const released: string[] = [];
  const runner: Runner = {
    kind: "local",
    build: async () => ({ statusUrl: "" }),
    release: async (version) => {
      released.push(version);
      return { statusUrl: `https://storypage.example.com/jobs/release-${version}` };
    },
  };

  it("releases a design-system PR when it's merged, and only with a valid signature", async () => {
    const app = gatewayFor(seededRepo(), { runner, githubWebhookSecret: secret });
    const send = (payload: unknown, signatureSecret = secret) => {
      const body = JSON.stringify(payload);
      return app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-event": "pull_request",
          "x-hub-signature-256": `sha256=${createHmac("sha256", signatureSecret).update(body).digest("hex")}`,
        },
        body,
      });
    };
    const merged = { action: "closed", pull_request: { merged: true, head: { ref: "design-system/v1.2.0" } } };
    expect((await send(merged, "forged")).status).toBe(401);
    expect((await send({ ...merged, pull_request: { merged: false, head: { ref: "design-system/v1.2.0" } } })).status).toBe(200);
    expect((await send({ ...merged, pull_request: { merged: true, head: { ref: "feature/x" } } })).status).toBe(200);
    expect((await send(merged)).status).toBe(202);
    expect(released).toEqual(["1.2.0"]);
  });
});
