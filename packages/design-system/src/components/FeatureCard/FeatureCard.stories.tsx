import type { Meta, StoryObj } from "@storybook/react-vite";
import { FeatureCard } from "./FeatureCard";

const meta = {
  title: "Content/FeatureCard",
  component: FeatureCard,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  decorators: [(Story) => <div style={{ width: 320 }}><Story /></div>],
  args: { title: "Fast by default", body: "Pages are composed from tested components, so they ship quickly." },
} satisfies Meta<typeof FeatureCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithIcon: Story = {
  args: { icon: { url: "https://placehold.co/80x80/2557D6/FFFFFF/png?text=%E2%9A%A1", alt: "" } },
};
