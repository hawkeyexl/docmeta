/**
 * `query` command core. Runs one SQL statement over an in-memory SQLite
 * database built per run from the metadata extracted from every input file.
 * Input handling (positional paths, globs, directories, `-` for stdin, and
 * config `paths:` fallback) mirrors `get` so the two commands behave
 * identically. Proposal 0021 is the design record.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve, extname, sep } from "node:path";
import {
  FILE_SCHEMA_KEY,
  collectSchemaPins,
  resolveElements,
  resolveSchemaSetWithSource,
} from "../core/resolve-schema.js";
import { detectJsonIndent, stripBom, toJsonText } from "../core/json-text.js";
import { integrityOf } from "../core/integrity.js";
import {
  assertNotIgnored,
  posixRelative,
  type IgnoreGuardText,
} from "./schemas.js";
import { writeFileAtomic } from "../core/write-file.js";
import { stripFrontmatter } from "../extractors/frontmatter-write.js";
import { deepEqual } from "../extractors/patch-util.js";
import {
  DocmetaError,
  type ExtractedMetadata,
  type MetadataExtractor,
  type MetadataPatch,
} from "../types.js";
import {
  extractorByName,
  extractorForExtension,
  supportedExtensions,
} from "../extractors/index.js";
import {
  assertNonEmpty,
  gitignoreOptions,
  resolveTargetSet,
  STDIN_TOKEN,
  STDIN_LABEL,
} from "../core/load-files.js";
import {
  resolveRunConfig,
  schemaTrustRoot,
  type ConfigNotice,
  type DocmetaConfig,
  type SchemaTrustRoot,
} from "../core/config.js";
import {
  RESERVED,
  SYSTEM_COLUMNS,
  assertSingleStatement,
  bindValue,
  collectNamedParameters,
  corpusDataColumns,
  createDocsTable,
  loadSqlite,
  registerLineFor,
  skipComment,
  skipStringOrIdent,
  startsComment,
  startsStringOrIdent,
  stripLeadingTrivia,
  type SqlValue,
} from "../core/projection.js";
import {
  collectCollections,
  collectionNames,
  createCollectionViews,
} from "../core/collections.js";
import type { FingerprintContext } from "../core/baseline.js";
import { stringFormatNames, validatesFormat } from "../core/validator.js";
import {
  classifyRef,
  isPublishedBuiltinUrl,
  loadSchema,
  publishedBuiltins,
} from "../core/schema-registry.js";
import { parseDocument, isMap, isSeq, isScalar } from "yaml";

export interface QueryOptions {
  /**
   * One SQL statement. The table is `docs`; see the system columns below.
   * May be empty when `db` is set — export without querying.
   */
  sql: string;
  /**
   * `--db`: also write the built database to this file, for any SQLite
   * front-end (sqlite3, Datasette, duckdb) to open afterwards. The file is a
   * regenerated artifact: an existing SQLite file at the path is overwritten,
   * anything else is refused.
   */
  db?: string;
  inputs: string[];
  as?: string;
  exclude?: string[];
  exts?: string[];
  configPath?: string;
  /** `--no-config`: skip config discovery and use the built-in defaults. */
  noConfig?: boolean;
  cwd?: string;
  /** Content for the `-` (stdin) input, injected by the CLI/tests. */
  stdinContent?: string;
  /** Permit an input set that resolves to zero files (see `assertNonEmpty`). */
  allowEmpty?: boolean;
  /**
   * `--no-gitignore` (false). Absent leaves config `respectGitignore:` in
   * charge, which itself defaults to on.
   */
  respectGitignore?: boolean;
  /** Diagnostics for the user; the CLI writes these to stderr. */
  onNotice?: (message: string) => void;
  /** Called once when a config governs the run, so the CLI can report it. */
  onConfigLoaded?: (info: ConfigNotice) => void;
  /**
   * `--offline`, accepted for surface parity with the other commands. DDL
   * statements do resolve the corpus's schema set (0024), but only from disk
   * and the bundled built-ins — a URL ref refuses with "vendor it first"
   * before anything could fetch — so there is still no network dependency to
   * suppress.
   */
  offline?: boolean;
  /**
   * `--dry-run`: preview the statement's per-file changes — the diff it
   * would make, files untouched. Without it a mutating statement applies,
   * matching `fill`'s convention (proposal 0025; 0022 recorded the original
   * preview-by-default surface this revises).
   */
  dryRun?: boolean;
  /**
   * Values for the statement's named parameters (`$name`, `:name`, `@name`),
   * keyed by bare name (a `$`/`:`/`@` prefix on a key is tolerated). Each
   * value passes through the same `bindValue` the projection loader uses —
   * booleans become 1/0, arrays and objects JSON text — so a bound parameter
   * compares against a stored cell under exactly the encoding the cell got
   * (proposal 0029). A parameter the SQL references with no entry here
   * refuses: unbound would silently bind NULL and match nothing.
   */
  params?: Record<string, unknown>;
  /**
   * `-s/--schema`, repeatable: the schema set the run's DDL evolves — CLI
   * precedence for the DDL planner *only* (proposal 0030). The per-file
   * resolution walk is skipped and the deduped refs are the set; every guard
   * inside the set (single local file for ADD, sole declarer for
   * DROP/RENAME, builtin fork, URL refusal, the trust boundary) runs
   * unchanged. Collection views keep following the config's resolution. A
   * run whose statement produces no DDL effect refuses before anything is
   * applied — a flag that would silently mean nothing must refuse.
   */
  schemas?: string[];
}

/**
 * One thing a statement changed, in file-space terms. Cell-level kinds carry
 * a `key` (a set, a deletion via `SET k = NULL` / `ALTER DROP COLUMN`, or a
 * key rename); file-level kinds carry the whole event (`cleared` — the block
 * stripped by DELETE; `created` — a file INSERT made; `renamed` — a `_path`
 * move). Exactly one kind per object.
 */
export type QueryChange = { file: string; written: boolean } & (
  | { key: string; from: unknown; to: unknown }
  | { key: string; from: unknown; deleted: true }
  | { key: string; renamedFrom: string; to: unknown }
  | { cleared: true; from: Record<string, unknown> }
  | { created: true; to: Record<string, unknown> }
  | { renamed: string }
  | {
      /** A DDL statement edited the schema itself (0024): `file` is the
       * schema written — an in-place edit, or the fork of a builtin. */
      schema: true;
      op: "add" | "drop" | "rename";
      key: string;
      renamedTo?: string;
      type?: string;
      /** 0028: a declared type equal to a format name carries the format. */
      format?: string;
      /** 0028: a `CHECK (k IN (…))` on the added column carries the enum. */
      enum?: (string | number)[];
      required?: boolean;
      forkedFrom?: string;
    }
  | {
      /** A DDL side effect on the governing config file: a fork repoints the
       * `schemas:` entry (`key: "schemas"`), an in-place edit of a pinned
       * schema refreshes its pin (`key: "integrity"`). Disclosed as a change
       * because the preview must name every file `--write` will touch. */
      config: true;
      key: string;
      from: unknown;
      to: unknown;
    }
);

export interface QueryRun {
  /** Result column names, in SELECT order — present even for zero rows. */
  columns: string[];
  rows: Record<string, unknown>[];
  /** Set when `db` was written: where, and how big the table is. */
  db?: { path: string; files: number; columns: number };
  /**
   * Present when the statement was a metadata edit: every cell it changed
   * (empty when a mutating statement matched nothing). Absent on reads.
   */
  changes?: QueryChange[];
  /**
   * Where the run stood, in the same shape `ValidateRun.frame` carries — the
   * path-normalization frame SARIF and JUnit need before they can name a file
   * the way the repository does (proposal 0026). Constructed from the run's
   * `cwd`, its config directory, and the directory file labels resolve
   * against; absent only when a caller built a `QueryRun` by hand.
   */
  frame?: FingerprintContext;
}

export async function runQuery(opts: QueryOptions): Promise<QueryRun> {
  const cwd = opts.cwd ?? process.cwd();
  const sql = opts.sql.trim();
  if (sql === "" && opts.db === undefined) {
    throw new DocmetaError("Specify SQL to run.");
  }
  if (sql !== "") assertSingleStatement(sql);

  // The false-green guard (proposal 0029): the engine throws on an extra
  // bound parameter, but a referenced parameter with nothing bound silently
  // binds NULL and matches nothing — a zero-row `--check` from a typo is a
  // passing CI gate. Refused here, before any file is read.
  const boundParams = bindParams(opts.params);
  if (sql !== "") {
    // Own keys only: `"toString" in {}` is true, so an `in` test would read
    // $toString (or $constructor, $__proto__) as bound and let it bind NULL —
    // the exact false green this guard refuses.
    const unbound = collectNamedParameters(sql).filter(
      (token) => !Object.hasOwn(boundParams, token.slice(1)),
    );
    if (unbound.length > 0) {
      const list = unbound.join(", ");
      throw new DocmetaError(
        `The statement references ${list} with nothing bound — an unbound parameter binds NULL and matches nothing. Bind ${
          unbound.length === 1 ? "it" : "each"
        } with --param ${unbound[0]?.slice(1) ?? "name"}=<value> (or \`params\` in the API).`,
      );
    }
  }

  // Explicit CLI inputs win, else config `paths:`; `base` is whichever of the
  // two directories those inputs were written relative to.
  const { config, inputs, base, configDir, configPath } = await resolveRunConfig(
    {
      cwd,
      configPath: opts.configPath,
      noConfig: opts.noConfig,
      inputs: opts.inputs,
      onConfigLoaded: opts.onConfigLoaded,
    },
  );
  const usingStdin = inputs.includes(STDIN_TOKEN);

  if (inputs.length === 0) {
    throw new DocmetaError(
      "No files to read. Pass paths/globs, or add `paths:` to docmeta.config.yaml.",
    );
  }

  const forced = opts.as ? extractorByName(opts.as) : undefined;
  if (opts.as && !forced) {
    throw new DocmetaError(
      `Unknown format "${opts.as}". Supported extensions: ${supportedExtensions().join(", ")}.`,
    );
  }

  const exts = opts.exts ?? (forced ? forced.extensions : undefined);
  const fileInputs = inputs.filter((i) => i !== STDIN_TOKEN);
  const allowEmpty = opts.allowEmpty ?? config?.allowEmpty;
  const exclude = [...(config?.exclude ?? []), ...(opts.exclude ?? [])];
  const { files, gitignoreSkipped } = await resolveTargetSet({
    inputs: fileInputs,
    exts,
    exclude,
    cwd: base,
    allowEmpty,
    ...gitignoreOptions({
      flag: opts.respectGitignore,
      configured: config?.respectGitignore,
      onNotice: opts.onNotice,
    }),
  });
  assertNonEmpty({
    files,
    inputs: fileInputs,
    usingStdin,
    allowEmpty,
    exclude,
    exts,
    gitignoreSkipped,
    action: "queried",
  });

  const entries: QueryEntry[] = [];

  const readOne = (label: string, content: string, extension: string): void => {
    const extractor = forced ?? extractorForExtension(extension);
    if (!extractor) {
      throw new DocmetaError(
        `Unsupported file type "${extension}" for "${label}". Supported: ${supportedExtensions().join(", ")}. Use --as to override.`,
      );
    }
    const extracted = extractor.extract(content, label, {
      elements: resolveElements(label, config),
    });
    entries.push({ label, extracted, extractor });
  };

  if (usingStdin) {
    if (!forced) {
      throw new DocmetaError(
        "Reading from stdin (`-`) requires --as <format> to choose an extractor.",
      );
    }
    // Unreachable while every registered extractor has at least one extension,
    // but a bare "" fallback here would surface as `Unsupported file type ""`
    // with the --as format name nowhere in it.
    const ext = forced.extensions[0];
    if (ext === undefined) {
      throw new DocmetaError(
        `Format "${forced.name}" registers no file extension to read stdin as.`,
      );
    }
    readOne(STDIN_LABEL, opts.stdinContent ?? "", ext);
  }

  for (const file of files) {
    const content = await readFile(resolve(base, file), "utf8");
    readOne(file, content, extname(file));
  }

  // The export path resolves like every positional the user typed: from
  // where they are standing, not from the config's directory.
  const db =
    opts.db === undefined
      ? undefined
      : { resolved: resolve(cwd, opts.db), display: opts.db };
  const run = await runSql(sql, entries, {
    target: db,
    params: boundParams,
    ...(opts.schemas !== undefined && opts.schemas.length > 0
      ? { cliSchemas: opts.schemas }
      : {}),
    write: !opts.dryRun,
    base,
    config,
    cwd,
    configDir,
    configPath,
    trustRoot: schemaTrustRoot(cwd, configDir),
    onNotice: opts.onNotice,
  });
  // The same frame `runValidate` returns, built from query's own run context:
  // fingerprints and canonical paths must not depend on where the command was
  // run from (proposal 0026 § stress test 6).
  return { ...run, frame: { cwd, base: configDir ?? cwd, runBase: base } };
}

