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

/** Attempts per URL, and the pause before each retry. */
const ATTEMPTS = 3;
const BACKOFF_MS = [500, 1500];

/**
 * Is this response the server saying "not now" rather than answering?
 *
 * The line worth drawing is transient vs deterministic, and it does **not**
 * fall between "threw" and "returned a response" — which is how the first
 * version of this got it wrong, and CI caught it within the hour: GitHub Pages
 * answered one URL with a 503 and the check reported the published schemas as
 * broken. A 5xx and a 429 are the server declining to answer yet, exactly like
 * a DNS hiccup or a TLS reset, and they deserve the same second chance.
 *
 * A 404 and a hash mismatch are on the other side of that line. They are real
 * answers, and asking again only gets the same one more slowly — retrying them
 * would paper over the very drift this exists to report.
 */
const isTransientStatus = (status) => status === 429 || status >= 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(url) {
  return await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/**
 * Fetch one URL, retrying only the transient cases above.
 *
 * This matters more here than it would in a PR check, because it runs
 * unattended and GitHub emails on a failed scheduled run. A check that cries
 * wolf on every blip is one nobody reads by the third month, which would cost
 * exactly the coverage it was added for.
 */
async function fetchWithRetry(url) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(BACKOFF_MS[attempt - 2] ?? 1500);
    try {
      const res = await fetchOnce(url);
      // Last word wins: on the final attempt the answer stands whatever it is.
      if (!isTransientStatus(res.status) || attempt === ATTEMPTS) return { res };
    } catch (err) {
      if (attempt === ATTEMPTS) return { err };
    }
  }
  // Unreachable while ATTEMPTS >= 1, since the final iteration always returns.
  // An explicit error rather than falling off the end: that would hand the
  // caller `undefined` and throw on the destructure at the call site, turning a
  // one-character edit to ATTEMPTS into a crash nowhere near its cause.
  return { err: new Error(`ATTEMPTS is ${ATTEMPTS}; no request was made`) };
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
      `${key}: could not be fetched after ${ATTEMPTS} attempts (${why})\n      ${url}`,
    );
    continue;
  }
  if (!res.ok) {
    // Name the transient case for what it is. A 503 that survived every retry
    // is the site being down, not the schema being wrong, and the two want
    // different responses from whoever reads this.
    const kind = isTransientStatus(res.status)
      ? `HTTP ${res.status} ${res.statusText} on all ${ATTEMPTS} attempts — the site looks down rather than wrong`
      : `HTTP ${res.status} ${res.statusText}`;
    problems.push(`${key}: ${kind}\n      ${url}`);
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
      "mismatch means the docs deploy is broken or served something it should not:\n" +
      "re-run the Docs workflow and compare against docs/public/schemas/**.\n" +
      "A 5xx or a timeout that outlived every retry usually means Pages itself is\n" +
      "having a bad day — check githubstatus.com before changing anything here.",
  );
  process.exit(1);
}

console.log(
  `schemas:check-published: ${checked} published schema URLs serve the bytes the manifest records ✓`,
);
