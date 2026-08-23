/**
 * Drift-check for the programmatic API reference docs.
 *
 * `src/index.ts` is a third public surface alongside the CLI and the Action, and
 * it had no guard. It is also the easiest of the three to grow by accident: a
 * `export * from "./types.js"` re-export means a new interface in `src/types.ts`
 * becomes published API without anyone editing the entry point, and an export
 * nobody documents is an export nobody can find.
 *
 * This reads the flattened `export { … };` statement at the end of the built
 * `dist/index.d.ts` — the real published surface, after the star re-export has
 * been resolved — and asserts that
 * docs/src/content/docs/reference/api.mdx documents exactly the same names.
 * Purposes stay hand-authored; only the machine-checkable surface is guarded.
 *
 * Names are read from inline code spans in the `Export` column of the page's
 * tables, so one cell may legitimately group several related exports.
 *
 * Usage:
 *   node scripts/check-api-reference.mjs [path/to/api.mdx]
 * Requires `npm run build` first (reads dist/index.d.ts).
 * Exit 0 = in sync, 1 = drift found, 2 = setup error.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH =
  process.argv[2] ?? path.join(ROOT, "docs/src/content/docs/reference/api.mdx");
const DTS_PATH = path.join(ROOT, "dist/index.d.ts");

const fail = (msg) => {
  console.error(`docs:check-api: ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// 1. Canonical surface from the built declaration file.
// ---------------------------------------------------------------------------
let dts;
try {
  dts = readFileSync(DTS_PATH, "utf8");
} catch (err) {
  console.error(
    `docs:check-api: could not read dist/index.d.ts — run \`npm run build\` first.\n${err.message}`,
  );
  process.exit(2);
}

// The bundler emits one flat `export { A, type B, … };` at the end of the file.
// `[^{}]` keeps this from swallowing a preceding declaration body, and the
// trailing `;` keeps it from matching a re-export (`export { X } from "y"`).
const statements = [...dts.matchAll(/export\s*\{([^{}]+)\}\s*;/g)];
const last = statements.at(-1);
if (!last) {
  // Passing here would be worse than having no guard at all: the page could
  // document nothing and still read as in sync.
  console.error(
    "docs:check-api: no flat `export { … };` statement found in dist/index.d.ts.\n" +
      "The build output is stale or its shape changed — run `npm run build` and re-run.",
  );
  process.exit(2);
}

/** Bare export names, with the `type ` modifier stripped. */
const realExports = new Set(
  last[1]
    .split(",")
    .map((n) => n.trim().replace(/^type\s+/, ""))
    .filter(Boolean),
);

if (realExports.size === 0) {
  console.error(
    "docs:check-api: dist/index.d.ts exports nothing — refusing to pass vacuously.",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 2. Documented surface from the reference page.
// ---------------------------------------------------------------------------
let md;
try {
  md = readFileSync(DOC_PATH, "utf8");
} catch {
  fail(
    `${path.relative(ROOT, DOC_PATH).replace(/\\/g, "/")} does not exist. src/index.ts is a public surface; it needs a reference page.`,
  );
}

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
const isSeparator = (row) => row.every((c) => /^:?-{2,}:?$/.test(c));
/**
 * Every identifier inside a backtick span. A cell may group related exports
 * (`` `runGet`, `renderGet` ``); anything that is not a bare identifier — a
 * flag, a type expression, a prose word — is not an export name and is skipped.
 */
const namesIn = (cell) =>
  [...cell.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1].trim().replace(/^type\s+/, ""))
    .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));

const docExports = new Set();

let exportCol = -1; // column index of the `Export` header in the current table

for (const line of md.split(/\r?\n/)) {
  if (!line.trim().startsWith("|")) {
    exportCol = -1; // any non-row line ends the table
    continue;
  }
  const row = cells(line);
  if (isSeparator(row)) continue;
  if (exportCol === -1) {
    // A table's first row is its header. Only tables with an `Export` column
    // are read, so a page can carry illustrative tables without confusing the
    // check.
    exportCol = row.findIndex((c) => c.toLowerCase() === "export");
    continue;
  }
  for (const n of namesIn(row[exportCol] ?? "")) docExports.add(n);
}

if (docExports.size === 0) {
  fail(
    `${path.relative(ROOT, DOC_PATH).replace(/\\/g, "/")} documents no exports — it needs at least one table with an \`Export\` column.`,
  );
}

// ---------------------------------------------------------------------------
// 3. Compare.
// ---------------------------------------------------------------------------
const problems = [];
const sorted = (names) => [...names].sort().join(", ");

const missing = [...realExports].filter((n) => !docExports.has(n));
const extra = [...docExports].filter((n) => !realExports.has(n));
if (missing.length) {
  problems.push(`exported from src/index.ts but not documented: ${sorted(missing)}`);
}
if (extra.length) {
  problems.push(`documented but no longer exported: ${sorted(extra)}`);
}

// ---------------------------------------------------------------------------
// 4. Report.
// ---------------------------------------------------------------------------
const rel = path.relative(ROOT, DOC_PATH).replace(/\\/g, "/");
if (problems.length) {
  console.error(`docs:check-api: ${rel} is out of sync with src/index.ts:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\nUpdate the page (the entry point is the source of truth) and re-run \`npm run docs:check-api\`.`,
  );
  process.exit(1);
}

console.log(
  `docs:check-api: ${rel} is in sync with src/index.ts (${realExports.size} exports) ✓`,
);
