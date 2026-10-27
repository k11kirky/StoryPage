// Generated from Figma by @storypage/schema — design-system@1.0.0. Do not edit.
export const designSystemVersion = "1.0.0";

/** CSS custom-property references for every Figma variable. */
export const tokens = {
  "palette": {
    "blue": {
      "_600": "var(--palette-blue-600)",
      "_400": "var(--palette-blue-400)"
    },
    "gray": {
      "_900": "var(--palette-gray-900)",
      "_100": "var(--palette-gray-100)"
    },
    "white": "var(--palette-white)"
  },
  "color": {
    "brand": {
      "primary": "var(--color-brand-primary)"
    },
    "text": {
      "default": "var(--color-text-default)",
      "muted": "var(--color-text-muted)",
      "onBrand": "var(--color-text-on-brand)"
    },
    "surface": {
      "default": "var(--color-surface-default)",
      "subtle": "var(--color-surface-subtle)"
    },
    "border": {
      "default": "var(--color-border-default)"
    }
  },
  "space": {
    "_1": "var(--space-1)",
    "_2": "var(--space-2)",
    "_3": "var(--space-3)",
    "_4": "var(--space-4)",
    "_6": "var(--space-6)",
    "_8": "var(--space-8)",
    "_12": "var(--space-12)",
    "_16": "var(--space-16)"
  },
  "radius": {
    "sm": "var(--radius-sm)",
    "md": "var(--radius-md)",
    "lg": "var(--radius-lg)",
    "full": "var(--radius-full)"
  },
  "font": {
    "family": {
      "sans": "var(--font-family-sans)"
    }
  },
  "shadow": {
    "card": "var(--shadow-card)"
  }
} as const;

/** Class names for Figma text styles, keyed by style name. */
export const textStyles = {
  "display": "ds-text-display",
  "heading/lg": "ds-text-heading-lg",
  "heading/md": "ds-text-heading-md",
  "body/md": "ds-text-body-md",
  "body/lg": "ds-text-body-lg",
  "label": "ds-text-label",
  "eyebrow": "ds-text-eyebrow"
} as const;

export type TextStyleName = keyof typeof textStyles;
