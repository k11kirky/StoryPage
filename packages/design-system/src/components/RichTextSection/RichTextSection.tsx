import { RichText } from "../../renderer/RichText";
import styles from "./RichTextSection.module.css";

export interface RichTextSectionProps {
  /** Markdown or a serialized Contentful Rich Text document. */
  content: string;
  width?: "narrow" | "wide";
}

export function RichTextSection({ content, width = "narrow" }: RichTextSectionProps) {
  return (
    <section className={`${styles.section} ${styles[width]}`}>
      <RichText value={content} />
    </section>
  );
}
