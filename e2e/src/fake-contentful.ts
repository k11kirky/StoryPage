/**
 * Stand-in for Contentful: an in-memory Content Management API covering what
 * StoryPage uses. Environments, aliases (with cloning), content types and
 * entries with Contentful's versioning (X-Contentful-Version, publish), entry
 * queries, and assets. Entries are checked against their content type, like
 * Contentful does: unknown fields are rejected, required fields on publish.
 */
import { Hono, type Context } from "hono";

export const SPACE_ID = "e2espace";
export const TOKEN = "CFPAT-e2e";
export const LOCALE = "en-US";

type Sys = Record<string, unknown> & { id: string; version: number; publishedVersion?: number; createdAt: string; updatedAt: string };
interface Resource {
  sys: Sys;
  [key: string]: unknown;
}
interface Field {
  id: string;
  required?: boolean;
  omitted?: boolean;
  disabled?: boolean;
}
interface Environment {
  sys: Sys;
  name: string;
  contentTypes: Map<string, Resource>;
  entries: Map<string, Resource>;
  assets: Map<string, Resource>;
}

class ApiError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly id: string,
    message: string,
    readonly details: unknown = undefined,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();
let sequence = 0;
const newId = () => `e2e${Date.now().toString(36)}${(sequence++).toString(36)}`;
const link = (linkType: string, id: string) => ({ sys: { type: "Link", linkType, id } });
const list = (items: unknown[], skip = 0, limit = 100) => ({ sys: { type: "Array" }, total: items.length, skip, limit, items: items.slice(skip, skip + limit) });

export class FakeContentful {
  readonly app = new Hono();
  readonly environments = new Map<string, Environment>();
  readonly aliases = new Map<string, Resource>();
  /** Every write, for the report: "PUT /environments/ds-1-0-1/content_types/hero" etc. */
  readonly writes: string[] = [];

  constructor(initialEnvironment = "main-2026-01-01") {
    this.environments.set(initialEnvironment, this.newEnvironment(initialEnvironment, "Main"));
    const t = now();
    this.aliases.set("master", {
      sys: { id: "master", type: "EnvironmentAlias", version: 1, createdAt: t, updatedAt: t },
      environment: link("Environment", initialEnvironment),
    });
    this.routes();
  }

  private newEnvironment(id: string, name: string): Environment {
    const t = now();
    return {
      sys: { id, type: "Environment", version: 1, createdAt: t, updatedAt: t, status: link("Status", "ready") },
      name,
      contentTypes: new Map(),
      entries: new Map(),
      assets: new Map(),
    };
  }

  /** The environment a path id names, following aliases as Contentful does. */
  environment(id: string): Environment {
    const env = this.environments.get(this.aliases.has(id) ? this.aliasTarget(id) : id);
    if (!env) throw new ApiError(404, "NotFound", `The resource could not be found (environment ${id})`);
    return env;
  }

  aliasTarget(alias = "master"): string {
    return (this.aliases.get(alias)?.environment as { sys: { id: string } }).sys.id;
  }

