/**
 * Stand-in for Figma: the REST endpoints StoryPage reads (file, variables,
 * style nodes, image renders) serving a library built from a design, and the
 * LIBRARY_PUBLISH webhook Figma sends when a designer publishes the library.
 */
import type { WebhookLibraryPublishPayload } from "@figma/rest-api-spec";
import { Hono } from "hono";
import { buildLibrary, solidPng, type Design, type FigmaLibrary, type LibraryOptions } from "./library.js";

export const FILE_KEY = "E2eLibrary0000000001";
export const TOKEN = "figd_e2e";

export class FakeFigma {
  private library: FigmaLibrary;
  readonly requests: string[] = [];
  readonly app = new Hono();
  /** Set once the server is listening; renders are served from here. */
  baseUrl = "";

  constructor(
    private design: Design,
    readonly options: LibraryOptions,
  ) {
    this.library = buildLibrary(design, options);
    this.app.use("*", async (c, next) => {
      this.requests.push(`${c.req.method} ${new URL(c.req.url).pathname}`);
      if (!c.req.path.startsWith("/renders/") && c.req.header("x-figma-token") !== TOKEN) return c.json({ status: 403, err: "Invalid token" }, 403);
      return next();
    });
    this.app.get(`/v1/files/${FILE_KEY}`, (c) => c.json(this.library.file));
    this.app.get(`/v1/files/${FILE_KEY}/variables/local`, (c) =>
      this.options.variables === "rest"
        ? c.json({ status: 200, error: false, meta: this.library.variables })
        : c.json({ status: 403, error: true, message: "Limited by Figma plan" }, 403),
    );
    this.app.get(`/v1/files/${FILE_KEY}/nodes`, (c) => {
      const ids = (c.req.query("ids") ?? "").split(",");
      return c.json({ name: this.options.fileName, nodes: Object.fromEntries(ids.map((id) => [id, this.library.styleNodes[id] ?? null])) });
    });
    this.app.get(`/v1/images/${FILE_KEY}`, (c) => {
      const ids = (c.req.query("ids") ?? "").split(",");
      return c.json({ err: null, images: Object.fromEntries(ids.map((id) => [id, this.library.renderColors[id] ? `${this.baseUrl}/renders/${encodeURIComponent(id)}.png` : null])) });
    });
    this.app.get("/renders/:file", (c) => {
      const id = decodeURIComponent(c.req.param("file").replace(/\.png$/, ""));
      return c.body(new Uint8Array(solidPng(this.library.renderColors[id] ?? "#CCCCCC")), 200, { "content-type": "image/png" });
    });
    this.app.all("*", (c) => c.json({ status: 404, err: "Not found" }, 404));
  }

  get current(): Design {
    return this.design;
  }

  /**
   * The designer edits the library. With the snapshot variables source, the
   * StoryPage plugin saves the variables as they edit (it runs in the file).
   */
  edit(change: (design: Design) => Design) {
    this.design = change(structuredClone(this.design));
    this.options.snapshotSavedAt = new Date().toISOString();
    this.library = buildLibrary(this.design, this.options);
  }

  /** The webhook payload Figma sends for "Publish library". */
  publishEvent(
    passcode: string,
    description: string,
    changes: Partial<Pick<WebhookLibraryPublishPayload, "created_components" | "modified_components" | "modified_variables" | "modified_styles">> = {},
  ): WebhookLibraryPublishPayload {
    return {
      event_type: "LIBRARY_PUBLISH",
      passcode,
      timestamp: new Date(Date.now() + 1000).toISOString(),
      webhook_id: "e2e-webhook",
      file_key: FILE_KEY,
      file_name: this.options.fileName,
      description,
      triggered_by: { id: "e2e-designer", handle: "E2E Designer", img_url: "" },
      library_item: { key: FILE_KEY, name: this.options.fileName },
      created_components: [],
      created_styles: [],
      created_variables: [],
      modified_components: [],
      modified_styles: [],
      modified_variables: [],
      deleted_components: [],
      deleted_styles: [],
      deleted_variables: [],
      ...changes,
    };
  }
}
