# Design system conventions

This package is the code half of the Figma design system. Most of it is
written by the storybook-agent from published Figma manifests, then reviewed
by a human in the release PR. Humans and the agent follow the same rules.

## What is generated, and must never be edited by hand

- `manifests/<version>.json` — published by the Figma plugin. Source of truth.
- `src/generated/tokens.css`, `src/generated/tokens.ts`, `src/generated/registry.json`
  — run `pnpm --filter @storypage/design-system generate` to regenerate.

## Component layout

Each component in `src/generated/registry.json` lives in
`src/components/<Name>/` with exactly these files:

- `<Name>.tsx` — a named export `<Name>` and an exported `<Name>Props` interface.
- `<Name>.module.css` — styles. Use only token custom properties
  (`var(--color-…)`, `var(--space-…)`, `var(--radius-…)`, `var(--shadow-…)`)
  and the text-style classes (`ds-text-<style>`), never raw hex values or
  pixel spacing that a token exists for.
- `<Name>.stories.tsx` — CSF3, `title: "<category>/<Name>"` (category from
  the registry), `component: <Name>`, `tags: ["autodocs"]`, and one story per
  value of each enum prop that changes the visuals.

Then add the component to `componentMap` and the re-exports in
`src/components/index.ts`.

## Props follow the contract exactly

Prop names, kinds and enum options come from the registry. Map kinds to types:

| kind       | TypeScript                                   |
|------------|----------------------------------------------|
| text       | `string`                                     |
| longText   | `string` (plain text, may contain newlines)  |
| richText   | `string`, rendered with `<RichText value />` |
| number     | `number`                                     |
| boolean    | `boolean`                                    |
| enum       | union of the option strings                  |
| link       | `string` (URL or site-relative path)         |
| image      | `ImageValue` from `@storypage/schema`        |
| slot       | `ReactNode` (`ReactNode[]` when `multiple`)  |

Optional props (`required: false`) are optional in TypeScript and must have
the registry default as the default value. Props with `editable: false` (for
example `state`) exist only to render Figma interaction states in Storybook.

## Fidelity

Match the Figma layout in the manifest: auto-layout direction, gap and padding
map to flex/grid; bound variables in `layout.tokens` tell you which token to
use. If a preview PNG is referenced, read it and compare. Components must be
responsive (stack below 768px) and accessible: semantic elements, alt text from
`ImageValue.alt`, visible focus states, AA contrast in both color modes.

## Verify before finishing

    pnpm --filter @storypage/design-system verify

runs typecheck, the contract tests (`test/contracts.test.tsx`) and a Storybook
build. All three must pass.

## Removing or renaming components

Delete the component directory and its `componentMap` entry. Content already
in Contentful keeps working: its content type is deprecated, not deleted.
