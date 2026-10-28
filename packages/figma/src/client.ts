import type {
  GetFileNodesResponse,
  GetFileResponse,
  GetImagesResponse,
  GetLocalVariablesResponse,
  PostWebhookRequestBody,
  WebhookV2,
} from "@figma/rest-api-spec";

export interface FigmaClientOptions {
  /** A personal access token (X-Figma-Token) or OAuth access token (Bearer). */
  token: string;
  oauth?: boolean;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class FigmaApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FigmaApiError";
  }
}

/** The few Figma REST endpoints the server-side extractor and webhook setup use. */
export class FigmaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FigmaClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.figma.com").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.options.oauth) headers.set("Authorization", `Bearer ${this.options.token}`);
    else headers.set("X-Figma-Token", this.options.token);
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new FigmaApiError(response.status, `Figma API ${response.status} for ${path}: ${(await response.text()).slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  /** The whole file, with the shared plugin data StoryPage's plugin stores. */
  getFile(fileKey: string): Promise<GetFileResponse> {
    return this.request(`/v1/files/${fileKey}?plugin_data=shared`);
  }

  getNodes(fileKey: string, ids: string[]): Promise<GetFileNodesResponse> {
    return this.request(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(ids.join(","))}&plugin_data=shared`);
  }

  /** Local variables, or null where the API isn't available (it is Enterprise-only). */
  async getLocalVariables(fileKey: string): Promise<GetLocalVariablesResponse["meta"] | null> {
    try {
      const response = await this.request<GetLocalVariablesResponse>(`/v1/files/${fileKey}/variables/local`);
      return response.meta;
    } catch (error) {
      if (error instanceof FigmaApiError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
  }

  /** PNG renders of nodes, as base64, by node id. */
  async renderPngs(fileKey: string, ids: string[], scale = 1): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const { images } = await this.request<GetImagesResponse>(
        `/v1/images/${fileKey}?ids=${encodeURIComponent(batch.join(","))}&format=png&scale=${scale}`,
      );
      for (const [id, url] of Object.entries(images)) {
        if (!url) continue;
        const image = await this.fetchImpl(url);
        if (image.ok) out[id] = Buffer.from(await image.arrayBuffer()).toString("base64");
      }
    }
    return out;
  }

  createWebhook(body: PostWebhookRequestBody): Promise<WebhookV2> {
    return this.request("/v2/webhooks", { method: "POST", body: JSON.stringify(body) });
  }

  listWebhooks(context: "file" | "project" | "team", contextId: string): Promise<{ webhooks: WebhookV2[] }> {
    return this.request(`/v2/webhooks?context=${context}&context_id=${encodeURIComponent(contextId)}`);
  }
}
