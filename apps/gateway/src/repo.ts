import { Octokit } from "@octokit/rest";

export interface RepoFile {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
}

/** The few repository operations the gateway needs, so tests can fake them. */
export interface RepoStore {
  readFile(path: string): Promise<string | null>;
  branchExists(branch: string): Promise<boolean>;
  commitToNewBranch(branch: string, files: RepoFile[], message: string): Promise<string>;
  dispatch(eventType: string, payload: Record<string, unknown>): Promise<void>;
  actionsUrl(): string;
}

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
}

export class GitHubRepoStore implements RepoStore {
  private readonly octokit: Octokit;

  constructor(private readonly config: GitHubConfig) {
    this.octokit = new Octokit({ auth: config.token, userAgent: "storypage-gateway" });
  }

  private get repo() {
    return { owner: this.config.owner, repo: this.config.repo };
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const response = await this.octokit.repos.getContent({
        ...this.repo,
        path,
        ref: this.config.baseBranch,
        mediaType: { format: "raw" },
      });
      return response.data as unknown as string;
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.octokit.git.getRef({ ...this.repo, ref: `heads/${branch}` });
      return true;
    } catch (error) {
      if ((error as { status?: number }).status === 404) return false;
      throw error;
    }
  }

  async commitToNewBranch(branch: string, files: RepoFile[], message: string): Promise<string> {
    const { data: base } = await this.octokit.git.getRef({ ...this.repo, ref: `heads/${this.config.baseBranch}` });
    const { data: baseCommit } = await this.octokit.git.getCommit({ ...this.repo, commit_sha: base.object.sha });
    const blobs = await Promise.all(
      files.map((file) => this.octokit.git.createBlob({ ...this.repo, content: file.content, encoding: file.encoding })),
    );
    const { data: tree } = await this.octokit.git.createTree({
      ...this.repo,
      base_tree: baseCommit.tree.sha,
      tree: files.map((file, i) => ({ path: file.path, mode: "100644", type: "blob", sha: blobs[i]!.data.sha })),
    });
    const { data: commit } = await this.octokit.git.createCommit({
      ...this.repo,
      message,
      tree: tree.sha,
      parents: [base.object.sha],
    });
    await this.octokit.git.createRef({ ...this.repo, ref: `refs/heads/${branch}`, sha: commit.sha });
    return commit.sha;
  }

  async dispatch(eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.octokit.repos.createDispatchEvent({ ...this.repo, event_type: eventType, client_payload: payload });
  }

  actionsUrl(): string {
    return `https://github.com/${this.config.owner}/${this.config.repo}/actions`;
  }
}
