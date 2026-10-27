import { z } from "zod";

/**
 * The design-system manifest is the single artifact the Figma plugin publishes.
 * Everything downstream (tokens, Storybook components, Contentful content types,
 * the Slack page composer) is derived from it, so it is versioned with semver and
 * committed to the repo at `packages/design-system/manifests/<version>.json`.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export const TokenAliasSchema = z.object({ alias: z.string().min(1) });

export const TokenValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  TokenAliasSchema,
]);

export const TokenTypeSchema = z.enum([
  "color",
  "dimension",
  "number",
  "string",
  "boolean",
  "fontFamily",
  "fontWeight",
]);

export const TokenSchema = z.object({
  /** Slash-delimited path as named in Figma, e.g. `color/brand/primary`. */
  name: z.string().min(1),
  type: TokenTypeSchema,
  collection: z.string().min(1),
  description: z.string().optional(),
  /** Value per mode name (e.g. `Light`, `Dark`). */
  values: z.record(z.string(), TokenValueSchema),
});

export const TokenCollectionSchema = z.object({
  name: z.string().min(1),
  modes: z.array(z.string().min(1)).min(1),
  defaultMode: z.string().min(1),
});

export const TextStyleSchema = z.object({
  name: z.string().min(1),
  fontFamily: z.string(),
  fontWeight: z.number(),
  fontSize: z.number(),
  /** Pixels, a percentage string such as `150%`, or `normal`. */
  lineHeight: z.union([z.number(), z.string()]),
  letterSpacing: z.union([z.number(), z.string()]),
  textCase: z.enum(["none", "upper", "lower", "title"]).default("none"),
});

export const EffectStyleSchema = z.object({
  name: z.string().min(1),
  /** CSS `box-shadow` value. */
  boxShadow: z.string(),
});

export const PropKindSchema = z.enum([
  "text",
  "longText",
  "richText",
  "number",
  "boolean",
  "enum",
  "image",
  "link",
  "slot",
]);

export const PropSpecSchema = z.object({
  /** camelCase prop name used in React and as the Contentful field id. */
  name: z.string().regex(/^[a-z][A-Za-z0-9]*$/, "props must be camelCase"),
  figmaName: z.string().optional(),
  kind: PropKindSchema,
  description: z.string().optional(),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** For `slot` props: component names that may be placed in the slot. */
  allowedComponents: z.array(z.string()).optional(),
  /** For `slot` props: whether the slot holds a list. */
  multiple: z.boolean().optional(),
  /**
   * Whether content editors (and the Slack composer) can set this prop.
   * Purely presentational variants such as `state=hover` are `false`.
   */
  editable: z.boolean().default(true),
});

export const PlacementSchema = z.enum(["section", "block", "none"]);

/** A trimmed copy of the Figma node tree for the default variant. */
export interface LayoutNode {
  name: string;
  type: string;
  width?: number | undefined;
  height?: number | undefined;
  layout?:
    | {
        mode: "HORIZONTAL" | "VERTICAL" | "NONE" | "GRID";
        gap?: number | undefined;
        padding?: [number, number, number, number] | undefined;
        align?: string | undefined;
        justify?: string | undefined;
        wrap?: boolean | undefined;
      }
    | undefined;
  radius?: number | undefined;
  fills?: string[] | undefined;
  strokes?: string[] | undefined;
  textStyle?: string | undefined;
  characters?: string | undefined;
  /** Token names bound to this node's properties, keyed by property. */
  tokens?: Record<string, string> | undefined;
  /** Name of the component this node is an instance of. */
  instanceOf?: string | undefined;
  children?: LayoutNode[] | undefined;
}

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
    layout: z
      .object({
        mode: z.enum(["HORIZONTAL", "VERTICAL", "NONE", "GRID"]),
        gap: z.number().optional(),
        padding: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
        align: z.string().optional(),
        justify: z.string().optional(),
        wrap: z.boolean().optional(),
      })
      .optional(),
    radius: z.number().optional(),
    fills: z.array(z.string()).optional(),
    strokes: z.array(z.string()).optional(),
    textStyle: z.string().optional(),
    characters: z.string().optional(),
    tokens: z.record(z.string(), z.string()).optional(),
    instanceOf: z.string().optional(),
    children: z.array(LayoutNodeSchema).optional(),
  }),
);