  private routes() {
    const app = this.app;
    const base = `/spaces/:space`;
    const env = `${base}/environments/:env`;

    app.use("*", async (c, next) => {
      if (c.req.header("authorization") !== `Bearer ${TOKEN}`) return c.json({ sys: { type: "Error", id: "AccessTokenInvalid" }, message: "The access token you sent could not be found or is invalid." }, 401);
      if (!c.req.path.startsWith(`/spaces/${SPACE_ID}`)) return this.error(c, new ApiError(404, "NotFound", "Unknown space"));
      if (c.req.method !== "GET") this.writes.push(`${c.req.method} ${c.req.path.replace(`/spaces/${SPACE_ID}`, "")}`);
      try {
        return await next();
      } catch (error) {
        return this.error(c, error);
      }
    });
    app.onError((error, c) => this.error(c, error));

    app.get(base, (c) => c.json({ sys: { id: SPACE_ID, type: "Space", version: 1 }, name: "StoryPage e2e" }));

    // Environments and aliases
    app.get(`${base}/environments`, (c) => c.json(list([...this.environments.values()].map(this.environmentJson))));
    app.get(`${base}/environments/:env`, (c) => c.json(this.environmentJson(this.environment(c.req.param("env")))));
    app.put(`${base}/environments/:env`, async (c) => {
      const id = c.req.param("env");
      const body = (await c.req.json().catch(() => ({}))) as { name?: string };
      if (this.environments.has(id)) throw new ApiError(409, "VersionMismatch", `Environment ${id} exists`);
      const source = this.environment(c.req.header("x-contentful-source-environment") ?? "master");
      const clone = this.newEnvironment(id, body.name ?? id);
      for (const key of ["contentTypes", "entries", "assets"] as const) {
        for (const [entityId, entity] of source[key]) clone[key].set(entityId, structuredClone(entity));
      }
      this.environments.set(id, clone);
      return c.json(this.environmentJson(clone), 201);
    });
    app.delete(`${base}/environments/:env`, (c) => {
      const id = c.req.param("env");
      if ([...this.aliases.keys()].some((alias) => this.aliasTarget(alias) === id)) throw new ApiError(400, "BadRequest", "An aliased environment can't be deleted");
      this.environments.delete(id);
      return c.body(null, 204);
    });
    app.get(`${base}/environment_aliases`, (c) => c.json(list([...this.aliases.values()])));
    app.get(`${base}/environment_aliases/:alias`, (c) => c.json(this.mustGet(this.aliases, c.req.param("alias"), "EnvironmentAlias")));
    app.put(`${base}/environment_aliases/:alias`, async (c) => {
      const alias = this.mustGet(this.aliases, c.req.param("alias"), "EnvironmentAlias");
      this.checkVersion(c, alias);
      const body = (await c.req.json()) as { environment: { sys: { id: string } } };
      if (!this.environments.has(body.environment.sys.id)) throw new ApiError(422, "ValidationFailed", `No environment ${body.environment.sys.id}`);
      alias.environment = link("Environment", body.environment.sys.id);
      this.bump(alias);
      return c.json(alias);
    });
    app.get(`${env}/locales`, (c) => c.json(list([{ sys: { id: "locale-en", type: "Locale" }, code: LOCALE, name: "English (United States)", default: true }])));

    // Content types
    app.get(`${env}/content_types`, (c) => c.json(list([...this.environment(c.req.param("env")).contentTypes.values()], 0, 1000)));
    app.get(`${env}/content_types/:id`, (c) => c.json(this.mustGet(this.environment(c.req.param("env")).contentTypes, c.req.param("id"), "ContentType")));
    app.put(`${env}/content_types/:id`, async (c) => {
      const store = this.environment(c.req.param("env")).contentTypes;
      const id = c.req.param("id");
      const body = (await c.req.json()) as Record<string, unknown>;
      const existing = store.get(id);
      if (existing) {
        this.checkVersion(c, existing);
        Object.assign(existing, body, { sys: existing.sys });
        this.bump(existing);
        return c.json(existing);
      }
      const t = now();
      const created: Resource = { ...body, sys: { id, type: "ContentType", version: 1, createdAt: t, updatedAt: t } };
      store.set(id, created);
      return c.json(created, 201);
    });
    app.put(`${env}/content_types/:id/published`, (c) => {
      const contentType = this.mustGet(this.environment(c.req.param("env")).contentTypes, c.req.param("id"), "ContentType");
      this.checkVersion(c, contentType);
      contentType.sys.publishedVersion = contentType.sys.version;
      this.bump(contentType);
      return c.json(contentType);
    });

    // Entries
    app.get(`${env}/entries`, (c) => {
      const query = new URL(c.req.url).searchParams;
      const items = this.query([...this.environment(c.req.param("env")).entries.values()], query);
      return c.json(list(items, Number(query.get("skip") ?? 0), Number(query.get("limit") ?? 100)));
    });
    app.get(`${env}/entries/:id`, (c) => c.json(this.mustGet(this.environment(c.req.param("env")).entries, c.req.param("id"), "Entry")));
    app.post(`${env}/entries`, async (c) => {
      const environment = this.environment(c.req.param("env"));
      const contentTypeId = c.req.header("x-contentful-content-type") ?? "";
      const body = (await c.req.json()) as { fields?: Record<string, unknown> };
      this.checkFields(environment, contentTypeId, body.fields ?? {});
      const t = now();
      const entry: Resource = {
        metadata: { tags: [] },
        fields: body.fields ?? {},
        sys: { id: newId(), type: "Entry", version: 1, createdAt: t, updatedAt: t, contentType: link("ContentType", contentTypeId), environment: link("Environment", environment.sys.id) },
      };
      environment.entries.set(entry.sys.id, entry);
      return c.json(entry, 201);
    });
    app.put(`${env}/entries/:id`, async (c) => {
      const environment = this.environment(c.req.param("env"));
      const entry = this.mustGet(environment.entries, c.req.param("id"), "Entry");
      this.checkVersion(c, entry);
      const body = (await c.req.json()) as { fields?: Record<string, unknown> };
      this.checkFields(environment, (entry.sys.contentType as { sys: { id: string } }).sys.id, body.fields ?? {});
      entry.fields = body.fields ?? {};
      this.bump(entry);
      return c.json(entry);
    });
    app.put(`${env}/entries/:id/published`, (c) => {
      const environment = this.environment(c.req.param("env"));
      const entry = this.mustGet(environment.entries, c.req.param("id"), "Entry");
      this.checkVersion(c, entry);
      const contentType = this.mustGet(environment.contentTypes, (entry.sys.contentType as { sys: { id: string } }).sys.id, "ContentType");
      const missing = (contentType.fields as Field[]).filter((f) => f.required && !f.omitted && !f.disabled && (entry.fields as Record<string, Record<string, unknown>>)[f.id]?.[LOCALE] === undefined);
      if (missing.length) {
        throw new ApiError(422, "ValidationFailed", "Validation error", { errors: missing.map((f) => ({ name: "required", path: ["fields", f.id], details: "The property is required" })) });
      }
      entry.sys.publishedVersion = entry.sys.version;
      this.bump(entry);
      return c.json(entry);
    });

    // Assets
    app.get(`${env}/assets`, (c) => {
      const query = new URL(c.req.url).searchParams;
      return c.json(list(this.query([...this.environment(c.req.param("env")).assets.values()], query)));
    });
    app.get(`${env}/assets/:id`, (c) => c.json(this.mustGet(this.environment(c.req.param("env")).assets, c.req.param("id"), "Asset")));
    app.post(`${env}/assets`, async (c) => {
      const environment = this.environment(c.req.param("env"));
      const body = (await c.req.json()) as { fields: Record<string, unknown> };
      const t = now();
      const asset: Resource = { metadata: { tags: [] }, fields: body.fields, sys: { id: newId(), type: "Asset", version: 1, createdAt: t, updatedAt: t } };
      environment.assets.set(asset.sys.id, asset);
      return c.json(asset, 201);
    });
    app.put(`${env}/assets/:id/files/:locale/process`, (c) => {
      const asset = this.mustGet(this.environment(c.req.param("env")).assets, c.req.param("id"), "Asset");
      const file = (asset.fields as { file: Record<string, { upload?: string; url?: string }> }).file[c.req.param("locale")];
      if (file?.upload) {
        file.url = file.upload;
        delete file.upload;
      }
      this.bump(asset);
      return c.body(null, 204);
    });
    app.put(`${env}/assets/:id/published`, (c) => {
      const asset = this.mustGet(this.environment(c.req.param("env")).assets, c.req.param("id"), "Asset");
      this.checkVersion(c, asset);
      asset.sys.publishedVersion = asset.sys.version;
      this.bump(asset);
      return c.json(asset);
    });

    app.all("*", (c) => this.error(c, new ApiError(404, "NotFound", `The fake Content Management API doesn't implement ${c.req.method} ${c.req.path}`)));
  }

