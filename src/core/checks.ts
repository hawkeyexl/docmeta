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
import { CHECK_NAME, type CheckConfig } from "./config.js";
import { escapePointerSegment } from "../extractors/pointer.js";
import {
  assertSingleStatement,
  collectNamedParameters,
  corpusDataColumns,
  createDocsTable,
  loadSqlite,
  registerLineFor,
  stripLeadingTrivia,
  type ProjectionEntry,
} from "./projection.js";
import {
  collectCollections,
  createCollectionViews,
  type CollectionParams,
} from "./collections.js";

/** One loaded file a check may attach findings to. */
export type CheckEntry = ProjectionEntry;

/** The `keyword` every check finding carries: no Ajv keyword produced it. */
export const CHECK_KEYWORD = "check";

/**
 * The `schema` ref a check's findings carry — and their baseline identity.
 *
 * The grammar is asserted here as well as in the config parser: a
 * programmatic `CheckConfig` never passes through `parseChecks`, and a
 * path-shaped name (`../evil`, `slugs.json`) would classify as a file ref and
 * fingerprint cwd-relative — the identity bug `CHECK_NAME` exists to prevent.
 */
export function checkSchemaRef(name: string): string {
  if (!CHECK_NAME.test(name) || name.toLowerCase().endsWith(".json")) {
    throw new DocmetaError(
      `check name "${name}" must match [a-z0-9][a-z0-9._-]* and not end in ".json" — the name is part of each finding's identity (check:<name>).`,
    );
  }
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
      // RFC 6901 escaping, or a key containing `/` or `~` would build a
      // pointer that parses as a different (nested) location.
      instancePath: key === undefined ? "" : `/${escapePointerSegment(key)}`,
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
 * usable — not so it is a good idea; write a message. A NULL cell says
 * nothing, so it is omitted rather than rendered as a literal `null`; when
 * every remaining cell is NULL the generic fallback stands.
 */
function synthesizeMessage(
  extras: readonly string[],
  row: Record<string, unknown>,
): string {
  const pairs = extras.flatMap((c) => {
    const value = row[c];
    if (value === null || value === undefined) return [];
    // SQL cells are string | number | bigint (a BLOB cannot arise from the
    // projection's text/numeric columns); the JSON fallback keeps a future
    // surprise printable rather than "[object Object]".
    const text =
      typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "bigint"
          ? String(value)
          : JSON.stringify(value);
    return [`${c}=${text}`];
  });
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
/**
 * The run context a check projection may need beyond the entries themselves:
 * the config whose named overrides become collection views (proposal 0027),
 * and the resolution inputs membership is decided with — the same ones
 * `validate` resolves each file's schema set with, so `FROM authors` in a
 * check means exactly "the files the author schema judged". The shape IS
 * `CollectionParams`: it is handed to `collectCollections` verbatim, and an
 * alias is what keeps the two from drifting apart field by field.
 */
export type CheckRunContext = CollectionParams;

export async function runChecks(
  checks: readonly CheckConfig[],
  entries: readonly CheckEntry[],
  ctx: CheckRunContext = {},
): Promise<Map<string, FieldError[]>> {
  const merged = new Map<string, FieldError[]>();
  if (checks.length === 0) return merged;

  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(":memory:");
  try {
    createDocsTable(db, entries, corpusDataColumns(entries));
    registerLineFor(db, entries);
    createCollectionViews(db, collectCollections(entries, ctx));
    // Checks are SELECT-only by design — 0021's original discipline, which
    // 0022 lifted for `query` because writes became query's *feature*, judged
    // by its effect gate. Checks have no such gate: without this, an UPDATE
    // in one check mutates the shared projection every later check computes
    // over, and a DELETE/DROP is misdiagnosed downstream. Set after the
    // table and views are built, before any check's SQL runs.
    db.exec("PRAGMA query_only = 1");
    const loaded = new Set(entries.map((e) => e.label));

    for (const check of checks) {
      // ATTACH and VACUUM write files of their own, which `query_only`
      // does not fully prevent (ATTACH creates the attached file; VACUUM
      // INTO creates its target before the engine refuses) — the same two
      // statements `query` refuses by name.
      const head = stripLeadingTrivia(check.query);
      if (/^(attach|vacuum)\b/i.test(head)) {
        throw new DocmetaError(
          `check "${check.name}": ${head.split(/\s/, 1)[0]?.toUpperCase() ?? "that statement"} is refused: it can write outside the docs table.`,
        );
      }
      // Checks bind nothing, so any named parameter would silently bind
      // NULL, match nothing, and green the gate forever — the false-green
      // shape the query-side guard refuses with a bind; here the remedy is
      // to inline the value.
      let tokens: string[];
      try {
        tokens = collectNamedParameters(check.query);
      } catch (err) {
        // The scan's own refusal (one name under two prefixes), check named.
        throw new DocmetaError(
          `check "${check.name}": ${(err as Error).message}`,
        );
      }
      if (tokens.length > 0) {
        throw new DocmetaError(
          `check "${check.name}": the SQL references ${tokens.join(", ")}, but checks bind no parameters — an unbound name binds NULL and matches nothing, so the gate would pass on a typo. Inline the value in the SQL.`,
        );
      }
      let columns: string[];
      let rows: Record<string, unknown>[];
      try {
        assertSingleStatement(check.query);
        const stmt = db.prepare(check.query);
        columns = stmt.columns().map((c) => c.name);
        rows = stmt.all();
      } catch (err) {
        const message = (err as Error).message;
        throw new DocmetaError(
          message.includes("attempt to write a readonly database")
            ? `check "${check.name}": ${message} — checks are read-only by design; a check is a SELECT over the projection. Edit the corpus with \`docmeta query\` instead.`
            : `check "${check.name}": ${message}`,
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
