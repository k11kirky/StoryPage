import { z } from "zod";
import type { PropSpec } from "./manifest.js";
import { contentProps, findComponent, slotTargets, type Registry } from "./registry.js";

/**
 * A CMS-agnostic page: a tree of component blocks whose props follow the
 * registry contracts. The Slack composer produces it, the Contentful package
 * writes it as entries, and the design system's `PageRenderer` renders it.
 */

export interface ImageValue {
  /** An existing Contentful asset id, or a URL to import. */
  assetId?: string | undefined;
  url?: string | undefined;
  alt: string;
  width?: number | undefined;
  height?: number | undefined;
}

export type PropValue = string | number | boolean | ImageValue | Block | Block[] | null;

export interface Block {
  component: string;
  /** Contentful entry id once persisted. */
  id?: string | undefined;
  props: Record<string, PropValue>;
}

export interface PageDocument {
  title: string;
  slug: string;
  description?: string | undefined;
  designSystemVersion?: string | undefined;
  sections: Block[];
}

export const ImageValueSchema = z
  .object({
    assetId: z.string().optional(),
    url: z.string().url().optional(),
    alt: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .refine((v) => v.assetId || v.url, "image needs an assetId or a url");

export const BlockSchema: z.ZodType<Block> = z.lazy(() =>
  z.object({
    component: z.string(),
    id: z.string().optional(),
    props: z.record(
      z.string(),
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        ImageValueSchema,
        BlockSchema,
        z.array(BlockSchema),
      ]),
    ),
  }),
);

export const PageDocumentSchema = z.object({
  title: z.string().min(1),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/, "slug must be kebab-case"),
  description: z.string().optional(),
  designSystemVersion: z.string().optional(),
  sections: z.array(BlockSchema).min(1),
});

export interface PageIssue {
  path: string;
  message: string;
}

const isBlock = (v: unknown): v is Block =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "component" in v && "props" in v;

const isImage = (v: unknown): v is ImageValue =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "alt" in v && ("url" in v || "assetId" in v);

function validateValue(prop: PropSpec, value: PropValue, path: string, registry: Registry, issues: PageIssue[]) {
  const fail = (message: string) => issues.push({ path, message });
  switch (prop.kind) {
    case "text":
    case "longText":
    case "richText":
      if (typeof value !== "string") return fail(`expected a string (${prop.kind})`);
      if (prop.kind === "text" && value.length > 255) fail("text props are limited to 255 characters");
      return;
    case "link":
      if (typeof value !== "string" || !/^(https?:\/\/|\/|mailto:|#)/.test(value)) {
        fail("expected a URL or site-relative path");
      }
      return;
    case "number":
      if (typeof value !== "number") fail("expected a number");
      return;
    case "boolean":
      if (typeof value !== "boolean") fail("expected a boolean");
      return;
    case "enum":
      if (typeof value !== "string" || !prop.options?.includes(value)) {
        fail(`expected one of: ${(prop.options ?? []).join(", ")}`);
      }
      return;
    case "image":
      if (!isImage(value)) fail("expected an image: { url | assetId, alt }");
      return;
    case "slot": {
      const blocks = prop.multiple ? value : [value];
      if (prop.multiple && !Array.isArray(value)) return fail("expected a list of blocks");
      if (!prop.multiple && Array.isArray(value)) return fail("expected a single block, not a list");
      (blocks as unknown[]).forEach((child, i) => {
        const childPath = prop.multiple ? `${path}[${i}]` : path;
        if (!isBlock(child)) {
          issues.push({ path: childPath, message: "expected a component block" });
          return;
        }
        const allowed = slotTargets(prop, registry);
        if (!allowed.includes(child.component)) {
          issues.push({ path: childPath, message: `${child.component} is not allowed here; use one of: ${allowed.join(", ")}` });
          return;
        }
        validateBlock(child, registry, childPath, issues);
      });
      return;
    }
  }
}

export function validateBlock(block: Block, registry: Registry, path: string, issues: PageIssue[] = []): PageIssue[] {
  const contract = findComponent(registry, block.component);
  if (!contract) {
    issues.push({
      path,
      message: `unknown component "${block.component}". Available: ${registry.components.map((c) => c.name).join(", ")}`,
    });
    return issues;
  }
  if (contract.placement === "none") {
    issues.push({ path, message: `${contract.name} is a Storybook-only building block and can't be placed on a page` });
    return issues;
  }
  const props = new Map(contract.props.map((p) => [p.name, p]));
  const content = new Set(contentProps(contract, registry).map((p) => p.name));
  for (const key of Object.keys(block.props)) {
    const prop = props.get(key);
    if (!prop) {
      issues.push({ path: `${path}.${key}`, message: `${contract.name} has no prop "${key}"` });
    } else if (!content.has(key)) {
      issues.push({ path: `${path}.${key}`, message: `${contract.name}.${key} is not editable content` });
    }
  }
  for (const prop of contract.props) {
    if (!content.has(prop.name)) continue;
    const value = block.props[prop.name];
    if (value === undefined || value === null) {
      if (prop.required && prop.default === undefined) {
        issues.push({ path: `${path}.${prop.name}`, message: `required ${prop.kind} prop is missing` });
      }
      continue;
    }
    validateValue(prop, value, `${path}.${prop.name}`, registry, issues);
  }
  return issues;
}

/** Validates a page against the registry; returns an empty array when valid. */
export function validatePage(page: PageDocument, registry: Registry): PageIssue[] {
  const parsed = PageDocumentSchema.safeParse(page);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({ path: i.path.join(".") || "page", message: i.message }));
  }
  const issues: PageIssue[] = [];
  page.sections.forEach((section, i) => {
    const path = `sections[${i}]`;
    const contract = findComponent(registry, section.component);
    if (contract && contract.placement !== "section") {
      issues.push({ path, message: `${contract.name} cannot be used as a top-level section` });
    }
    validateBlock(section, registry, path, issues);
  });
  return issues;
}
