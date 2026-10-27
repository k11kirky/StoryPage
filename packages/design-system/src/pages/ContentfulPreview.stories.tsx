import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PageDocument, Registry } from "@storypage/schema";
import { fetchPage } from "../contentful/fetchPage";
import registryJson from "../generated/registry.json";
import { PageRenderer } from "../renderer/PageRenderer";

/**
 * Renders a Contentful page with the components in this Storybook build.
 * The Slack bot links here: `?path=/story/pages-contentful-preview--page&args=slug:<slug>`.
 * Configure with STORYBOOK_CONTENTFUL_* variables at build time.
 */
function ContentfulPage({ slug }: { slug: string }) {
  const [state, setState] = useState<{ page?: PageDocument | null; error?: string }>({});
  useEffect(() => {
    const env = import.meta.env;
    if (!env.STORYBOOK_CONTENTFUL_SPACE_ID || !env.STORYBOOK_CONTENTFUL_PREVIEW_TOKEN) {
      setState({ error: "Set STORYBOOK_CONTENTFUL_SPACE_ID and STORYBOOK_CONTENTFUL_PREVIEW_TOKEN to enable previews." });
      return;
    }
    let cancelled = false;
    setState({});
    fetchPage(
      slug,
      {
        spaceId: env.STORYBOOK_CONTENTFUL_SPACE_ID,
        environment: env.STORYBOOK_CONTENTFUL_ENVIRONMENT || "master",
        accessToken: env.STORYBOOK_CONTENTFUL_PREVIEW_TOKEN,
        preview: true,
      },
      registryJson as Registry,
    ).then(
      (page) => !cancelled && setState({ page }),
      (error: unknown) => !cancelled && setState({ error: String(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [slug]);

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
