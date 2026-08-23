/**
 * Liveness check for the published built-in schemas.
 *
 * `check-builtin-schemas.mjs` is the *local* half of this promise: it asserts
 * that `src/schemas/**`, `docs/public/schemas/**`, and the hashes in
 * `src/schemas/manifest.json` all agree. Every one of its checks passes on a
 * repository whose docs site is 404ing, because none of them leaves the disk.
 *
 * That gap matters more here than it would elsewhere. docmeta tells people a
 * version-pinned schema URL never changes, and invites them to depend on it from
 * `$schema` in a document or from `schemas:` in a config. The people taking that
 * offer are not necessarily running docmeta at all, so if a Pages deploy drops a
 * file, changes the base path, or serves something stale, nothing in this repo
 * notices and nobody upstream can tell us — their build just starts failing on a
 * URL we published.
 *
 * So this fetches each URL for real and hashes what comes back. It is the one
 * check that cannot run on a PR (no network guarantees, and a contributor should
 * not see red for someone else's outage), which is why it runs on a schedule
 * instead. See `.github/workflows/published-schemas.yml`.
 *
 * Usage:
 *   node scripts/check-published-schemas.mjs [baseUrl]
 * Exit 0 = every URL serves the bytes the manifest records, 1 = drift or an
 * unreachable URL, 2 = setup error.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "src", "schemas", "manifest.json");

/** Where the docs site serves `docs/public/schemas/**`. */
const DEFAULT_BASE = "https://hawkeyexl.github.io/docmeta/schemas/";
const BASE = (process.argv[2] ?? DEFAULT_BASE).replace(/\/?$/, "/");

/** Generous: this is a liveness check, not a latency budget. */
const TIMEOUT_MS = 30_000;

function setupError(message) {
  console.error(`schemas:check-published: ${message}`);
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch (err) {
  setupError(`could not read src/schemas/manifest.json.\n${err.message}`);
}

const entries = Object.entries(manifest?.schemas ?? {});
if (entries.length === 0) {
  // Refusing to pass vacuously: an empty manifest means the check verified
  // nothing, and "0 URLs OK" reads exactly like success.
  setupError("src/schemas/manifest.json records no schemas — nothing to check.");
}

const sha256 = (buf) => `sha256-${createHash("sha256").update(buf).digest("hex")}`;

/**
 * Fetch one URL, retrying a *thrown* request exactly once.
 *
 * The asymmetry is the point. A 404 and a hash mismatch are deterministic
 * answers — asking again just gets the same answer more slowly, and retrying
 * them would paper over the very drift this exists to report. A thrown `fetch`
 * is not an answer at all: it is a DNS hiccup, a TLS reset, a cold edge node.
 *
 * That distinction matters more here than it would in a PR check, because this
 * runs unattended and GitHub emails on a failed scheduled run. A check that
 * cries wolf on every transient blip is one nobody reads by the third month,
 * which would cost exactly the coverage it was added for.
 */
async function fetchOnce(url) {
  return await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function fetchWithRetry(url) {
  try {
    return { res: await fetchOnce(url) };
  } catch {
    try {
      return { res: await fetchOnce(url) };
    } catch (err) {
      // The second failure is the one reported: if the two differ, it is the
      // one that still described reality when we gave up.
      return { err };
    }
  }
}

/**
 * Failures are collected rather than thrown. Stopping at the first bad URL
 * would hide how much is broken — "the deploy dropped one file" and "the whole
 * site is gone" want different responses, and the report should tell them apart.
 */
const problems = [];
let checked = 0;

for (const [key, expected] of entries) {
  const url = `${BASE}${key}`;
  const { res, err } = await fetchWithRetry(url);
  if (!res) {
    const why =
      err?.name === "TimeoutError"
        ? `timed out after ${TIMEOUT_MS}ms`
        : (err?.message ?? String(err));
    problems.push(
      `${key}: could not be fetched, twice (${why})\n      ${url}`,
    );
    continue;
  }
  if (!res.ok) {
    problems.push(`${key}: HTTP ${res.status} ${res.statusText}\n      ${url}`);
    continue;
  }
  const actual = sha256(Buffer.from(await res.arrayBuffer()));
  checked++;
  if (actual !== expected) {
    problems.push(
      `${key}: content does not match the manifest\n` +
        `      expected ${expected}\n` +
        `      served   ${actual}\n` +
        `      ${url}`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `schemas:check-published: ${problems.length} of ${entries.length} published schema URLs are wrong:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n\nA published URL is a promise its content never changes. A 404 or a hash\n" +
      "mismatch means the docs deploy is broken or served something it should not;\n" +
      "re-run the Docs workflow and compare against docs/public/schemas/**.",
  );
  process.exit(1);
}

console.log(
  `schemas:check-published: ${checked} published schema URLs serve the bytes the manifest records ✓`,
);
