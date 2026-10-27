import semver from "semver";
import type { ComponentSpec, DesignSystemManifest, PropSpec, Token } from "./manifest.js";

export type Bump = "major" | "minor" | "patch";

export interface PropChange {
  name: string;
  before: PropSpec;
  after: PropSpec;
  changes: string[];
  breaking: boolean;
  /** Adds capability (new enum options, newly accepted slot components). */
  additive: boolean;
}

export interface ComponentChange {
  name: string;
  before: ComponentSpec;
  after: ComponentSpec;
  propsAdded: PropSpec[];
  propsRemoved: PropSpec[];
  propsChanged: PropChange[];
  /** Non-prop changes such as description, placement or layout. */
  otherChanges: string[];
  breaking: boolean;
}

export interface ManifestDiff {
  from: string | null;
  to: string;
  tokens: { added: Token[]; removed: Token[]; changed: Token[] };
  components: {
    added: ComponentSpec[];
    removed: ComponentSpec[];
    changed: ComponentChange[];
  };
  breakingReasons: string[];
  requiredBump: Bump;
  isEmpty: boolean;
}

function diffProp(before: PropSpec, after: PropSpec): PropChange | null {
  const changes: string[] = [];
  let breaking = false;

  if (before.kind !== after.kind) {
    changes.push(`kind ${before.kind} → ${after.kind}`);
    breaking = true;
  }
  if (!before.required && after.required) {
    changes.push("became required");
    breaking = true;
  } else if (before.required && !after.required) {
    changes.push("became optional");
  }
  const removedOptions = (before.options ?? []).filter((o) => !after.options?.includes(o));
  const addedOptions = (after.options ?? []).filter((o) => !before.options?.includes(o));
  if (removedOptions.length) {
    changes.push(`options removed: ${removedOptions.join(", ")}`);
    breaking = true;
  }
  if (addedOptions.length) changes.push(`options added: ${addedOptions.join(", ")}`);

  const removedAllowed = (before.allowedComponents ?? []).filter(
    (c) => !after.allowedComponents?.includes(c),
  );
  const addedAllowed = (after.allowedComponents ?? []).filter(
    (c) => !before.allowedComponents?.includes(c),
  );
  if (removedAllowed.length) {
    changes.push(`slot no longer accepts: ${removedAllowed.join(", ")}`);
    breaking = true;
  }
  if (addedAllowed.length) changes.push(`slot now accepts: ${addedAllowed.join(", ")}`);
  if (Boolean(before.multiple) !== Boolean(after.multiple)) {
    changes.push(after.multiple ? "slot became a list" : "slot became single");
    breaking = true;
  }
  if (before.editable && !after.editable) {
    changes.push("no longer editable in CMS");
    breaking = true;
  } else if (!before.editable && after.editable) {
    changes.push("now editable in CMS");
  }
  if (before.default !== after.default) changes.push(`default ${before.default} → ${after.default}`);
  if ((before.description ?? "") !== (after.description ?? "")) changes.push("description changed");

  if (changes.length === 0) return null;
  const additive = addedOptions.length > 0 || addedAllowed.length > 0 || (!before.editable && after.editable);
  return { name: after.name, before, after, changes, breaking, additive };
}

function diffComponent(before: ComponentSpec, after: ComponentSpec): ComponentChange | null {
  const beforeProps = new Map(before.props.map((p) => [p.name, p]));
  const afterProps = new Map(after.props.map((p) => [p.name, p]));

  const propsAdded = after.props.filter((p) => !beforeProps.has(p.name));
  const propsRemoved = before.props.filter((p) => !afterProps.has(p.name));
  const propsChanged: PropChange[] = [];
  for (const [name, prop] of afterProps) {
    const prev = beforeProps.get(name);
    if (!prev) continue;
    const change = diffProp(prev, prop);
    if (change) propsChanged.push(change);
  }

  const otherChanges: string[] = [];
  if (before.name !== after.name) otherChanges.push(`renamed ${before.name} → ${after.name}`);
  if (before.description !== after.description) otherChanges.push("description changed");
  if (before.category !== after.category) otherChanges.push(`category ${before.category} → ${after.category}`);
  if (before.placement !== after.placement) otherChanges.push(`placement ${before.placement} → ${after.placement}`);
  if (JSON.stringify(before.layout) !== JSON.stringify(after.layout)) {
    otherChanges.push("visual layout changed");
  }
  if (before.variantCount !== after.variantCount) {
    otherChanges.push(`variants ${before.variantCount} → ${after.variantCount}`);
  }

  const breaking =
    before.name !== after.name ||
    propsRemoved.some((p) => p.editable) ||
    propsAdded.some((p) => p.required && p.editable && p.default === undefined) ||
    propsChanged.some((c) => c.breaking) ||
    (before.placement === "section" && after.placement !== "section");

  if (!propsAdded.length && !propsRemoved.length && !propsChanged.length && !otherChanges.length) {
    return null;
  }
  return { name: after.name, before, after, propsAdded, propsRemoved, propsChanged, otherChanges, breaking };
}

/**
 * Compares two manifests. Components are matched by their stable Figma key so a
 * rename in Figma shows up as a change (and a breaking one, since the content
 * type id changes) instead of an unrelated add + remove.
 */
