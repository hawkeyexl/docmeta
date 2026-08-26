/**
 * Serve a `docmeta query --db` export to Datasette Lite — a browsable SQL UI
 * over the corpus with no Python (or anything else) installed. Datasette Lite
 * is Datasette compiled to WebAssembly, running entirely in the browser; the
 * only local piece it needs is an HTTP URL for the database file, which is
 * what this ~40-line server provides. CORS is open because lite.datasette.io
 * is the cross-origin consumer, and browsers treat 127.0.0.1 as a secure
 * context, so the https page may fetch from it.
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

const server = createServer((req, res) => {
  // Whatever the request path, the answer is the database. The server exists
  // to hand Datasette Lite this one file and nothing else.
  const bytes = readFileSync(db);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": bytes.length,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(bytes);
});

server.listen(port, "127.0.0.1", () => {
  const fileUrl = `http://127.0.0.1:${String(port)}/${basename(db)}`;
  const ui = `https://lite.datasette.io/?url=${encodeURIComponent(fileUrl)}`;
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
