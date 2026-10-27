# StoryPage

An agentic pipeline from **Figma → Storybook → Contentful → Slack**, built on the Claude Agent SDK with the Figma, Storybook and Contentful MCP servers:

1. A designer builds the design system in Figma and presses **Publish** in the StoryPage Figma plugin.
2. **Build agent:** implements the components in **Storybook**, reading the design through the **Figma MCP** and the existing system through the **Storybook MCP**, and checks its work with story screenshots and the contract tests.
3. **Review agent:** a separate agent compares every changed story with Figma. Blocking findings go back to the build agent, and the result is opened as a PR for a human.
4. **Content agent:** once the PR merges and Storybook deploys, it migrates the **Contentful** content model *and the existing content* through the **Contentful MCP**, in a cloned environment. It goes live only after every page validates.
5. **Composer agent:** anyone can ask the **Slack bot** for a page. It reads component docs through the Storybook MCP and existing content through the Contentful MCP, then saves a validated draft with a Storybook-rendered preview.

```mermaid
flowchart LR
  F[Figma plugin] -- manifest + previews --> G[Gateway]
  G -- commit design-system/vX + dispatch --> B
  subgraph Build workflow
    B[Build agent] -- findings --- V[Review agent]
  end
  B -. Figma MCP .-> FM[(Figma)]
  V -. Figma MCP .-> FM
  B -. Storybook MCP + screenshots .-> SD[storybook dev]
  V -. Storybook MCP + screenshots .-> SD
  B -- PR --> R{Human review}
  R -- merge --> L[Release workflow]
  L -- deploy --> S[Storybook]
  L --> CA[Content agent]
  CA -. Contentful MCP, cloned env .-> C[(Contentful)]
  CA -. validated promote .-> C
  U[Slack /page] --> K[Composer agent]
  K -. Storybook docs MCP .-> S
  K -. Contentful MCP, read-only .-> C
  K -- validated drafts --> C
  K -- signed preview link --> S
```

The steps that must be exact are deterministic code the agents call as tools: token generation, the content-model planner, validation, promotion. Every stage reads the same versioned **manifest** (`packages/design-system/manifests/<version>.json`), so tokens, components, content types and pages can't drift apart. See [docs/architecture.md](docs/architecture.md) for the stages, their tools and guardrails, versioning, and the security model.

## Repository layout

| Path | What it is |
|------|------------|
| `packages/schema` | Manifest schema, semver diffing, page validation, token codegen, Figma annotation parsing, Contentful mapping. Shared by everything. |
| `packages/agents` | The agent runtime: stage runner on the Claude Agent SDK, Figma/Contentful/Storybook MCP configs, per-stage tool policies, and the in-process pipeline tools (verify, screenshot, content-model steps, page drafts). |
| `packages/design-system` | The Storybook design system: React components, stories, generated tokens/registry, `PageRenderer`, contract tests, Storybook MCP addon. |
| `packages/contentful` | Content-model planning and release steps (clone, apply, find stranded content, validate, promote), page writer/publisher, signed preview tokens. |
| `apps/pipeline` | The pipeline CLI: `build` (build agent → review agent → verify → PR body) and `release` (content agent). |
| `apps/figma-plugin` | Figma plugin that extracts and publishes the design system. |
| `apps/gateway` | Small HTTP service: receives publishes, commits manifests, triggers the build, serves signed draft previews. |
| `apps/slack-bot` | Slack app running the composer agent. |
| `.github/workflows` | CI, the build stage (`design-system-build.yml`) and the release stage (`design-system-release.yml`). |

