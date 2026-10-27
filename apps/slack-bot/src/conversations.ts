import type { SavedDraft } from "@storypage/agents";

export type Draft = SavedDraft;

export interface Conversation {
  /** The thread's Agent SDK session, resumed for every reply. */
  sessionId: string;
  draft?: Draft | undefined;
  updatedAt: number;
}

/**
 * Per-Slack-thread state: the agent session to resume and the latest draft.
 * The conversation itself lives in the Agent SDK's session transcript. In
 * memory with a TTL, which suits a single instance; swap for Redis or
 * Postgres (and keep CLAUDE_CONFIG_DIR on shared storage) to run more.
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
