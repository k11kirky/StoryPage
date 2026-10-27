import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring preview links. The Slack bot signs `slug + expiry`; the
 * gateway verifies it before serving draft content. Storybook never holds a
 * Contentful token, so a public Storybook can't read unpublished drafts.
 */
export interface PreviewToken {
  exp: number;
  sig: string;
}

const payload = (slug: string, exp: number) => `${slug}\n${exp}`;

export function signPreview(slug: string, secret: string, ttlSeconds = 7 * 24 * 60 * 60, now = Date.now()): PreviewToken {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = createHmac("sha256", secret).update(payload(slug, exp)).digest("base64url");
  return { exp, sig };
}

export function verifyPreview(slug: string, token: Partial<PreviewToken>, secret: string, now = Date.now()): boolean {
  if (!token.exp || !token.sig || token.exp < Math.floor(now / 1000)) return false;
  const expected = createHmac("sha256", secret).update(payload(slug, Number(token.exp))).digest();
  const given = Buffer.from(token.sig, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
