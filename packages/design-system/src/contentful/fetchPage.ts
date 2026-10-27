import { pageFromDelivery, type DeliveryResponse, type PageDocument, type Registry } from "@storypage/schema";

export interface ContentfulReadConfig {
  spaceId: string;
  environment: string;
  accessToken: string;
  /** Use the Preview API so drafts created by the Slack bot are visible. */
  preview: boolean;
}

/**
 * Fetches a page by slug from the Contentful Delivery/Preview API and maps it
 * to a PageDocument. For server-side rendering on the website, where the token
 * stays on the server; never call it from a public static build.
 */
export async function fetchPage(slug: string, config: ContentfulReadConfig, registry: Registry): Promise<PageDocument | null> {
  const host = config.preview ? "preview.contentful.com" : "cdn.contentful.com";
  const url = new URL(`https://${host}/spaces/${config.spaceId}/environments/${config.environment}/entries`);
  url.searchParams.set("content_type", "page");
  url.searchParams.set("fields.slug", slug);
  url.searchParams.set("include", "10");
  url.searchParams.set("limit", "1");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${config.accessToken}` } });
  if (!response.ok) throw new Error(`Contentful responded ${response.status}: ${await response.text()}`);
  return pageFromDelivery((await response.json()) as DeliveryResponse, registry);
}
