import type { ComponentSpec, DesignSystemManifest, Placement, PropSpec } from "./manifest.js";

/**
 * The registry is the code-facing view of the manifest: the component contracts
 * without Figma layout detail. It is generated into
 * `packages/design-system/src/registry.json`, shipped with the Storybook build
 * (`/registry.json`), and read by the Contentful sync and the Slack composer.
 */
export interface ComponentContract {
  name: string;
  description: string;
  category: string;
  placement: Placement;
  figmaKey: string;
  props: PropSpec[];
}

export interface Registry {
  name: string;
  version: string;
  generatedFrom: { figmaFileKey: string; publishedAt: string };
  components: ComponentContract[];
}

export function toContract(spec: ComponentSpec): ComponentContract {
  return {
    name: spec.name,
    description: spec.description,
    category: spec.category,
    placement: spec.placement,
    figmaKey: spec.figmaKey,
    props: spec.props,
  };
}

export function toRegistry(manifest: DesignSystemManifest): Registry {
  return {
    name: manifest.name,
    version: manifest.version,
    generatedFrom: {
      figmaFileKey: manifest.source.figmaFileKey,
      publishedAt: manifest.publishedAt,
    },
    components: manifest.components
      .map(toContract)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function findComponent(registry: Registry, name: string): ComponentContract | undefined {
  return registry.components.find((c) => c.name === name);
}

export function editableProps(contract: ComponentContract): PropSpec[] {
  return contract.props.filter((p) => p.editable);
}

/** Components that can be placed directly in a page's `sections`. */
export function sectionComponents(registry: Registry): ComponentContract[] {
  return registry.components.filter((c) => c.placement === "section");
}

/** Storybook story id for a component's docs page, e.g. `components-button--docs`. */
export function storybookDocsId(contract: Pick<ComponentContract, "name" | "category">): string {
  // Mirrors Storybook's `sanitize`: lowercase, punctuation/space runs become "-".
  const slug = (s: string) =>
    s
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
  return `${slug(contract.category)}-${slug(contract.name)}--docs`;
}
