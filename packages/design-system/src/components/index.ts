import type { ComponentType } from "react";
import { Button } from "./Button/Button";
import { FeatureCard } from "./FeatureCard/FeatureCard";
import { FeatureGrid } from "./FeatureGrid/FeatureGrid";
import { Hero } from "./Hero/Hero";
import { RichTextSection } from "./RichTextSection/RichTextSection";

export * from "./Button/Button";
export * from "./FeatureCard/FeatureCard";
export * from "./FeatureGrid/FeatureGrid";
export * from "./Hero/Hero";
export * from "./RichTextSection/RichTextSection";

/**
 * Every component in `generated/registry.json` must be listed here under its
 * contract name. The contract test fails if one is missing, and the
 * PageRenderer uses this map to render CMS content.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const componentMap: Record<string, ComponentType<any>> = {
  Button,
  FeatureCard,
  FeatureGrid,
  Hero,
  RichTextSection,
};
