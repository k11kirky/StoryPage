# Hosted StoryPage: the gateway plus the local runner, which runs the agent
# stages itself instead of GitHub Actions (STORYPAGE_RUNNER=local).
#
#   docker build -t storypage .
#   docker run -p 8787:8787 -v storypage-data:/data --env-file .env storypage
#
# /data keeps the repo checkout, the hosted Storybook and Claude's config
# (including the Figma MCP sign-in from `pipeline figma-connect`) across restarts.

# Matches playwright-core in packages/agents, so story screenshots find their browser.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production \
    PORT=8787 \
    STORYPAGE_RUNNER=local \
    STORYPAGE_WORKDIR=/data \
    CLAUDE_CONFIG_DIR=/data/claude
VOLUME /data
EXPOSE 8787
CMD ["pnpm", "--filter", "@storypage/gateway", "start"]
