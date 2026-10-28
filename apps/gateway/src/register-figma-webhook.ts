/**
 * Registers Figma's LIBRARY_PUBLISH webhook for the design-system file, so
 * publishing the library in Figma starts a StoryPage release. Run once:
 *
 *   FIGMA_API_KEY=… FIGMA_FILE_KEYS=<file key> FIGMA_WEBHOOK_PASSCODE=… \
 *   STORYPAGE_PUBLIC_URL=https://storypage.example.com \
 *   pnpm --filter @storypage/gateway figma:webhook
 *
 * The token needs the webhooks:write scope and edit access to the file.
 */
import { FigmaClient } from "@storypage/figma";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const client = new FigmaClient({
  token: process.env.FIGMA_WEBHOOK_TOKEN ?? required("FIGMA_API_KEY"),
  oauth: process.env.FIGMA_WEBHOOK_TOKEN_TYPE === "oauth",
});
const endpoint = `${required("STORYPAGE_PUBLIC_URL").replace(/\/$/, "")}/webhooks/figma`;

for (const fileKey of required("FIGMA_FILE_KEYS").split(",").map((k) => k.trim()).filter(Boolean)) {
  const { webhooks } = await client.listWebhooks("file", fileKey);
  if (webhooks.some((w) => w.event_type === "LIBRARY_PUBLISH" && w.endpoint === endpoint)) {
    console.log(`${fileKey}: already registered`);
    continue;
  }
  const webhook = await client.createWebhook({
    event_type: "LIBRARY_PUBLISH",
    context: "file",
    context_id: fileKey,
    endpoint,
    passcode: required("FIGMA_WEBHOOK_PASSCODE"),
    description: "StoryPage: build Storybook and Contentful from library publishes",
  });
  console.log(`${fileKey}: registered webhook ${webhook.id}`);
}