interface QueryEntry {
  label: string;
  extracted: ExtractedMetadata;
  /** The extractor that read it — a write goes back through the same one. */
  extractor: MetadataExtractor;
}

/**
 * `QueryOptions.params`, normalized for the engine: bare-name keys (a
 * `$`/`:`/`@` prefix is tolerated, since `node:sqlite` binds either spelling)
 * and SQL-space values via the projection's own `bindValue`.
 */
function bindParams(
  params: Record<string, unknown> | undefined,
): Record<string, SqlValue> {
  // Null prototype, so a `__proto__` key is an ordinary own entry (it passes
  // the name grammar) instead of a prototype mutation the engine never sees.
  const out: Record<string, SqlValue> = Object.create(null) as Record<
    string,
    SqlValue
  >;
  for (const [key, value] of Object.entries(params ?? {})) {
    const name = key.startsWith("$") || key.startsWith(":") || key.startsWith("@")
      ? key.slice(1)
      : key;
    out[name] = bindValue(value);
  }
  return out;
}

interface RunContext {
  target?: { resolved: string; display: string };
  /** Named-parameter binds, bare-name keys, already through `bindValue`. */
  params: Record<string, SqlValue>;
  /** `-s` refs: the DDL planner's set, in place of the per-file walk (0030). */
  cliSchemas?: string[];
  write: boolean;
  /** Directory file labels resolve against (see `resolveRunConfig`). */
  base: string;
  config: DocmetaConfig | null;
  /** The run's working directory — schema refs resolve from here. */
  cwd: string;
  /** Directory holding the governing config file, when one exists. */
  configDir?: string;
  /** Absolute path of the governing config file, when one exists. */
  configPath?: string;
  /** The boundary a schema read or write may not escape (proposal 0015). */
  trustRoot: SchemaTrustRoot;
  /** Diagnostics for the user; the CLI writes these to stderr. */
  onNotice?: (message: string) => void;
}

/**
 * Only two byte patterns may be overwritten by `--db`: a SQLite database
 * (docmeta's own artifact, or anyone else's — both are regenerable-shaped)
 * and an empty file. Anything else at the path is somebody's data.
 */
async function prepareDbTarget(resolved: string, display: string): Promise<void> {
  let handle;
  try {
    handle = await open(resolved, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    const { bytesRead, buffer } = await handle.read(
      Buffer.alloc(16),
      0,
      16,
      0,
    );
    const magic = Buffer.from("SQLite format 3\0", "latin1");
    const isSqlite = bytesRead === 16 && buffer.equals(magic);
    if (bytesRead !== 0 && !isSqlite) {
      throw new DocmetaError(
        `"${display}" exists and is not a SQLite database; refusing to overwrite it.`,
      );
    }
  } finally {
    await handle.close();
  }
  await rm(resolved);
}

/**
 * Internal signal for the lazy view build: the statement referenced a
 * configured collection whose view is not created yet. Never escapes
 * `runSql` — its retry catch either rebuilds once or is not reached.
 */
class MissingCollectionView extends Error {}

/**
 * Wrap an engine error from the user's statement — prepare-time or
 * execution-time — into the operational refusal the CLI reports. Two cases
 * get a remedy: an INSERT/rename onto a loaded `_path` (the projection's
 * primary key catches it before any disk check can), and a write through a
 * collection view (0027) — SQLite's own refusal, completed with the
 * write-through-docs spelling. The view-name capture is non-greedy up to the
 * literal tail: a collection name may contain spaces, which \S+ would
 * truncate into a remedy naming a view that does not exist.
 */
function refuseSqlError(err: unknown): never {
  const message = (err as Error).message;
  if (message.includes("UNIQUE constraint failed: docs._path")) {
    throw new DocmetaError("That _path already exists in the corpus.");
  }
  const viewWrite = /cannot modify (.+?) because it is a view/.exec(message);
  const viewName = viewWrite?.[1];
  if (viewName !== undefined) {
    throw new DocmetaError(
      `SQL error: ${message}; a collection is read-only — write through docs: UPDATE docs … WHERE _path IN (SELECT _path FROM "${viewName.replaceAll('"', '""')}").`,
    );
  }
  throw new DocmetaError(`SQL error: ${message}`);
}

/**
 * Build the `docs` table — in memory, or at the export target — run the
 * user's statement over it (none, when only exporting), and judge what the
 * statement *did*: reads return rows; metadata edits become per-file changes,
 * previewed or (with `write`) applied through the extractors' writers.
 */
async function runSql(
  sql: string,
  entries: QueryEntry[],
  ctx: RunContext,
): Promise<QueryRun> {
  const target = ctx.target;
  // Data columns: the corpus's key union, plus a SET/INSERT target no file has
  // yet — that is how a corpus-new key is created. The scan is tolerant and
  // only ever *adds* empty columns: anything it misses fails exactly as before
  // ("no such column"), and a false positive is an all-NULL column nothing
  // diffs.
  const dataColumns = corpusDataColumns(
    entries,
    sql === ""
      ? []
      : [...collectSetTargets(sql), ...collectInsertTargets(sql)],
  );

  const { DatabaseSync } = await loadSqlite();
  if (target) {
    // SQLite creates the file but never its directories — `.docmeta/` on a
    // fresh checkout is exactly the path that does not exist yet.
    await mkdir(dirname(target.resolved), { recursive: true });
    await prepareDbTarget(target.resolved, target.display);
  }
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(target ? target.resolved : ":memory:");
  } catch (err) {
    throw new DocmetaError(
      `Cannot open "${target?.display ?? ":memory:"}": ${(err as Error).message}`,
    );
  }
  const dbInfo = target
    ? {
        path: target.display,
        files: entries.length,
        columns: SYSTEM_COLUMNS.length + dataColumns.length,
      }
    : undefined;
  try {
    createDocsTable(db, entries, dataColumns);
    // Named collections (0027): one view per named override, of the files it
    // won resolution for — built LAZILY on the normal path, because 0021's
    // founding rule is that plain reads resolve nothing: a statement that
    // never names a collection must not pay the per-file resolution walk
    // membership costs. The build happens on demand (below, when the engine
    // reports the collection's table as missing) — with one eager exception:
    // a `--db` export must carry the views (0027 § stress test 5), empty-SQL
    // export-only runs included.
    // Annotated `boolean`: assignments happen inside `buildViews`, which
    // narrowing does not track — an inferred `false` reads every later
    // `!viewsBuilt` as always-true.
    let viewsBuilt: boolean = false;
    const buildViews = (): void => {
      // Idempotent, because the eager triggers overlap: a `--db` export and
      // the catalog pre-trigger may both ask for the same build.
      if (viewsBuilt) return;
      createCollectionViews(
        db,
        collectCollections(entries, {
          config: ctx.config,
          fileBase: ctx.cwd,
          trustRoot: ctx.trustRoot,
          ...(ctx.onNotice ? { onNotice: ctx.onNotice } : {}),
        }),
      );
      viewsBuilt = true;
    };
    if (target) buildViews();
    if (sql === "") {
      return { columns: [], rows: [], ...(dbInfo ? { db: dbInfo } : {}) };
    }

    // ATTACH and VACUUM INTO write files of their own, outside the table the
    // effect gate below watches — the only statements refused by name. The
    // check runs on the first real token: `/* c */ ATTACH …` must not slip
    // past a first-character regex on the strength of a comment.
    //
    // Deliberately NOT `PRAGMA query_only`: writes to the projection are the
    // feature since 0022 (the effect gate below is the guard), and the
    // snapshot reads share this handle. The residue is confined to a `--db`
    // export — a statement may add its own tables or indexes to that file,
    // which is a regenerable artifact by declared contract.
    const head = stripLeadingTrivia(sql);
    if (/^(attach|vacuum)\b/i.test(head)) {
      throw new DocmetaError(
        `${head.split(/\s/, 1)[0]?.toUpperCase() ?? "That statement"} is refused: it can write outside the docs table.`,
      );
    }

    // Fail-safe eager build for catalog-observing statements — and any
    // statement that plausibly names a collection. A sqlite_master /
    // sqlite_schema read, a PRAGMA, and CREATE/DROP/ALTER never raise
    // `no such table` for a missing view, so the lazy retry below cannot
    // rescue them: without this they would observe a catalog with no views
    // (empty listings, table_info silence, CREATE silently shadowing a
    // collection name) where the always-eager build listed, answered, or
    // refused. The substring search deliberately OVER-triggers: a collection
    // name inside a string literal or comment costs one always-correct eager
    // build, while under-triggering is exactly this silent-miss bug class.
    // The retry stays as the backstop for the one spelling a raw-text search
    // cannot see — a name whose quoted-identifier spelling doubles a quote
    // character inside it.
    const lower = sql.toLowerCase();
    const observesCatalog =
      lower.includes("sqlite_master") ||
      lower.includes("sqlite_schema") ||
      lower.includes("pragma") ||
      /^(create|drop|alter)\b/i.test(head) ||
      collectionNames(ctx.config).some((n) => lower.includes(n.toLowerCase()));
    if (observesCatalog) buildViews();

    // 0024: `SET k = NULL` is the removal spelling, so the literal `k: null`
    // gets a function instead — `explicit_null()` returns a per-run random
    // sentinel no real content can collide with and nothing can type.
    const sentinel = `docmeta:null:${randomBytes(16).toString("hex")}`;
    db.function("explicit_null", () => sentinel);
    // 0026: the statement may name the source line a key sits on.
    registerLineFor(db, entries);

    // 0022: the statement runs freely against this disposable projection and
    // is judged by its effects, not its syntax. A read leaves no diff. The
    // column snapshot (0024) is what makes DDL an effect too.
    //
    // One closure, so the lazy view build below can re-run it intact. The
    // ordering invariant: prepare first — compiling is effect-free, so a
    // lazy-view miss on the first attempt costs one compile and never a
    // full-corpus snapshot — then the baseline snapshots, then execution:
    // the baseline must precede the statement's effects. The snapshots
    // themselves are all docs-scoped (`SELECT * FROM docs`,
    // `PRAGMA table_info(docs)`, the catalog row named `docs`) and cannot
    // see views, so a rebuild between attempts changes nothing they record.
    const runOnce = async (): Promise<QueryRun> => {
      let stmt: ReturnType<typeof db.prepare>;
      let columns: string[];
      try {
        stmt = db.prepare(sql);
        columns = stmt.columns().map((c) => c.name);
      } catch (err) {
        const message = (err as Error).message;
        // Lazy collection views: the first time a statement names a configured
        // collection, its view does not exist yet and the engine reports the
        // table as missing (case-folded — SQLite resolves table names
        // case-insensitively). Signal the build-and-retry; on the retry
        // `viewsBuilt` is true, so a second failure surfaces normally below.
        const missing = missingTableName(message);
        if (
          missing !== undefined &&
          !viewsBuilt &&
          namesConfiguredCollection(missing, ctx.config)
        ) {
          // INVARIANT: this signal may only ever be raised from this
          // prepare-time catch. `no such table` is a compile error — probed
          // unreachable from execution on node:sqlite — and a retry thrown
          // after execution began would re-run `stmt.all` and double-apply
          // whatever DML the first run already did.
          throw new MissingCollectionView();
        }
        refuseSqlError(err);
      }
      const before = snapshotRows(db);
      const colBefore = snapshotColumns(db);
      // 0028: table_info cannot see a CHECK, so the stored CREATE TABLE text is
      // snapshotted alongside the column shapes and consulted for adds only.
      const catalogBefore = snapshotCatalogSql(db);
      let rows: Record<string, unknown>[];
      try {
        // The single user-SQL call site (proposal 0029): binding here is why
        // parameters work uniformly across reads, `--check` gates, and DML.
        // Passed unconditionally — probed on node:sqlite, `all({})` behaves
        // identically to `all()` for statements with and without parameters,
        // and the unbound-reference guard already refused any statement whose
        // named parameters this object does not cover.
        // node:sqlite types rows as unknown[]; each row is a name->value record.
        rows = stmt.all(ctx.params);
      } catch (err) {
        refuseSqlError(err);
      }
      let after: Map<string, Record<string, unknown>>;
      try {
        after = snapshotRows(db);
      } catch {
        // The table itself is gone. "Delete the table definition" is the
        // accident-shaped spelling of two real statements; name them both.
        throw new DocmetaError(
          "DROP TABLE is refused. DELETE FROM docs WHERE … strips metadata from files; ALTER TABLE docs DROP COLUMN retires one key from the schema and every file.",
        );
      }
      const diff = diffProjection(before, after);
      const schemaOps = columnDiffOps(
        colBefore,
        snapshotColumns(db),
        before,
        after,
        catalogBefore,
        snapshotCatalogSql(db),
      );
      // 0030: -s speaks only to the DDL planner, and DDL is judged by its
      // effects — so "no DDL happened" is knowable only here, after
      // execution. The placement is load-bearing: the refusal must land on
      // the plan side of the all-or-nothing line, BEFORE buildChanges and
      // applyChanges, so a DML statement under -s never writes files and
      // then errors (the applies-then-refuses trap the -f csv review found).
      if (ctx.cliSchemas !== undefined && schemaOps.length === 0) {
        throw new DocmetaError(
          "-s names the schema set DDL evolves; this statement ran no DDL, so the flag would silently mean nothing — nothing was applied. Drop -s, or evolve the schema with ALTER TABLE.",
        );
      }
      // Structural, not textual: a read always yields result columns, DML and
      // DDL (without RETURNING) never do — so `WITH … UPDATE …` classifies
      // correctly even when it matches zero rows. The residual: RETURNING DML
      // that matches nothing reads as an empty result, which is what it shows.
      const mutatingIntent = columns.length === 0;
      const hasEffects =
        diff.cells.length > 0 ||
        diff.clearedRows.length > 0 ||
        diff.createdRows.size > 0 ||
        diff.renamedFiles.length > 0 ||
        schemaOps.length > 0;
      if (!hasEffects && !mutatingIntent) {
        return { columns, rows, ...(dbInfo ? { db: dbInfo } : {}) };
      }

      // DDL edits the schema itself (0024); its plan carries both the schema
      // change records and — for a builtin fork — the reference repoints.
      assertDefaultsMatchDeclaredTypes(schemaOps, diff.cells);
      const schemaPlan =
        schemaOps.length > 0
          ? await planSchemaMutation(schemaOps, entries, ctx)
          : undefined;
      const renameHints = schemaOps.flatMap((op) =>
        op.op === "rename" && op.renamedTo !== undefined
          ? [{ from: op.key, to: op.renamedTo }]
          : [],
      );
      // 0028: a BOOLEAN add's backfill writes real booleans to the files — the
      // projection's 1/0 encoding is bind-layer, not file-layer.
      const booleanAdds = new Set(
        schemaOps.flatMap((op) =>
          op.op === "add" && op.type === "boolean" ? [op.key] : [],
        ),
      );
      const changes = [
        ...(schemaPlan?.changes ?? []),
        ...buildChanges(diff, entries, sentinel, ctx, renameHints, booleanAdds),
      ];
      if (ctx.write) await applyChanges(changes, entries, ctx, schemaPlan);
      return { columns, rows, changes, ...(dbInfo ? { db: dbInfo } : {}) };
    };

    try {
      return await runOnce();
    } catch (err) {
      if (!(err instanceof MissingCollectionView)) throw err;
      // The first prepare named a collection with no view yet: build them
      // all and re-run the closure — prepare, snapshots, execution,
      // judgment. The first attempt died compiling, so nothing ran and
      // nothing was snapshotted; re-running the whole closure keeps one code
      // path with the baseline still taken before the (only) execution. A
      // write through the fresh view reaches the ordinary "cannot modify X
      // because it is a view" remedy on this retry; any other second failure
      // surfaces as usual.
      buildViews();
      return await runOnce();
    }
  } finally {
    db.close();
  }
}

