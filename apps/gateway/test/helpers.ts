/** Shared fakes for the gateway tests. */
import { readFileSync } from "node:fs";
import { toRegistry, type DesignSystemManifest } from "@storypage/schema";
import { createApp, MANIFESTS_DIR, REGISTRY_PATH, type GatewayOptions } from "../src/app.js";
import type { Notifier } from "../src/notify.js";
import { ReleaseService } from "../src/releases.js";
import type { RepoFile, RepoStore } from "../src/repo.js";
import { GitHubActionsRunner } from "../src/runners/github.js";

const seedJson = readFileSync(new URL("../../../packages/design-system/manifests/1.0.0.json", import.meta.url), "utf8");
export const seed = JSON.parse(seedJson) as DesignSystemManifest;
export const TOKEN = "secret-token";
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export class FakeRepo implements RepoStore {
  files = new Map<string, string>();
  branches = new Map<string, RepoFile[]>();
  dispatches: { eventType: string; payload: Record<string, unknown> }[] = [];
  pullRequests: { branch: string; title: string; body: string; draft: boolean }[] = [];
  async readFile(path: string) {
    return this.files.get(path) ?? null;
  }
  async branchExists(branch: string) {
    return this.branches.has(branch);
  }
  async commitToNewBranch(branch: string, files: RepoFile[]) {
    this.branches.set(branch, files);
    return "abc123";
  }
  async dispatch(eventType: string, payload: Record<string, unknown>) {
    this.dispatches.push({ eventType, payload });
  }
  actionsUrl() {
    return "https://github.com/acme/site/actions";
  }
  async openPullRequest(request: { branch: string; title: string; body: string; draft: boolean }) {
    this.pullRequests.push(request);
    return `https://github.com/acme/site/pull/${this.pullRequests.length}`;
  }
}

/** A repo whose main branch has the seed design system (1.0.0) released. */
export function seededRepo(): FakeRepo {
  const repo = new FakeRepo();
  repo.files.set(`${MANIFESTS_DIR}/1.0.0.json`, seedJson);
  repo.files.set(REGISTRY_PATH, JSON.stringify(toRegistry(seed as never)));
  return repo;
}

export class RecordingNotifier implements Notifier {
  messages: string[] = [];
  async send(text: string) {
    this.messages.push(text);
  }
}

export function gatewayFor(repo: RepoStore, extra: Partial<GatewayOptions> = {}, notifier: Notifier = new RecordingNotifier()) {
  const runner = extra.runner ?? new GitHubActionsRunner(repo);
  return createApp({ releases: extra.releases ?? new ReleaseService(repo, runner, notifier), runner, publishToken: TOKEN, ...extra });
}
