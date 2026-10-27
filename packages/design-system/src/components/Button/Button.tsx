import type { AnchorHTMLAttributes } from "react";
import styles from "./Button.module.css";

export interface ButtonProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  label: string;
  href: string;
  variant?: "primary" | "secondary";
  size?: "md" | "lg";
  /** Figma interaction state. Not editable in the CMS; used to render hover/pressed in Storybook. */
  state?: "default" | "hover" | "pressed";
}

export function Button({ label, href, variant = "primary", size = "md", state = "default", className, ...rest }: ButtonProps) {
  const classes = [styles.button, styles[variant], styles[size], state !== "default" && styles[state], className]
    .filter(Boolean)
    .join(" ");
  return (
    <a {...rest} href={href} className={classes}>
      {label}
    </a>
  );
}
