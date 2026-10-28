import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";

export interface Listening {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Serves a Hono app on 127.0.0.1 (a free port unless one is given). */
export function listen(app: Hono, port = 0): Promise<Listening> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        port: info.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
