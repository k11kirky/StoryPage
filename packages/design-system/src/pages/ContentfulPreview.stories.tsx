import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PageDocument } from "@storypage/schema";
import { PageRenderer } from "../renderer/PageRenderer";

/**
 * Renders a draft Contentful page with the components in this Storybook build.
 *
 * The Slack bot links to the chrome-less iframe with a signed, expiring token:
 * `iframe.html?id=pages-contentful-preview--page&viewMode=story&slug=<slug>&exp=<exp>&sig=<sig>`.
 * The page is fetched from the gateway's `/preview/pages/<slug>`, which checks
 * the signature, so this static build holds no Contentful credentials and is
 * safe to host publicly. Set STORYBOOK_PREVIEW_API_URL to the gateway URL.
 */
function ContentfulPage({ slug: argSlug }: { slug: string }) {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get("slug") ?? argSlug;
  const exp = params.get("exp") ?? "";
  const sig = params.get("sig") ?? "";
  const [state, setState] = useState<{ page?: PageDocument | null; error?: string }>({});

  useEffect(() => {
    const api = import.meta.env.STORYBOOK_PREVIEW_API_URL;
    if (!api) {
      setState({ error: "Set STORYBOOK_PREVIEW_API_URL to the StoryPage gateway to enable previews." });
      return;
    }
    if (!sig) {
      setState({ error: "Open this preview from the link the StoryPage Slack bot posts." });
      return;
    }
    let cancelled = false;
    setState({});
    const url = new URL(`preview/pages/${slug.split("/").map(encodeURIComponent).join("/")}`, `${api.replace(/\/$/, "")}/`);
    url.searchParams.set("exp", exp);
    url.searchParams.set("sig", sig);
    fetch(url)
      .then(async (response) => {
        const body = (await response.json()) as PageDocument | { error: string };
        if (cancelled) return;
        if ("error" in body) setState(response.status === 404 ? { page: null } : { error: body.error });
        else setState({ page: body });
      })
      .catch((error: unknown) => !cancelled && setState({ error: String(error) }));
    return () => {
      cancelled = true;
    };
  }, [slug, exp, sig]);

  if (state.error) return <p role="alert">{state.error}</p>;
  if (state.page === undefined) return <p>Loading “{slug}”…</p>;
  if (state.page === null) return <p role="alert">No page with slug “{slug}”.</p>;
  return <PageRenderer page={state.page} />;
}

const meta = {
  title: "Pages/Contentful Preview",
  component: ContentfulPage,
  args: { slug: "home" },
  parameters: { a11y: { test: "off" } },
} satisfies Meta<typeof ContentfulPage>;

export default meta;
export const Page: StoryObj<typeof meta> = {};
