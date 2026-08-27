/**
 * The SQL projection of a metadata corpus — the `docs` table both `query`
 * (proposal 0021) and the named corpus checks (proposal 0026) run over.
 *
 * One file, one row: the four system columns plus one column per top-level
 * metadata key across the corpus. `query` adds statement-specific columns and
 * effect-judging on top; checks read the same table and nothing else. The
 * table-building lives here so the two entry points cannot drift.
 */
import type { DatabaseSync } from "node:sqlite";
import { DocmetaError, type ExtractedMetadata } from "../types.js";

/**
 * The columns every `docs` table carries, reserved so ordinary frontmatter can
 * never shadow them. A frontmatter key with exactly one of these names is not
 * lifted to a column and stays reachable as `_data ->> '$.<key>'`; any other
 * `_`-prefixed key lifts normally — the reservation is four names, not a
 * namespace grab (proposal 0021 § stress test 4).
 */
export const SYSTEM_COLUMNS = ["_path", "_format", "_present", "_data"] as const;
export const RESERVED: ReadonlySet<string> = new Set<string>(SYSTEM_COLUMNS);

/** What `node:sqlite` accepts as a bound parameter. */
export type SqlValue = null | number | bigint | string;

/** One loaded file, as the projection needs it: its label and its extraction. */
export interface ProjectionEntry {
  label: string;
  extracted: ExtractedMetadata;
}

/** Any key becomes a legal quoted identifier by doubling internal quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * One frontmatter value, as SQLite stores it: booleans as 1/0 (`node:sqlite`
 * refuses to bind a boolean), arrays and objects as JSON text (which
 * `json_each` and `->>` then query directly), non-finite numbers as NULL
 * (SQLite has no NaN — it would store NULL anyway, this just does it without
 * an engine error).
 */
export function bindValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case "boolean":
      return value ? 1 : 0;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
    case "string":
      return value;
    default:
      return JSON.stringify(value);
  }
}

/**
 * Data columns for a corpus: the union of top-level keys across `entries` —
 * the same scan boundary `schemas infer` chose — plus any `extraKeys` the
 * caller's statement names (a SET target no file has yet still deserves a
 * column). Sorted, so the column order (and any `SELECT *`) is deterministic
 * regardless of file order.
 */
export function corpusDataColumns(
  entries: readonly ProjectionEntry[],
  extraKeys: Iterable<string> = [],
): string[] {
  const keys = new Set<string>();
  for (const { extracted } of entries) {
    for (const key of Object.keys(extracted.data)) {
      if (key !== "" && !RESERVED.has(key)) keys.add(key);
    }
  }
  for (const key of extraKeys) {
    if (key !== "" && !RESERVED.has(key)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Create and load the `docs` table on an open database.
 *
 * Data columns get no type affinity, so SQLite stores exactly the value each
 * file had and never coerces one file's string into another's number. One
 * transaction for the bulk load: each bare run() would otherwise commit on its
 * own, which is where a large corpus spends its load time.
 */
export function createDocsTable(
  db: DatabaseSync,
  entries: readonly ProjectionEntry[],
  dataColumns: readonly string[],
): void {
  db.exec(
    `CREATE TABLE docs ("_path" TEXT PRIMARY KEY, "_format" TEXT, "_present" INTEGER, "_data" TEXT${dataColumns
      .map((c) => `, ${quoteIdent(c)}`)
      .join("")})`,
  );
  const insert = db.prepare(
    `INSERT INTO docs VALUES (${["?", "?", "?", "?", ...dataColumns.map(() => "?")].join(", ")})`,
  );
  db.exec("BEGIN");
  for (const { label, extracted } of entries) {
    insert.run(
      label,
      extracted.format,
      extracted.present ? 1 : 0,
      JSON.stringify(extracted.data),
      ...dataColumns.map((c) => bindValue(extracted.data[c])),
    );
  }
  db.exec("COMMIT");
}

/**
 * Register `lineFor(path, key)` as a SQL function on the run's database, so a
 * statement can name the source line a metadata key sits on (proposal 0026).
 *
 * Backed by each entry's `extracted.lineFor` — the contract every extractor
 * already fulfills for annotations — through the same `db.function` mechanism
 * that registers `explicit_null()`, plus `deterministic: true`: the answer
 * depends only on the arguments for the life of the statement, which lets
 * SQLite fold repeated calls. `NULL` for an unknown path, a key the extractor
 * cannot place, or a non-string argument.
 */
export function registerLineFor(
  db: DatabaseSync,
  entries: readonly ProjectionEntry[],
): void {
  const byLabel = new Map(entries.map((e) => [e.label, e.extracted]));
  db.function("lineFor", { deterministic: true }, (path, key) => {
    if (typeof path !== "string" || typeof key !== "string") return null;
    return byLabel.get(path)?.lineFor(key) ?? null;
  });
}

/**
 * Refuse a second statement instead of silently dropping it.
 *
 * `prepare()` compiles the first statement and ignores the rest, so
 * `SELECT 1; DROP TABLE docs` would run the SELECT and quietly skip the DROP —
 * a request half-honored with exit 0, the false-green shape 0016 exists to
 * keep out. The scan skips string literals, quoted identifiers, and both
 * comment forms; a trailing `;` (or several) is a terminator, not a chain.
 */
export function assertSingleStatement(sql: string): void {
  const cut = topLevelSemicolon(sql);
  if (cut === -1) return;
  if (!isTrivia(sql.slice(cut + 1))) {
    throw new DocmetaError(
      "Run a single SQL statement per query; text after the first `;` would be silently ignored.",
    );
  }
}

/**
 * Index of the first `;` outside literals, identifiers, and comments.
 *
 * Parenthesis depth is deliberately not tracked: in valid SQLite, the only
 * semicolons outside strings are statement terminators — the grammar has no
 * parenthesized position where one may appear — so depth would be state with
 * nothing to distinguish. (Trigger bodies, the one construct with interior
 * semicolons, never reach here: the docs projection has no triggers.)
 */
function topLevelSemicolon(sql: string): number {
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      // A doubled quote is an escaped quote, not a close-then-open.
      i++;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
    } else if (ch === "[") {
      // SQLite bracket identifiers have no `]]` escape (unlike T-SQL), so a
      // plain scan to the close is exact and needs no doubling branch.
      while (i < sql.length && sql[i] !== "]") i++;
    } else if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i++;
    } else if (ch === ";") {
      return i;
    }
  }
  return -1;
}

