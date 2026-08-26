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
 * The `/write` panel runs UPDATE statements through the real `runQuery` —
 * preview first, apply on request — and re-exports the database afterwards so
 * a Lite reload shows the new truth. The panel is guarded by a per-session
 * token embedded in its page: a cross-origin page can neither read the token
 * nor send the custom header without a CORS preflight this server never
 * grants, so a drive-by site cannot make it write.
 *
 * Usage:  node scripts/query-ui.mjs [path/to/query.db] [port] [--no-open]
 *                                   [--corpus <cwd> [inputs...]]
 * Or:     npm run query:ui   (exports the repo's own docs first)
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const autoOpen = !argv.includes("--no-open");
const corpusAt = argv.indexOf("--corpus");
// Everything after --corpus: the cwd, then explicit inputs (none = config).
const corpus = {
  cwd: corpusAt === -1 ? process.cwd() : resolve(argv[corpusAt + 1] ?? "."),
  inputs: corpusAt === -1 ? [] : argv.slice(corpusAt + 2),
};
const args = (corpusAt === -1 ? argv : argv.slice(0, corpusAt)).filter(
  (a) => a !== "--no-open",
);
const db = resolve(args[0] ?? ".docmeta/query.db");
const port = Number(args[1] ?? 8765);
const token = randomBytes(16).toString("hex");
statSync(db); // fail fast, with the path in the error, if the export is missing

const { runQuery } = await import(
  pathToFileURL(resolve("dist/index.js")).href
);

const PANEL = `<!doctype html><meta charset="utf-8"><title>docmeta write</title>
<style>
  body{font-family:ui-monospace,monospace;background:#171717;color:#fff;max-width:60rem;margin:2rem auto;padding:0 1rem}
  textarea{width:100%;height:7rem;background:#0d0d0d;color:#fff;border:1px solid #58a6ff;padding:.5rem;font:inherit}
  button{background:#0d0d0d;color:#58a6ff;border:1px solid #58a6ff;padding:.5rem 1rem;font:inherit;cursor:pointer;margin-right:.5rem}
  pre{background:#0d0d0d;padding:1rem;overflow-x:auto;white-space:pre-wrap}
  a{color:#58a6ff}
</style>
<h1>docmeta query — write</h1>
<p>One UPDATE against the <code>docs</code> table. Preview shows the per-file
diff; Apply writes it through docmeta's verifying writers and refreshes the
database for <a href="/?url=${basename(db)}">Datasette Lite</a>.</p>
<textarea id="sql">UPDATE docs SET draft = 0 WHERE draft = 1</textarea>
<p><button id="preview">Preview</button><button id="apply">Apply to files</button></p>
<pre id="out">—</pre>
<script>
  const out = document.getElementById("out");
  async function go(apply) {
    out.textContent = "…";
    const res = await fetch("/api/write", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Docmeta-Token": "${token}" },
      body: JSON.stringify({ sql: document.getElementById("sql").value, apply }),
    });
    const body = await res.json();
    out.textContent = body.error
      ? "refused: " + body.error
      : (body.changes.length === 0
          ? "0 changes"
          : body.changes.map(c => {
              const tail = c.written ? "  [written]" : "";
              if (c.config) return "config " + c.file + ": " + c.key + ": " + JSON.stringify(c.from) + " -> " + JSON.stringify(c.to) + tail;
              if (c.schema) return "schema " + c.file + ": " + c.op + " " + c.key + (c.renamedTo ? " -> " + c.renamedTo : "") + (c.forkedFrom ? " (forked from " + c.forkedFrom + ")" : "") + tail;
              if (c.cleared) return c.file + ": (frontmatter removed)" + tail;
              if (c.created) return c.file + ": (created: " + JSON.stringify(c.to) + ")" + tail;
              if (c.renamed) return c.file + " -> " + c.renamed + " (moved)" + tail;
              if (c.renamedFrom) return c.file + ": " + c.renamedFrom + " -> " + c.key + " (key renamed)" + tail;
              if (c.deleted) return c.file + ": " + c.key + ": " + JSON.stringify(c.from) + " -> (deleted)" + tail;
              return c.file + ": " + c.key + ": " + JSON.stringify(c.from) + " -> " + JSON.stringify(c.to) + tail;
            }).join("\\n"))
        + (apply ? "\\n\\napplied — reload Datasette Lite to see it" : "\\n\\npreview only");
  }
  document.getElementById("preview").onclick = () => go(false);
  document.getElementById("apply").onclick = () => go(true);
</script>`;

const LITE = "https://lite.datasette.io";
const shellCache = new Map(); // pathname -> { body: Buffer, type: string }

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", `http://127.0.0.1:${String(port)}`);

  if (pathname === "/write") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PANEL);
    return;
  }

  if (pathname === "/api/write" && req.method === "POST") {
    if (req.headers["x-docmeta-token"] !== token) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad token" }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      void (async () => {
        try {
          const { sql, apply } = JSON.parse(raw);
          if (typeof sql !== "string" || sql.trim() === "") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing sql field" }));
            return;
          }
          const run = await runQuery({
            sql,
            inputs: corpus.inputs,
            cwd: corpus.cwd,
            write: Boolean(apply),
          });
          if (apply) {
            // Refresh the export so a Lite reload shows the applied state.
            await runQuery({
              sql: "",
              inputs: corpus.inputs,
              cwd: corpus.cwd,
              db,
            });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ changes: run.changes ?? [] }));
        } catch (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
    });
    return;
  }

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

// EADDRINUSE and friends deserve one readable line, not an unhandled throw.
server.on("error", (err) => {
  console.error(`Cannot listen on 127.0.0.1:${String(port)}: ${err.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  // A relative url= keeps the database fetch same-origin, worker included.
  const ui = `http://127.0.0.1:${String(port)}/?url=${basename(db)}`;
  console.log(`Serving ${db}`);
  console.log(`Datasette Lite: ${ui}`);
  console.log(`Write panel:    http://127.0.0.1:${String(port)}/write`);
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