export function diffManifests(
  previous: DesignSystemManifest | null,
  next: DesignSystemManifest,
): ManifestDiff {
  const prevTokens = new Map((previous?.tokens ?? []).map((t) => [t.name, t]));
  const nextTokens = new Map(next.tokens.map((t) => [t.name, t]));
  const tokens = {
    added: next.tokens.filter((t) => !prevTokens.has(t.name)),
    removed: (previous?.tokens ?? []).filter((t) => !nextTokens.has(t.name)),
    changed: next.tokens.filter((t) => {
      const prev = prevTokens.get(t.name);
      return prev && JSON.stringify(prev) !== JSON.stringify(t);
    }),
  };

  const prevComponents = new Map((previous?.components ?? []).map((c) => [c.figmaKey, c]));
  const nextComponents = new Map(next.components.map((c) => [c.figmaKey, c]));
  const added = next.components.filter((c) => !prevComponents.has(c.figmaKey));
  const removed = (previous?.components ?? []).filter((c) => !nextComponents.has(c.figmaKey));
  const changed: ComponentChange[] = [];
  for (const component of next.components) {
    const prev = prevComponents.get(component.figmaKey);
    if (!prev) continue;
    const change = diffComponent(prev, component);
    if (change) changed.push(change);
  }

  const breakingReasons: string[] = [];
  for (const t of tokens.removed) breakingReasons.push(`token ${t.name} removed`);
  for (const c of removed) breakingReasons.push(`component ${c.name} removed`);
  for (const c of changed.filter((c) => c.breaking)) {
    const details = [
      ...c.otherChanges.filter((o) => o.startsWith("renamed") || o.startsWith("placement")),
      ...c.propsRemoved.filter((p) => p.editable).map((p) => `prop ${p.name} removed`),
      ...c.propsAdded
        .filter((p) => p.required && p.editable && p.default === undefined)
        .map((p) => `required prop ${p.name} added without default`),
      ...c.propsChanged.filter((p) => p.breaking).map((p) => `${p.name}: ${p.changes.join("; ")}`),
    ];
    breakingReasons.push(`component ${c.name}: ${details.join("; ")}`);
  }

  const additive =
    tokens.added.length > 0 ||
    added.length > 0 ||
    changed.some((c) => c.propsAdded.length > 0 || c.propsChanged.some((p) => p.additive));

  const requiredBump: Bump = breakingReasons.length ? "major" : additive ? "minor" : "patch";
  const isEmpty =
    !tokens.added.length &&
    !tokens.removed.length &&
    !tokens.changed.length &&
    !added.length &&
    !removed.length &&
    !changed.length &&
    JSON.stringify(previous?.textStyles) === JSON.stringify(next.textStyles) &&
    JSON.stringify(previous?.effectStyles) === JSON.stringify(next.effectStyles);

  return {
    from: previous?.version ?? null,
    to: next.version,
    tokens,
    components: { added, removed, changed },
    breakingReasons,
    requiredBump,
    isEmpty,
  };
}

/** The lowest version the next release may use, given the previous version and the diff. */
export function suggestNextVersion(previousVersion: string | null, bump: Bump): string {
  if (!previousVersion) return "1.0.0";
  // Pre-1.0 design systems treat breaking changes as minor bumps, as semver allows.
  const effective = semver.major(previousVersion) === 0 && bump === "major" ? "minor" : bump;
  const next = semver.inc(previousVersion, effective);
  if (!next) throw new Error(`Cannot bump invalid version "${previousVersion}"`);
  return next;
}

/**
 * Returns a problem description if `diff.to` is not a valid successor of
 * `diff.from`, or null if the version is acceptable.
 */
export function checkVersionBump(diff: ManifestDiff): string | null {
  if (diff.from === null) return null;
  if (!semver.gt(diff.to, diff.from)) {
    return `Version ${diff.to} must be greater than the current version ${diff.from}.`;
  }
  const minimum = suggestNextVersion(diff.from, diff.requiredBump);
  if (semver.lt(diff.to, minimum)) {
    const why = diff.breakingReasons.length
      ? ` Breaking changes: ${diff.breakingReasons.join("; ")}.`
      : "";
    return `This release needs at least a ${diff.requiredBump} bump (${minimum}), got ${diff.to}.${why}`;
  }
  return null;
}

/** Markdown summary used in PR bodies, Slack notifications and the Figma plugin. */
export function summarizeDiff(diff: ManifestDiff): string {
  const lines: string[] = [];
  lines.push(`**${diff.from ?? "(none)"} → ${diff.to}** (${diff.requiredBump} change)`);
  const list = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push("", `**${title}**`, ...items.map((i) => `- ${i}`));
  };
  list("Breaking", diff.breakingReasons);
  list("New components", diff.components.added.map((c) => `${c.name} (${c.props.length} props)`));
  list("Removed components", diff.components.removed.map((c) => c.name));
  list(
    "Changed components",
    diff.components.changed.map((c) => {
      const parts = [
        ...c.otherChanges,
        ...c.propsAdded.map((p) => `+${p.name}`),
        ...c.propsRemoved.map((p) => `-${p.name}`),
        ...c.propsChanged.map((p) => `${p.name}: ${p.changes.join(", ")}`),
      ];
      return `${c.name}: ${parts.join("; ")}`;
    }),
  );
  const tokenParts = [
    diff.tokens.added.length && `${diff.tokens.added.length} added`,
    diff.tokens.changed.length && `${diff.tokens.changed.length} changed`,
    diff.tokens.removed.length && `${diff.tokens.removed.length} removed`,
  ].filter(Boolean);
  if (tokenParts.length) lines.push("", `**Tokens:** ${tokenParts.join(", ")}`);
  if (diff.isEmpty) lines.push("", "_No changes detected._");
  return lines.join("\n");
}