  private environmentJson = (env: Environment) => ({ sys: env.sys, name: env.name });

  private error(c: Context, error: unknown) {
    if (error instanceof ApiError) {
      return c.json({ sys: { type: "Error", id: error.id }, message: error.message, ...(error.details ? { details: error.details } : {}), requestId: "e2e" }, error.status);
    }
    console.error(error);
    return c.json({ sys: { type: "Error", id: "ServerError" }, message: String(error) }, 500);
  }

  private mustGet(store: Map<string, Resource>, id: string, type: string): Resource {
    const found = store.get(id);
    if (!found) throw new ApiError(404, "NotFound", `The resource could not be found (${type} ${id})`);
    return found;
  }

  private checkVersion(c: Context, resource: Resource) {
    const given = Number(c.req.header("x-contentful-version"));
    if (given !== resource.sys.version) throw new ApiError(409, "VersionMismatch", `Version mismatch: sent ${given}, current ${resource.sys.version}`);
  }

  private bump(resource: Resource) {
    resource.sys.version += 1;
    resource.sys.updatedAt = now();
  }

  private checkFields(environment: Environment, contentTypeId: string, fields: Record<string, unknown>) {
    const contentType = environment.contentTypes.get(contentTypeId);
    if (!contentType?.sys.publishedVersion) throw new ApiError(422, "UnknownContentType", `Content type ${contentTypeId} doesn't exist or isn't published`);
    const known = new Set((contentType.fields as Field[]).map((f) => f.id));
    const unknown = Object.keys(fields).filter((id) => !known.has(id));
    if (unknown.length) {
      throw new ApiError(422, "InvalidEntry", "Validation error", { errors: unknown.map((id) => ({ name: "unknown", path: ["fields", id], details: "The property is not expected" })) });
    }
  }

