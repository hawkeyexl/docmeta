/**
 * Named collections (proposal 0027): each `overrides[]` entry carrying a
 * `name:` becomes a SQL view over the `docs` projection, holding exactly the
 * files that override **won schema resolution for** — first-match-wins, so
 * views are disjoint, and `FROM authors` means "the files the author schema
 * judges".
 *
 * Shared by both projection consumers — `query` and the corpus checks
 * `validate` runs — so the two cannot drift on what a collection contains.
 *
 * Labeling, never a gate: plain reads resolve no schemas (0021's founding
 * rule), so the resolution walk below runs only when the config names at
 * least one collection, and a per-file refusal (a `$schema` the trust
 * settings reject, or one that cannot even be coerced) demotes the file to
 * "member of no view" rather than turning a working SELECT into exit 2. The
 * file's `docs` row is untouched either way.
 */
import type { DatabaseSync } from "node:sqlite";
import type { DocmetaConfig, SchemaTrustRoot } from "./config.js";
import {
  FILE_SCHEMA_KEY,
  matchesFileGlob,
  resolveSchemaSetWithSource,
} from "./resolve-schema.js";
import { quoteIdent, type ProjectionEntry } from "./projection.js";

/** One named override group, with the members resolution awarded it. */
export interface Collection {
  name: string;
  /** `_path` labels of the member files. May be empty — an empty view. */
  members: string[];
}

export interface CollectionParams {
  config: DocmetaConfig | null | undefined;
  /** `--schema` values, when the caller has them: `cli` outranks overrides. */
  cliSchemas?: string[];
  /** Directory a relative document-supplied file ref is measured from. */
  fileBase?: string;
  /** The repository boundary a document-supplied local path may not escape. */
  trustRoot?: SchemaTrustRoot;
  /**
   * Diagnostics for the user (stderr). Used for exactly one notice: a file a
   * named glob matches that is *not* in the view because its own `$schema`
   * won resolution (0027 § stress test 1) — the designed meaning, stated
   * where it happens instead of discovered later.
   */
  onNotice?: (message: string) => void;
}

/** Does this config define any collection at all? */
export function hasNamedOverrides(
  config: DocmetaConfig | null | undefined,
): boolean {
  return (config?.overrides ?? []).some((o) => o.name !== undefined);
}

/**
 * Compute every collection's member list from the loaded entries.
 *
 * Membership is the resolution winner, never a raw glob match: an overlapping
 * glob must not put one file in two collections when only one schema set
 * judges it. The resolver's own notices (e.g. the `documentRefs: none` drop)
 * are deliberately not re-voiced here — `validate` already reports them from
 * its own walk, and a read-only query should not repeat them per statement;
 * this walk speaks only for view membership.
 */
export function collectCollections(
  entries: readonly ProjectionEntry[],
  params: CollectionParams,
): Collection[] {
  const overrides = params.config?.overrides ?? [];
  const named = overrides.flatMap((o, i) =>
    o.name !== undefined ? [{ name: o.name, files: o.files, index: i }] : [],
  );
  if (named.length === 0) return [];

  const members = new Map<number, string[]>();
  for (const entry of entries) {
    let resolved;
    try {
      resolved = resolveSchemaSetWithSource({
        filePath: entry.label,
        fileSchema: entry.extracted.data[FILE_SCHEMA_KEY],
        ...(params.cliSchemas ? { cliSchemas: params.cliSchemas } : {}),
        config: params.config,
        ...(params.fileBase !== undefined ? { fileBase: params.fileBase } : {}),
        ...(params.trustRoot ? { trustRoot: params.trustRoot } : {}),
      });
    } catch {
      // A refused or malformed `$schema` demotes to "member of no view";
      // `validate` is where that refusal becomes a finding (0027 § stress
      // test 3), and a query must keep working regardless.
      continue;
    }
    if (resolved.source === "override" && resolved.overrideIndex !== undefined) {
      const list = members.get(resolved.overrideIndex);
      if (list) list.push(entry.label);
      else members.set(resolved.overrideIndex, [entry.label]);
      continue;
    }
    if (resolved.source === "document") {
      const excluded = named.find((g) => matchesFileGlob(g.files, entry.label));
      if (excluded) {
        params.onNotice?.(
          `${entry.label}: not in the "${excluded.name}" collection — its own "${FILE_SCHEMA_KEY}" won schema resolution over the override (${excluded.files}). Membership follows the schema a file is validated as; set schemaTrust.documentRefs to "none" to let the override decide.`,
        );
      }
    }
  }
  return named.map(({ name, index }) => ({
    name,
    members: members.get(index) ?? [],
  }));
}

/** One member path as a SQL string literal (doubling internal quotes). */
function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Create one view per collection on an open database that already holds the
 * `docs` table.
 *
 * Each view is built from the computed member list — literal paths, `WHERE 0`
 * for an empty group — never from a SQL translation of the config glob:
 * picomatch and SQLite `GLOB` are different languages, and membership was
 * already decided by the code that owns the decision. The IN-list scales past
 * any real corpus (0027 § stress test 4: SQLite's SQL-length ceiling is
 * ~1 GB; ten thousand long-ish paths are under a megabyte).
 *
 * Views live in `sqlite_master`, outside the two snapshots effect judgment
 * diffs (`SELECT * FROM docs`, `PRAGMA table_info(docs)`), so the effect gate
 * never sees them — and a `--db` export carries them, which is a feature.
 */
export function createCollectionViews(
  db: DatabaseSync,
  collections: readonly Collection[],
): void {
  for (const c of collections) {
    const where =
      c.members.length === 0
        ? "0"
        : `_path IN (${c.members.map(quoteSqlString).join(", ")})`;
    db.exec(
      `CREATE VIEW ${quoteIdent(c.name)} AS SELECT * FROM docs WHERE ${where}`,
    );
  }
}
