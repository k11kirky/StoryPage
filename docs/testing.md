# Testing StoryPage end to end

There are three levels, from fastest to most real:

| Level | Command | Needs |
|-------|---------|-------|
| Unit and contract tests | `pnpm test` | nothing |
| End-to-end run with local stand-ins | `pnpm e2e` | Node 22, pnpm, git, Chromium (about two minutes) |
| Same, with every agent stage on Claude | `pnpm e2e --with-agents` | `ANTHROPIC_API_KEY` (takes longer and uses the API) |
| Live run on real Figma, GitHub, Contentful and Slack | `pnpm e2e:doctor`, then the [checklist](#live-run-on-real-services) | a staging setup |

Start with `pnpm e2e`. It needs no accounts, runs in CI, and covers everything except the outside services themselves.

## `pnpm e2e`: the whole flow on one machine

The run starts the real gateway with the hosted runner, which runs the real `pipeline build` and `pipeline release` in a fresh clone. The Storybook build and the preview story are the real ones too. Only the outside services are swapped for local stand-ins:

| Service | Stand-in | What it does |
|---------|----------|--------------|
| Figma | `e2e/src/fake-figma.ts` | A Figma REST API serving a library file built from the design system in this checkout: variables (the plugin's saved snapshot, as on non-Enterprise plans), text and effect styles, components with variants and properties, the plugin's saved choices on each component, and PNG renders. It sends the `LIBRARY_PUBLISH` webhook the way Figma does. |
| GitHub | `e2e/src/git-repo.ts` | A bare git repository the runner clones and pushes to. Pull requests are recorded and merged with git, and the merge webhook is signed like GitHub's. |
| Contentful | `e2e/src/fake-contentful.ts` | An in-memory Content Management API with environments, aliases and cloning, content types, entries and assets. It enforces versions (`X-Contentful-Version`), unknown fields and required fields on publish, like Contentful does. |
| Claude | none | Without `--with-agents`, the scenario needs no agent: a design-token change is built and released deterministically. |

### What it does

1. Builds the Figma library from `packages/design-system/manifests/<current>.json` and checks that the real extractor reads back the same components, props, tokens and text styles. This tests the plugin choices → manifest path.
2. Creates the GitHub stand-in from your working tree, uncommitted changes included, and a Contentful space at the current release with a published `/home` page.
3. **The designer publishes without changes.** The webhook is accepted and nothing is built.
4. **The designer darkens the brand blue and publishes.** The gateway reads the library, versions it as a patch (`1.0.1`), and commits the release branch with Figma previews. The runner installs, runs `pipeline build` (codegen, then verification with typecheck, contract tests and a Storybook build), pushes, and opens the pull request.
5. **A reviewer merges it.** The signed GitHub webhook starts the release. The runner builds and serves Storybook, then `pipeline release` clones Contentful's live environment to `ds-1-0-1`, applies the content model, records the release, and moves the `master` alias. The run checks that `/home` still validates against the new release.
6. **Someone asks for a page in Slack.** The composer's `save_page_draft` tool validates the page and saves it to Contentful as a draft.
7. **Preview.** The signed preview link is opened in Chromium and must render the draft in the deployed Storybook. A forged signature must be refused.
8. **An editor presses Publish.** The page and everything it references are published.

Each step checks its result. The first failure stops the run, prints the reason (job logs included), and marks the remaining steps as skipped. The exit code is non-zero on failure.

### What you get

Everything is kept in `.storypage-e2e/<timestamp>/`:

- `report.md`: each step's result and notes, the Slack messages the gateway would have posted, and request counts per stand-in.
- `pull-request.md`: the pull request body the build wrote.
- `build-*.log`, `release-*.log`: the runner's job output.
- `preview.png`: the draft page as Storybook rendered it.
- `origin.git`, `worker/repo`: the repository after the run, to inspect with git.

### Options

- `--with-agents`: needs `ANTHROPIC_API_KEY`. The designer also adds a **Testimonial** page section (`1.1.0`, minor), so the build and review agents implement it in Storybook. The content agent runs the release, and the Slack composer agent writes the page from a prompt. Figma's MCP server is off in this mode (`FIGMA_MCP=off`) because the Figma file is a stand-in, so agents work from the manifest's layout tree and preview images. Contentful's MCP server needs HTTPS, so agents use only the pipeline's own Contentful tools against the stand-in. The report and `pull-request.md` include the agents' cost.
- `--serve`: keeps everything running after the run, so you can open the deployed Storybook, the draft preview, the pull request and job status in a browser. Press Ctrl+C to stop.
- `--out <dir>`: write the run somewhere else.

Chromium comes from Playwright. If it isn't installed, run `pnpm --filter @storypage/e2e exec playwright-core install chromium`, or set `CHROMIUM_PATH`.

CI runs `pnpm e2e` on every pull request and uploads the report, logs and screenshot as the `e2e-report` artifact.

### Adding a scenario

Scenarios live in `e2e/src/scenario.ts`. A designer change is a function that edits the design, passed to `figma.edit(...)` before `figma.publishEvent(...)`. The stand-ins are plain classes, so a test can also use them directly. `e2e/test/stand-ins.test.ts` runs the real extractor, Contentful sync and page code against them in about a second.

### What the stand-ins don't cover

They are faithful to the API calls StoryPage makes, not to the services as a whole. They don't model:

- Figma: real rendering, OAuth, the official MCP server, webhook retries and pauses.
- Contentful: field validations beyond unknown and required fields, rate limits, the time cloning an environment takes, plan limits on environments.
- GitHub: Actions (the hosted runner runs the same commands instead), branch protection, checks, review requests.
- Slack itself: the composer runs, but nothing is posted.

The live run covers these.

## Live run on real services

Use a staging setup, not production:

- a copy of the Figma library file, or a small test library
- a test repository made from this one
- a Contentful space where environment aliases are available
- a Slack test channel

Then:

1. **Configure** the services as in the [README](../README.md#setting-it-up), and load the same environment variables in your shell.
2. **Check the setup:** `pnpm e2e:doctor`. It only reads, never writes. It checks the Claude API key and model, the Figma token and file (published components, and whether variables come from the Enterprise API or the plugin's snapshot), the `LIBRARY_PUBLISH` webhook, the Figma MCP sign-in for the agents, GitHub push access (plus the workflows, or the webhook secret for the hosted runner), the Contentful alias and locale, the gateway's `/health`, and the Slack bot token. Fix what it reports until it says *Ready for a live run*. Run it on the machine that runs the agents too: the Figma MCP sign-in is stored there.
3. **Publish from Figma.** In the library file, open the StoryPage plugin and choose at least one page section. Change something visible, such as a color variable, then click **Publish library** with a description.
   - Within a minute, Slack says which version is being built.
   - If it doesn't, check the gateway log for the webhook delivery and the webhook's status in `pnpm e2e:doctor`.
4. **Review the pull request.**
   - Within minutes, *Design system x.y.z* opens with the build report and verification result.
   - If it doesn't, check the `design-system-build` workflow run, or the hosted runner's `/jobs/<id>` (the link is in the Slack message).
5. **Merge it.**
   - The release deploys Storybook and creates `ds-x-y-z` in Contentful. Once pages validate, the alias moves to it.
   - Check the release workflow summary, or the job page, for the content agent's report. In Contentful, the previous environment is still there as the rollback.
6. **Compose a page.** In Slack, run `/page …`.
   - Check that the draft appears in Contentful and that **Preview** renders it in Storybook.
   - **Publish** makes it live.
7. **Rehearse a rollback** once: point the alias back at the previous environment in Contentful (Settings → Environments), and check that the site serves the old content.

When a live run fails where the offline run passes, the difference is in the service. Add what you learn to the stand-in, so `pnpm e2e` catches it next time.
