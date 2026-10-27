/**
 * Contract conformance: every component in the generated registry (i.e. every
 * component published from Figma) must be implemented, exported, documented in
 * Storybook, and render for every editable enum option. This is the gate the
 * storybook-agent has to pass before a release PR is opened.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Block, ComponentContract, PropSpec, PropValue, Registry } from "@storypage/schema";
import { componentMap } from "../src/components";
import registryJson from "../src/generated/registry.json";
import { BlockRenderer } from "../src/renderer/PageRenderer";

const registry = registryJson as Registry;
const stories = import.meta.glob<{ default: { title?: string; component?: unknown } }>(
  "../src/components/*/*.stories.tsx",
  { eager: true },
);

function sampleValue(prop: PropSpec, depth: number): PropValue | undefined {
  switch (prop.kind) {
    case "text":
      return `Sample ${prop.name}`;
    case "longText":
      return `Sample ${prop.name} with a longer sentence of supporting copy.`;
    case "richText":
      return `## Heading\n\nSome **rich** text with a [link](https://example.com).`;
    case "number":
      return typeof prop.default === "number" ? prop.default : 1;
    case "boolean":
      return typeof prop.default === "boolean" ? prop.default : true;
    case "enum":
      return String(prop.default ?? prop.options?.[0]);
    case "link":
      return "/example";
    case "image":
      return { url: "https://placehold.co/600x400/png", alt: "Sample image", width: 600, height: 400 };
    case "slot": {
      if (depth > 2) return undefined;
      const childName = prop.allowedComponents?.[0];
      const child = childName ? registry.components.find((c) => c.name === childName) : undefined;
      if (!child) return undefined;
      const block = sampleBlock(child, depth + 1);
      return prop.multiple ? [block, { ...block, id: "second" }] : block;
    }
  }
}

function sampleBlock(contract: ComponentContract, depth = 0, overrides: Record<string, PropValue> = {}): Block {
  const props: Record<string, PropValue> = {};
  for (const prop of contract.props) {
    const value = sampleValue(prop, depth);
    if (value !== undefined) props[prop.name] = value;
  }
  return { component: contract.name, props: { ...props, ...overrides } };
}

describe("design-system contracts", () => {
  it("has at least one component", () => {
    expect(registry.components.length).toBeGreaterThan(0);
  });

  describe.each(registry.components.map((c) => [c.name, c] as const))("%s", (name, contract) => {
    it("is exported in componentMap", () => {
      expect(componentMap[name], `add ${name} to src/components/index.ts componentMap`).toBeTypeOf("function");
    });

    it("has a Storybook story titled after its Figma category", () => {
      const file = Object.keys(stories).find((f) => f.endsWith(`/${name}/${name}.stories.tsx`));
      expect(file, `create src/components/${name}/${name}.stories.tsx`).toBeDefined();
      expect(stories[file!]!.default.title).toBe(`${contract.category}/${name}`);
      expect(stories[file!]!.default.component).toBe(componentMap[name]);
    });

    it("renders with sample content", () => {
      const html = renderToStaticMarkup(<BlockRenderer block={sampleBlock(contract)} registry={registry} />);
      expect(html.length).toBeGreaterThan(0);
      for (const prop of contract.props.filter((p) => p.kind === "text" && p.editable)) {
        expect(html, `${name} should render its "${prop.name}" text prop`).toContain(`Sample ${prop.name}`);
      }
    });

    const enums = contract.props.filter((p) => p.kind === "enum");
    it.each(enums.flatMap((p) => (p.options ?? []).map((o) => [p.name, o] as const)))(
      "renders %s=%s",
      (propName, option) => {
        const html = renderToStaticMarkup(
          <BlockRenderer block={sampleBlock(contract, 0, { [propName]: option })} registry={registry} />,
        );
        expect(html.length).toBeGreaterThan(0);
      },
    );
  });
});
