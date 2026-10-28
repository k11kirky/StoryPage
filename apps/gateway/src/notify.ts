/** Where designers hear back about releases they didn't start from the plugin. */
export interface Notifier {
  send(text: string): Promise<void>;
}

/** Posts to a Slack incoming webhook (e.g. the design team's channel). */
export class SlackWebhookNotifier implements Notifier {
  constructor(private readonly url: string) {}

  async send(text: string): Promise<void> {
    const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!response.ok) console.error(`Slack notification failed (${response.status})`);
  }
}

export class ConsoleNotifier implements Notifier {
  async send(text: string): Promise<void> {
    console.log(`[notify] ${text}`);
  }
}