/**
 * The one grammar for a named parameter's bare name. The scan below matches
 * it as a prefix; `isParamName` answers for a whole string — exported so the
 * CLI's `--param` validation cannot drift from what the scan recognizes.
 */
const PARAM_NAME_HEAD = /^[A-Za-z_][A-Za-z0-9_]*/;
export function isParamName(name: string): boolean {
  return PARAM_NAME_HEAD.exec(name)?.[0] === name;
}

/**
 * Named-parameter tokens (`$name`, `:name`, `@name`) the statement references
 * outside string literals, quoted identifiers, and comments — the same skip
 * rules as `topLevelSemicolon`, for the same reason: text inside a literal is
 * data, not syntax (proposal 0029).
 *
 * The tokens are returned as written, prefix included, first occurrence only.
 * The grammar is deliberately narrow: a prefix character must be followed
 * immediately by an identifier (`[A-Za-z_][A-Za-z0-9_]*`), so a bare `$`, a
 * spaced `:`, and a doubled `::` are all operators-or-noise, never parameters.
 *
 * One bare name under two prefixes (`$p` and `:p` in one statement) refuses
 * here: the engine rejects it anyway, but as a generic "conflicting names"
 * SQL error with neither spelling named.
 *
 * Why this exists: the engine throws on an *extra* bound parameter, but a
 * parameter the SQL references with nothing bound silently binds NULL — which
 * matches nothing, and a zero-row `--check` is a passing CI gate. The caller
 * uses this list to refuse that false green before the statement runs.
 */
export function collectNamedParameters(sql: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const prefixOf = new Map<string, string>();
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      // Same doubled-quote walk as the semicolon scan.
      i++;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
    } else if (ch === "[") {
      while (i < sql.length && sql[i] !== "]") i++;
    } else if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i++;
    } else if (ch === "$" || ch === ":" || ch === "@") {
      if (ch === ":" && sql[i + 1] === ":") {
        // `::` is no parameter; consume both so neither colon starts one.
        i++;
        continue;
      }
      const m = PARAM_NAME_HEAD.exec(sql.slice(i + 1));
      if (!m) continue;
      const token = ch + m[0];
      const priorPrefix = prefixOf.get(m[0]);
      if (priorPrefix !== undefined && priorPrefix !== ch) {
        throw new DocmetaError(
          `The statement references both ${priorPrefix}${m[0]} and ${token} — one name under two prefixes, which the engine rejects as conflicting. Use one spelling throughout.`,
        );
      }
      prefixOf.set(m[0], ch);
      if (!seen.has(token)) {
        seen.add(token);
        tokens.push(token);
      }
      i += m[0].length;
    }
  }
  return tokens;
}

/**
 * The statement with leading whitespace and comments removed — the first real
 * token, for the callers that refuse a statement by name (`query`'s
 * ATTACH/VACUUM gate, and the checks' twin of it). Lived in query.ts until
 * the checks needed the identical scan.
 */
export function stripLeadingTrivia(sql: string): string {
  let i = 0;
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i] ?? "")) i++;
    if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return "";
      i = end + 2;
      continue;
    }
    return sql.slice(i);
  }
}

/** Only whitespace, comments, and bare `;` — legal after the terminator. */
function isTrivia(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined || /\s/.test(ch) || ch === ";") continue;
    if (ch === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * `node:sqlite`, imported on first use only.
 *
 * Two reasons this is not a top-level import. A static import would load the
 * module for every docmeta invocation, `validate` runs included. And on the
 * Node 24 engines floor the module is a release candidate that announces
 * itself with an ExperimentalWarning on load — which would open every CI log
 * with a scare line — so exactly that one warning is filtered while the
 * import runs. Delete the filter when `node:sqlite` reaches Stable.
 */
let sqliteModule: Promise<typeof import("node:sqlite")> | undefined;
export function loadSqlite(): Promise<typeof import("node:sqlite")> {
  sqliteModule ??= (async () => {
    // Bound, so the capture is a standalone function twice over: callable
    // here without a `this` surprise, and safe to leave installed as the
    // restored property.
    const original = process.emitWarning.bind(process);
    const filtered: typeof process.emitWarning = (warning, ...rest) => {
      const text = typeof warning === "string" ? warning : warning.message;
      if (text.includes("SQLite is an experimental feature")) return;
      Reflect.apply(original, process, [warning, ...rest]);
    };
    process.emitWarning = filtered;
    try {
      return await import("node:sqlite");
    } finally {
      process.emitWarning = original;
    }
  })();
  return sqliteModule;
}
