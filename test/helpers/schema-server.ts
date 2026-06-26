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
}

export interface SchemaServer {
  url: string;
  hits: (path: string) => number;
  close: () => Promise<void>;
}

export async function startSchemaServer(
  routes: Record<string, Route>,
): Promise<SchemaServer> {
  const counts = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    counts.set(path, (counts.get(path) ?? 0) + 1);
    res.on("error", () => {});
    const route = routes[path];
    if (!route) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const send = () => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.statusCode = route.status ?? 200;
        res.setHeader("content-type", route.contentType ?? "application/json");
        const body =
          route.body ??
          (route.json !== undefined ? JSON.stringify(route.json) : "");
        res.end(body);
      } catch {
        /* socket may have been aborted (timeout tests) */
      }
    };
    if (route.delayMs) setTimeout(send, route.delayMs).unref();
    else send();
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    hits: (path) => counts.get(path) ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
