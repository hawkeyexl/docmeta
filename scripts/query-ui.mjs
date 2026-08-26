/**
 * Serve a `docmeta query --db` export to Datasette Lite — a browsable SQL UI
 * over the corpus with no Python (or anything else) installed. Datasette Lite
 * is Datasette compiled to WebAssembly, running entirely in the browser.
 *
 * The Lite shell (index.html, webworker.js) is proxied from lite.datasette.io
 * and served from this process, so the page, the worker, and the database all
 * share one plain-http local origin. That single-origin shape is the point:
 * an https-hosted Lite fetching a http://127.0.0.1 database is mixed content,
 * which some browsers block inside workers — same-origin has no such edge.
 * Pyodide itself still loads from its CDN, so the first open needs network.
 *
 * Usage:  node scripts/query-ui.mjs [path/to/query.db] [port] [--no-open]
 * Or:     npm run query:ui   (exports the repo's own docs first)
 */
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, basename } from "node:path";

const autoOpen = !process.argv.includes("--no-open");
const args = process.argv.slice(2).filter((a) => a !== "--no-open");
const db = resolve(args[0] ?? ".docmeta/query.db");
const port = Number(args[1] ?? 8765);
statSync(db); // fail fast, with the path in the error, if the export is missing

const LITE = "https://lite.datasette.io";
const shellCache = new Map(); // pathname -> { body: Buffer, type: string }

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", `http://127.0.0.1:${String(port)}`);

  if (pathname === `/${basename(db)}`) {
    // Re-read per request, so re-running the export refreshes a mere reload.
    const bytes = readFileSync(db);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": bytes.length,
    });
    res.end(bytes);
    return;
  }

  // Everything else is the Lite shell, fetched once and cached for the
  // session. Whatever assets upstream introduces are proxied the same way.
  const cached = shellCache.get(pathname);
  if (cached) {
    res.writeHead(200, { "Content-Type": cached.type });
    res.end(cached.body);
    return;
  }
  fetch(`${LITE}${pathname === "/" ? "/index.html" : pathname}`)
    .then(async (upstream) => {
      if (!upstream.ok) {
        res.writeHead(upstream.status).end();
        return;
      }
      const entry = {
        body: Buffer.from(await upstream.arrayBuffer()),
        type: upstream.headers.get("content-type") ?? "text/html",
      };
      shellCache.set(pathname, entry);
      res.writeHead(200, { "Content-Type": entry.type });
      res.end(entry.body);
    })
    .catch((err) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Could not reach ${LITE}: ${err.message}\n`);
    });
});

server.listen(port, "127.0.0.1", () => {
  // A relative url= keeps the database fetch same-origin, worker included.
  const ui = `http://127.0.0.1:${String(port)}/?url=${basename(db)}`;
  console.log(`Serving ${db}`);
  console.log(`Datasette Lite: ${ui}`);
  console.log("Ctrl-C to stop.");
  if (!autoOpen) return;
  const [cmd, cmdArgs] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", ui]]
      : process.platform === "darwin"
        ? ["open", [ui]]
        : ["xdg-open", [ui]];
  spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).unref();
});
