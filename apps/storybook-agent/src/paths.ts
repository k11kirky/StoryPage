import { existsSync } from "node:fs";
import path from "node:path";

export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No pnpm-workspace.yaml above ${start}`);
    dir = parent;
  }
  return dir;
}

export const DESIGN_SYSTEM_DIR = "packages/design-system";
export const COMPONENTS_DIR = `${DESIGN_SYSTEM_DIR}/src/components`;
export const MANIFESTS_DIR = `${DESIGN_SYSTEM_DIR}/manifests`;
export const OUTPUT_DIR = ".storypage";
