import type { Meta, StoryObj } from "@storybook/react-vite";
import { RichTextSection } from "./RichTextSection";

const meta = {
  title: "Content/RichTextSection",
  component: RichTextSection,
  tags: ["autodocs"],
  args: {
    content: [
      "## Why a single pipeline?",
      "",
      "Design drift happens when **Figma**, *code* and the CMS evolve separately. [Read the docs](https://example.com).",
      "",
      "- Tokens are generated, never hand-copied",
      "- Components are verified in Storybook",
      "- Content types follow the component contract",
      "",
      "> Every page is backed by a tested component.",
    ].join("\n"),
  },
} satisfies Meta<typeof RichTextSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Narrow: Story = { args: { width: "narrow" } };
export const Wide: Story = { args: { width: "wide" } };
