import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../Button/Button";
import { Hero } from "./Hero";

const meta = {
  title: "Marketing/Hero",
  component: Hero,
  tags: ["autodocs"],
  args: {
    eyebrow: "New",
    headline: "Design in Figma. Publish everywhere.",
    body: "Every component you ship in Figma becomes a tested Storybook component and a Contentful content type.",
    cta: <Button label="Get started" href="/signup" />,
    image: { url: "https://placehold.co/1120x800/png", alt: "Product screenshot", width: 560, height: 400 },
  },
  argTypes: { cta: { control: false } },
} satisfies Meta<typeof Hero>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Left: Story = { args: { align: "left" } };
export const Center: Story = { args: { align: "center", image: undefined } };
export const Minimal: Story = { args: { eyebrow: undefined, body: undefined, cta: undefined, image: undefined } };
