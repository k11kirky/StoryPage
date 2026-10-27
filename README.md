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

Set your gateway's URL in `apps/figma-plugin/manifest.json` → `networkAccess.allowedDomains`, then in Figma use **Plugins → Development → Import plugin from manifest…**. Publish it privately to your organization, so designers just find it under **Plugins** like any other. The first time someone runs it, they enter the gateway URL and the publish token. You can share those with the team once.

### 3. Figma MCP for the agents (one time, not for designers)

The build and review agents read the design through **Figma's official MCP server** (`https://mcp.figma.com/mcp`). It signs in with OAuth only, and only from approved clients. Claude Code is one of them, and the Agent SDK runs Claude Code. So someone signs in **once** on the machine that runs the agents, with a Figma account that can view the design-system file (a shared "design bot" seat works well):

```bash
CLAUDE_CONFIG_DIR=/srv/storypage/claude pnpm --filter @storypage/pipeline pipeline figma-connect --no-browser
```

It prints a Figma sign-in link; open it, approve, and paste the redirect URL back. The grant is stored in `CLAUDE_CONFIG_DIR` and refreshed by later runs, so that directory must persist. Run the build workflow on a **self-hosted runner** with that directory: set the `STORYPAGE_AGENT_RUNNER` and `STORYPAGE_CLAUDE_CONFIG_DIR` variables. If Figma ever needs signing in again, the PR says so and the agents carry on from the manifest.

No persistent runner? Use GitHub-hosted runners with `FIGMA_MCP=framelink` and a `FIGMA_API_KEY` personal access token: the community Framelink server reads the same file over Figma's REST API.

### 4. GitHub

| Kind | Name | Used by |
|------|------|---------|
| Secret | `ANTHROPIC_API_KEY` | Build, review and content agents |
| Variable | `STORYPAGE_AGENT_RUNNER`, `STORYPAGE_CLAUDE_CONFIG_DIR` | Self-hosted runner label and its persistent Claude config directory, for Figma's official MCP server |
| Variable | `FIGMA_MCP` (optional) | `official` (default), `framelink`, or `url` with `FIGMA_MCP_URL` |
| Secret | `FIGMA_API_KEY` (only for `framelink`) | Figma personal access token with file read access |
| Secret | `STORYPAGE_BOT_TOKEN` (optional) | Pushing and opening the release PR. A PAT/App token lets the PR trigger CI; PRs opened with `GITHUB_TOKEN` don't. |
| Secret | `CONTENTFUL_MANAGEMENT_TOKEN` | Contentful sync |
| Variable | `CONTENTFUL_SPACE_ID`, `CONTENTFUL_ENVIRONMENT` (default `master`), `CONTENTFUL_LOCALE` (default `en-US`) | Contentful sync |
| Variable | `CONTENTFUL_SYNC_STRATEGY` (`alias` default, or `in-place`), `CONTENTFUL_KEEP_ENVIRONMENTS` (optional) | Contentful sync |
| Variable | `STORYPAGE_GATEWAY_URL` | Storybook preview story |
| Variable | `STORYPAGE_AGENT_MAX_BUDGET_USD` (default 25) | Spend cap per agent stage |
| Variable | `STORYPAGE_CONTENT_AGENT` (`false` to disable) | Release without the content agent: schema-only sync, no content migration |

Enable GitHub Pages with source **GitHub Actions** (or swap the deploy job for your host).

### 5. Contentful

Create a management token with access to the space. The default `alias` strategy needs [environment aliases](https://www.contentful.com/developers/docs/concepts/environment-aliases/) with `master` as an alias. Without them, set `CONTENTFUL_SYNC_STRATEGY=in-place`. To bootstrap from the seed design system, run the **Design system release** workflow once manually.

### 6. Slack bot

Create a Slack app from [`apps/slack-bot/manifest.yml`](apps/slack-bot/manifest.yml), install it, and deploy `apps/slack-bot` with the variables in [`apps/slack-bot/.env.example`](apps/slack-bot/.env.example). `PREVIEW_SIGNING_SECRET` must match the gateway's. For local development, set `SLACK_APP_TOKEN` to use Socket Mode (no public URL needed).

## Using it

**Designers** only use the Figma plugin:

1. **Scan file.**
2. **Choose what to publish.** Every component gets one of four choices:
   - **Page section:** editors can add it to pages.
   - **Content block:** editors can put it inside other components, like a card in a grid.
   - **Storybook only:** built as code for other components to use.
   - **Not published.**

   **Use suggestions** picks likely page sections. Anything a chosen component is built from, or offers in a slot, is included automatically with the reason shown. For sections and blocks, **Content fields** shows what editors fill in: switch a text to *Paragraph*, *Formatted text* or *Link*, untick design-only options, or add an *Image* field. Choices are saved in the Figma file, so the whole team shares them. See [Choosing what to publish](docs/architecture.md#choosing-what-to-publish).
3. **Continue.** Check the summary and the suggested version, write what changed, and **Publish**.

A PR titled *Design system x.y.z* follows a few minutes later.

**Engineers:** review the PR like any other. It contains the build agent's per-component report and judgment calls, the review agent's verdict and findings, and the verification result (typecheck, contract tests, Storybook build). If verification failed, the PR is a draft. Merging releases it. The release job's summary shows the content agent's report: what content it migrated, and anything an editor should check.

**Everyone else:** in Slack, run `/page a landing page for our October webinar on AI search` or mention `@StoryPage`. Reply in the thread to change the page. **Preview** opens it rendered by Storybook, **Open in Contentful** lets editors fine-tune it, and **Publish** makes it live (limited to `SLACK_PUBLISHER_IDS` if set).
