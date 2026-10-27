import { chromium, type Browser } from "playwright-core";

/**
 * Renders Storybook stories to PNG so agents can compare them with the Figma
 * frames visually. Uses Playwright's Chromium (`playwright-core install
 * chromium`), or CHROMIUM_PATH when the browser lives elsewhere.
 */
export class StoryCamera {
  private browser: Promise<Browser> | null = null;

  constructor(private readonly storybookUrl: string) {}

  private launch(): Promise<Browser> {
    this.browser ??= chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    return this.browser;
  }

  async capture(storyId: string, options: { width?: number; colorMode?: "light" | "dark" } = {}): Promise<Buffer> {
    const browser = await this.launch();
    const page = await browser.newPage({ viewport: { width: options.width ?? 1280, height: 800 } });
    try {
      const url = new URL("iframe.html", `${this.storybookUrl.replace(/\/$/, "")}/`);
      url.searchParams.set("id", storyId);
      url.searchParams.set("viewMode", "story");
      if (options.colorMode) url.searchParams.set("globals", `color:${options.colorMode}`);
      await page.goto(url.toString(), { waitUntil: "networkidle" });
      await page.waitForSelector("#storybook-root > *", { timeout: 15_000 });
      const error = await page.$(".sb-show-errordisplay");
      if (error) throw new Error((await page.textContent("#error-message")) ?? "Story failed to render");
      return await page.screenshot({ fullPage: true, type: "png" });
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) await (await this.browser).close();
    this.browser = null;
  }
}
