import type { ReactNode } from "react";
import { findComponent, type Block, type PageDocument, type PropValue, type Registry } from "@storypage/schema";
import { componentMap } from "../components";
import registryJson from "../generated/registry.json";

const defaultRegistry = registryJson as Registry;

const isBlock = (v: PropValue): v is Block =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "component" in v;

export interface BlockRendererProps {
  block: Block;
  registry?: Registry;
}

/** Renders one block and, recursively, the blocks in its slot props. */
export function BlockRenderer({ block, registry = defaultRegistry }: BlockRendererProps): ReactNode {
  const Component = componentMap[block.component];
  const contract = findComponent(registry, block.component);
  if (!Component || !contract) {
    return import.meta.env.DEV ? (
      <div role="alert" style={{ padding: 16, border: "1px dashed red" }}>
        Unknown component “{block.component}” (design-system@{registry.version})
      </div>
    ) : null;
  }
  const props: Record<string, unknown> = {};
  for (const prop of contract.props) {
    const value = block.props[prop.name];
    if (value === undefined || value === null) continue;
    if (prop.kind === "slot") {
      if (Array.isArray(value)) {
        props[prop.name] = value.map((child, i) => (
          <BlockRenderer key={child.id ?? i} block={child} registry={registry} />
        ));
      } else if (isBlock(value)) {
        props[prop.name] = <BlockRenderer block={value} registry={registry} />;
      }
    } else {
      props[prop.name] = value;
    }
  }
  return <Component {...props} />;
}

export interface PageRendererProps {
  page: PageDocument;
  registry?: Registry;
}

export function PageRenderer({ page, registry = defaultRegistry }: PageRendererProps) {
  return (
    <main data-page={page.slug} data-design-system-version={page.designSystemVersion ?? registry.version}>
      {page.sections.map((section, i) => (
        <BlockRenderer key={section.id ?? i} block={section} registry={registry} />
      ))}
    </main>
  );
}
