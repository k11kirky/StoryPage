import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button";

const meta = {
  title: "Actions/Button",
  component: Button,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { label: "Get started", href: "/signup" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: "primary" } };
export const Secondary: Story = { args: { variant: "secondary" } };
export const Large: Story = { args: { size: "lg" } };
export const Hover: Story = { args: { state: "hover" } };
export const Pressed: Story = { args: { state: "pressed" } };
