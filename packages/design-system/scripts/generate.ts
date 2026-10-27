/**
 * Deterministic codegen: manifest → tokens.css, tokens.ts, registry.json.
 *
 *   pnpm --filter @storypage/design-system generate [manifests/<version>.json]
 *
 * Without an argument it regenerates from the highest manifest version.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, renderTokensCss, renderTokensTs, toRegistry } from "@storypage/schema";
import semver from "semver";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestsDir = path.join(root, "manifests");
const outDir = path.join(root, "src/generated");

export function latestManifestPath(): string {
  const versions = readdirSync(manifestsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((v) => semver.valid(v))
    .sort(semver.rcompare);
  if (!versions[0]) throw new Error(`No manifests found in ${manifestsDir}`);
  return path.join(manifestsDir, `${versions[0]}.json`);
}

export function generate(manifestPath: string) {
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "tokens.css"), renderTokensCss(manifest));
  writeFileSync(path.join(outDir, "tokens.ts"), renderTokensTs(manifest));
  writeFileSync(path.join(outDir, "registry.json"), `${JSON.stringify(toRegistry(manifest), null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : latestManifestPath();
  const manifest = generate(target);
  console.log(`Generated tokens and registry for ${manifest.name}@${manifest.version}`);
}
