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
