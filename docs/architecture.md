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
| New tokens, components, props, enum options or slot targets | minor |
| Removed or renamed component, removed editable prop, kind change, removed enum option, prop becomes required without a default, section becomes non-section, removed token | **major** |

The plugin shows the diff and suggests the next version. The gateway rejects under-bumped versions (`409` with the version it needs) and re-publishing an existing version.

A version moves through the system like this:

1. **Published:** `manifests/x.y.z.json` is on branch `design-system/vx.y.z`.
2. **Built:** the agent's commit is on the same branch, and a PR is open.
3. **Released:** the PR is merged, Storybook is deployed, Contentful's `master` alias points at `ds-x-y-z`, a `dsRelease` entry records the registry, and the git tag `design-system@x.y.z` is pushed.

Every page entry stores the `designSystemVersion` it was built with.

## The Storybook agent

`apps/storybook-agent` runs in the **Design system build** workflow:

1. Diff the new manifest against the version in `registry.json`.
2. Regenerate tokens and the registry (no model involved).
3. Plan tasks: create, update (with the exact prop changes) or remove each component. Token-only releases skip the agent.
4. Run Claude through the **Claude Agent SDK** with the Claude Code toolset. The prompt contains each component's contract, Figma layout tree and preview image path. `packages/design-system/CLAUDE.md` defines the conventions.
5. Run `verify` (typecheck, contract tests, Storybook build). On failure, resume the **same agent session** with the error output, up to 3 attempts.
6. Write `.storypage/pr-body.md`. The workflow commits, pushes and opens the PR, as a draft if verification still fails.

The contract tests (`packages/design-system/test/contracts.test.tsx`) are the quality gate. Every registry component must:

- be exported in `componentMap`,
- have a story titled `<category>/<Name>`,
- render with sample content (each text prop must appear in the output),
- render every enum option.

## Contentful migration strategy

`planContentModel()` turns the registry into content types (`ds<Name>`, plus `page` and `dsRelease`) and **never deletes content**:

| Registry change | Contentful change |
|---|---|
| New component | New content type, created in two passes so types that reference each other can be created in any order |
| New prop | New field |
| Removed prop | Field becomes `omitted` and `disabled`, and is renamed "(deprecated)"; existing data is kept |
| Kind change (e.g. text → richText) | The old field is hidden and a new field `<prop>V<major>` is created. Readers and writers resolve the live field with `resolveFieldId()`. |
| Removed component | Content type renamed `[Deprecated] …` and removed from page section validations; existing entries still render |
| Enum options, slot targets, required, defaults | Field validations and defaults updated in place |

With the default `alias` strategy, each release is applied to a fresh clone (`ds-x-y-z`) of the environment `master` currently points at, and `master` moves only after every content type is migrated. **Rollback** means pointing the alias back. Set `CONTENTFUL_KEEP_ENVIRONMENTS` to prune old clones, since spaces have environment limits.

## The Slack composer

`apps/slack-bot` reads the registry from the latest `dsRelease` entry in Contentful, so it always composes against exactly the content model that is live. It uses the Anthropic SDK tool runner (`claude-opus-5-5`, adaptive thinking, server-side refusal fallback) with three tools:

- `search_assets`: find existing images to reference.
- `load_page`: load an existing page (drafts included) to edit it.
- `save_page_draft`: validate against the component contracts (`validatePage()`), then write draft entries bottom-up. Validation problems go back to Claude as precise, path-qualified messages, such as `sections[0].cta: FeatureCard is not allowed here; use one of: Button`, so it can fix them and retry.

Each Slack thread is one conversation. Replies continue it, and messages in the same thread are queued rather than raced. Nothing is published until a person presses **Publish**, which publishes the page's children first and then the page.

## Figma annotations

Figma component properties map to props automatically:

| Figma property | Prop |
|---|---|
| Text | `text`, required |
| Boolean, or a variant with only true/false, yes/no or on/off | `boolean` |
| Variant | `enum` (options camelCased). Variants named `state`/`interaction` are not CMS-editable. |
| Instance swap / slot | `slot`, allowed components from preferred values |

Anything else goes in the component's **description**:

```
A full-width hero with a headline and call to action.
@placement section
@category Marketing
@prop body: richText -- Supporting copy under the headline
@prop image: image required
@prop eyebrow: text optional
@prop cta: slot Button
@prop features: slot[] FeatureCard|StatCard
@prop state: internal
```

Kinds are `text`, `longText`, `richText`, `number`, `boolean`, `enum`, `image`, `link` and `slot`, with `[]` marking a list. Components whose names start with `_` or `.` are treated as private and not published.

## Security model

- **Figma → gateway:** a shared bearer token, compared in constant time. The gateway, not the plugin, holds the GitHub token.
- **The agent's input is untrusted.** Manifest text is designer-authored, so the agent runs with a strict permission policy (`apps/storybook-agent/src/permissions.ts`):
  - writes only under `src/components/`,
  - shell limited to the design system's own `pnpm` scripts, with no chaining or redirection,
  - no web tools.

  Child processes get an allowlisted environment: verification gets no credentials at all, and the agent gets only `ANTHROPIC_*`. The workflow keeps the push token off disk until the agent has finished. Agent-written code still runs during verification, with the agent's API key in scope; network-restricted runners close that gap. Finally, a human reviews every PR before it reaches `main`.
- **Previews:** Storybook builds hold **no Contentful credentials**. The Slack bot signs `slug + expiry` with `PREVIEW_SIGNING_SECRET` (HMAC-SHA256, 7-day expiry by default). The gateway verifies the signature before returning a draft page, so a public Storybook can't read unpublished content.
- **Publishing:** draft-only by default. Publishing needs a button press in Slack and can be restricted with `SLACK_PUBLISHER_IDS`.

## Scaling notes

- The Slack bot keeps conversation state in memory, which is fine for one instance. Swap `ConversationStore` for Redis or Postgres to run several.
- Editing a page writes new block entries; the old ones remain as unreferenced drafts. A periodic cleanup job, or an editor reusing the existing block ids, can be added.
- Model choices are environment-configurable: `STORYPAGE_AGENT_MODEL` and `STORYPAGE_COMPOSER_MODEL`. The composer runs at `medium` effort to keep Slack responsive.
