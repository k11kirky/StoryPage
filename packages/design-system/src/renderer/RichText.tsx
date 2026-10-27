import { Fragment, type ReactNode } from "react";
import { toRichTextDocument, type BlockNode, type InlineNode, type TextNode } from "@storypage/schema";

function renderText(node: TextNode, key: number): ReactNode {
  return node.marks.reduce<ReactNode>((child, mark) => {
    switch (mark.type) {
      case "bold":
        return <strong>{child}</strong>;
      case "italic":
        return <em>{child}</em>;
      case "underline":
        return <u>{child}</u>;
      case "code":
        return <code>{child}</code>;
    }
  }, <Fragment key={key}>{node.value}</Fragment>);
}

function renderNode(node: BlockNode | InlineNode | TextNode, key: number): ReactNode {
  if (node.nodeType === "text") return <Fragment key={key}>{renderText(node, key)}</Fragment>;
  if (node.nodeType === "hyperlink") {
    return (
      <a key={key} href={node.data.uri}>
        {node.content.map(renderNode)}
      </a>
    );
  }
  const children = node.content.map(renderNode);
  switch (node.nodeType) {
    case "paragraph":
      return <p key={key}>{children}</p>;
    case "heading-2":
      return <h2 key={key}>{children}</h2>;
    case "heading-3":
      return <h3 key={key}>{children}</h3>;
    case "heading-4":
      return <h4 key={key}>{children}</h4>;
    case "unordered-list":
      return <ul key={key}>{children}</ul>;
    case "ordered-list":
      return <ol key={key}>{children}</ol>;
    case "list-item":
      return <li key={key}>{children}</li>;
    case "blockquote":
      return <blockquote key={key}>{children}</blockquote>;
    case "hr":
      return <hr key={key} />;
  }
}

export interface RichTextProps {
  /** Markdown or a serialized Contentful Rich Text document. */
  value: string;
}

export function RichText({ value }: RichTextProps) {
  const document = toRichTextDocument(value);
  return <>{document.content.map(renderNode)}</>;
}