## Quick start (local)

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm test                                        # unit tests plus an end-to-end Agent SDK session against a scripted model
pnpm --filter @storypage/design-system storybook # http://localhost:6006
```

The repo ships with a seed design system (`manifests/1.0.0.json`: tokens, `Button`, `FeatureCard`, `Hero`, `FeatureGrid`, `RichTextSection`) so every stage works before the first Figma publish.

## Setting it up

### 1. Gateway

Deploy `apps/gateway` anywhere that runs Node (`pnpm --filter @storypage/gateway start`). See [`apps/gateway/.env.example`](apps/gateway/.env.example). It needs a GitHub token that can create branches and send `repository_dispatch` events (a fine-grained token with *Contents: read & write*).

### 2. Figma plugin

```bash
pnpm --filter @storypage/figma-plugin build
```

Set your gateway's URL in `apps/figma-plugin/manifest.json` → `networkAccess.allowedDomains`, then in Figma use **Plugins → Development → Import plugin from manifest…**. Publish it privately to your organization when ready. The first time it runs, enter the gateway URL and the publish token.

### 3. GitHub

| Kind | Name | Used by |
|------|------|---------|
| Secret | `ANTHROPIC_API_KEY` | Build, review and content agents |
| Secret | `FIGMA_API_KEY` | Figma MCP for the build and review agents (a Figma personal access token with file read access). Without it they work from the manifest's layout and preview images. |
| Secret | `STORYPAGE_BOT_TOKEN` (optional) | Pushing and opening the release PR. A PAT/App token lets the PR trigger CI; PRs opened with `GITHUB_TOKEN` don't. |
| Secret | `CONTENTFUL_MANAGEMENT_TOKEN` | Contentful sync |
| Variable | `CONTENTFUL_SPACE_ID`, `CONTENTFUL_ENVIRONMENT` (default `master`), `CONTENTFUL_LOCALE` (default `en-US`) | Contentful sync |
| Variable | `CONTENTFUL_SYNC_STRATEGY` (`alias` default, or `in-place`), `CONTENTFUL_KEEP_ENVIRONMENTS` (optional) | Contentful sync |
| Variable | `STORYPAGE_GATEWAY_URL` | Storybook preview story |
| Variable | `STORYPAGE_AGENT_MAX_BUDGET_USD` (default 25) | Spend cap per agent stage |
| Variable | `STORYPAGE_CONTENT_AGENT` (`false` to disable) | Release without the content agent: schema-only sync, no content migration |

Enable GitHub Pages with source **GitHub Actions** (or swap the deploy job for your host).

### 4. Contentful

Create a management token with access to the space. The default `alias` strategy needs [environment aliases](https://www.contentful.com/developers/docs/concepts/environment-aliases/) with `master` as an alias. Without them, set `CONTENTFUL_SYNC_STRATEGY=in-place`. To bootstrap from the seed design system, run the **Design system release** workflow once manually.

### 5. Slack bot

Create a Slack app from [`apps/slack-bot/manifest.yml`](apps/slack-bot/manifest.yml), install it, and deploy `apps/slack-bot` with the variables in [`apps/slack-bot/.env.example`](apps/slack-bot/.env.example). `PREVIEW_SIGNING_SECRET` must match the gateway's. For local development, set `SLACK_APP_TOKEN` to use Socket Mode (no public URL needed).

## Using it

**Designers:** annotate components in Figma (see [Figma annotations](docs/architecture.md#figma-annotations)), open the plugin, **Scan file**, check the diff and the suggested version, write what changed, and **Publish**. A PR titled *Design system x.y.z* follows a few minutes later.

**Engineers:** review the PR like any other. It contains the build agent's per-component report and judgment calls, the review agent's verdict and findings, and the verification result (typecheck, contract tests, Storybook build). If verification failed, the PR is a draft. Merging releases it. The release job's summary shows the content agent's report: what content it migrated, and anything an editor should check.

**Everyone else:** in Slack, run `/page a landing page for our October webinar on AI search` or mention `@StoryPage`. Reply in the thread to change the page. **Preview** opens it rendered by Storybook, **Open in Contentful** lets editors fine-tune it, and **Publish** makes it live (limited to `SLACK_PUBLISHER_IDS` if set).
