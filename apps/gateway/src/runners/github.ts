import type { RepoStore } from "../repo.js";
import type { BuildRequest, Runner } from "./types.js";

export const DISPATCH_EVENT = "design-system-published";

/** Starts `.github/workflows/design-system-build.yml` with a repository_dispatch event. */
export class GitHubActionsRunner implements Runner {
  readonly kind = "github" as const;

  constructor(private readonly repo: RepoStore) {}

  async build({ version, branch }: BuildRequest) {
    await this.repo.dispatch(DISPATCH_EVENT, { version, branch });
    return { statusUrl: this.repo.actionsUrl() };
  }
}
