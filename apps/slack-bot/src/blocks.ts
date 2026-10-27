import type { KnownBlock } from "@slack/types";
import { entryEditorUrl } from "@storypage/contentful";
import { previewUrl } from "@storypage/agents";
import type { Draft } from "./conversations.js";

export const PUBLISH_ACTION = "storypage_publish";

export interface DraftLinks {
  storybookUrl: string;
  previewSigningSecret: string;
  spaceId: string;
  environment: string;
}

/** Slack section text is limited to 3000 characters. */
const clamp = (text: string) => (text.length > 2900 ? `${text.slice(0, 2900)}…` : text);

export function replyBlocks(reply: string, draft: Draft | undefined, links: DraftLinks): KnownBlock[] {
  const blocks: KnownBlock[] = [{ type: "section", text: { type: "mrkdwn", text: clamp(reply) } }];
  if (!draft) return blocks;
  blocks.push(
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Draft \`/${draft.slug}\` · design-system@${draft.designSystemVersion} · reply in this thread to change it` },
      ],
    },
    {
      type: "actions",
      elements: [
        ...(links.storybookUrl
          ? [{ type: "button" as const, text: { type: "plain_text" as const, text: "Preview" }, url: previewUrl(links.storybookUrl, draft.slug, links.previewSigningSecret) }]
          : []),
        {
          type: "button",
          text: { type: "plain_text", text: "Open in Contentful" },
          url: entryEditorUrl(links.spaceId, links.environment, draft.pageId),
        },
        {
          type: "button",
          style: "primary",
          action_id: PUBLISH_ACTION,
          value: JSON.stringify({ pageId: draft.pageId, slug: draft.slug }),
          text: { type: "plain_text", text: "Publish" },
          confirm: {
            title: { type: "plain_text", text: "Publish this page?" },
            text: { type: "mrkdwn", text: `\`/${draft.slug}\` and all of its sections will go live.` },
            confirm: { type: "plain_text", text: "Publish" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      ],
    },
  );
  return blocks;
}
