import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(ts|tsx)"],
  // addon-mcp serves an MCP endpoint at /mcp from `storybook dev`, used by the
  // pipeline agents; with the components manifest it also documents every component.
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-mcp"],
  framework: { name: "@storybook/react-vite", options: {} },
  // Publishes registry.json (and tokens) next to the Storybook build so the
  // Slack composer and Contentful sync can read exactly what Storybook shows.
  staticDirs: [{ from: "../src/generated", to: "/" }],
};

export default config;
