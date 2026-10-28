/** What the simulated designer and content editor do in the end-to-end run. */
import type { ComponentSpec, PageDocument } from "@storypage/schema";
import type { Design } from "./library.js";

/** The color change every run publishes: a patch release with no agent work. */
export const BRAND_COLOR = { token: "palette/blue/600", value: "#1D4ED8" };

export function changeBrandColor(design: Design): Design {
  const token = design.tokens.find((t) => t.name === BRAND_COLOR.token);
  if (!token) throw new Error(`The seed design system has no ${BRAND_COLOR.token} token`);
  token.values = Object.fromEntries(Object.keys(token.values).map((mode) => [mode, BRAND_COLOR.value]));
  return design;
}

/** A new page section, for runs with agents: the build agent implements it in Storybook. */
export const TESTIMONIAL: ComponentSpec = {
  figmaKey: "t1u2v3testimonial",
  figmaNodeId: "20:1",
  name: "Testimonial",
  figmaName: "Marketing/Testimonial",
  description: "A customer quote with the person's name, role and an optional photo.",
  category: "Marketing",
  placement: "section",
  variantCount: 1,
  props: [
    { name: "quote", figmaName: "Quote#20:0", kind: "longText", required: true, editable: true },
    { name: "author", figmaName: "Author#20:1", kind: "text", required: true, editable: true },
    { name: "role", figmaName: "Role#20:2", kind: "text", required: false, editable: true },
    { name: "avatar", kind: "image", required: false, editable: true, description: "Square photo of the person" },
  ],
  layout: {
    name: "Testimonial",
    type: "COMPONENT",
    width: 1280,
    height: 420,
    layout: { mode: "VERTICAL", gap: 24, padding: [80, 64, 80, 64], align: "CENTER" },
    fills: ["color/surface/subtle"],
    tokens: { itemSpacing: "space/6" },
    children: [
      { name: "Quote", type: "TEXT", textStyle: "heading/md", characters: "“StoryPage cut our launch time in half.”" },
      {
        name: "Attribution",
        type: "FRAME",
        layout: { mode: "HORIZONTAL", gap: 12, padding: [0, 0, 0, 0], align: "CENTER" },
        children: [
          { name: "Avatar", type: "ELLIPSE", width: 48, height: 48, radius: 9999 },
          { name: "Author", type: "TEXT", textStyle: "label", characters: "Dana Kim" },
          { name: "Role", type: "TEXT", textStyle: "body/md", characters: "Head of Brand, Acme" },
        ],
      },
    ],
  },
};

export function addTestimonial(design: Design): Design {
  design.components.push(structuredClone(TESTIMONIAL));
  return design;
}

/** A page that already exists in Contentful before any release (it must survive them). */
export const HOME_PAGE: PageDocument = {
  title: "Home",
  slug: "home",
  description: "StoryPage turns your Figma design system into on-brand pages.",
  sections: [
    {
      component: "Hero",
      props: {
        eyebrow: "StoryPage",
        headline: "Pages your designers would approve",
        body: "Compose pages from the components your design team already ships.",
        cta: { component: "Button", props: { label: "Get started", href: "/start" } },
      },
    },
    {
      component: "FeatureGrid",
      props: {
        heading: "Why teams use it",
        features: [
          { component: "FeatureCard", props: { title: "Always on brand", body: "Every section comes from the design system." } },
          { component: "FeatureCard", props: { title: "Fast", body: "Ask in Slack, preview in minutes." } },
        ],
      },
    },
  ],
};

/** The page the Slack composer is asked for, and the draft it saves when the run has no model. */
export const LAUNCH_REQUEST =
  "Make a launch page for our spring release at /spring-launch: a hero with a call to action to /signup, three feature cards (faster publishing, brand-safe pages, Slack previews) and a short closing paragraph.";

export const LAUNCH_PAGE: PageDocument = {
  title: "Spring launch",
  slug: "spring-launch",
  description: "Everything new in StoryPage this spring.",
  sections: [
    {
      component: "Hero",
      props: {
        eyebrow: "New this spring",
        headline: "Ship on-brand pages in minutes",
        body: "Describe the page in Slack. StoryPage builds it from your design system and saves a draft for review.",
        cta: { component: "Button", props: { label: "Sign up", href: "/signup" } },
        align: "center",
      },
    },
    {
      component: "FeatureGrid",
      props: {
        heading: "What's new",
        columns: "v3",
        features: [
          { component: "FeatureCard", props: { title: "Faster publishing", body: "Drafts land in Contentful the moment you ask." } },
          { component: "FeatureCard", props: { title: "Brand-safe pages", body: "Only components from the design system, with their real props." } },
          { component: "FeatureCard", props: { title: "Slack previews", body: "Every draft comes with a Storybook preview link." } },
        ],
      },
    },
    {
      component: "RichTextSection",
      props: { content: "## Ready when you are\n\nStoryPage is available to every team today. **Try it** on your next launch." },
    },
  ],
};
