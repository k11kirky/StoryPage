import type { ComponentSpec, DesignSystemManifest, ManifestDiff } from "@storypage/schema";

export type Task =
  | { type: "create"; component: ComponentSpec }
  | { type: "update"; component: ComponentSpec; previousName: string; changes: string[] }
  | { type: "remove"; name: string };

/**
 * Turns a manifest diff into the work the agent must do. Token, text-style and
 * effect changes need no agent work: they are regenerated deterministically and
 * every component reads them through CSS custom properties.
 */
export function planTasks(diff: ManifestDiff, next: DesignSystemManifest): Task[] {
  const byKey = new Map(next.components.map((c) => [c.figmaKey, c]));
  const tasks: Task[] = [];
  for (const component of diff.components.added) tasks.push({ type: "create", component });
  for (const change of diff.components.changed) {
    const component = byKey.get(change.after.figmaKey)!;
    const changes = [
      ...change.otherChanges,
      ...change.propsAdded.map((p) => `add prop ${p.name} (${p.kind})`),
      ...change.propsRemoved.map((p) => `remove prop ${p.name}`),
      ...change.propsChanged.map((p) => `${p.name}: ${p.changes.join(", ")}`),
    ];
    // A description-only change needs no code.
    if (changes.every((c) => c === "description changed")) continue;
    tasks.push({ type: "update", component, previousName: change.before.name, changes });
  }
  for (const component of diff.components.removed) tasks.push({ type: "remove", name: component.name });
  return tasks;
}

export interface ComponentBrief {
  task: Task["type"];
  name: string;
  previousName?: string;
  changes?: string[];
  contract?: Omit<ComponentSpec, "layout" | "preview" | "figmaKey">;
  figma?: { fileKey: string; nodeId: string; url: string } | undefined;
  /** Exported preview of every variant, relative to the repo root. */
  previewImage?: string | undefined;
  /** Trimmed Figma layout of the default variant, from the manifest. */
  layout?: ComponentSpec["layout"];
}

export interface ReleasePlan {
  designSystem: string;
  version: string;
  previousVersion: string | null;
  publishedBy: string;
  changelog: string;
  diff: string;
  textStyles: string[];
  components: ComponentBrief[];
}

/** Everything the build and review agents need about a release, as one document. */
export function releasePlan(manifest: DesignSystemManifest, diff: ManifestDiff, tasks: Task[], diffSummary: string, manifestsDir: string): ReleasePlan {
  const fileKey = manifest.source.figmaFileKey;
  const hasFigma = /^[A-Za-z0-9]{10,}$/.test(fileKey);
  return {
    designSystem: manifest.name,
    version: manifest.version,
    previousVersion: diff.from,
    publishedBy: manifest.publishedBy.name,
    changelog: manifest.changelog,
    diff: diffSummary,
    textStyles: manifest.textStyles.map((s) => s.name),
    components: tasks.map((task): ComponentBrief => {
      if (task.type === "remove") return { task: "remove", name: task.name };
      const { layout, preview, figmaKey: _key, ...contract } = task.component;
      return {
        task: task.type,
        name: task.component.name,
        ...(task.type === "update" ? { previousName: task.previousName, changes: task.changes } : {}),
        contract,
        figma:
          hasFigma && task.component.figmaNodeId
            ? {
                fileKey,
                nodeId: task.component.figmaNodeId,
                url: `https://www.figma.com/design/${fileKey}/?node-id=${task.component.figmaNodeId.replace(":", "-")}`,
              }
            : undefined,
        previewImage: preview ? `${manifestsDir}/${preview}` : undefined,
        layout,
      };
    }),
  };
}
