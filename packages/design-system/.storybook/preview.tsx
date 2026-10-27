import type { Preview } from "@storybook/react-vite";
import "../src/generated/tokens.css";
import "../src/global.css";

const preview: Preview = {
  globalTypes: {
    color: {
      description: "Figma color mode",
      toolbar: { title: "Mode", icon: "mirror", items: ["light", "dark"], dynamicTitle: true },
    },
  },
  initialGlobals: { color: "light" },
  decorators: [
    (Story, context) => (
      <div data-color={context.globals.color} className="ds-root" style={{ padding: 16 }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
    a11y: { test: "error" },
  },
};

export default preview;