/**
 * The name after `no such table: ` in an engine message — sliced rather than
 * regexed, because a collection name may legally contain a newline, which a
 * `.`-based capture cannot span.
 */
function missingTableName(message: string): string | undefined {
  const prefix = "no such table: ";
  const at = message.indexOf(prefix);
  return at === -1 ? undefined : message.slice(at + prefix.length);
}

/**
 * Does the engine's missing-table name refer to a configured collection?
 * Case-folded, because SQLite resolves table names case-insensitively (see
 * `collectionNames` for why JS's looser fold is safe here); a `main.`/`temp.`
 * qualifier the engine may echo for a qualified reference is tolerated too.
 */
function namesConfiguredCollection(
  missing: string,
  config: DocmetaConfig | null,
): boolean {
  const candidates = [missing, missing.replace(/^(main|temp)\./i, "")];
  return collectionNames(config).some((n) =>
    candidates.some((c) => c.toLowerCase() === n.toLowerCase()),
  );
}

/** The one sliver of the `node:sqlite` surface the snapshots need. */
interface Queryable {
  prepare(sql: string): { all(): unknown[] };
}

/** Every row of the projection, keyed by `_path`. */
function snapshotRows(db: Queryable): Map<string, Record<string, unknown>> {
  const rows = db.prepare("SELECT * FROM docs").all() as Record<
    string,
    unknown
  >[];
  return new Map(rows.map((r) => [String(r._path), r]));
}

/** Exported with `assertDefaultsMatchDeclaredTypes`, not via the API index. */
export interface CellEffect {
  file: string;
  key: string;
  /** SQL-space value the statement left behind. */
  to: unknown;
}

interface ProjectionDiff {
  cells: CellEffect[];
  /** Rows the statement removed — DELETE, meaning: strip the block. */
  clearedRows: string[];
  /** Rows the statement added — INSERT, meaning: create the file. */
  createdRows: Map<string, Record<string, unknown>>;
  /** Rows whose only change is `_path` — a file move. */
  renamedFiles: { from: string; to: string }[];
}

/**
 * What the statement did, judged by effects (0024). Common rows diff cell by
 * cell; a removed row is a DELETE (strip), an added row an INSERT (create),
 * and a removed/added pair identical in everything but `_path` is a rename.
 * Mixing a rename with cell edits in one statement refuses — each deserves
 * its own preview. Non-`_path` system columns stay read-only.
 */
function diffProjection(
  before: Map<string, Record<string, unknown>>,
  after: Map<string, Record<string, unknown>>,
): ProjectionDiff {
  const allRemoved = [...before.keys()].filter((p) => !after.has(p)).sort();
  const allAdded = [...after.keys()].filter((p) => !before.has(p)).sort();

  // Greedy pairing in sorted order, tracked in sets rather than spliced out
  // of the arrays — same outcome, no quadratic index churn on a bulk rename.
  const renamedFiles: { from: string; to: string }[] = [];
  const pairedFrom = new Set<string>();
  const pairedTo = new Set<string>();
  for (const from of allRemoved) {
    const was = before.get(from);
    if (!was) continue;
    const to = allAdded.find((p) => {
      if (pairedTo.has(p)) return false;
      const now = after.get(p);
      return now !== undefined && rowsEqualExceptPath(was, now);
    });
    if (to === undefined) continue;
    renamedFiles.push({ from, to });
    pairedFrom.add(from);
    pairedTo.add(to);
  }
  const removed = allRemoved.filter((p) => !pairedFrom.has(p));
  const added = allAdded.filter((p) => !pairedTo.has(p));
  if (removed.length > 0 && added.length > 0) {
    // Leftover unpaired adds and removes together can only mean a `_path`
    // change combined with cell edits — no single-statement DML produces
    // both a genuine strip and a genuine create.
    throw new DocmetaError(
      "The statement changed _path and other cells together; rename and edit separately, so each has its own preview.",
    );
  }

  const cells: CellEffect[] = [];
  for (const [path, was] of before) {
    const now = after.get(path);
    if (!now) continue; // removed — handled as a cleared row
    // The union of both sides: a column ALTER ADD introduced exists only in
    // `now`, and with a DEFAULT it backfills every row — a real change a
    // before-keys-only scan would silently miss.
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (Object.is(was[key], now[key])) continue;
      if (RESERVED.has(key)) {
        throw new DocmetaError(
          `The statement changed system column "${key}" for "${path}"; system columns are read-only.`,
        );
      }
      cells.push({ file: path, key, to: now[key] });
    }
  }
  cells.sort((a, b) =>
    a.file === b.file ? a.key.localeCompare(b.key) : a.file.localeCompare(b.file),
  );
  return {
    cells,
    clearedRows: removed,
    createdRows: new Map(
      added.map((p) => [p, after.get(p) ?? {}] as const),
    ),
    renamedFiles: renamedFiles.sort((a, b) => a.from.localeCompare(b.from)),
  };
}

/** Row equality over every column except `_path` — the rename signature. */
function rowsEqualExceptPath(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === "_path") continue;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/** Declared shape of one projection column, from `PRAGMA table_info`. */
function snapshotColumns(
  db: Queryable,
): Map<string, { type: string; notnull: number }> {
  const rows = db.prepare("PRAGMA table_info(docs)").all() as {
    name: string;
    type: string;
    notnull: number;
  }[];
  // The cast trusts node:sqlite's documented row shape; this catches the day
  // a Node release renames a pragma column, instead of mistyping silently.
  if (rows.length > 0 && typeof rows[0]?.name !== "string") {
    throw new DocmetaError(
      "PRAGMA table_info returned an unexpected row shape; this node:sqlite build is not one docmeta understands.",
    );
  }
  return new Map(rows.map((r) => [r.name, { type: r.type, notnull: r.notnull }]));
}

/** Exported with `assertDefaultsMatchDeclaredTypes`, not via the API index. */
export interface SchemaOp {
  op: "add" | "drop" | "rename";
  key: string;
  renamedTo?: string;
  type?: string;
  /** 0028: the format a declared type equal to a format name carries. */
  format?: string;
  /** 0028: the members of a `CHECK (k IN (…))` on the added column. */
  enum?: (string | number)[];
  required?: boolean;
}

/** The stored `CREATE TABLE docs` text — the only place a CHECK lives. */
function snapshotCatalogSql(db: Queryable): string {
  const rows = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'docs'",
    )
    .all() as { sql: unknown }[];
  const sql = rows[0]?.sql;
  return typeof sql === "string" ? sql : "";
}

/**
 * DDL, read as an effect: the column set changed. A removed/added pair whose
 * per-row values are identical is a column rename; the rest are drops and
 * adds, an add carrying its declared type and NOT NULL as schema intent.
 *
 * The catalog text (0028) is consulted **only for adds** — `ADD COLUMN`
 * appends the column def verbatim to docmeta-authored CREATE TABLE text, so
 * the suffix delta is extractable without parsing the user's statement. DROP
 * and RENAME rewrite the stored text mid-string and never consult it.
 */
