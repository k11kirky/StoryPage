import type Anthropic from "@anthropic-ai/sdk";

export interface Draft {
  pageId: string;
  slug: string;
  title: string;
  designSystemVersion: string;
}

export interface Conversation {
  messages: Anthropic.Beta.BetaMessageParam[];
  draft?: Draft | undefined;
  updatedAt: number;
}

/**
 * Per-Slack-thread conversation state. In-memory with a TTL, which is fine for
 * a single instance; swap for Redis/Postgres when running more than one.
 */
export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>();
  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  private key(channel: string, threadTs: string) {
    return `${channel}:${threadTs}`;
  }

  get(channel: string, threadTs: string): Conversation | undefined {
    const conversation = this.conversations.get(this.key(channel, threadTs));
    if (conversation && Date.now() - conversation.updatedAt > this.ttlMs) {
      this.conversations.delete(this.key(channel, threadTs));
      return undefined;
    }
    return conversation;
  }

  set(channel: string, threadTs: string, conversation: Omit<Conversation, "updatedAt">) {
    this.conversations.set(this.key(channel, threadTs), { ...conversation, updatedAt: Date.now() });
  }

  has(channel: string, threadTs: string): boolean {
    return this.get(channel, threadTs) !== undefined;
  }
}
