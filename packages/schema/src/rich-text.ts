/**
 * Contentful Rich Text document types plus a small Markdown converter.
 * The composer writes rich text as Markdown; it is stored in Contentful as a
 * Rich Text document, and the design system renders either form.
 */

export type Mark = "bold" | "italic" | "underline" | "code";

export interface TextNode {
  nodeType: "text";
  value: string;
  marks: { type: Mark }[];
  data: Record<string, never>;
}

export interface InlineNode {
  nodeType: "hyperlink";
  data: { uri: string };
  content: TextNode[];
}

export type BlockType =
  | "paragraph"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "unordered-list"
  | "ordered-list"
  | "list-item"
  | "blockquote"
  | "hr";

export interface BlockNode {
  nodeType: BlockType;
  data: Record<string, never>;
  content: (BlockNode | InlineNode | TextNode)[];
}

export interface RichTextDocument {
  nodeType: "document";
  data: Record<string, never>;
  content: BlockNode[];
}

const text = (value: string, marks: Mark[] = []): TextNode => ({
  nodeType: "text",
  value,
  marks: marks.map((type) => ({ type })),
  data: {},
});

const block = (nodeType: BlockType, content: BlockNode["content"]): BlockNode => ({
  nodeType,
  data: {},
  content,
});

/** Parses inline Markdown: **bold**, *italic*, `code`, [links](url). */
export function parseInline(source: string, marks: Mark[] = []): (TextNode | InlineNode)[] {
  const out: (TextNode | InlineNode)[] = [];
  const pattern = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/;
  let rest = source;
  while (rest.length > 0) {
    const match = pattern.exec(rest);
    if (!match) {
      out.push(text(rest, marks));
      break;
    }
    if (match.index > 0) out.push(text(rest.slice(0, match.index), marks));
    const [whole, , bold1, bold2, italic1, italic2, code, linkText, href] = match;
    if (bold1 ?? bold2) out.push(...parseInline((bold1 ?? bold2)!, [...marks, "bold"]));
    else if (italic1 ?? italic2) out.push(...parseInline((italic1 ?? italic2)!, [...marks, "italic"]));
    else if (code) out.push(text(code, [...marks, "code"]));
    else if (linkText && href) {
      out.push({
        nodeType: "hyperlink",
        data: { uri: href },
        content: parseInline(linkText, marks).filter((n): n is TextNode => n.nodeType === "text"),
      });
    }
    rest = rest.slice(match.index + whole.length);
  }
  return out.length ? out : [text("")];
}

export function markdownToRichText(markdown: string): RichTextDocument {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const content: BlockNode[] = [];
  let paragraph: string[] = [];
  let list: { type: "unordered-list" | "ordered-list"; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) content.push(block("paragraph", parseInline(paragraph.join(" "))));
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      content.push(
        block(
          list.type,
          list.items.map((item) => block("list-item", [block("paragraph", parseInline(item))])),
        ),
      );
    }
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);

    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushParagraph();
      flushList();
      content.push(block("hr", []));
    } else if (heading) {
      flushParagraph();
      flushList();
      // h1 is reserved for the page title; clamp to the enabled heading levels.
      const level = Math.min(Math.max(heading[1]!.length, 2), 4) as 2 | 3 | 4;
      content.push(block(`heading-${level}`, parseInline(heading[2]!)));
    } else if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? "unordered-list" : "ordered-list";
      if (list && list.type !== type) flushList();
      list ??= { type, items: [] };
      list.items.push((bullet ?? ordered)![1]!);
    } else if (quote) {
      flushParagraph();
      flushList();
      content.push(block("blockquote", [block("paragraph", parseInline(quote[1]!))]));
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  if (!content.length) content.push(block("paragraph", [text("")]));
  return { nodeType: "document", data: {}, content };
}

/** Accepts a serialized Rich Text document or Markdown and returns a document. */
export function toRichTextDocument(value: string): RichTextDocument {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as RichTextDocument;
      if (parsed?.nodeType === "document") return parsed;
    } catch {
      // Not JSON; fall through to Markdown.
    }
  }
  return markdownToRichText(value);
}
