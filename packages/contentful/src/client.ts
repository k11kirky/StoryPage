import { createClient, type PlainClientAPI } from "contentful-management";

export interface ContentfulConfig {
  managementToken: string;
  spaceId: string;
  /** Environment or alias id that readers use (normally the `master` alias). */
  environment: string;
  locale: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ContentfulConfig {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  return {
    managementToken: required("CONTENTFUL_MANAGEMENT_TOKEN"),
    spaceId: required("CONTENTFUL_SPACE_ID"),
    environment: env.CONTENTFUL_ENVIRONMENT ?? "master",
    locale: env.CONTENTFUL_LOCALE ?? "en-US",
  };
}

export function createContentfulClient(config: ContentfulConfig, environmentId = config.environment): PlainClientAPI {
  return createClient(
    { accessToken: config.managementToken, application: "storypage/0.1" },
    { type: "plain", defaults: { spaceId: config.spaceId, environmentId } },
  );
}

export type { PlainClientAPI };
