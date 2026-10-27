import type { ReactNode } from "react";
import styles from "./FeatureGrid.module.css";

export interface FeatureGridProps {
  heading: string;
  intro?: string;
  /** Slot list: FeatureCard. */
  features: ReactNode[];
  columns?: "v2" | "v3";
}

export function FeatureGrid({ heading, intro, features, columns = "v3" }: FeatureGridProps) {
  return (
    <section className={styles.section}>
      <header className={styles.header}>
        <h2 className={`${styles.heading} ds-text-heading-lg`}>{heading}</h2>
        {intro && <p className={`${styles.intro} ds-text-body-lg`}>{intro}</p>}
      </header>
      <div className={`${styles.grid} ${styles[columns]}`}>{features}</div>
    </section>
  );
}
