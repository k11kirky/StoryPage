import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { RepoStore } from "../repo.js";
import type { BuildRequest, Runner } from "./types.js";

/**
 * Runs the pipeline on this machine: the hosted setup, or a self-hosted one
 * without GitHub Actions. Jobs run one at a time in a checkout under
 * `workDir`, which also keeps Claude's config (and with it the Figma MCP
 * sign-in) between runs.
 */

export interface LocalRunnerOptions {
  workDir: string;
  /** Clone URL of the repository (https://github.com/owner/repo.git, or a local path in tests). */
  repoUrl: string;
  /** Token for git over HTTPS; sent per command, never written to .git/config. */
  gitToken?: string | undefined;
  baseBranch: string;
  repo: Pick<RepoStore, "openPullRequest">;
  /** Public URL of this gateway: Storybook is served from `<publicUrl>/storybook/`. */
  publicUrl: string;
  /** Environment for pipeline commands: Anthropic, Figma and Contentful settings only. */
  pipelineEnv: Record<string, string>;
  /** Override the commands (tests); defaults run pnpm in the checkout. */
  commands?: Partial<Commands>;
  log?: (line: string) => void;
}

interface Commands {
  install: string[] | null;
  build: (version: string) => string[];
  storybook: string[];
  release: (storybookUrl: string) => string[];
}

const DEFAULT_COMMANDS: Commands = {
  install: ["pnpm", "install", "--frozen-lockfile"],
  build: (version) => ["pnpm", "--filter", "@storypage/pipeline", "pipeline", "build", "--version", version],
  storybook: ["pnpm", "--filter", "@storypage/design-system", "build-storybook", "--quiet"],
  release: (storybookUrl) => ["pnpm", "--filter", "@storypage/pipeline", "pipeline", "release", "--storybook-url", storybookUrl],
};

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  kind: "build" | "release";
  version: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  pullRequestUrl?: string;
  error?: string;
  /** The last lines of output, for the status page. */
  log: string[];
}