export const ComponentSpecSchema = z.object({
  /** Stable Figma component (set) key. Survives renames. */
  figmaKey: z.string().min(1),
  figmaNodeId: z.string().optional(),
  /** PascalCase component name used in code and Contentful. */
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "components must be PascalCase"),
  figmaName: z.string(),
  description: z.string().default(""),
  category: z.string().default("Components"),
  placement: PlacementSchema.default("block"),
  props: z.array(PropSpecSchema),
  variantCount: z.number().int().nonnegative().default(1),
  layout: LayoutNodeSchema.optional(),
  /** Exported PNG preview, relative to `manifests/` (e.g. `1.2.0/previews/Button.png`). */
  preview: z.string().optional(),
});

export const DesignSystemManifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  name: z.string().min(1),
  version: z.string().regex(semverPattern, "version must be semver"),
  changelog: z.string().default(""),
  publishedAt: z.string().datetime(),
  publishedBy: z.object({
    name: z.string(),
    figmaUserId: z.string().optional(),
  }),
  source: z.object({
    figmaFileKey: z.string(),
    figmaFileName: z.string(),
  }),
  collections: z.array(TokenCollectionSchema),
  tokens: z.array(TokenSchema),
  textStyles: z.array(TextStyleSchema).default([]),
  effectStyles: z.array(EffectStyleSchema).default([]),
  components: z.array(ComponentSpecSchema),
});

export type TokenValue = z.infer<typeof TokenValueSchema>;
export type TokenType = z.infer<typeof TokenTypeSchema>;
export type Token = z.infer<typeof TokenSchema>;
export type TokenCollection = z.infer<typeof TokenCollectionSchema>;
export type TextStyle = z.infer<typeof TextStyleSchema>;
export type EffectStyle = z.infer<typeof EffectStyleSchema>;
export type PropKind = z.infer<typeof PropKindSchema>;
export type PropSpec = z.infer<typeof PropSpecSchema>;
export type Placement = z.infer<typeof PlacementSchema>;
export type ComponentSpec = z.infer<typeof ComponentSpecSchema>;
export type DesignSystemManifest = z.infer<typeof DesignSystemManifestSchema>;
export type DesignSystemManifestInput = z.input<typeof DesignSystemManifestSchema>;

/**
 * Parses a manifest and runs the cross-field checks zod can't express:
 * unique names, slot references that resolve, enum defaults that exist.
 */
export function parseManifest(input: unknown): DesignSystemManifest {
  const manifest = DesignSystemManifestSchema.parse(input);
  const problems = lintManifest(manifest);
  if (problems.length > 0) {
    throw new ManifestError(problems);
  }
  return manifest;
}

export class ManifestError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid design-system manifest:\n- ${problems.join("\n- ")}`);
    this.name = "ManifestError";
  }
}

export function lintManifest(manifest: DesignSystemManifest): string[] {
  const problems: string[] = [];
  const componentNames = new Set<string>();
  for (const component of manifest.components) {
    if (componentNames.has(component.name)) {
      problems.push(`Duplicate component name "${component.name}"`);
    }
    componentNames.add(component.name);
  }

  const tokenNames = new Set<string>();
  for (const token of manifest.tokens) {
    if (tokenNames.has(token.name)) problems.push(`Duplicate token "${token.name}"`);
    tokenNames.add(token.name);
  }
  for (const token of manifest.tokens) {
    for (const value of Object.values(token.values)) {
      if (typeof value === "object" && !tokenNames.has(value.alias)) {
        problems.push(`Token "${token.name}" aliases unknown token "${value.alias}"`);
      }
    }
  }

  for (const component of manifest.components) {
    const propNames = new Set<string>();
    for (const prop of component.props) {
      const where = `${component.name}.${prop.name}`;
      if (propNames.has(prop.name)) problems.push(`Duplicate prop ${where}`);
      propNames.add(prop.name);
      if (prop.kind === "enum") {
        if (!prop.options?.length) problems.push(`Enum prop ${where} has no options`);
        if (prop.default !== undefined && !prop.options?.includes(String(prop.default))) {
          problems.push(`Enum prop ${where} default "${prop.default}" is not an option`);
        }
      }
      if (prop.kind === "slot") {
        for (const allowed of prop.allowedComponents ?? []) {
          if (!componentNames.has(allowed)) {
            problems.push(`Slot ${where} allows unknown component "${allowed}"`);
          }
        }
      }
    }
  }
  return problems;
}
