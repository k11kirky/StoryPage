# StoryPage

Figma → Storybook → Contentful → Slack pipeline. Start with README.md and docs/architecture.md.

- pnpm workspace, TypeScript, Node 22. Run `pnpm typecheck` and `pnpm test` before committing; `pnpm e2e` for changes to the gateway, runner or pipeline (see docs/testing.md).
- `packages/schema` is the shared contract. Change it first, then its consumers.
- Generated files (`packages/design-system/src/generated/*`, `manifests/*.json`) are never edited by hand.
- Component conventions live in `packages/design-system/CLAUDE.md`.
