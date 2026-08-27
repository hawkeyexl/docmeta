/**
 * Named corpus checks (proposal 0026): SQL from the config's `checks:` list,
 * run over the same `docs` projection `query` builds, whose result rows are
 * **findings** rather than a table.
 *
 * The column convention is the whole mapping: `path` (required) names the file
 * a finding attaches to, `line` its 1-based source line, `key` the metadata
 * field at fault (it becomes the `instancePath`, and with it part of the
 * finding's baseline identity), `message` the prose. A row that follows it
 * becomes an ordinary `FieldError` — `schema: "check:<name>"`, `keyword:
 * "check"` — and every downstream surface (pretty, github, SARIF, JUnit, the
 * baseline ratchet) works unchanged.
 */
import { DocmetaError, type FieldError } from "../types.js";
import type { CheckConfig } from "./config.js";
import {
  assertSingleStatement,
  corpusDataColumns,
  createDocsTable,
  loadSqlite,
  registerLineFor,
  type ProjectionEntry,
} from "./projection.js";

/** One loaded file a check may attach findings to. */
export type CheckEntry = ProjectionEntry;

/** The `keyword` every check finding carries: no Ajv keyword produced it. */
export const CHECK_KEYWORD = "check";

/** The `schema` ref a check's findings carry — and their baseline identity. */
export function checkSchemaRef(name: string): string {
  return `check:${name}`;
}

/** The columns the convention consumes; everything else feeds the message. */
const CONVENTION_COLUMNS = new Set(["path", "line", "key", "message"]);

/**
 * Map one check's result rows to findings, keyed by file path.
 *
 * `loaded` is the set of paths this run holds extractions for. A row naming
 * any other path is a broken check, not a finding: fabricating a result for a
 * file the run never read would corrupt the summary, so it refuses (exit 2)
 * with the check named — the same class as SQL that does not prepare. On the
 * `query --check` path no set is passed: the SELECT is the user's own, its
 * `path` column is taken at its word (`<stdin>` included — proposal 0026
 * § stress test 7), and only a non-string path refuses.
 */
export function rowsToFindings(
  name: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
  loaded?: ReadonlySet<string>,
): Map<string, FieldError[]> {
  if (!columns.includes("path")) {
    throw new DocmetaError(
      `check "${name}": the result has no \`path\` column. A check's SELECT names its findings through the column convention: \`path\` (required), and optionally \`line\`, \`key\`, and \`message\`; any other column is folded into the message.`,
    );
  }
  const findings = new Map<string, FieldError[]>();
  const extras = columns.filter((c) => !CONVENTION_COLUMNS.has(c));
  for (const row of rows) {
    const path = row.path;
    if (typeof path !== "string" || (loaded !== undefined && !loaded.has(path))) {
      throw new DocmetaError(
        `check "${name}": a result row names ${JSON.stringify(path)}, which this run did not load — a finding must attach to a file of the corpus. Fix the check's \`path\` column.`,
      );
    }
    const key = typeof row.key === "string" && row.key !== "" ? row.key : undefined;
    const line = asLine(row.line);
    const message =
      typeof row.message === "string" && row.message !== ""
        ? row.message
        : synthesizeMessage(extras, row);
    const err: FieldError = {
      schema: checkSchemaRef(name),
      keyword: CHECK_KEYWORD,
      instancePath: key === undefined ? "" : `/${key}`,
      message,
      ...(line === undefined ? {} : { line }),
    };
    const bucket = findings.get(path);
    if (bucket) bucket.push(err);
    else findings.set(path, [err]);
  }
  return findings;
}

/** A `line` cell, when it is the 1-based positive integer the contract means. */
function asLine(value: unknown): number | undefined {
  const n =
    typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : undefined;
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * The fallback prose when a check declares no `message`: `col=value` over the
 * remaining columns, so a lazy `SELECT _path AS path, slug FROM …` is still
 * usable — not so it is a good idea; write a message.
 */
function synthesizeMessage(
  extras: readonly string[],
  row: Record<string, unknown>,
): string {
  const pairs = extras.map((c) => `${c}=${String(row[c])}`);
  return pairs.length > 0 ? pairs.join(", ") : "check matched";
}

/**
 * Run every configured check over the corpus and merge their findings.
 *
 * The projection is the one `query` builds — same columns, same value
 * conventions — plus `lineFor(path, key)` so a check can carry a source line.
 * A check whose SQL cannot prepare, or whose rows break the column
 * convention, aborts the run with the check named: a broken rule is an
 * operational error, never a finding or a silent skip.
 */
export async function runChecks(
  checks: readonly CheckConfig[],
  entries: readonly CheckEntry[],
): Promise<Map<string, FieldError[]>> {
  const merged = new Map<string, FieldError[]>();
  if (checks.length === 0) return merged;

  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(":memory:");
  try {
    createDocsTable(db, entries, corpusDataColumns(entries));
    registerLineFor(db, entries);
    const loaded = new Set(entries.map((e) => e.label));

    for (const check of checks) {
      let columns: string[];
      let rows: Record<string, unknown>[];
      try {
        assertSingleStatement(check.query);
        const stmt = db.prepare(check.query);
        columns = stmt.columns().map((c) => c.name);
        rows = stmt.all();
      } catch (err) {
        throw new DocmetaError(
          `check "${check.name}": ${(err as Error).message}`,
        );
      }
      for (const [path, errs] of rowsToFindings(
        check.name,
        columns,
        rows,
        loaded,
      )) {
        const bucket = merged.get(path);
        if (bucket) bucket.push(...errs);
        else merged.set(path, errs);
      }
    }
  } finally {
    db.close();
  }
  return merged;
}