function columnDiffOps(
  before: Map<string, { type: string; notnull: number }>,
  after: Map<string, { type: string; notnull: number }>,
  rowsBefore: Map<string, Record<string, unknown>>,
  rowsAfter: Map<string, Record<string, unknown>>,
  catalogBefore: string,
  catalogAfter: string,
): SchemaOp[] {
  const removed = [...before.keys()].filter((c) => !after.has(c));
  const added = [...after.keys()].filter((c) => !before.has(c));
  const ops: SchemaOp[] = [];
  // Same set-tracked pairing as diffProjection's file renames — one idiom for
  // both rename detectors, though DDL grammar bounds these arrays at one.
  const pairedFrom = new Set<string>();
  const pairedTo = new Set<string>();
  for (const from of removed) {
    // The size guard keeps an empty corpus from vacuously pairing every drop
    // with every add — unreachable through one ALTER today, stated anyway.
    const to = added.find(
      (a) =>
        !pairedTo.has(a) &&
        rowsBefore.size > 0 &&
        [...rowsBefore.keys()].every((path) =>
          Object.is(rowsBefore.get(path)?.[from], rowsAfter.get(path)?.[a]),
        ),
    );
    if (!to) continue;
    ops.push({ op: "rename", key: from, renamedTo: to });
    pairedFrom.add(from);
    pairedTo.add(to);
  }
  for (const key of removed.filter((k) => !pairedFrom.has(k))) {
    ops.push({ op: "drop", key });
  }
  for (const key of added.filter((k) => !pairedTo.has(k))) {
    const decl = after.get(key);
    const mapped = mapDeclaredType(decl?.type ?? "");
    const members = enumForAddedColumn(catalogBefore, catalogAfter, key, mapped);
    ops.push({
      op: "add",
      key,
      ...(mapped?.type !== undefined ? { type: mapped.type } : {}),
      ...(mapped?.format !== undefined ? { format: mapped.format } : {}),
      ...(members !== undefined ? { enum: members } : {}),
      required: decl?.notnull === 1,
    });
  }
  return ops;
}

/** What a declared column type means for the schema property it will build. */
interface DeclaredMapping {
  type: string;
  format?: string;
}

/**
 * SQLite declared type → JSON Schema mapping. 0024 stopped at SQLite's own
 * affinity rules; 0028 puts the format match **before** them — ordering is
 * load-bearing, or `/INT/` eats `json-POINTER` (0028 § stress test 3):
 *
 * 1. a type case-insensitively equal to a format name the validator enforces
 *    (derived from the ajv-formats registration, so upgrades arrive free)
 *    maps to `{type: "string", format: <name>}`;
 * 2. the closed alias pair `DATETIME`/`TIMESTAMP` → `format: date-time`;
 * 3. `BOOLEAN`/`BOOL` → `{type: "boolean"}`;
 * 4. the affinity regexes, exactly as before.
 */
function mapDeclaredType(declared: string): DeclaredMapping | undefined {
  const lower = declared.toLowerCase();
  if (stringFormatNames().has(lower)) return { type: "string", format: lower };
  if (lower === "datetime" || lower === "timestamp") {
    return { type: "string", format: "date-time" };
  }
  if (lower === "boolean" || lower === "bool") return { type: "boolean" };
  if (/INT/i.test(declared)) return { type: "integer" };
  if (/CHAR|CLOB|TEXT/i.test(declared)) return { type: "string" };
  if (/REAL|FLOA|DOUB|NUMERIC|DEC/i.test(declared)) return { type: "number" };
  return undefined;
}

/**
 * The column definition `ADD COLUMN` appended to the stored CREATE TABLE
 * text: the after-text is the before-text with `, <def>` inserted before the
 * final `)` (verified against the engine — 0028 § stress test 2). Undefined
 * when the delta is not that shape.
 */
function appendedColumnDef(before: string, after: string): string | undefined {
  const cut = before.lastIndexOf(")");
  if (cut === -1 || cut !== before.length - 1 || !after.endsWith(")")) {
    return undefined;
  }
  const prefix = before.slice(0, cut);
  if (!after.startsWith(prefix)) return undefined;
  const appended = after.slice(prefix.length, -1);
  const comma = /^\s*,\s*/.exec(appended);
  return comma ? appended.slice(comma[0].length) : undefined;
}

/** Index of the first non-whitespace character of `text` at or after `from`. */
function skipWs(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  return i;
}

/**
 * Index of a `CHECK` keyword at or after `from`, outside quoted regions and
 * comments. The comment branch matters because SQLite stores an ADD COLUMN's
 * definition verbatim, comments included — a CHECK spelled inside one must
 * not satisfy the count guard or trip the one-shape refusal.
 */
