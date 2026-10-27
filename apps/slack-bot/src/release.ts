import { getLiveRelease, signPreview, type LiveRelease, type PlainClientAPI } from "@storypage/contentful";
import type { Registry } from "@storypage/schema";

/**
 * The composer must use exactly the design system that Contentful's content
 * model was synced to, so it reads the registry from the latest `dsRelease`
 * entry rather than from the repo. Cached briefly; a release lands within
 * minutes of the alias moving.
 */
export class ReleaseCache {
  private cached: { release: LiveRelease; at: number } | null = null;

  constructor(
    private readonly client: PlainClientAPI,
    private readonly locale: string,
    private readonly fallbackStorybookUrl?: string,
    private readonly ttlMs = 5 * 60 * 1000,
  ) {}

  async get(): Promise<LiveRelease> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.release;
    let release = await getLiveRelease(this.client, this.locale);
    if (!release && this.fallbackStorybookUrl) {
      const response = await fetch(new URL("registry.json", `${this.fallbackStorybookUrl.replace(/\/$/, "")}/`));
      if (!response.ok) throw new Error(`Could not load registry from Storybook (${response.status})`);
      const registry = (await response.json()) as Registry;
      release = { version: registry.version, registry, storybookUrl: this.fallbackStorybookUrl, environment: "" };
    }
    if (!release) throw new Error("No design-system release found in Contentful. Run the Contentful sync first.");
    if (!release.storybookUrl && this.fallbackStorybookUrl) release.storybookUrl = this.fallbackStorybookUrl;
    this.cached = { release, at: Date.now() };
    return release;
  }
}

/** A signed, expiring link to the draft rendered by Storybook's preview story. */
export function previewUrl(storybookUrl: string, slug: string, signingSecret: string): string {
  const { exp, sig } = signPreview(slug, signingSecret);
  const url = new URL("iframe.html", `${storybookUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("id", "pages-contentful-preview--page");
  url.searchParams.set("viewMode", "story");
  url.searchParams.set("slug", slug);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return url.toString();
}
