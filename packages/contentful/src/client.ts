import { createClient, type PlainClientAPI } from "contentful-management";

export interface ContentfulConfig {
  managementToken: string;
  spaceId: string;
  /** Environment or alias id that readers use (normally the `master` alias). */
  environment: string;
  locale: string;
  /** API host, `host[:port]`. Defaults to api.contentful.com; set for a local stand-in (see e2e/). */
  host?: string | undefined;
  /** Plain HTTP instead of HTTPS, only for a local stand-in. */
  insecure?: boolean | undefined;
  /** Overrides client creation (tests, or reusing a configured client). */
  clientFor?: ((environmentId: string) => PlainClientAPI) | undefined;
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
    host: env.CONTENTFUL_HOST || undefined,
    insecure: env.CONTENTFUL_INSECURE === "true",
  };
}

export function createContentfulClient(config: ContentfulConfig, environmentId = config.environment): PlainClientAPI {
  if (config.clientFor) return config.clientFor(environmentId);
  return createClient(
    {
      accessToken: config.managementToken,
      application: "storypage/0.1",
      ...(config.host ? { host: config.host } : {}),
      ...(config.insecure ? { insecure: true } : {}),
    },
    { type: "plain", defaults: { spaceId: config.spaceId, environmentId } },
  );
}

export type { PlainClientAPI };
