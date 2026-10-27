/**
 * StoryPage Slack bot: `/page <what you want>` or @mention it, and it composes
 * a page from the design system and saves it as a Contentful draft. Reply in
 * the thread to iterate; press Publish to go live.
 */
import Anthropic from "@anthropic-ai/sdk";
import { App, LogLevel } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { createContentfulClient, publishPage } from "@storypage/contentful";
import { PUBLISH_ACTION, replyBlocks } from "./blocks.js";
import { compose } from "./composer.js";
import { loadConfig } from "./config.js";
import { ConversationStore } from "./conversations.js";
import { ReleaseCache } from "./release.js";

const config = loadConfig();
const anthropic = new Anthropic();
const contentful = createContentfulClient(config.contentful);
const releases = new ReleaseCache(contentful, config.contentful.locale, config.storybookUrl);
const conversations = new ConversationStore();
/** Threads currently being worked on, so overlapping messages queue instead of racing. */
const inFlight = new Map<string, Promise<void>>();

const app = new App({
  token: config.slack.botToken,
  signingSecret: config.slack.signingSecret,
  ...(config.slack.appToken ? { socketMode: true, appToken: config.slack.appToken } : {}),
  logLevel: LogLevel.INFO,
});

const stripMention = (text: string) => text.replace(/<@[A-Z0-9]+>/g, "").trim();

async function handleTurn(client: WebClient, channel: string, threadTs: string, user: string, text: string) {
  const key = `${channel}:${threadTs}`;
  const previous = inFlight.get(key) ?? Promise.resolve();
  const turn = previous.catch(() => undefined).then(async () => {
    const placeholder = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "Composing your page from the design system…",
    });
    try {
      const release = await releases.get();
      const conversation = conversations.get(channel, threadTs);
      const result = await compose(
        {
          anthropic,
          contentful,
          release,
          spaceId: config.contentful.spaceId,
          environment: config.contentful.environment,
          locale: config.contentful.locale,
          model: config.model,
          previewSigningSecret: config.previewSigningSecret,
        },
        conversation?.messages ?? [],
        `<@${user}>: ${text}`,
      );
      const draft = result.draft ?? conversation?.draft;
      conversations.set(channel, threadTs, { messages: result.messages, draft });
      await client.chat.update({
        channel,
        ts: placeholder.ts!,
        text: result.reply,
        blocks: replyBlocks(result.reply, result.draft, {
          storybookUrl: release.storybookUrl,
          previewSigningSecret: config.previewSigningSecret,
          spaceId: config.contentful.spaceId,
          environment: config.contentful.environment,
        }),
      });
    } catch (error) {
      app.logger.error(error);
      await client.chat.update({
        channel,
        ts: placeholder.ts!,
        text: `Something went wrong: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
  const tracked: Promise<void> = turn.finally(() => {
    if (inFlight.get(key) === tracked) inFlight.delete(key);
  });
  inFlight.set(key, tracked);
  await tracked;
}

app.command("/page", async ({ ack, command, client, respond }) => {
  await ack();
  if (!command.text.trim()) {
    await respond({ response_type: "ephemeral", text: "Tell me what page you need, e.g. `/page a landing page for our October webinar on AI search`" });
    return;
  }
  let root;
  try {
    root = await client.chat.postMessage({
      channel: command.channel_id,
      text: `<@${command.user_id}> asked for a page: ${command.text}`,
    });
  } catch {
    await respond({ response_type: "ephemeral", text: "I can't post here yet. Invite me with `/invite @StoryPage` and try again." });
    return;
  }
  await handleTurn(client, command.channel_id, root.ts!, command.user_id, command.text);
});

app.event("app_mention", async ({ event, client }) => {
  if (!event.user) return;
  await handleTurn(client, event.channel, event.thread_ts ?? event.ts, event.user, stripMention(event.text));
});

// Follow-ups in a thread the bot is already working in don't need an @mention.
app.message(async ({ message, client, context }) => {
  if (message.subtype !== undefined || !("thread_ts" in message) || !message.thread_ts) return;
  if (!message.user || message.user === context.botUserId) return;
  if (message.text?.includes(`<@${context.botUserId}>`)) return; // handled by app_mention
  if (!conversations.has(message.channel, message.thread_ts)) return;
  await handleTurn(client, message.channel, message.thread_ts, message.user, message.text ?? "");
});

app.action(PUBLISH_ACTION, async ({ ack, body, action, client, respond }) => {
  await ack();
  if (action.type !== "button" || !action.value) return;
  const { pageId, slug } = JSON.parse(action.value) as { pageId: string; slug: string };
  if (config.slack.publisherIds.length && !config.slack.publisherIds.includes(body.user.id)) {
    await respond({ response_type: "ephemeral", replace_original: false, text: "Only designated publishers can publish pages. Ask one of them to review this draft." });
    return;
  }
  try {
    const count = await publishPage(contentful, pageId);
    const channel = body.channel?.id;
    const message = "message" in body ? body.message : undefined;
    if (channel && message?.ts) {
      await client.chat.postMessage({
        channel,
        thread_ts: (message.thread_ts as string | undefined) ?? message.ts,
        text: `:white_check_mark: <@${body.user.id}> published \`/${slug}\` (${count} entr${count === 1 ? "y" : "ies"} updated).`,
      });
    }
  } catch (error) {
    await respond({ response_type: "ephemeral", replace_original: false, text: `Publishing failed: ${error instanceof Error ? error.message : String(error)}` });
  }
});

await app.start(config.port);
app.logger.info(`StoryPage bot running${config.slack.appToken ? " in Socket Mode" : ` on :${config.port}`}`);
