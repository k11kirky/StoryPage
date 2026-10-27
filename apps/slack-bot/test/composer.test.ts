import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { PlainClientAPI } from "@storypage/contentful";
import { parseManifest, toRegistry } from "@storypage/schema";
import { compose, type ComposeContext } from "../src/composer.js";

const registry = toRegistry(
  parseManifest(
    JSON.parse(readFileSync(new URL("../../../packages/design-system/manifests/1.0.0.json", import.meta.url), "utf8")),
  ),
);

/** A fake Messages API that replays scripted responses and records requests. */
function scriptedAnthropic(responses: Array<Partial<Anthropic.Beta.BetaMessage>>) {
  const requests: Record<string, unknown>[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    if (!next) throw new Error("No scripted response left");
    const body = {
      id: `msg_${requests.length}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      ...next,
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { client: new Anthropic({ apiKey: "test", fetch, maxRetries: 0 }), requests };
}

function fakeContentful() {
  const created: { contentTypeId: string; fields: unknown }[] = [];
  const client = {
    contentType: {
      get: async ({ contentTypeId }: { contentTypeId: string }) => {
        const name = contentTypeId.slice(2);
        const contract = registry.components.find((c) => c.name === name)!;
        return { fields: contract.props.map((p) => ({ id: p.name })) };
      },
    },
    entry: {
      getMany: async () => ({ items: [] }),
      create: async ({ contentTypeId }: { contentTypeId: string }, { fields }: { fields: unknown }) => {
        created.push({ contentTypeId, fields });
        return { sys: { id: `e${created.length}` } };
      },
    },
  };
  return { client: client as unknown as PlainClientAPI, created };
}

const toolUse = (id: string, name: string, input: unknown) => ({
  stop_reason: "tool_use" as const,
  content: [{ type: "tool_use" as const, id, name, input, caller: { type: "direct" as const } }],
});

describe("compose", () => {
  it("feeds validation errors back, saves the draft and returns the full thread history", async () => {
    const invalid = {
      title: "Summit",
      slug: "summit",
      sections: [{ component: "Hero", props: { headline: "Join us", cta: { component: "FeatureCard", props: {} } } }],
    };
    const valid = {
      ...invalid,
      sections: [
        {
          component: "Hero",
          props: { headline: "Join us", cta: { component: "Button", props: { label: "Register", href: "/summit/register" } } },
        },
      ],
    };
    const anthropic = scriptedAnthropic([
      toolUse("t1", "save_page_draft", invalid),
      toolUse("t2", "save_page_draft", valid),
      { content: [{ type: "text", text: "Built *Summit*:\n• Hero", citations: null }] },
    ]);
    const contentful = fakeContentful();
    const ctx: ComposeContext = {
      anthropic: anthropic.client,
      contentful: contentful.client,
      release: { version: "1.0.0", registry, storybookUrl: "https://design.example.com", environment: "ds-1-0-0" },
      spaceId: "space",
      environment: "master",
      locale: "en-US",
      model: "claude-opus-5-5",
    };

    const result = await compose(ctx, [], "Make a page for our summit");

    expect(result.reply).toBe("Built *Summit*:\n• Hero");
    expect(result.draft).toMatchObject({ slug: "summit", designSystemVersion: "1.0.0" });
    expect(contentful.created.map((c) => c.contentTypeId)).toEqual(["dsButton", "dsHero", "page"]);

    const firstRequest = anthropic.requests[0]!;
    expect(firstRequest).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", thinking: { type: "adaptive" } });
    expect(JSON.stringify(firstRequest.system)).toContain("FeatureGrid");

    const secondRequest = anthropic.requests[1]! as { messages: Anthropic.Beta.BetaMessageParam[] };
    const toolResult = JSON.stringify(secondRequest.messages.at(-1));
    expect(toolResult).toContain("FeatureCard is not allowed here; use one of: Button");

    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  });
});
