/**
 * Publish the built-in schemas, and record their bytes.
 *
 * Two outputs, both committed:
 *
 * 1. `docs/public/schemas/<dir>/<version>.json` — byte-identical copies. Astro
 *    serves `docs/public/**` at the site root and the site's `base` is
 *    `/docmeta`, so these land at
 *    `https://hawkeyexl.github.io/docmeta/schemas/<dir>/<version>.json`.
 * 2. `src/schemas/manifest.json` — `sha256-<hex>` over each file's exact bytes.
 *
 * They are committed rather than generated during the docs build because the
 * `build` job in `.github/workflows/docs.yml` is a separate checkout that runs
 * `npm ci` only inside `docs/`: the repo root has no `node_modules` there, and
 * nothing from the `validate-docs` job reaches it. `npm test` asserts the copies
 * are identical, so they cannot drift.
 *
 * **This script never changes a hash it has already recorded.** New keys are
 * added; existing ones are left exactly as they are. That is the whole point of
 * the manifest — a published URL is immutable, so editing a shipped schema has
 * to fail `npm run schemas:check` rather than being papered over by re-running
 * this. A genuine fix ships as a new version file.
 *
 * Usage:
 *   node scripts/sync-builtin-schemas.mjs
 * Exit 0 = written (or already current), 2 = setup error.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src", "schemas");
const PUBLIC = path.join(ROOT, "docs", "public", "schemas");
const MANIFEST = path.join(SRC, "manifest.json");

/** Every `<dir>/<version>.json`, posix-keyed and sorted. */
function sourceKeys(base) {
  const keys = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(path.join(base, entry.name))) {
      if (file.endsWith(".json")) keys.push(`${entry.name}/${file}`);
    }
  }
  return keys.sort();
}

const hashOf = (file) =>
  `sha256-${createHash("sha256").update(readFileSync(file)).digest("hex")}`;

let keys;
try {
  keys = sourceKeys(SRC);
} catch (err) {
  console.error(`schemas:sync: could not read ${SRC}\n${err.message}`);
  process.exit(2);
}
if (keys.length === 0) {
  console.error(`schemas:sync: found no schemas under ${SRC}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 1. The published copies.
// ---------------------------------------------------------------------------
// Rebuilt from scratch so a renamed or deleted source file does not leave an
// orphan being served. Removing a published version is itself a promise broken,
// and `schemas:check` reports it — but it reports it against `src/schemas`,
// which is the copy that has to be restored.
rmSync(PUBLIC, { recursive: true, force: true });
for (const key of keys) {
  const segments = key.split("/");
  const dest = path.join(PUBLIC, ...segments);
  mkdirSync(path.dirname(dest), { recursive: true });
  // `copyFile`, not read-then-write: the bytes are what the manifest hashes and
  // what the URL serves, so nothing may re-encode them on the way through.
  copyFileSync(path.join(SRC, ...segments), dest);
}

// ---------------------------------------------------------------------------
// 2. The manifest — additive only.
// ---------------------------------------------------------------------------
let recorded = {};
try {
  const existing = JSON.parse(readFileSync(MANIFEST, "utf8"));
  // `typeof null === "object"`, so the null check is not redundant: without
  // it `recorded` becomes null and the `recorded[key]` below throws a raw
  // TypeError outside this try, printing a stack trace instead of a
  // `schemas:sync:` line. `schemas:check` already guards the same shape.
  if (
    existing &&
    typeof existing.schemas === "object" &&
    existing.schemas !== null &&
    !Array.isArray(existing.schemas)
  ) {
    recorded = existing.schemas;
  }
} catch {
  // No manifest yet, or an unreadable one: start from empty and write a fresh
  // file below. A malformed manifest is reported by `schemas:check`, which is
  // the command that is allowed to fail.
}

const added = [];
const schemas = {};
for (const key of keys) {
  const kept = recorded[key];
  if (typeof kept === "string") {
    schemas[key] = kept;
  } else {
    schemas[key] = hashOf(path.join(SRC, ...key.split("/")));
    added.push(key);
  }
}
// Entries whose source file is gone are kept, not dropped: a published URL that
// starts 404ing is exactly what `schemas:check` has to be able to report.
const orphans = Object.keys(recorded).filter((k) => !(k in schemas));
for (const key of orphans) schemas[key] = recorded[key];

const sorted = Object.fromEntries(
  Object.keys(schemas)
    .sort()
    .map((k) => [k, schemas[k]]),
);
writeFileSync(MANIFEST, `${JSON.stringify({ version: 1, schemas: sorted }, null, 2)}\n`, "utf8");

// ---------------------------------------------------------------------------
// 3. Report.
// ---------------------------------------------------------------------------
const rel = path.relative(ROOT, PUBLIC).replace(/\\/g, "/");
console.log(`schemas:sync: wrote ${keys.length} schemas to ${rel}/`);
if (added.length > 0) {
  console.log(`schemas:sync: recorded ${added.length} new manifest entries:`);
  for (const key of added.sort()) console.log(`  + ${key}`);
} else {
  console.log("schemas:sync: no new manifest entries");
}
if (orphans.length > 0) {
  console.log(
    "schemas:sync: kept manifest entries whose source file is missing (run `npm run schemas:check`):",
  );
  for (const key of orphans.sort()) console.log(`  ? ${key}`);
}
console.log("schemas:sync: commit both src/schemas/manifest.json and docs/public/schemas/");
