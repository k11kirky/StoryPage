import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PageDocument } from "@storypage/schema";
import { PageRenderer } from "../renderer/PageRenderer";

const page: PageDocument = {
  title: "Launch",
  slug: "launch",
  sections: [
    {
      component: "Hero",
      props: {
        eyebrow: "Introducing StoryPage",
        headline: "From Figma to a live page in one conversation",
        body: "Ask the Slack bot for a page. It composes it from your Storybook components and drafts it in Contentful.",
        cta: { component: "Button", props: { label: "Request access", href: "/signup" } },
      },
    },
    {
      component: "FeatureGrid",
      props: {
        heading: "Built on your design system",
        features: [
          { component: "FeatureCard", props: { title: "Figma", body: "Designers publish tokens and components." } },
          { component: "FeatureCard", props: { title: "Storybook", body: "An agent builds and verifies each component." } },
          { component: "FeatureCard", props: { title: "Contentful", body: "Content types follow every release." } },
        ],
      },
    },
    { component: "RichTextSection", props: { content: "## Versioned end to end\n\nEvery page records the design-system version it was built with." } },
  ],
};

const meta = {
  title: "Pages/Example",
  component: PageRenderer,
  args: { page },
} satisfies Meta<typeof PageRenderer>;

export default meta;
export const Launch: StoryObj<typeof meta> = {};
