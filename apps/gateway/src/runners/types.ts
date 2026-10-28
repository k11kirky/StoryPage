export interface BuildRequest {
  version: string;
  /** Branch holding the published manifest (`design-system/v<version>`). */
  branch: string;
}

/**
 * Where the agent stages run. The same `apps/pipeline` code runs either way:
 * - `github`: GitHub Actions workflows in your repo (the open-source setup).
 * - `local`: this gateway's own worker (hosted, or self-hosted on one machine).
 */
export interface Runner {
  readonly kind: "github" | "local";
  /** Build a published version in Storybook and open its pull request. */
  build(request: BuildRequest): Promise<{ statusUrl: string }>;
  /**
   * Release a merged version: deploy Storybook, migrate Contentful. Not needed
   * with GitHub Actions, where the release workflow runs on merge.
   */
  release?(version: string): Promise<{ statusUrl: string }>;
}
