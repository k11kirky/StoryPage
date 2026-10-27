import type { ReactNode } from "react";
import type { ImageValue } from "@storypage/schema";
import styles from "./Hero.module.css";

export interface HeroProps {
  eyebrow?: string;
  headline: string;
  body?: string;
  /** Slot: a Button. */
  cta?: ReactNode;
  image?: ImageValue;
  align?: "left" | "center";
}

export function Hero({ eyebrow, headline, body, cta, image, align = "left" }: HeroProps) {
  return (
    <section className={`${styles.hero} ${styles[align]}`}>
      <div className={styles.copy}>
        {eyebrow && <p className={`${styles.eyebrow} ds-text-eyebrow`}>{eyebrow}</p>}
        <h1 className={`${styles.headline} ds-text-display`}>{headline}</h1>
        {body && <p className={`${styles.body} ds-text-body-lg`}>{body}</p>}
        {cta && <div className={styles.cta}>{cta}</div>}
      </div>
      {image?.url && (
        <img className={styles.image} src={image.url} alt={image.alt} width={image.width} height={image.height} />
      )}
    </section>
  );
}
