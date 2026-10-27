import type { Meta, StoryObj } from "@storybook/react-vite";
import { FeatureCard } from "../FeatureCard/FeatureCard";
import { FeatureGrid } from "./FeatureGrid";

const cards = ["Figma is the source of truth", "Storybook is the contract", "Contentful is the canvas"].map((title) => (
  <FeatureCard key={title} title={title} body="Each stage is generated from the one before it and versioned together." />
));

const meta = {
  title: "Marketing/FeatureGrid",
  component: FeatureGrid,
  tags: ["autodocs"],
  args: { heading: "How it works", intro: "One pipeline from design to published page.", features: cards },
  argTypes: { features: { control: false } },
} satisfies Meta<typeof FeatureGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeColumns: Story = { args: { columns: "v3" } };
export const TwoColumns: Story = { args: { columns: "v2", features: cards.slice(0, 2) } };