/** Keys a pipeline command may inherit from the gateway's environment. */
export function pipelineEnvFrom(source: NodeJS.ProcessEnv): Record<string, string> {
  const keep = (key: string) =>
    ["PATH", "HOME", "USER", "LANG", "TMPDIR", "CI", "PNPM_HOME", "NODE_OPTIONS", "CHROMIUM_PATH", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"].includes(key) ||
    key.startsWith("ANTHROPIC_") ||
    key.startsWith("FIGMA_") ||
    key.startsWith("CONTENTFUL_") ||
    key.startsWith("STORYPAGE_") ||
    key === "CLAUDE_CONFIG_DIR";
  return Object.fromEntries(Object.entries(source).filter((e): e is [string, string] => Boolean(e[1]) && keep(e[0])));
}

export class LocalRunner implements Runner {
  readonly kind = "local" as const;
  readonly jobs: Job[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly commands: Commands;
  private readonly checkout: string;
  private readonly log: (line: string) => void;

  constructor(private readonly options: LocalRunnerOptions) {
    this.commands = { ...DEFAULT_COMMANDS, ...options.commands };
    this.checkout = path.join(options.workDir, "repo");
    this.log = options.log ?? ((line) => console.log(`[runner] ${line}`));
    mkdirSync(options.workDir, { recursive: true });
  }

  /** Where the hosted Storybook is served from (see the gateway's /storybook route). */
  get storybookDir(): string {
    return path.join(this.options.workDir, "storybook");
  }

  private statusUrl(job: Job) {
    return `${this.options.publicUrl.replace(/\/$/, "")}/jobs/${job.id}`;
  }

  private enqueue(kind: Job["kind"], version: string, work: (job: Job) => Promise<void>): Job {
    const job: Job = { id: `${kind}-${version}-${Date.now().toString(36)}`, kind, version, status: "queued", createdAt: new Date().toISOString(), log: [] };
    this.jobs.unshift(job);
    this.jobs.splice(50);
    this.queue = this.queue.then(async () => {
      job.status = "running";
      try {
        await work(job);
        job.status = "succeeded";
      } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        this.log(`${job.id} failed: ${job.error}`);
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    });
    return job;
  }

  /** Resolves when every queued job has finished (tests, graceful shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private run(job: Job, command: string[], options: { cwd?: string; env?: Record<string, string>; allowFailure?: boolean } = {}): Promise<number> {
    const [cmd, ...args] = command;
    return new Promise((resolve, reject) => {
      const child = spawn(cmd!, args, { cwd: options.cwd ?? this.checkout, env: options.env ?? this.options.pipelineEnv, stdio: ["ignore", "pipe", "pipe"] });
      const capture = (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          job.log.push(line);
          if (job.log.length > 200) job.log.shift();
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0 || options.allowFailure) resolve(code ?? 1);
        else reject(new Error(`${command.join(" ")} exited with ${code}`));
      });
    });
  }

  /** git with credentials passed for this command only. */
  private git(job: Job, args: string[], cwd = this.checkout) {
    const auth = this.options.gitToken
      ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${this.options.gitToken}`).toString("base64")}`]
      : [];
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0" };
    return this.run(job, ["git", ...auth, ...args], { cwd, env });
  }

  private async checkoutRef(job: Job, ref: string) {
    if (!existsSync(path.join(this.checkout, ".git"))) {
      await this.git(job, ["clone", this.options.repoUrl, this.checkout], this.options.workDir);
      await this.git(job, ["config", "user.name", "storypage-bot"]);
      await this.git(job, ["config", "user.email", "storypage-bot@users.noreply.github.com"]);
    }
    await this.git(job, ["fetch", "origin", ref]);
    await this.git(job, ["checkout", "-B", ref, `origin/${ref}`]);
    await this.git(job, ["reset", "--hard", `origin/${ref}`]);
    // Keep ignored files (node_modules) for speed; drop anything else left over.
    await this.git(job, ["clean", "-fd"]);
    if (this.commands.install) await this.run(job, this.commands.install);
  }

  build({ version, branch }: BuildRequest) {
    const job = this.enqueue("build", version, async (job) => {
      await this.checkoutRef(job, branch);
      // A failed verification still produces release.json and a draft PR for a human to finish.
      await this.run(job, this.commands.build(version), { allowFailure: true });
      const releasePath = path.join(this.checkout, ".storypage", "release.json");
      if (!existsSync(releasePath)) throw new Error("The build stage crashed before writing its report");
      const release = JSON.parse(readFileSync(releasePath, "utf8")) as { verified: boolean; tasks: string[] };
      const body = readFileSync(path.join(this.checkout, ".storypage", "pr-body.md"), "utf8");

      await this.git(job, ["add", "packages/design-system"]);
      const unchanged = (await this.git(job, ["diff", "--cached", "--quiet"]).then(() => 0, () => 1)) === 0;
      if (!unchanged) await this.git(job, ["commit", "-m", `Build design system ${version} in Storybook`, "-m", release.tasks.join("\n")]);
      await this.git(job, ["push", "origin", `HEAD:${branch}`]);
      job.pullRequestUrl = await this.options.repo.openPullRequest({
        branch,
        title: `Design system ${version}`,
        body,
        draft: !release.verified,
      });
    });
    return Promise.resolve({ statusUrl: this.statusUrl(job) });
  }

  release(version: string) {
    const job = this.enqueue("release", version, async (job) => {
      await this.checkoutRef(job, this.options.baseBranch);
      const storybookUrl = `${this.options.publicUrl.replace(/\/$/, "")}/storybook/`;
      // The preview story fetches drafts from this gateway; no Contentful token in the bundle.
      await this.run(job, this.commands.storybook, {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", STORYBOOK_PREVIEW_API_URL: this.options.publicUrl },
      });
      const built = path.join(this.checkout, "packages", "design-system", "storybook-static");
      rmSync(this.storybookDir, { recursive: true, force: true });
      cpSync(built, this.storybookDir, { recursive: true });
      await this.run(job, this.commands.release(storybookUrl));
    });
    return Promise.resolve({ statusUrl: this.statusUrl(job) });
  }
}
