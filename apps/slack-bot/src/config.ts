import { configFromEnv, type ContentfulConfig } from "@storypage/contentful";

export interface BotConfig {
  slack: {
    botToken: string;
    signingSecret: string;
    /** Set to use Socket Mode (no public URL needed). */
    appToken?: string | undefined;
    /** Slack user ids allowed to publish pages. Empty = anyone in the channel. */
    publisherIds: string[];
  };
  contentful: ContentfulConfig;
  /** Fallback when no release has been synced into Contentful yet. */
  storybookUrl?: string | undefined;
  model: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  return {
    slack: {
      botToken: required("SLACK_BOT_TOKEN"),
      signingSecret: required("SLACK_SIGNING_SECRET"),
      appToken: env.SLACK_APP_TOKEN,
      publisherIds: (env.SLACK_PUBLISHER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    },
    contentful: configFromEnv(env),
    storybookUrl: env.STORYBOOK_URL,
    model: env.STORYPAGE_COMPOSER_MODEL ?? "claude-opus-5-5",
    port: Number(env.PORT ?? 3000),
  };
}
