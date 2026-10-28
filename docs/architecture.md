# Architecture

## The manifest is the contract

The Figma plugin publishes a **manifest**: a JSON document validated by `DesignSystemManifestSchema` in `packages/schema`. It contains:

- **Tokens** from Figma variables, with values per mode (e.g. `Light`/`Dark`) and aliases preserved.
- **Text and effect styles.**
- **Components:** a stable Figma key, a PascalCase name and category (from `Category/Name`), placement, typed **props**, a trimmed **layout tree** of the default variant (auto-layout, padding, gaps, bound token names) and a PNG **preview** of all variants.

Everything downstream is derived from it:

| Derived artifact | How | Where |
|---|---|---|
| `tokens.css`, `tokens.ts` | Deterministic codegen | `packages/design-system/src/generated/` |
| `registry.json` (component contracts) | Deterministic | same, also served at `<storybook>/registry.json` |
| React components and stories | **Claude agent**, verified by contract tests | `packages/design-system/src/components/` |
| Contentful content types | Deterministic plan + migration | Contentful environment `ds-x-y-z` |
| Pages | **Claude** in Slack, validated against the registry | Contentful entries |

Only the two steps that need judgment use a model: turning a visual spec into React, and turning a request into a page. Everything else is deterministic code with tests.

## Versioning

`diffManifests()` matches components by their **Figma key**, so a rename shows up as a rename rather than an add plus a remove. It also computes the minimum semver bump:

| Change | Bump |
|---|---|
| Token or style values, descriptions, visual layout | patch |
| New tokens, components, props, enum options or slot targets; a component promoted (Storybook only → Content block → Page section) | minor |
| Removed or renamed component, removed editable prop, kind change, removed enum option, prop becomes required without a default, a component demoted (e.g. Page section → Content block → Storybook only), removed token | **major** |

The plugin shows the diff and suggests the next version. The gateway rejects under-bumped versions (`409` with the version it needs) and re-publishing an existing version.

A version moves through the system like this:

1. **Published:** `manifests/x.y.z.json` is on branch `design-system/vx.y.z`.
2. **Built:** the agent's commit is on the same branch, and a PR is open.
3. **Released:** the PR is merged, Storybook is deployed, Contentful's `master` alias points at `ds-x-y-z`, a `dsRelease` entry records the registry, and the git tag `design-system@x.y.z` is pushed.

Every page entry stores the `designSystemVersion` it was built with.

## How a release starts

Designers already know how to ship a design system in Figma: they build components with variants and properties, define variables and styles, and **Publish library** so other files can use it. StoryPage starts from that same action.

1. Figma sends a `LIBRARY_PUBLISH` webhook to the gateway (`/webhooks/figma`). The payload carries the file, who published it, the publish description, and which components, styles and variables changed.
2. The gateway reads the library through Figma's REST API (`packages/figma`):
   - components and component sets, with their properties, variants and default-variant layout;
   - text and effect styles;
   - the choices made in the plugin (shared plugin data on each component);
   - variables, from the REST variables API on Enterprise plans, or otherwise from the snapshot the plugin saves in the file.
