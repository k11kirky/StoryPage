import type { WebhookLibraryPublishPayload } from "@figma/rest-api-spec";
import { scanLibrary, type FigmaClient } from "@storypage/figma";
import {
  checkVersionBump,
  DesignSystemManifestSchema,
  diffManifests,
  lintManifest,
  parseManifest,
  resolveSelection,
  suggestNextVersion,
  summarizeDiff,
  type DesignSystemManifest,
  type ManifestDiff,
  type Registry,
} from "@storypage/schema";
import type { Notifier } from "./notify.js";
import type { RepoFile, RepoStore } from "./repo.js";
import type { Runner } from "./runners/types.js";

export const MANIFESTS_DIR = "packages/design-system/manifests";
export const REGISTRY_PATH = "packages/design-system/src/generated/registry.json";

const PNG_BASE64_PREFIX = "iVBORw0KGgo";

export const branchFor = (version: string) => `design-system/v${version}`;

export class PublishError extends Error {
  constructor(
    readonly status: 400 | 409 | 422,
    message: string,
    readonly details: { problems?: string[]; suggestedVersion?: string } = {},
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export interface PublishResult {
  version: string;
  branch: string;
  commit: string;
  requiredBump: ManifestDiff["requiredBump"];
  summary: string;
  statusUrl: string;
}

/**
 * Turns a design-system version into a release, whichever way it arrives:
 * the plugin's Publish button, or Figma's own "Publish library" (webhook).
 * Commits the manifest to `design-system/v<version>` and hands it to the
 * runner: GitHub Actions in the open-source setup, the hosted worker otherwise.
 */
export class ReleaseService {
  /** Webhook deliveries already handled (Figma retries on slow or failed responses). */
  private readonly seen = new Set<string>();

  constructor(
    private readonly repo: RepoStore,
    private readonly runner: Runner,
    private readonly notifier: Notifier,
  ) {}

  async currentManifest(): Promise<DesignSystemManifest | null> {
    const registryJson = await this.repo.readFile(REGISTRY_PATH);
    if (!registryJson) return null;
    const { version } = JSON.parse(registryJson) as Registry;
    const manifestJson = await this.repo.readFile(`${MANIFESTS_DIR}/${version}.json`);
    return manifestJson ? parseManifest(JSON.parse(manifestJson)) : null;
  }

  async publish(manifest: DesignSystemManifest, previews: Record<string, string>): Promise<PublishResult> {
    const previous = await this.currentManifest();
    const diff = diffManifests(previous, manifest);
    if (diff.isEmpty) throw new PublishError(409, "Nothing changed since the last published version.");
    const versionProblem = checkVersionBump(diff);
    if (versionProblem) {
      throw new PublishError(409, versionProblem, { suggestedVersion: suggestNextVersion(diff.from, diff.requiredBump) });
    }
    const branch = branchFor(manifest.version);
    if ((await this.repo.branchExists(branch)) || (await this.repo.readFile(`${MANIFESTS_DIR}/${manifest.version}.json`))) {
      throw new PublishError(409, `Version ${manifest.version} has already been published.`);
    }

    const files: RepoFile[] = [];
    const componentNames = new Set(manifest.components.map((component) => component.name));
    for (const [name, png] of Object.entries(previews)) {
      if (!componentNames.has(name)) continue;
      if (!png.startsWith(PNG_BASE64_PREFIX)) throw new PublishError(400, `Preview for ${name} is not a PNG`);
      const previewPath = `${manifest.version}/previews/${name}.png`;
      files.push({ path: `${MANIFESTS_DIR}/${previewPath}`, content: png, encoding: "base64" });
      manifest.components.find((component) => component.name === name)!.preview = previewPath;
    }
    files.unshift({ path: `${MANIFESTS_DIR}/${manifest.version}.json`, content: `${JSON.stringify(manifest, null, 2)}\n`, encoding: "utf-8" });

    const message = [
      `Publish design system ${manifest.version} from Figma`,
      "",
      `Published by ${manifest.publishedBy.name} from "${manifest.source.figmaFileName}".`,
      ...(manifest.changelog ? ["", manifest.changelog] : []),
    ].join("\n");
    const commit = await this.repo.commitToNewBranch(branch, files, message);
    const { statusUrl } = await this.runner.build({ version: manifest.version, branch });
    return { version: manifest.version, branch, commit, requiredBump: diff.requiredBump, summary: summarizeDiff(diff), statusUrl };
  }

  /**
   * Handles Figma's LIBRARY_PUBLISH webhook: reads the library over the REST
   * API, applies the choices made in the StoryPage plugin, versions the
   * release automatically, and reports back in Slack. Designers just publish
   * their library as usual; the publish description becomes the changelog.
   */
  async publishLibrary(event: WebhookLibraryPublishPayload, figma: FigmaClient): Promise<PublishResult | null> {
    const delivery = `${event.webhook_id}:${event.file_key}:${event.timestamp}`;
    if (this.seen.has(delivery)) return null;
    this.seen.add(delivery);
    const who = event.triggered_by?.handle ?? "Someone";
    try {
      const scan = await scanLibrary(figma, event.file_key);
      const resolved = resolveSelection(scan.drafts, scan.selections);
      if (!resolved.components.length) {
        await this.notifier.send(
          `${who} published *${event.file_name}*, but no components are set up for StoryPage yet. Open the StoryPage plugin in the file, choose the page sections to publish, then publish the library again.`,
        );
        return null;
      }
      const variablesChanged = event.created_variables.length + event.modified_variables.length + event.deleted_variables.length > 0;
      if (scan.variablesSource === "snapshot" && variablesChanged && scan.variablesSavedAt && scan.variablesSavedAt < event.timestamp) {
        await this.notifier.send(
          `${who} published *${event.file_name}* with variable changes, but StoryPage's saved variable values are from ${scan.variablesSavedAt.slice(0, 10)}. ` +
            "Open the StoryPage plugin in the file once (it saves them), then publish the library again.",
        );
        return null;
      }

      const previous = await this.currentManifest();
      const draft = {
        ...scan.manifest,
        components: resolved.components,
        version: "0.0.0",
        changelog: event.description ?? "",
        publishedAt: event.timestamp,
        publishedBy: { name: who, figmaUserId: event.triggered_by?.id },
      };
      const parsed = DesignSystemManifestSchema.parse({ ...draft, version: "0.0.1" });
      const problems = lintManifest(parsed);
      if (problems.length) {
        await this.notifier.send(`${who} published *${event.file_name}*, but StoryPage can't build it yet:\n${problems.map((p) => `• ${p}`).join("\n")}`);
        return null;
      }
      const diff = diffManifests(previous, parsed);
      if (diff.isEmpty) return null; // the publish didn't touch anything StoryPage builds
      // Designers don't pick version numbers: the change decides the bump.
      const manifest = parseManifest({ ...draft, version: suggestNextVersion(previous?.version ?? null, diff.requiredBump) });

      const nodeIds = manifest.components.map((c) => c.figmaNodeId).filter((id): id is string => Boolean(id));
      const pngs = await figma.renderPngs(event.file_key, nodeIds);
      const previews = Object.fromEntries(
        manifest.components.filter((c) => c.figmaNodeId && pngs[c.figmaNodeId]).map((c) => [c.name, pngs[c.figmaNodeId!]!]),
      );
      const result = await this.publish(manifest, previews);
      const notes = [...scan.warnings, ...resolved.warnings];
      await this.notifier.send(
        `${who} published *${event.file_name}*: design system *${result.version}* (${result.requiredBump} release) is being built in Storybook. A pull request will follow: ${result.statusUrl}` +
          (notes.length ? `\n${notes.map((n) => `• ${n}`).join("\n")}` : ""),
      );
      return result;
    } catch (error) {
      const message = error instanceof PublishError ? [error.message, ...(error.details.problems ?? [])].join("\n") : String(error);
      await this.notifier.send(`StoryPage couldn't process ${who}'s publish of *${event.file_name}*: ${message}`);
      throw error;
    }
  }
}
