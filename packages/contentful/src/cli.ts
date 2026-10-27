#!/usr/bin/env -S npx tsx
/**
 * Syncs Contentful content types to a design-system registry.
 *
 *   pnpm --filter @storypage/contentful sync \
 *     --registry packages/design-system/src/generated/registry.json \
 *     --storybook-url https://design.example.com [--dry-run] [--strategy in-place]
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Registry } from "@storypage/schema";
import { configFromEnv } from "./client.js";
import { syncDesignSystem } from "./sync.js";

const { values } = parseArgs({
  options: {
    registry: { type: "string" },
    changelog: { type: "string" },
    "diff-file": { type: "string" },
    "storybook-url": { type: "string" },
    strategy: { type: "string", default: "alias" },
    "keep-environments": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!values.registry) throw new Error("--registry is required");
if (values.strategy !== "alias" && values.strategy !== "in-place") throw new Error("--strategy must be alias or in-place");

const registry = JSON.parse(readFileSync(values.registry, "utf8")) as Registry;
const result = await syncDesignSystem({
  config: configFromEnv(),
  registry,
  strategy: values.strategy,
  dryRun: values["dry-run"],
  ...(values.changelog ? { changelog: values.changelog } : {}),
  ...(values["diff-file"] ? { diffSummary: readFileSync(values["diff-file"], "utf8") } : {}),
  ...(values["storybook-url"] ? { storybookUrl: values["storybook-url"] } : {}),
  ...(values["keep-environments"] ? { keepEnvironments: Number(values["keep-environments"]) } : {}),
});
const changed = result.changes.filter((c) => c.action !== "unchanged").length;
console.log(`design-system@${registry.version}: ${changed} content type change(s) in ${result.environment}`);