  /** The query parameters StoryPage sends: content_type, fields.x, fields.x[exists], sys.id[in], query, order. */
  private query(items: Resource[], params: URLSearchParams): Resource[] {
    const field = (item: Resource, path: string): unknown => {
      const [, name, ...rest] = path.split(".");
      const value = (item.fields as Record<string, Record<string, unknown>>)[name!]?.[LOCALE];
      return rest.reduce<unknown>((v, key) => (v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined), value);
    };
    let out = items;
    for (const [key, value] of params) {
      if (key === "content_type") out = out.filter((i) => (i.sys.contentType as { sys: { id: string } }).sys.id === value);
      else if (key === "sys.id[in]") out = out.filter((i) => value.split(",").includes(i.sys.id));
      else if (key === "query") out = out.filter((i) => JSON.stringify(i.fields).toLowerCase().includes(value.toLowerCase()));
      else if (key.startsWith("fields.")) {
        const match = /^(fields\.[\w.]+?)(?:\[(exists|match)\])?$/.exec(key);
        if (!match) continue;
        const [, path, operator] = match;
        out = out.filter((i) => {
          const v = field(i, path!);
          if (operator === "exists") return (v !== undefined && v !== null) === (value === "true");
          if (operator === "match") return String(v ?? "").toLowerCase().includes(value.toLowerCase());
          return String(v) === value;
        });
      }
    }
    const order = params.get("order");
    if (order) {
      const desc = order.startsWith("-");
      const key = order.replace(/^-/, "").replace(/^sys\./, "") as keyof Sys;
      out = [...out].sort((a, b) => String(a.sys[key]).localeCompare(String(b.sys[key])) * (desc ? -1 : 1));
    }
    return out;
  }
}