3. It applies the designer's choices (`resolveSelection`) and diffs against the released version. If nothing StoryPage builds changed, it stops quietly. Otherwise the change decides the semver bump, and the publish description becomes the changelog.
4. It commits the manifest and previews (rendered by Figma's image API) to `design-system/v<version>` and hands the release to the runner. Progress, and anything a designer must fix, is posted to Slack (`SLACK_NOTIFY_WEBHOOK_URL`).

The plugin's own *Publish now* button runs steps 3–4 the same way, for files that aren't published as libraries. The plugin and the REST reader share their conversion code (`packages/schema/src/figma*.ts`), so both produce the same manifest; tests run one library through both.

## Where the agents run

`apps/pipeline` holds every stage; the runner (`apps/gateway/src/runners`) only decides where it runs.

- **`github` (default, open source):** the gateway sends a `repository_dispatch`. `design-system-build.yml` runs the build and review agents and opens the PR. `design-system-release.yml` deploys Storybook and runs the content agent after merge.
- **`local` (hosted, or one self-hosted machine):** the gateway runs `pipeline build` itself, one job at a time, in a checkout under `STORYPAGE_WORKDIR`. It then:
  - pushes the agents' commit and opens the PR through the GitHub API;
  - on GitHub's "PR merged" webhook, builds Storybook, serves it at `/storybook/`, and runs `pipeline release`.

  Git credentials are passed per command and never written to the checkout. Pipeline commands get only Anthropic, Figma, Contentful and StoryPage settings, never the gateway's GitHub token or publish token. Job status is at `/jobs/<id>`. The `Dockerfile` packages this, and its `/data` volume keeps the checkout, the hosted Storybook and the Figma MCP sign-in.

## The agentic pipeline

Each stage is a **Claude Agent SDK** session started by `runStage()` (`packages/agents`). A stage has:

- a fixed set of **MCP servers**,
- a **tool allowlist** enforced by a permission policy; there is no human prompt, and tools a stage may not use are removed from the model's context,
- a **budget** and turn limit,
- a **structured result** the next step relies on.

The steps that must be exact are **in-process pipeline tools**, deterministic code the agents call: token codegen, verification, the content-model planner, validation and promotion.

| Stage | Runs in | MCP servers | Can change | Result |
|---|---|---|---|---|
| **Build** | Build workflow | Figma (official server, or Framelink), Storybook (`storybook dev` + addon-mcp), pipeline: `get_release_plan`, `verify_design_system`, `screenshot_story` | Files under `src/components/` only; no shell | Per-component report, judgment calls, unresolved items |
| **Review** (fresh session each round) | Build workflow | Figma, Storybook docs, pipeline: `get_release_plan`, `screenshot_story` | Nothing (read-only) | Verdict + findings (blocking/minor) |
| **Content** | Release workflow | Contentful (`@contentful/mcp-server`, pinned to the release environment), Storybook docs (served from the deployed build), pipeline: `plan_content_model`, `apply_content_model`, `list_pending_migrations`, `markdown_to_rich_text`, `validate_environment`, `promote_environment` | Entries in the cloned environment (`update_entry`, `publish_entry`); content types only via `apply_content_model`; the alias only via `promote_environment` | Migrations done, items for editors |
| **Composer** | Slack bot, per thread | Contentful (read-only, live), Storybook docs, pipeline: `save_page_draft`, `load_page`, `search_assets` | Draft pages via `save_page_draft` only | Reply + draft |

### Build → review → verify (`pipeline build`)

1. **Codegen** (deterministic): diff the manifest against the current registry, check the semver bump, and regenerate tokens and the registry.
2. **Plan:** tasks per component (create, update with exact prop changes, or remove), each with its contract, Figma `fileKey`/`nodeId`, preview image and layout tree.
3. **Build agent:**
   - reads the design (`get_figma_data`, plus `download_figma_images` into `.storypage/figma/`) and learns the existing system (`get-storybook-story-instructions`, `docs-show`);
   - writes components and stories;
   - screenshots its stories at desktop and mobile widths, in light and dark mode, and compares them with the Figma render;
   - runs `verify_design_system` until it passes.
4. **Review agent:** an independent session that never wrote the code compares every changed story with Figma and the contract. Blocking findings **resume the build agent's session**, then a new reviewer checks again (up to `--max-review-rounds`, default 2).
5. **Verify** (deterministic): typecheck, contract tests and a Storybook build decide the PR's status, whatever the agents reported. The PR body carries the build report, review findings, verification result and per-stage cost.

The contract tests (`packages/design-system/test/contracts.test.tsx`) are the quality gate. Every registry component must:

- be exported in `componentMap`,
- have a story titled `<category>/<Name>`,
- render with sample content (each text prop must appear in the output),
- render every enum option.

### Content migration (`pipeline release`)

1. **Clone** (deterministic): copy the environment the `master` alias points at into `ds-x-y-z`.
2. **Content agent:**
   - applies the schema with `apply_content_model`;
   - lists content the schema change stranded (`list_pending_migrations`): entries whose old field holds a value the new field doesn't;
   - moves and converts it with the Contentful MCP, e.g. plain text into a new Rich Text field via `markdown_to_rich_text`, or a removed enum option to the closest new one;
   - republishes entries that were published before;
   - fixes pages `validate_environment` flags.
3. **Promote:** `promote_environment` refuses while any kind-change migration is pending or any page fails validation. Pages that use a removed component are warnings for editors, not blockers. When it succeeds, it records the `dsRelease` entry and moves the alias. If the agent can't get there safely, the job fails, the alias stays where it was, and the report says why.

`--skip-agents` (or `STORYPAGE_CONTENT_AGENT=false`) runs the same steps without the agent: the schema is synced and stranded content stays in hidden fields.

### Composer (Slack)

The bot reads the registry from the latest `dsRelease` entry in Contentful, so it composes against exactly the content model that is live. Each Slack thread is one Agent SDK session, resumed for every reply.

The composer can:

- look up components with Storybook's docs tools;
- look at existing pages with Contentful's read tools;
- write only through `save_page_draft`, which validates against the component contracts (`validatePage()`) before any entry is created. Problems come back as path-qualified messages, such as `sections[0].cta: FeatureCard is not allowed here; use one of: Button`, so it can fix them.

Nothing is published until a person presses **Publish**.

## Contentful schema rules

`planContentModel()` turns the registry into content types (`ds<Name>`, plus `page` and `dsRelease`) and **never deletes content**:

| Registry change | Contentful change |
|---|---|
| New component | New content type, created in two passes so types that reference each other can be created in any order |
| New prop | New field |
| Removed prop | Field becomes `omitted` and `disabled`, and is renamed "(deprecated)"; data kept and listed for review |
| Kind change (e.g. text → richText) | The old field is hidden and a new field `<prop>V<major>` is created; the content agent moves the data. Readers and writers resolve the live field with `resolveFieldId()`. |
| Removed component | Content type renamed `[Deprecated] …` and removed from page section validations; existing entries are reported to editors |
| Enum options, slot targets, required, defaults | Field validations and defaults updated in place |

**Rollback** means pointing the alias back at the previous environment. Set `CONTENTFUL_KEEP_ENVIRONMENTS` to prune old clones, since spaces have environment limits.

## Choosing what to publish

Most Figma files hold far more than editors should see: primitives, icons, work in progress. Designers decide in the plugin, per component, with no syntax to learn.

| Choice in the plugin | Storybook | Contentful |
|---|---|---|
| **Page section** | Component + stories | Content type `ds<Name>`, allowed in `page.sections` |
| **Content block** | Component + stories | Content type `ds<Name>`, allowed only in other components' slots |
| **Storybook only** | Component + stories (a building block other components use) | Nothing |
| **Not published** | Nothing | Nothing |

### Components that come along automatically

Designers usually pick just the sections. `resolveSelection()` (`packages/schema/src/figma.ts`) then adds what those need. Each automatic inclusion is shown in the plugin with its reason.

- Every component **used inside** a published one (an instance in its layout) is published to **Storybook only**, so the agent can build the section from the real component.
- Every component a published section or block **offers in a content slot** (an instance-swap property's preferred values) becomes a **Content block**, so editors can fill the slot.
- A designer's explicit choice always wins:
  - Choosing *Storybook only* for a slot's component turns that slot into a design decision in code; it's no longer a Contentful field.
  - *Don't include* removes it from slots. It's still built for Storybook if a published component contains it; the plugin warns when that happens.
  - A required content slot that only Storybook-only components could fill is rejected with a fix to choose.

### Content fields

For sections and blocks, the plugin lists the fields Contentful will get, derived from Figma's component properties:

| Figma property | Field (designers can change it) |
|---|---|
| Text | *Short text*, or *Paragraph* / *Link* when the name suggests it (`body`, `href`, …). Switchable to *Formatted text*. Required. |
| Boolean, or a variant with only true/false, yes/no or on/off | *On/off* |
| Variant | *Choice*. Variants named `state`/`interaction` start as design-only. |
| Instance swap / slot | *Components*: the content blocks it accepts |

Designers can:

- untick **Editors fill in** to make a property a design decision. It stays a React prop for Storybook, but gets no Contentful field.
- **Add field** for what Figma has no property for: an *Image*, a *Link*, *Formatted text*.

### Where choices live

Choices are stored on each component in the Figma file as shared plugin data, so the whole team sees the same selection and it versions with the file. Files from before the picker can still use description annotations (`@placement section`, `@prop body: richText`, …); a saved choice in the plugin takes precedence. Components whose names start with `_` or `.` are treated as private and never listed.

### Changing your mind

Tiers are part of the version:

- Promoting a component (Storybook only → Content block → Page section) is a **minor** release.
- Demoting one is **major**: its Contentful type is deprecated (never deleted) and the content agent reports the pages that used it.

## Security model

Agents run unattended on untrusted input: manifests are designer-authored, Slack messages are user-authored, and code the agents write gets executed. So every stage is fenced in.

- **Tools:** each stage has an explicit allowlist (`createPolicy`). Everything else is denied, and MCP tools outside it are removed from the model's context, so the content agent never sees `delete_entry`, `delete_environment` or the content-type tools.
- **Files and shell:**
  - The build agent writes only under `src/components/` and has **no shell**; checks run through `verify_design_system`.
  - The reviewer is read-only.
  - The composer and content agents have no file or shell tools at all.
  - Figma image downloads are confined to `.storypage/figma/`.
- **Contentful scoping:** the Contentful MCP's tools take `spaceId`/`environmentId` as arguments. The policy pins every call, reads included, to the stage's own environment: the release clone for the content agent, the live alias (read-only) for the composer. The server also runs with `PROTECTED_ENVIRONMENTS` set to the live alias and its target, so it refuses those writes itself.
- **Credentials:**
  - MCP servers get only their own credentials, passed in their configs.
  - The Claude Code process gets only `ANTHROPIC_*` and a few explicit settings (no parent-session state).
  - Verification and `storybook dev`, which run agent-written code, get no credentials.
  - The workflow keeps the git push token off disk until the agents finish.

  Agent-written code still runs with the agent's API key reachable through its parent process tree; network-restricted runners close that gap.
- **Human gates:** a person reviews every design-system PR before `main`, and a person presses **Publish** for every page (restrictable with `SLACK_PUBLISHER_IDS`).
- **Figma → gateway:** a shared bearer token, compared in constant time. The gateway, not the plugin, holds the GitHub token.
- **Previews:** Storybook builds hold **no Contentful credentials**. The Slack bot signs `slug + expiry` with `PREVIEW_SIGNING_SECRET` (HMAC-SHA256, 7-day expiry by default), and the gateway verifies the signature before returning a draft page.
- **Third-party servers:** MCP servers run from versions pinned in the lockfile, not fetched at runtime. Framelink's telemetry is turned off.

## Scaling notes

- The Slack bot maps threads to Agent SDK sessions in memory, and sessions are stored under `CLAUDE_CONFIG_DIR`. To run several instances, move the map to Redis or Postgres and put `CLAUDE_CONFIG_DIR` and `STORYPAGE_BOT_WORKDIR` on shared storage.
- Editing a page writes new block entries; the old ones remain as unreferenced drafts. A periodic cleanup job, or an editor reusing the existing block ids, can be added.
- Model choices are environment-configurable: `STORYPAGE_AGENT_MODEL` for every stage and `STORYPAGE_COMPOSER_MODEL` for the bot (default `claude-opus-5-5`). Pipeline stages run at `high` effort; the composer runs at `medium` to keep Slack responsive.
- **Figma MCP modes** (`FIGMA_MCP`):
  - `official` (the default) is Figma's remote server. It has no token login, only OAuth from approved clients, and the Agent SDK qualifies because it runs Claude Code. `pipeline figma-connect` signs in once, and Claude Code stores the grant in `CLAUDE_CONFIG_DIR`, keyed by server name, type, URL and headers, so the agents' `figma` server config reuses it. The machine running the agents must keep that directory, which means a self-hosted runner or another persistent worker.
  - `framelink` uses a personal access token and works on ephemeral runners.
  - `url` points at another server with Figma's tools, such as the Dev Mode server in the desktop app.
  - `off` runs without Figma; agents work from the manifest's layout tree and preview images (the e2e harness uses this, since its Figma file is a stand-in).

  Every stage records whether Figma connected, and the PR says when it didn't.
