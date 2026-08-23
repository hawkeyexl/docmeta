/**
 * Tiny local HTTP server for exercising the remote-schema (`http(s)://`) path
 * without touching the network. Serves a fixed routing table and counts hits
 * per path so tests can assert caching. Ports are ephemeral, so URLs are built
 * at runtime rather than baked into fixtures.
 */
import { createServer, type Server } from "node:http";

export interface Route {
  /** HTTP status to return (default 200). */
  status?: number;
  /** Object body, JSON-stringified before sending. */
  json?: unknown;
  /** Raw body string (takes precedence over `json`). */
  body?: string;
  /** Content-Type header (default application/json). */
  contentType?: string;
  /** Delay before responding, to drive timeout tests. */
  delayMs?: number;
  /**
   * Send the status line and headers immediately, then wait this long before
   * the body. Drives the abort-*during*-the-body case, which `delayMs` cannot
   * reach: that one never gets past `fetch()`.
   */
  bodyDelayMs?: number;
  /**
   * Stream `count` copies of `text` as separate writes. No `content-length` is
   * set, so the response is chunked — which is the point: a response-size cap
   * has to count the bytes it actually reads, because `content-length` is
   * advisory and may be absent or a lie.
   */
  streamChunks?: { text: string; count: number };
  /**
   * Destroy the socket without answering, producing a genuine **network**
   * error in the client rather than an HTTP status. That is the other half of
   * what the retry policy covers, and a status code cannot simulate it.
   */
  resetSocket?: boolean;
}

/**
 * A route that varies with how many times it has been asked.
 *
 * A static table cannot express "fail once, then succeed", which is exactly the
 * shape a retry has to be tested against: with a fixed 500 the second attempt is
 * indistinguishable from the first, so the test cannot tell a retry that healed
 * from one that never happened. `hit` is 1-based.
 */
export type RouteFn = (hit: number) => Route;

export interface RecordedRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface SchemaServer {
  url: string;
  hits: (path: string) => number;
  /** Every request received, in order. */
  requests: () => RecordedRequest[];
  close: () => Promise<void>;
}

export async function startSchemaServer(
  routes: Record<string, Route | RouteFn>,
): Promise<SchemaServer> {
  const counts = new Map<string, number>();
  const log: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const hit = (counts.get(path) ?? 0) + 1;
    counts.set(path, hit);
    log.push({ path, method: req.method ?? "GET", headers: { ...req.headers } });
    res.on("error", () => {});
    const entry = routes[path];
    const route = typeof entry === "function" ? entry(hit) : entry;
    if (!route) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const sendBody = () => {
      if (res.writableEnded || res.destroyed) return;
      try {
        const stream = route.streamChunks;
        if (stream) {
          for (let i = 0; i < stream.count; i++) res.write(stream.text);
          res.end();
          return;
        }
        const body =
          route.body ??
          (route.json !== undefined ? JSON.stringify(route.json) : "");
        res.end(body);
      } catch {
        /* socket may have been aborted (timeout tests) */
      }
    };
    const send = () => {
      if (res.writableEnded || res.destroyed) return;
      if (route.resetSocket) {
        req.socket.destroy();
        return;
      }
      try {
        res.statusCode = route.status ?? 200;
        res.setHeader("content-type", route.contentType ?? "application/json");
        if (route.bodyDelayMs) {
          res.flushHeaders();
          setTimeout(sendBody, route.bodyDelayMs).unref();
          return;
        }
        sendBody();
      } catch {
        /* socket may have been aborted (timeout tests) */
      }
    };
    if (route.delayMs) setTimeout(send, route.delayMs).unref();
    else send();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    hits: (path) => counts.get(path) ?? 0,
    requests: () => [...log],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
