import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: { name: "@storybook/react-vite", options: {} },
  // Publishes registry.json (and tokens) next to the Storybook build so the
  // Slack composer and Contentful sync can read exactly what Storybook shows.
  staticDirs: [{ from: "../src/generated", to: "/" }],
};

export default config;
