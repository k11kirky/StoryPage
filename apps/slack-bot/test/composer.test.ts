import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StageOptions } from "@storypage/agents";
import type { PlainClientAPI } from "@storypage/contentful";
import { parseManifest, toRegistry } from "@storypage/schema";

const calls: StageOptions[] = [];
let onCall: (options: StageOptions) => Promise<void> = async () => {};
vi.mock("@storypage/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@storypage/agents")>();
  return {
    ...actual,
    runStage: vi.fn(async (options: StageOptions) => {
      calls.push(options);
      await onCall(options);
      return { sessionId: "session-1", success: true, summary: "Built *Summit*:\n• Hero", output: null, costUsd: 0.1, turns: 3 };
    }),
  };
});
const { compose } = await import("../src/composer.js");

const registry = toRegistry(
  parseManifest(JSON.parse(readFileSync(new URL("../../../packages/design-system/manifests/1.0.0.json", import.meta.url), "utf8"))),
);
const created: string[] = [];
const contentful = {
  contentType: {
    get: async ({ contentTypeId }: { contentTypeId: string }) => ({
      fields: registry.components.find((c) => `ds${c.name}` === contentTypeId)!.props.map((p) => ({ id: p.name })),
    }),
  },
  entry: {
    getMany: async () => ({ items: [] }),
    create: async ({ contentTypeId }: { contentTypeId: string }) => {
      created.push(contentTypeId);
      return { sys: { id: `e${created.length}` } };
    },
  },
} as unknown as PlainClientAPI;

const ctx = {
  contentful,
  config: { managementToken: "cfm", spaceId: "space1", environment: "master", locale: "en-US" },
  release: { version: "1.0.0", registry, storybookUrl: "https://design.example.com", environment: "ds-1-0-0" },
  previewSigningSecret: "secret",
  storybookDocsUrl: "http://127.0.0.1:5555/mcp",
  workDir: "/tmp/bot",
};

beforeEach(() => {
  calls.length = 0;
  created.length = 0;
  onCall = async () => {};
});

describe("compose", () => {
  it("gives the agent read-only Contentful, Storybook docs and the validated page tools", async () => {
    await compose(ctx, undefined, "<@U1>: a page for our summit");
    const options = calls[0]!;
    expect(options.persona).toBe("custom");
    expect(options.tools.filter((t) => !t.startsWith("mcp__"))).toEqual([]);
    expect(options.tools).toEqual(expect.arrayContaining(["mcp__pipeline__save_page_draft", "mcp__storybook__docs-show", "mcp__contentful__search_entries"]));
    expect(options.tools.filter((t) => /create|update|publish|delete/.test(t) && t.startsWith("mcp__contentful"))).toEqual([]);
    expect(options.mcpServers.contentful).toMatchObject({ env: { ENVIRONMENT_ID: "master", PROTECTED_ENVIRONMENTS: "master,ds-1-0-0" } });
    expect(options.instructions).toContain("Design system StoryPage@1.0.0");
  });

  it("resumes the thread's session and reports the saved draft", async () => {
    onCall = async (options) => {
      // Simulate the agent calling save_page_draft on the in-process MCP server
      // (reaches into the MCP SDK's tool registry; the agents e2e test covers the real call path).
      const server = options.mcpServers.pipeline as unknown as { instance: { _registeredTools: Record<string, { handler?: (a: unknown, e: unknown) => Promise<unknown>; callback?: (a: unknown, e: unknown) => Promise<unknown> }> } };
      const tool = server.instance._registeredTools.save_page_draft!;
      await (tool.handler ?? tool.callback)!(
        {
          title: "Summit",
          slug: "summit",
          sections: [{ component: "Hero", props: { headline: "Join us", cta: { component: "Button", props: { label: "Register", href: "/summit" } } } }],
        },
        {},
      );
    };
    const result = await compose(ctx, "session-0", "<@U1>: make the headline punchier");
    expect(calls[0]!.resume).toBe("session-0");
    expect(result).toMatchObject({ sessionId: "session-1", reply: "Built *Summit*:\n• Hero", draft: { slug: "summit", designSystemVersion: "1.0.0" } });
    expect(created).toEqual(["dsButton", "dsHero", "page"]);
  });
});
