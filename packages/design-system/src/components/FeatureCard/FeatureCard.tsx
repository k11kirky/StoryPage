import type { ImageValue } from "@storypage/schema";
import styles from "./FeatureCard.module.css";

export interface FeatureCardProps {
  title: string;
  body: string;
  icon?: ImageValue;
}

export function FeatureCard({ title, body, icon }: FeatureCardProps) {
  return (
    <article className={styles.card}>
      {icon?.url && <img className={styles.icon} src={icon.url} alt={icon.alt} width={40} height={40} />}
      <h3 className={`${styles.title} ds-text-heading-md`}>{title}</h3>
      <p className={`${styles.body} ds-text-body-md`}>{body}</p>
    </article>
  );
}
