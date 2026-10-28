/**
 * Stand-in for GitHub: a bare git repository on disk that the gateway and the
 * hosted runner use like the real one (the runner clones and pushes to it),
 * with pull requests recorded in memory and merged with git.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { RepoFile, RepoStore } from "@storypage/gateway";

export interface PullRequest {
  number: number;
  branch: string;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "merged";
  url: string;
}

const IDENTITY = { GIT_AUTHOR_NAME: "StoryPage e2e", GIT_AUTHOR_EMAIL: "e2e@storypage.invalid", GIT_COMMITTER_NAME: "StoryPage e2e", GIT_COMMITTER_EMAIL: "e2e@storypage.invalid" };

export function git(cwd: string, args: string[], options: { input?: string | Buffer; env?: Record<string, string> } = {}): string {
  return execFileSync("git", args, {
    cwd,
    input: options.input,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...IDENTITY, ...options.env },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

export class LocalGitRepoStore implements RepoStore {
  readonly pullRequests: PullRequest[] = [];
  readonly dispatches: { eventType: string; payload: Record<string, unknown> }[] = [];

  constructor(
    /** Path of the bare repository (the "origin" the runner clones). */
    readonly bare: string,
    readonly baseBranch: string,
    /** Where pull request links point (the gateway serves them for the report). */
    private readonly pullUrl: (number: number) => string,
  ) {}

  async readFile(file: string): Promise<string | null> {
    try {
      return execFileSync("git", ["show", `${this.baseBranch}:${file}`], { cwd: this.bare, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return null;
    }
  }

  async branchExists(branch: string): Promise<boolean> {
    try {
      git(this.bare, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Like the GitHub implementation: blobs → tree on top of the base branch → commit → new ref. */
  async commitToNewBranch(branch: string, files: RepoFile[], message: string): Promise<string> {
    const index = path.join(mkdtempSync(path.join(this.bare, "..", "index-")), "index");
    const env = { GIT_INDEX_FILE: index };
    try {
      const base = git(this.bare, ["rev-parse", `refs/heads/${this.baseBranch}`]);
      git(this.bare, ["read-tree", base], { env });
      for (const file of files) {
        const content = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
        const blob = git(this.bare, ["hash-object", "-w", "--stdin"], { input: content });
        git(this.bare, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file.path}`], { env });
      }
      const tree = git(this.bare, ["write-tree"], { env });
      const commit = git(this.bare, ["commit-tree", tree, "-p", base], { input: message });
      git(this.bare, ["update-ref", `refs/heads/${branch}`, commit, ""]);
      return commit;
    } finally {
      rmSync(path.dirname(index), { recursive: true, force: true });
    }
  }

  async dispatch(eventType: string, payload: Record<string, unknown>): Promise<void> {
    this.dispatches.push({ eventType, payload });
  }

  actionsUrl(): string {
    return "(local runner)";
  }

  async openPullRequest({ branch, title, body, draft }: { branch: string; title: string; body: string; draft: boolean }): Promise<string> {
    const open = this.pullRequests.find((pr) => pr.branch === branch && pr.state === "open");
    if (open) {
      Object.assign(open, { body, draft });
      return open.url;
    }
    const number = this.pullRequests.length + 1;
    const pr: PullRequest = { number, branch, title, body, draft, state: "open", url: this.pullUrl(number) };
    this.pullRequests.push(pr);
    return pr.url;
  }

  /** What pressing "Merge" does: a merge commit of the branch on the base branch. */
  merge(pr: PullRequest): string {
    const work = mkdtempSync(path.join(this.bare, "..", "merge-"));
    try {
      git(work, ["clone", "--quiet", "--branch", this.baseBranch, this.bare, "."]);
      git(work, ["fetch", "--quiet", "origin", pr.branch]);
      git(work, ["merge", "--no-ff", "--quiet", "-m", `Merge pull request #${pr.number} from ${pr.branch}\n\n${pr.title}`, "FETCH_HEAD"]);
      git(work, ["-c", "push.negotiate=false", "push", "--quiet", "origin", `HEAD:${this.baseBranch}`]);
      pr.state = "merged";
      return git(work, ["rev-parse", "HEAD"]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