function indexOfCheck(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (startsStringOrIdent(text, i)) {
      i = skipStringOrIdent(text, i);
    } else if (startsComment(text, i)) {
      i = skipComment(text, i);
    } else if (ch !== undefined && /[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      const word = m?.[0] ?? "";
      if (word.toUpperCase() === "CHECK") return i;
      i += Math.max(word.length, 1);
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Index just past `(…)` starting at `open` — paren-aware, and skipping every
 * string/identifier form, brackets included: `[a)b]` is a legal identifier
 * whose `)` must not close the group early. Comments too: a paren inside a
 * block or line comment must not move the depth. (The enum member grammar's
 * own whitespace walks stay strict on purpose — a comment between literals
 * refuses loudly per the one-shape contract, which is the designed outcome,
 * not a miscount.)
 */
function matchingParenEnd(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (startsStringOrIdent(text, i)) {
      i = skipStringOrIdent(text, i);
      continue;
    }
    if (startsComment(text, i)) {
      i = skipComment(text, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * `enum` members for an added column, read from the catalog delta — the
 * second recorded consultation of syntax (after ATTACH/VACUUM's
 * refusal-by-name), scoped to stay small (0028 § stress test 2). The grammar
 * accepted is exactly one shape: `CHECK (<the-new-column> IN (<literals>))`
 * with the literals all strings or all numbers, agreeing with the declared
 * type. Everything else refuses, naming the shape and the hand-edit
 * alternative — a constraint silently dropped from the schema would be worse
 * than either.
 */
function enumForAddedColumn(
  catalogBefore: string,
  catalogAfter: string,
  key: string,
  mapped: DeclaredMapping | undefined,
): (string | number)[] | undefined {
  // The variable annotation (not just the return position) is what lets
  // control-flow analysis treat a `refuseShape()` call as terminating.
  const refuseShape: () => never = () => {
    throw new DocmetaError(
      `The CHECK on "${key}" is not the one shape DDL maps: \`CHECK (${key} IN (…))\` with all-string or all-number literals becomes \`enum\`. Anything else — an expression, another column, AND — is a hand edit to the schema file.`,
    );
  };
  const def = appendedColumnDef(catalogBefore, catalogAfter);
  if (def === undefined) {
    // Unreachable through ALTER ADD against docmeta-authored text today;
    // stated anyway so an engine that rewrites the catalog differently
    // refuses loudly instead of silently dropping a CHECK the user wrote.
    const count = (text: string): number => {
      let n = 0;
      for (let i = indexOfCheck(text, 0); i !== -1; i = indexOfCheck(text, i + 5)) {
        n++;
      }
      return n;
    };
    if (count(catalogAfter) > count(catalogBefore)) refuseShape();
    return undefined;
  }
  const checkAt = indexOfCheck(def, 0);
  if (checkAt === -1) return undefined;

  const i = skipWs(def, checkAt + "CHECK".length);
  if (def[i] !== "(") refuseShape();
  const end = matchingParenEnd(def, i);
  if (end === -1) refuseShape();
  // A second CHECK anywhere in the def is not the supported shape.
  if (indexOfCheck(def, end) !== -1) refuseShape();
  const inner = def.slice(i + 1, end - 1);

  // `<the-new-column> IN ( <literals> )`, and nothing else.
  let j = skipWs(inner, 0);
  const col = readIdentifier(inner, j);
  if (!col || col.value.toLowerCase() !== key.toLowerCase()) refuseShape();
  j = skipWs(inner, col.end);
  const kw = /^[A-Za-z]+/.exec(inner.slice(j));
  if (kw?.[0]?.toUpperCase() !== "IN") refuseShape();
  j = skipWs(inner, j + 2);
  if (inner[j] !== "(") refuseShape();
  const listEnd = matchingParenEnd(inner, j);
  if (listEnd === -1 || skipWs(inner, listEnd) !== inner.length) refuseShape();
  const list = inner.slice(j + 1, listEnd - 1);

  const members: (string | number)[] = [];
  let sawString = false;
  let sawNumber = false;
  let k = skipWs(list, 0);
  for (;;) {
    if (list[k] === "'") {
      const close = skipStringOrIdent(list, k);
      if (list[close - 1] !== "'" || close <= k + 1) refuseShape();
      members.push(list.slice(k + 1, close - 1).replaceAll("''", "'"));
      sawString = true;
      k = close;
    } else {
      const m = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(
        list.slice(k),
      );
      if (!m) refuseShape();
      members.push(Number(m[0]));
      sawNumber = true;
      k += m[0].length;
    }
    k = skipWs(list, k);
    if (k >= list.length) break;
    if (list[k] !== ",") refuseShape();
    k = skipWs(list, k + 1);
  }
  if (members.length === 0) refuseShape();
  if (sawString && sawNumber) {
    // Homogeneity is part of the grammar, not a rule invented later.
    throw new DocmetaError(
      `The CHECK on "${key}" mixes string and number literals; an IN list maps to \`enum\` only as all strings or all numbers.`,
    );
  }
  if (mapped !== undefined) {
    const disagree = sawString
      ? mapped.type !== "string"
      : mapped.type === "integer"
        ? members.some((v) => typeof v === "number" && !Number.isInteger(v))
        : mapped.type !== "number";
    if (disagree) {
      throw new DocmetaError(
        `The CHECK on "${key}" lists ${sawString ? "string" : "number"} literals, but the declared type maps to ${mapped.type} — the members' JSON types must agree with the declared type, the same reconciliation the DEFAULT guard applies.`,
      );
    }
  }
  return members;
}

/**
 * The declared type and the DEFAULT are two halves of one statement, and
 * SQLite will happily store a default its own declaration cannot hold
 * (`INTEGER … DEFAULT 'high'` stores TEXT). Left unchecked, that writes a
 * schema requiring a type every backfilled file immediately violates — the
 * exact inverse of the ratchet staying green. Refused before any plan exists.
 *
 * Exported for the guard's own tests: `mapDeclaredType` always pairs a
 * format with a type today, but `SchemaOp` declares them independent, and
 * the format check below must hold for a format-only op too.
 */
export function assertDefaultsMatchDeclaredTypes(
  ops: SchemaOp[],
  cells: CellEffect[],
): void {
  // JSON.stringify throws on bigint — a refusal must never crash while
  // trying to describe the value it is refusing.
  const show = (v: unknown): string =>
    typeof v === "bigint" ? `${String(v)}n` : (toJsonText(v) ?? "undefined");
  for (const op of ops) {
    // Adds only — and NOT gated on a declared type: an op with no mapped
    // type has nothing for the `ok` chain below to refuse (it falls through
    // to true), while the format check must still run.
    if (op.op !== "add") continue;
    for (const cell of cells) {
      if (cell.key !== op.key || cell.to === null || cell.to === undefined) {
        continue;
      }
      const to = cell.to;
      const ok =
        op.type === "integer"
          ? typeof to === "bigint" ||
            (typeof to === "number" && Number.isInteger(to))
          : op.type === "number"
            ? typeof to === "number" || typeof to === "bigint"
            : op.type === "string"
              ? typeof to === "string"
              : op.type === "boolean"
                ? // The reconciliation accepts only the SQL spellings 0, 1,
                  // true, false — all of which the engine stores as 0/1.
                  to === 0 || to === 1 || to === 0n || to === 1n
                : true;
      if (!ok) {
        throw new DocmetaError(
          op.type === "boolean"
            ? `ALTER declares "${op.key}" as boolean, but the DEFAULT backfills ${show(to)} — only 0, 1, true, or false reconcile with a boolean column.`
            : // `!ok` is unreachable with no declared type (the chain falls
              // through to true), so the fallback text never actually prints.
              `ALTER declares "${op.key}" as ${op.type ?? "its declared type"}, but the DEFAULT backfills ${show(to)} — the corpus would fail the schema it just gained. Match the DEFAULT to the declared type.`,
        );
      }
      // 0028 stress 4: `DATE DEFAULT 'yesterday'` sails through the engine
      // and through the broad-type check above; the format is validated with
      // the same ajv-formats machinery `validate` enforces it with, before
      // any plan exists. (Enums need no twin: SQLite itself refuses an ADD
      // whose DEFAULT violates its own CHECK.)
      if (
        op.format !== undefined &&
        typeof to === "string" &&
        !validatesFormat(op.format, to)
      ) {
        throw new DocmetaError(
          `ALTER declares "${op.key}" as format ${op.format}, but the DEFAULT backfills ${show(to)} — the corpus would fail the schema it just gained. Match the DEFAULT to the format.`,
        );
      }
    }
  }
}

interface SchemaWrite {
  path: string;
  content: string;
  /**
   * Bytes the plan read from this path; apply refuses if they moved since —
   * the same contract corpus files get. Absent means the plan requires the
   * path to not exist (a fork target).
   */
  expected?: string;
}

interface SchemaPlan {
  changes: QueryChange[];
  writes: SchemaWrite[];
  /**
   * ADD writes the schema after the corpus, so a mid-apply failure leaves
   * extra keys under an unchanged schema (still green) instead of a new
   * requirement without its backfill (red). DROP/RENAME write schema-first
   * for the mirror-image reason: files keep a key the schema merely no longer
   * declares.
   */
  schemaLast: boolean;
}

/** One schema of the resolved set, loaded exactly once. */
type SetMember =
  | {
      /** The ref exactly as the set spells it — what repoints must match. */
      ref: string;
      kind: "file";
      /** Resolved from the run's cwd, the same base `loadSchema` uses. */
      abs: string;
      /** The exact text read, for indent/EOL fidelity and pin hashing. */
      text: string;
      schema: Record<string, unknown>;
    }
  | {
      ref: string;
      kind: "builtin";
      /** The bundled id — the ref itself, or a published URL's alias. */
      builtinId: string;
      schema: Record<string, unknown>;
    };

/** `properties`, when it is the object the mutation machinery can touch. */
function propsOf(
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const p = schema.properties;
  return p !== null && typeof p === "object" && !Array.isArray(p)
    ? (p as Record<string, unknown>)
    : undefined;
}

/** Does this schema constrain `key` — by declaring it, or by requiring it? */
function constrains(member: SetMember, key: string): boolean {
  const props = propsOf(member.schema);
  if (props && key in props) return true;
  const required = member.schema.required;
  return Array.isArray(required) && required.some((r) => r === key);
}

const FORK_IGNORE_TEXT: IgnoreGuardText = {
  refusal: (target) =>
    `Refusing to fork into "${target}": git reports it as ignored. The forked schema must be committed — an ignored copy validates on this machine and is simply missing in CI, where the failure reads as a schema nobody changed. Drop the .gitignore rule covering this path, or evolve a tracked local schema instead.`,
  unchecked: (where) =>
    `could not check .gitignore for "${where}" (no repository here, or no git on PATH). The forked schema must be committed — make sure this path is tracked.`,
};

/** Preserve the reference text's line endings in a freshly serialized body. */
function matchEol(reference: string, text: string): string {
  return reference.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
}

/** A path the way reports spell it: relative to the run's base, posix. */
function displayPath(ctx: RunContext, abs: string): string {
  const rel = posixRelative(ctx.base, abs);
  return rel === "" || rel.startsWith("..") ? abs : rel;
}

/** Refuse a schema write outside the boundary every schema *read* honors. */
function assertSchemaWriteWithin(ctx: RunContext, abs: string): void {
  const within = posixRelative(ctx.trustRoot.dir, abs);
  if (within !== "" && !within.startsWith("..") && !isAbsolute(within)) return;
  throw new DocmetaError(
    `The resolved schema "${abs}" lives outside ${ctx.trustRoot.dir}; DDL edits schemas inside the repository. Evolve it where it lives, or vendor a copy in.`,
  );
}

/**
 * Load every schema in the set, through the same conventions the rest of the
 * pipeline reads them with: refs resolve from the run's cwd (the
 * `LoadSchemaOptions.fileBase` contract), text is BOM-stripped before parsing
 * only, integrity pins are verified against the exact bytes, and a published
 * built-in URL is the built-in it aliases. Any plain URL refuses: DDL cannot
 * inspect (let alone edit) a schema a server owns, and sibling-conflict
 * checks below need to see the whole set.
 */
async function loadSetMembers(
  refs: readonly string[],
  ctx: RunContext,
): Promise<SetMember[]> {
  const pins = collectSchemaPins(ctx.config);
  const members: SetMember[] = [];
  for (const ref of refs) {
    const { kind } = classifyRef(ref);
    if (kind === "url" && !isPublishedBuiltinUrl(ref)) {
      throw new DocmetaError(
        `"${ref}" in the resolved schema set is a URL — DDL edits local schemas only. Vendor it first (docmeta schemas vendor), then evolve the local copy.`,
      );
    }
    if (kind === "builtin" || kind === "url") {
      const builtinId =
        kind === "url"
          ? (publishedBuiltins().find((b) => b.url === ref)?.id ?? ref)
          : ref;
      members.push({
        ref,
        kind: "builtin",
        builtinId,
        schema: await loadSchema(builtinId),
      });
      continue;
    }
    const abs = resolve(ctx.cwd, ref);
    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      throw new DocmetaError(
        `Schema file not found: "${ref}" (looked at ${abs}).`,
      );
    }
    const pin = pins.get(ref);
    if (pin?.integrity !== undefined) {
      if (integrityOf(Buffer.from(text, "utf8")) !== pin.integrity) {
        throw new DocmetaError(
          `Schema "${ref}" does not match its recorded integrity; its contents have moved since it was vendored. Re-vendor it before evolving it.`,
        );
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(text));
    } catch {
      throw new DocmetaError(
        `Schema "${ref}" is not valid JSON, so DDL cannot read it. Fix the file first.`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DocmetaError(
        `Schema "${ref}" is not an object schema; DDL edits \`properties\` and \`required\`, which only an object schema carries.`,
      );
    }
    members.push({
      ref,
      kind: "file",
      abs,
      text,
      schema: parsed as Record<string, unknown>,
    });
  }
  return members;
}

/**
 * 0024's DDL pipeline: resolve the run's single schema set, pick the target,
 * and plan the mutation — an in-place edit for a hand-maintained local file,
 * a fork (plus reference repoints) for an immutable builtin. Every refusal
 * here costs nothing: no file has been touched.
 */
async function planSchemaMutation(
  ops: SchemaOp[],
  entries: QueryEntry[],
  ctx: RunContext,
): Promise<SchemaPlan> {
  // One action per statement is SQLite's own ALTER grammar; a second op here
  // would mean the effect diff misread the projection.
  const [op, ...extraOps] = ops;
  if (!op) return { changes: [], writes: [], schemaLast: false };
  if (extraOps.length > 0) {
    throw new DocmetaError(
      "One DDL action per statement; this statement produced several column effects, which DDL cannot attribute to one schema edit.",
    );
  }
  if (entries.length === 0) {
    throw new DocmetaError(
      "DDL needs at least one loaded file: the schema it edits is the one the corpus resolves, and this run matched no files.",
    );
  }

  // One schema set for the whole run, or nothing mutates. Resolution runs
  // with the same trust boundary as validate — a document may not name a
  // schema outside the repository, least of all as a write target.
  //
  // 0030: -s replaces the walk outright — the deduped CLI refs ARE the set
  // (source "cli"), unanimous by construction, so neither the split refusal
  // nor the default-set refusal below can arise. Everything after the set is
  // chosen — member loading, trust, every ownership guard — is one shared
  // path: -s picks the contract, never what the contract says.
  let refs: string[] | undefined;
  const sources = new Set<string>();
  const groupIndexes = new Set<number>();
  let splitLabel: string | undefined;
  if (ctx.cliSchemas !== undefined && ctx.cliSchemas.length > 0) {
    refs = [...new Set(ctx.cliSchemas)];
    sources.add("cli");
  } else {
    for (const e of entries) {
      let resolved;
      try {
        resolved = resolveSchemaSetWithSource({
          filePath: e.label,
          fileSchema: e.extracted.data[FILE_SCHEMA_KEY],
          config: ctx.config,
          fileBase: ctx.cwd,
          trustRoot: ctx.trustRoot,
          onNotice: ctx.onNotice,
        });
      } catch (err) {
        // `coerceFileSchema` throws a plain Error; either way the file that
        // carried the bad `$schema` is the one fact the user needs.
        throw new DocmetaError(`"${e.label}": ${(err as Error).message}`);
      }
      sources.add(resolved.source);
      if (resolved.overrideIndex !== undefined) {
        groupIndexes.add(resolved.overrideIndex);
      }
      if (refs === undefined) {
        refs = resolved.schemas;
      } else if (
        // Order-insensitive, like seqResolvesToRunSet below: a document that
        // lists the same refs in another order names the same contract.
        splitLabel === undefined &&
        JSON.stringify([...refs].sort()) !==
          JSON.stringify([...resolved.schemas].sort())
      ) {
        // The walk finishes before refusing, so the refusal can name every
        // override group the run spans, not only the first two it met.
        splitLabel = e.label;
      }
    }
  }
  if (splitLabel !== undefined) {
    // With named override groups (0027) the remedy is finally spellable:
    // list each group by name with its glob, so "one group's files" is a
    // copy-pastable next step rather than a concept.
    const overrides = ctx.config?.overrides ?? [];
    const named = [...groupIndexes]
      .sort((a, b) => a - b)
      .flatMap((i) => {
        const o = overrides[i];
        return o?.name !== undefined ? [`${o.name} (${o.files})`] : [];
      });
    const last = named[named.length - 1];
    // 0030: -s makes the set unanimous by construction, so it is the third
    // remedy — the direct one — in both spellings of this refusal.
    const remedy =
      named.length >= 2 && last !== undefined
        ? `The run spans ${[named.slice(0, -1).join(", "), last].join(" and ")}; re-run over one group's files, or pass -s <schema> to name the contract directly.`
        : "Scope the run to one override group, or pass -s <schema> to name the contract directly.";
    throw new DocmetaError(
      `DDL needs the corpus to resolve to one schema set, and this run's is split ("${splitLabel}" resolves differently). ${remedy}`,
    );
  }
  if (!refs || sources.has("default")) {
    throw new DocmetaError(
      "DDL edits the resolved schema, and this corpus runs on the built-in default set. Name a schema to evolve — in the config's `schemas:`, an override group, or the files' own `$schema`. For data-only edits the UPDATE spellings cover every case: `SET k = v` (backfill via `WHERE k IS NULL`), `SET k = NULL` to remove a key, and paired SETs to rename one.",
    );
  }

  const members = await loadSetMembers(refs, ctx);
  const fileMembers = members.flatMap((m) => (m.kind === "file" ? [m] : []));
  const builtinMembers = members.flatMap((m) =>
    m.kind === "builtin" ? [m] : [],
  );

  // The target: for ADD the single local file (else the builtin, forked); for
  // DROP/RENAME the one schema that constrains the key. "One" is load-bearing
  // both ways — a second declarer, or a sibling that still requires a dropped
  // key, would leave the corpus failing a schema this statement never named.
  let target: SetMember;
  if (op.op === "add") {
    if (fileMembers.length > 1) {
      throw new DocmetaError(
        `The resolved set names ${String(fileMembers.length)} local schema files (${fileMembers.map((m) => m.ref).join(", ")}) — DDL cannot tell which one to evolve. Scope the run to an override group that names one, set the files' \`$schema\` to the schema to evolve, or pass -s <schema> to name it directly.`,
      );
    }
    const chosen = fileMembers[0] ?? builtinMembers[0];
    if (!chosen) {
      throw new DocmetaError(
        `No local schema or built-in in the resolved set takes this DDL.`,
      );
    }
    target = chosen;
    const targetProps = propsOf(target.schema);
    if (target.schema.properties !== undefined && targetProps === undefined) {
      throw new DocmetaError(
        `Schema "${target.ref}": its "properties" is not an object, so DDL cannot edit it.`,
      );
    }
    if (targetProps && op.key in targetProps) {
      throw new DocmetaError(
        `"${op.key}" is already declared in ${target.ref}; ALTER ADD would overwrite its subschema, constraints included. Edit the schema file directly to change an existing property.`,
      );
    }
    for (const m of members) {
      if (m !== target && constrains(m, op.key)) {
        throw new DocmetaError(
          `"${op.key}" is already declared by ${m.ref} in the same schema set; adding it to ${target.ref} would put two contracts on one key. Evolve ${m.ref} instead, or scope the run to a set with one owner of the key.`,
        );
      }
    }
  } else {
    // Destructuring narrows without a third guard: `sole` absent IS the
    // zero-declarers case, and `rest` non-empty is the shared-key refusal.
    const [sole, ...rest] = members.filter((m) => constrains(m, op.key));
    if (!sole) {
      throw new DocmetaError(
        `No schema in the resolved set declares "${op.key}".`,
      );
    }
    if (rest.length > 0) {
      throw new DocmetaError(
        `"${op.key}" is constrained by ${String(rest.length + 1)} schemas in the set (${[sole, ...rest].map((m) => m.ref).join(", ")}); a DDL statement edits one schema. Evolve them separately.`,
      );
    }
    target = sole;
    if (op.op === "rename") {
      const to = op.renamedTo ?? op.key;
      for (const m of members) {
        if (constrains(m, to)) {
          throw new DocmetaError(
            `"${to}" is already declared${m === target ? "" : ` by ${m.ref}`} in the schema set; renaming "${op.key}" onto it would overwrite that declaration. Pick another name, or evolve that schema first.`,
          );
        }
      }
    }
  }

  const writes: SchemaWrite[] = [];
  const changes: QueryChange[] = [];
  const configEdit: ConfigEditRequest = {};

  let baseObject: Record<string, unknown>;
  let schemaAbs: string;
  /** Indent and EOL come from the file being edited; a fork starts fresh. */
  let styleReference: string;
  let schemaExpected: string | undefined;
  let forkedFrom: string | undefined;
  if (target.kind === "file") {
    schemaAbs = target.abs;
    baseObject = target.schema;
    styleReference = target.text;
    schemaExpected = target.text;
    assertSchemaWriteWithin(ctx, schemaAbs);
  } else {
    // A builtin is immutable by invariant — fork it beside the config and
    // repoint every reference: the config entry, and any in-file `$schema`.
    forkedFrom = target.builtinId;
    const [, name, ver] = target.builtinId.split(":");
    // Segments reach the filesystem; every shipped id is [a-z0-9._-] but the
    // filename must not trust that a future one stays so.
    const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "-");
    const forkName = `${safe(name ?? "schema")}-${safe(ver ?? "0")}.local.json`;
    schemaAbs = resolve(ctx.configDir ?? ctx.cwd, "schemas", forkName);
    assertSchemaWriteWithin(ctx, schemaAbs);
    if (existsSync(schemaAbs)) {
      throw new DocmetaError(
        `"${displayPath(ctx, schemaAbs)}" already exists; refusing to overwrite it with a fork of ${target.builtinId}.`,
      );
    }
    await assertNotIgnored(
      schemaAbs,
      dirname(schemaAbs),
      ctx.cwd,
      ctx.onNotice,
      FORK_IGNORE_TEXT,
    );
    baseObject = { ...target.schema, $id: `${target.builtinId}+local` };
    styleReference = "\n";
    if (ctx.configPath !== undefined && ctx.configDir !== undefined) {
      const rel = posixRelative(ctx.configDir, schemaAbs);
      configEdit.repoint = {
        oldRef: target.ref,
        newRef: rel.startsWith(".") ? rel : `./${rel}`,
      };
    }
    const docRel = posixRelative(ctx.cwd, schemaAbs);
    const newRefForDocs = docRel.startsWith(".") ? docRel : `./${docRel}`;
    for (const e of entries) {
      const fileSchema = e.extracted.data[FILE_SCHEMA_KEY];
      if (fileSchema === target.ref) {
        changes.push({
          file: e.label,
          key: FILE_SCHEMA_KEY,
          from: fileSchema,
          to: newRefForDocs,
          written: false,
        });
      } else if (Array.isArray(fileSchema)) {
        // The documented list spelling repoints element-wise; the rest of
        // the list is not this statement's business.
        const list = fileSchema.filter(
          (r): r is string => typeof r === "string",
        );
        if (
          list.length === fileSchema.length &&
          list.includes(target.ref)
        ) {
          changes.push({
            file: e.label,
            key: FILE_SCHEMA_KEY,
            from: fileSchema,
            to: list.map((r) => (r === target.ref ? newRefForDocs : r)),
            written: false,
          });
        }
      }
    }
  }

  // BOM-strip before sniffing: the regex anchors at the string head, and a
  // BOM'd file would silently fall back to two-space and be reformatted.
  const indent = detectJsonIndent(stripBom(styleReference));
  const mutated = mutateSchemaObject(baseObject, op);
  const content = matchEol(
    styleReference,
    `${JSON.stringify(mutated, null, indent)}\n`,
  );
  changes.unshift({
    file: displayPath(ctx, schemaAbs),
    schema: true,
    op: op.op,
    key: op.key,
    ...(op.renamedTo !== undefined ? { renamedTo: op.renamedTo } : {}),
    ...(op.type !== undefined ? { type: op.type } : {}),
    ...(op.format !== undefined ? { format: op.format } : {}),
    ...(op.enum !== undefined ? { enum: op.enum } : {}),
    ...(op.required ? { required: true } : {}),
    ...(forkedFrom !== undefined ? { forkedFrom } : {}),
    written: false,
  });
  writes.push({
    path: schemaAbs,
    content,
    ...(schemaExpected !== undefined ? { expected: schemaExpected } : {}),
  });

  // An in-place edit of a pinned schema carries its pin along: the pin is a
  // promise about the bytes, and the bytes just changed on purpose.
  if (target.kind === "file") {
    const pin = collectSchemaPins(ctx.config).get(target.ref);
    if (pin?.integrity !== undefined) {
      configEdit.integrity = {
        ref: target.ref,
        value: integrityOf(Buffer.from(content, "utf8")),
      };
    }
  }

  if (configEdit.repoint || configEdit.integrity) {
    const edited = await planConfigEdit(ctx, configEdit, refs);
    changes.push(...edited.changes);
    if (edited.write) writes.push(edited.write);
    if (
      configEdit.repoint &&
      !edited.repointed &&
      (sources.has("config") || sources.has("override"))
    ) {
      throw new DocmetaError(
        `The run resolved ${configEdit.repoint.oldRef} through the config, but no \`schemas:\` entry in it matches — refusing to fork with a reference that cannot be repointed.`,
      );
    }
  }

  return { changes, writes, schemaLast: op.op === "add" };
}

/** Apply one DDL op to a schema object, touching properties/required only. */
function mutateSchemaObject(
  schema: Record<string, unknown>,
  op: SchemaOp,
): Record<string, unknown> {
  const without = (
    obj: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> =>
    Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
  let props = { ...(propsOf(schema) ?? {}) };
  // Spec-invalid non-string entries are dropped rather than carried: every
  // comparison below is against a string key, so they could only persist as
  // junk this rewrite pretended not to see.
  let required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter(
        (r): r is string => typeof r === "string",
      )
    : [];
  switch (op.op) {
    case "add":
      props[op.key] = {
        ...(op.type !== undefined ? { type: op.type } : {}),
        ...(op.format !== undefined ? { format: op.format } : {}),
        ...(op.enum !== undefined ? { enum: op.enum } : {}),
      };
      if (op.required && !required.includes(op.key)) required.push(op.key);
      break;
    case "drop":
      props = without(props, op.key);
      required = required.filter((r) => r !== op.key);
      break;
    case "rename": {
      const to = op.renamedTo ?? op.key;
      const moved = props[op.key];
      props = without(props, op.key);
      // A required-only key (no `properties` entry — legal, if odd) renames
      // to a required-only key: the guard keeps the faithful shape rather
      // than fabricating an empty subschema the author never declared.
      if (moved !== undefined) props[to] = moved;
      required = required.map((r) => (r === op.key ? to : r));
      break;
    }
  }
  // Set-or-remove explicitly: a spread of the original schema would carry the
  // old `required` back in whenever the new list is empty.
  const out: Record<string, unknown> = { ...schema, properties: props };
  if (required.length > 0) out.required = required;
  else delete out.required;
  return out;
}

interface ConfigEditRequest {
  /** A builtin fork: point the entry that named the builtin at the fork. */
  repoint?: { oldRef: string; newRef: string };
  /** An in-place edit of a pinned schema: the pin over the new bytes. */
  integrity?: { ref: string; value: string };
}

/**
 * Plan an edit to the governing config — the file discovery actually loaded,
 * at `ctx.configPath` — through the YAML Document API, so every comment and
 * untouched line survives. Both spellings of a `schemas:` entry are handled:
 * the bare string, and the `{ref, source, integrity}` mapping.
 *
 * A repoint touches only the sequences that resolve to the run's schema set.
 * An override group with a different set is somebody else's contract; the
 * single-set guard proved it governs none of this run's files, and rewriting
 * it would change validation for files this statement never loaded.
 */
async function planConfigEdit(
  ctx: RunContext,
  edit: ConfigEditRequest,
  runRefs: readonly string[],
): Promise<{ write?: SchemaWrite; changes: QueryChange[]; repointed: boolean }> {
  const { configPath, configDir } = ctx;
  if (configPath === undefined || configDir === undefined) {
    return { changes: [], repointed: false };
  }
  const text = await readFile(configPath, "utf8");
  // BOM-strip like every other parse of file text; `expected`/`matchEol`
  // below still see the raw bytes, which is what freshness and EOL are about.
  const doc = parseDocument(stripBom(text));
  const display = displayPath(ctx, configPath);

  const rawRefOf = (item: unknown): string | undefined => {
    if (isScalar(item) && typeof item.value === "string") return item.value;
    if (isMap(item)) {
      const ref = item.get("ref");
      if (typeof ref === "string") return ref;
    }
    return undefined;
  };
  // The YAML holds refs as written; the run's set holds them rebased. Spell
  // the raw ones the same way before comparing.
  const rebaseRaw = (raw: string): string =>
    classifyRef(raw).kind === "file" && !isAbsolute(raw)
      ? resolve(configDir, raw)
      : raw;
  // Both sides through the same rebase: `runRefs` is raw whenever the config
  // sat in the working directory (rebasing was the identity there).
  const wantSet = runRefs.map(rebaseRaw).sort().join("\n");
  const seqResolvesToRunSet = (node: unknown): boolean => {
    if (!isSeq(node)) return false;
    const refs = node.items
      .map(rawRefOf)
      .flatMap((r) => (r === undefined ? [] : [rebaseRaw(r)]));
    return refs.length === node.items.length &&
      [...refs].sort().join("\n") === wantSet;
  };

  const repoint = (node: unknown): number => {
    if (!edit.repoint || !isSeq(node) || !seqResolvesToRunSet(node)) return 0;
    let n = 0;
    for (const item of node.items) {
      if (isScalar(item) && item.value === edit.repoint.oldRef) {
        item.value = edit.repoint.newRef;
        n += 1;
      } else if (isMap(item) && item.get("ref") === edit.repoint.oldRef) {
        item.set("ref", edit.repoint.newRef);
        n += 1;
      }
    }
    return n;
  };
  const topSeq = doc.get("schemas", true);
  let repointCount = repoint(topSeq);
  const overrides = doc.get("overrides", true);
  if (isSeq(overrides)) {
    for (const entry of overrides.items) {
      if (isMap(entry)) repointCount += repoint(entry.get("schemas", true));
    }
  }
  const repointed = repointCount > 0;

  let pinFrom: unknown;
  let pinned = false;
  if (edit.integrity && isSeq(topSeq)) {
    // Pins live on top-level mapping entries only — that is where
    // `collectSchemaPins` reads them from. Both spellings rebased, as above.
    const wantRef = rebaseRaw(edit.integrity.ref);
    for (const item of topSeq.items) {
      if (!isMap(item)) continue;
      const raw = rawRefOf(item);
      if (raw === undefined || rebaseRaw(raw) !== wantRef) continue;
      pinFrom = item.get("integrity");
      item.set("integrity", edit.integrity.value);
      pinned = true;
    }
  }

  const changes: QueryChange[] = [];
  if (repointed && edit.repoint) {
    changes.push({
      file: display,
      config: true,
      key: "schemas",
      from: edit.repoint.oldRef,
      to: edit.repoint.newRef,
      written: false,
    });
  }
  if (pinned && edit.integrity) {
    changes.push({
      file: display,
      config: true,
      key: "integrity",
      from: pinFrom,
      to: edit.integrity.value,
      written: false,
    });
  }
  if (!repointed && !pinned) return { changes: [], repointed };
  return {
    write: {
      path: configPath,
      content: matchEol(text, doc.toString({ lineWidth: 0 })),
      expected: text,
    },
    changes,
    repointed,
  };
}

type FileType = "boolean" | "number" | "bigint" | "string" | "array" | "object";

function fileTypeOf(value: unknown): FileType | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "boolean" || t === "number" || t === "bigint" || t === "string") {
    return t;
  }
  return t === "object" ? "object" : undefined;
}

/**
 * File-space changes from the projection diff — 0022's inverse map plus
 * 0024's file-level kinds. Type precedence for a restored cell: the file's
 * own original type, then the column's dominant type, then storage as-is.
 * Failures refuse by file and key rather than guess.
 */
function buildChanges(
  diff: ProjectionDiff,
  entries: QueryEntry[],
  sentinel: string,
  ctx: RunContext,
  renameHints: readonly { from: string; to: string }[] = [],
  /** Keys a DDL add declared boolean: their backfill restores as booleans. */
  booleanAdds: ReadonlySet<string> = new Set(),
): QueryChange[] {
  const effects = diff.cells;
  const originals = new Map(entries.map((e) => [e.label, e.extracted.data]));
  const meta = new Map(entries.map((e) => [e.label, e.extracted]));
  const dominant = new Map<string, FileType | undefined>();
  const dominantFor = (key: string): FileType | undefined => {
    if (dominant.has(key)) return dominant.get(key);
    const counts = new Map<FileType, number>();
    for (const e of entries) {
      const t = fileTypeOf(e.extracted.data[key]);
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    let best: FileType | undefined;
    let bestN = 0;
    let tied = false;
    for (const [t, n] of counts) {
      if (n > bestN) [best, bestN, tied] = [t, n, false];
      else if (n === bestN) tied = true;
    }
    const result = tied ? undefined : best;
    dominant.set(key, result);
    return result;
  };

  const restoreValue = (
    file: string,
    key: string,
    to: unknown,
    targetType: FileType | undefined,
  ): unknown => {
    // The variable annotation (not just the return position) is what lets
    // control-flow analysis treat a `refuse(...)` call as terminating.
    const refuse: (why: string) => never = (why) => {
      throw new DocmetaError(`"${key}" in ${file}: ${why}`);
    };
    // JSON.stringify throws on bigint — a refusal must never crash while
    // trying to describe the value it is refusing.
    const show = (v: unknown): string =>
      typeof v === "bigint" ? `${String(v)}n` : (toJsonText(v) ?? "undefined");
    if (to instanceof Uint8Array) refuse("a BLOB cannot be written back");
    if (to === null || targetType === undefined) return to;
    switch (targetType) {
      case "boolean":
        // A SQL expression can come back as bigint; 1n is as boolean as 1.
        if (to === 1 || to === 1n) return true;
        if (to === 0 || to === 0n) return false;
        refuse(`${show(to)} is not a boolean`);
      case "array":
      case "object": {
        if (typeof to !== "string") {
          refuse(`${show(to)} is not JSON text for a ${targetType}`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(to);
        } catch {
          refuse(`the new value is not valid JSON for a ${targetType}`);
        }
        const kind = Array.isArray(parsed) ? "array" : typeof parsed;
        if (kind !== targetType) {
          refuse(`the new value is ${kind}, and the key holds ${targetType}`);
        }
        return parsed;
      }
      case "number":
      case "bigint":
        if (typeof to !== "number" && typeof to !== "bigint") {
          refuse(`${show(to)} is not a number`);
        }
        return to;
      case "string":
        if (typeof to !== "string") {
          refuse(`${show(to)} is not a string; quote it in the statement`);
        }
        return to;
    }
    return to;
  };

  // Key-rename pairing pre-pass (per file): a deletion of `a` and a creation
  // of `b` whose SQL value equals `bindValue(original a)` is a rename, and it
  // carries the original file value verbatim — an array must never round-trip
  // through its JSON-text projection (0024 § stress test 1).
  type Pair = { key: string; renamedFrom: string; to: unknown };
  const consumedDeletes = new Set<CellEffect>();
  const pairForCreate = new Map<CellEffect, Pair>();
  const byFile = new Map<string, CellEffect[]>();
  for (const e of effects) {
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }
  // A DDL column rename is authoritative before any value matching: the pair
  // comes from the column diff, so it carries an explicit-null value the
  // generic pass below cannot see (a NULL cell is a deletion, not an add).
  for (const hint of renameHints) {
    for (const [file, list] of byFile) {
      const data = originals.get(file) ?? {};
      if (data[hint.from] === undefined) continue;
      const del = list.find(
        (e) =>
          e.key === hint.from &&
          (e.to === null || e.to === undefined) &&
          !consumedDeletes.has(e),
      );
      const add = list.find(
        (e) => e.key === hint.to && !pairForCreate.has(e),
      );
      if (!del || !add) continue;
      consumedDeletes.add(del);
      pairForCreate.set(add, {
        key: hint.to,
        renamedFrom: hint.from,
        to: data[hint.from],
      });
    }
  }
  for (const [file, list] of byFile) {
    const data = originals.get(file) ?? {};
    const dels = list.filter(
      (e) =>
        (e.to === null || e.to === undefined) &&
        data[e.key] !== undefined &&
        !consumedDeletes.has(e),
    );
    const adds = list.filter(
      (e) => data[e.key] === undefined && e.to != null && e.to !== sentinel,
    );
    for (const d of dels) {
      const bound = bindValue(data[d.key]);
      const match = adds.find(
        (a) => !pairForCreate.has(a) && Object.is(a.to, bound),
      );
      if (!match) continue;
      consumedDeletes.add(d);
      pairForCreate.set(match, {
        key: match.key,
        renamedFrom: d.key,
        to: data[d.key],
      });
    }
  }

  const changes: QueryChange[] = [];
  for (const effect of effects) {
    const { file, key, to } = effect;
    if (consumedDeletes.has(effect)) continue;
    const pair = pairForCreate.get(effect);
    if (pair) {
      changes.push({ file, ...pair, written: false });
      continue;
    }
    const original = originals.get(file)?.[key];
    // `explicit_null()` bypasses the type map by design: the statement asked
    // for the literal, whatever type the key held.
    if (to === sentinel) {
      changes.push({ file, key, from: original, to: null, written: false });
      continue;
    }
    // Deletion: `SET k = NULL` (0024's standard spelling) or a dropped
    // column. Deleting a key the file never had is a no-op, not a change.
    if (to === null || to === undefined) {
      if (original !== undefined) {
        changes.push({ file, key, from: original, deleted: true, written: false });
      }
      continue;
    }
    // A boolean DDL add is authoritative for a key no file had: without the
    // hint the backfill's 1/0 would land in the files as numbers (0028).
    const targetType =
      fileTypeOf(original) ??
      (booleanAdds.has(key) ? "boolean" : dominantFor(key));
    // `from` stays `undefined` for a key the file never had — JSON output
    // omits it — which keeps "absent" distinguishable from an explicit null.
    changes.push({
      file,
      key,
      from: original,
      to: restoreValue(file, key, to, targetType),
      written: false,
    });
  }

  // DELETE: a removed row strips the block. A file that had none is a no-op.
  const extractorOf = new Map(entries.map((e) => [e.label, e.extractor]));
  for (const file of diff.clearedRows) {
    const extracted = meta.get(file);
    if (!extracted?.present) continue;
    // Refused at plan time, not discovered at apply: this extraction did not
    // come from a fenced block — element-backed metadata, or an RST/AsciiDoc
    // file read through its native-header fallback — so there is nothing
    // whose removal leaves the document whole, and the preview must never
    // promise a strip the writer refuses. Per-file truth, not extractor
    // capability: the same RST extractor answers both ways.
    if (extracted.fenced !== true) {
      const name = extractorOf.get(file)?.name ?? extracted.format;
      throw new DocmetaError(
        `"${file}": the ${name} format has no front matter block to strip.`,
      );
    }
    changes.push({ file, cleared: true, from: extracted.data, written: false });
  }

  // INSERT: an added row creates a file.
  for (const [file, row] of diff.createdRows) {
    // An *omitted* _path never reaches here — the PRIMARY KEY's NOT NULL
    // rejects it in SQLite. What does arrive and still refuses: the empty
    // string (NOT NULL admits it) and a BLOB (TEXT affinity never coerces
    // blobs), neither of which names a file.
    if (typeof row._path !== "string" || row._path === "") {
      throw new DocmetaError("INSERT requires a non-empty _path.");
    }
    for (const sys of SYSTEM_COLUMNS) {
      if (sys !== "_path" && row[sys] != null) {
        throw new DocmetaError(
          `INSERT may not set system column "${sys}".`,
        );
      }
    }
    validateNewPath(file, ctx.base);
    // Refused at plan time so the preview never promises a file the writer
    // cannot build — the same courtesy every other refusal here extends.
    if (!extractorForExtension(extname(file))?.apply) {
      throw new DocmetaError(
        `"${file}": no writable format for that extension.`,
      );
    }
    if (existsSync(resolve(ctx.base, file))) {
      throw new DocmetaError(
        `"${file}" already exists; INSERT creates new files only.`,
      );
    }
    const to: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (RESERVED.has(key) || value === null || value === undefined) continue;
      to[key] =
        value === sentinel
          ? null
          : restoreValue(file, key, value, dominantFor(key));
    }
    changes.push({ file, created: true, to, written: false });
  }

  // A `_path` move renames the file.
  for (const { from, to } of diff.renamedFiles) {
    validateNewPath(to, ctx.base);
    if (extname(to).toLowerCase() !== extname(from).toLowerCase()) {
      throw new DocmetaError(
        `"${from}" -> "${to}": a rename may not change the extension.`,
      );
    }
    if (existsSync(resolve(ctx.base, to))) {
      throw new DocmetaError(
        `"${to}" already exists; the rename would overwrite it.`,
      );
    }
    changes.push({ file: from, renamed: to, written: false });
  }

  return changes;
}

/** A path an INSERT or rename may target: relative, contained, no traversal. */
function validateNewPath(p: string, base: string): void {
  const refuse = (why: string): never => {
    throw new DocmetaError(`"${p}" is not a usable path: ${why}.`);
  };
  if (isAbsolute(p)) refuse("it is absolute");
  if (p.split(/[\\/]/).some((segment) => segment === "..")) {
    refuse("it traverses upward");
  }
  const abs = resolve(base, p);
  // Named before the escape check: `.` resolves to the base itself, and
  // "escapes the corpus" would be a baffling description of that.
  if (abs === resolve(base)) refuse("it points at the corpus root, not a file");
  if (!abs.startsWith(resolve(base) + sep)) refuse("it escapes the corpus");
}

/**
 * All-or-nothing apply: phase one computes every file's new content — any
 * refusal (unwritable format, a corpus that moved underneath the run, or the
 * writer's own re-parse verification) aborts before a single byte lands;
 * phase two writes atomically. A half-applied bulk edit would leave the
 * corpus in a state no statement describes.
 */
async function applyChanges(
  changes: QueryChange[],
  entries: QueryEntry[],
  ctx: RunContext,
  schemaPlan?: SchemaPlan,
): Promise<void> {
  const schemaWrites = schemaPlan?.writes ?? [];
  if (changes.length === 0 && schemaWrites.length === 0) return;
  const byLabel = new Map(entries.map((e) => [e.label, e]));
  interface FileOps {
    patch: MetadataPatch;
    deletions: string[];
    cleared?: boolean;
    created?: Record<string, unknown>;
    renamedTo?: string;
  }
  const grouped = new Map<string, FileOps>();
  for (const c of changes) {
    if (c.file === STDIN_LABEL) {
      throw new DocmetaError(
        "A write cannot touch <stdin>: there is no file behind it.",
      );
    }
    if ("schema" in c || "config" in c) continue; // satisfied by schemaWrites
    const group = grouped.get(c.file) ?? { patch: {}, deletions: [] };
    if ("cleared" in c) group.cleared = true;
    else if ("created" in c) group.created = c.to;
    else if ("renamed" in c) group.renamedTo = c.renamed;
    else if ("deleted" in c) group.deletions.push(c.key);
    else if ("renamedFrom" in c) {
      group.patch[c.key] = c.to;
      group.deletions.push(c.renamedFrom);
    } else group.patch[c.key] = c.to;
    grouped.set(c.file, group);
  }

  const pendingWrites: { path: string; content: string; ensureDir?: boolean }[] =
    [];
  const pendingRenames: { from: string; to: string }[] = [];
  for (const [label, ops] of grouped) {
    const path = resolve(ctx.base, label);

    if (ops.renamedTo !== undefined) {
      if (!existsSync(path)) {
        throw new DocmetaError(
          `"${label}" is gone from disk since it was read; re-run the query.`,
        );
      }
      // The destination gets the same appeared-since-the-plan re-check the
      // created files do: rename(2) overwrites silently on POSIX.
      const toDisk = resolve(ctx.base, ops.renamedTo);
      if (existsSync(toDisk)) {
        throw new DocmetaError(
          `"${ops.renamedTo}" appeared on disk since the plan; re-run the query.`,
        );
      }
      pendingRenames.push({ from: path, to: toDisk });
      continue;
    }

    if (ops.created !== undefined) {
      const extractor = extractorForExtension(extname(label));
      if (!extractor?.apply) {
        throw new DocmetaError(
          `"${label}": no writable format for that extension.`,
        );
      }
      // Same moved-underneath contract the schema writes get: a file that
      // materialized here since the plan is somebody's data, not a target.
      if (existsSync(path)) {
        throw new DocmetaError(
          `"${label}" appeared on disk since the plan; re-run the query.`,
        );
      }
      pendingWrites.push({
        path,
        content: extractor.apply("", ops.created, {
          filePath: label,
          elements: resolveElements(label, ctx.config),
        }),
        ensureDir: true,
      });
      continue;
    }

    const entry = byLabel.get(label);
    if (!entry) throw new DocmetaError(`No loaded entry for "${label}".`);
    const content = await readFile(path, "utf8");
    // The change was computed against load-time data; if the file moved
    // since, applying it would encode a state nobody previewed.
    const current = entry.extractor.extract(content, label, {
      elements: resolveElements(label, ctx.config),
    });

    if (ops.cleared) {
      if (!deepEqual(current.data, entry.extracted.data)) {
        throw new DocmetaError(
          `"${label}" changed on disk since it was read; re-run the query.`,
        );
      }
      const stripped = stripFrontmatter(content);
      if (stripped === content) {
        // No fenced block to remove — element-backed metadata, or a native
        // header the fence writer does not own. Effect-judged, no name list.
        throw new DocmetaError(
          `"${label}": the ${entry.extractor.name} format has no front matter block to strip.`,
        );
      }
      pendingWrites.push({ path, content: stripped });
      continue;
    }

    if (!entry.extractor.apply) {
      throw new DocmetaError(
        `"${label}": the ${entry.extractor.name} format is read-only.`,
      );
    }
    for (const key of [...Object.keys(ops.patch), ...ops.deletions]) {
      if (!deepEqual(current.data[key], entry.extracted.data[key])) {
        throw new DocmetaError(
          `"${label}" changed on disk since it was read ("${key}" moved); re-run the query.`,
        );
      }
    }
    const applied = entry.extractor.apply(content, ops.patch, {
      filePath: label,
      elements: resolveElements(label, ctx.config),
      deletions: ops.deletions,
    });
    if (ops.deletions.length > 0) {
      // `deletions` is advisory in the ApplyOptions contract — a writer that
      // cannot remove a key ignores it. Certainty comes from reading back.
      const check = entry.extractor.extract(applied, label, {
        elements: resolveElements(label, ctx.config),
      });
      for (const key of ops.deletions) {
        if (check.data[key] !== undefined) {
          throw new DocmetaError(
            `"${label}": the ${entry.extractor.name} writer cannot delete "${key}".`,
          );
        }
      }
    }
    pendingWrites.push({ path, content: applied });
  }
  // Phase two opens by re-checking the plan-time schema/config reads — the
  // same moved-underneath refusal corpus files got in phase one. Nothing has
  // landed yet, so a refusal here still leaves every file untouched.
  for (const w of schemaWrites) {
    const display = displayPath(ctx, w.path);
    if (w.expected === undefined) {
      if (existsSync(w.path)) {
        throw new DocmetaError(
          `"${display}" appeared on disk since the plan; re-run the query.`,
        );
      }
      continue;
    }
    let now: string | undefined;
    try {
      now = await readFile(w.path, "utf8");
    } catch {
      now = undefined;
    }
    if (now !== w.expected) {
      throw new DocmetaError(
        `"${display}" changed on disk since it was read; re-run the query.`,
      );
    }
  }
  // Parent directories once each, and only where one can be missing: a
  // fork's schemas/ dir, an INSERT into a new subtree, a rename into one.
  // Files that were read from disk this run prove their directories exist.
  const dirs = new Set<string>();
  for (const w of schemaWrites) dirs.add(dirname(w.path));
  for (const r of pendingRenames) dirs.add(dirname(r.to));
  for (const p of pendingWrites) {
    if (p.ensureDir) dirs.add(dirname(p.path));
  }
  for (const d of dirs) await mkdir(d, { recursive: true });

  // ADD writes the schema after the corpus so a mid-apply failure leaves
  // extra keys under an unchanged schema (green); DROP/RENAME write it first
  // so files at worst keep a key the schema no longer declares.
  const writeSchema = async (): Promise<void> => {
    for (const w of schemaWrites) await writeFileAtomic(w.path, w.content);
  };
  const schemaLast = schemaPlan?.schemaLast ?? false;
  if (!schemaLast) await writeSchema();
  // Content before moves: a statement may rename one file while editing
  // others, and writes are the failure-prone step (disk full, permissions).
  // With renames last, a write failure leaves every file under its old name
  // with some new values — the statement re-runs to convergence — instead of
  // a completed rename whose "already exists" guard blocks the re-run.
  for (const p of pendingWrites) await writeFileAtomic(p.path, p.content);
  for (const r of pendingRenames) {
    try {
      await rename(r.from, r.to);
    } catch (err) {
      // EXDEV and friends arrive as raw fs errors; name the move and keep
      // the operational exit code instead of an "Unexpected error" trace.
      throw new DocmetaError(
        `Cannot move "${r.from}" to "${r.to}": ${(err as Error).message}`,
      );
    }
  }
  if (schemaLast) await writeSchema();
  for (const c of changes) c.written = true;
}

/**
 * Column names a statement SETs, so the table can be widened before it runs.
 * Tolerant by design: it walks strings and comments with the same rules as
 * the semicolon scan, and bails out at anything unexpected — a miss merely
 * leaves today's "no such column" error in place.
 *
 * Exported for the scanner parity suite, not via the API index.
 */
export function collectSetTargets(sql: string): string[] {
  const targets: string[] = [];
  let i = 0;
  const n = sql.length;
  const isWord = (ch: string | undefined): boolean =>
    ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  while (i < n) {
    const ch = sql[i];
    if (startsStringOrIdent(sql, i)) {
      i = skipStringOrIdent(sql, i);
    } else if (startsComment(sql, i)) {
      i = skipComment(sql, i);
    } else if (
      (ch === "s" || ch === "S") &&
      /^set$/i.test(sql.slice(i, i + 3)) &&
      !isWord(sql[i - 1]) &&
      !isWord(sql[i + 3])
    ) {
      i += 3;
      // Assignment list: identifier `=` expression, comma-separated, ending
      // at a top-level WHERE/FROM/RETURNING or the end of the statement.
      for (;;) {
        while (i < n && /\s/.test(sql[i] ?? "")) i++;
        const name = readIdentifier(sql, i);
        if (!name) return targets;
        targets.push(name.value);
        i = name.end;
        while (i < n && /\s/.test(sql[i] ?? "")) i++;
        if (sql[i] !== "=") return targets;
        const next = skipExpression(sql, i + 1);
        if (next.terminator !== ",") return targets;
        i = next.end + 1;
      }
    } else {
      i++;
    }
  }
  return targets;
}

/**
 * Column names an INSERT's column list carries, so a corpus-new key can be
 * introduced by creation too. Same tolerance contract as `collectSetTargets`.
 *
 * Exported for the scanner parity suite, not via the API index.
 */
export function collectInsertTargets(sql: string): string[] {
  const head = stripLeadingTrivia(sql);
  if (!/^(insert|replace)\b/i.test(head)) return [];
  const open = head.indexOf("(");
  if (open === -1) return [];
  const targets: string[] = [];
  let i = open + 1;
  for (;;) {
    while (i < head.length && /\s/.test(head[i] ?? "")) i++;
    const id = readIdentifier(head, i);
    if (!id) return targets;
    targets.push(id.value);
    i = id.end;
    while (i < head.length && /\s/.test(head[i] ?? "")) i++;
    if (head[i] === ",") {
      i++;
      continue;
    }
    return targets;
  }
}

function readIdentifier(
  sql: string,
  from: number,
): { value: string; end: number } | undefined {
  const ch = sql[from];
  if (ch === '"' || ch === "`") {
    const end = skipStringOrIdent(sql, from);
    const raw = sql.slice(from + 1, end - 1);
    return { value: raw.replaceAll(ch + ch, ch), end };
  }
  if (ch === "[") {
    // The bracket skip's unterminated-at-EOF return (length + 1) is what
    // keeps `end - 1` the content boundary HERE. The quote path above has no
    // such contract: unterminated, the skip returns length, and `end - 1`
    // drops the final character — long-standing behavior, unchanged.
    const end = skipStringOrIdent(sql, from);
    return { value: sql.slice(from + 1, end - 1), end };
  }
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(from));
  return m ? { value: m[0], end: from + m[0].length } : undefined;
}

/**
 * Skip one SET-clause expression. Ends at a top-level `,` (another
 * assignment) or a top-level WHERE/FROM/RETURNING keyword or end-of-string.
 */
function skipExpression(
  sql: string,
  from: number,
): { end: number; terminator: "," | "end" } {
  let depth = 0;
  let i = from;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    // Every string/identifier form, brackets included — a bracket identifier
    // may contain the `,`/`(`/`)` this scan otherwise acts on. Comments too:
    // `SET k = /* a, b */ 1` must not read the comment's comma as a
    // target separator.
    if (startsStringOrIdent(sql, i)) {
      i = skipStringOrIdent(sql, i);
      continue;
    }
    if (startsComment(sql, i)) {
      i = skipComment(sql, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0) {
      if (ch === ",") return { end: i, terminator: "," };
      if (/^(where|from|returning)\b/i.test(sql.slice(i, i + 10)) &&
          !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
        return { end: i, terminator: "end" };
      }
    }
    i++;
  }
  return { end: i, terminator: "end" };
}

// `quoteIdent`, `bindValue`, `assertSingleStatement`, and `loadSqlite` moved
// to ../core/projection.ts (proposal 0026), where the named checks share them.
