/**
 * `query` command core. Runs one SQL statement over an in-memory SQLite
 * database built per run from the metadata extracted from every input file.
 * Input handling (positional paths, globs, directories, `-` for stdin, and
 * config `paths:` fallback) mirrors `get` so the two commands behave
 * identically. Proposal 0021 is the design record.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve, extname, sep } from "node:path";
import {
  FILE_SCHEMA_KEY,
  resolveElements,
  resolveSchemaSetWithSource,
} from "../core/resolve-schema.js";
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
  type ConfigNotice,
  type DocmetaConfig,
} from "../core/config.js";
import { classifyRef, loadSchema } from "../core/schema-registry.js";
import { parseDocument, isSeq, isScalar } from "yaml";

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
   * `--offline`, accepted for surface parity with the other commands. It has
   * no effect here for the same reason as on `get`: nothing ever resolves or
   * loads a schema, so there is no network dependency to suppress.
   */
  offline?: boolean;
  /**
   * `--write`: apply the statement's per-file changes to the underlying
   * documents. Without it a mutating statement is a preview — the diff it
   * would make, files untouched. Proposal 0022 is the design record.
   */
  write?: boolean;
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
      required?: boolean;
      forkedFrom?: string;
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
}

/**
 * The columns every `docs` table carries, reserved so ordinary frontmatter can
 * never shadow them. A frontmatter key with exactly one of these names is not
 * lifted to a column and stays reachable as `_data ->> '$.<key>'`; any other
 * `_`-prefixed key lifts normally — the reservation is four names, not a
 * namespace grab (proposal 0021 § stress test 4).
 */
const SYSTEM_COLUMNS = ["_path", "_format", "_present", "_data"] as const;
const RESERVED = new Set<string>(SYSTEM_COLUMNS);

/** What `node:sqlite` accepts as a bound parameter. */
type SqlValue = null | number | bigint | string;

export async function runQuery(opts: QueryOptions): Promise<QueryRun> {
  const cwd = opts.cwd ?? process.cwd();
  const sql = opts.sql.trim();
  if (sql === "" && opts.db === undefined) {
    throw new DocmetaError("Specify SQL to run.");
  }
  if (sql !== "") assertSingleStatement(sql);

  // Explicit CLI inputs win, else config `paths:`; `base` is whichever of the
  // two directories those inputs were written relative to.
  const { config, inputs, base } = await resolveRunConfig({
    cwd,
    configPath: opts.configPath,
    noConfig: opts.noConfig,
    inputs: opts.inputs,
    onConfigLoaded: opts.onConfigLoaded,
  });
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
  return runSql(sql, entries, {
    target: db,
    write: Boolean(opts.write),
    base,
    config,
    cwd,
  });
}

interface QueryEntry {
  label: string;
  extracted: ExtractedMetadata;
  /** The extractor that read it — a write goes back through the same one. */
  extractor: MetadataExtractor;
}

interface RunContext {
  target?: { resolved: string; display: string };
  write: boolean;
  /** Directory file labels resolve against (see `resolveRunConfig`). */
  base: string;
  config: DocmetaConfig | null;
  /** The run's working directory — schema refs resolve from here. */
  cwd: string;
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
  // Data columns are the union of top-level keys across the corpus — the same
  // scan boundary `schemas infer` chose. Sorted, so the column order (and any
  // `SELECT *`) is deterministic regardless of file order.
  const keys = new Set<string>();
  for (const { extracted } of entries) {
    for (const key of Object.keys(extracted.data)) {
      if (key !== "" && !RESERVED.has(key)) keys.add(key);
    }
  }
  // A SET target no file has yet still deserves a column — that is how a
  // corpus-new key is created. The scan is tolerant and only ever *adds*
  // empty columns: anything it misses fails exactly as before ("no such
  // column"), and a false positive is an all-NULL column nothing diffs.
  if (sql !== "") {
    for (const key of [
      ...collectSetTargets(sql),
      ...collectInsertTargets(sql),
    ]) {
      if (key !== "" && !RESERVED.has(key)) keys.add(key);
    }
  }
  const dataColumns = [...keys].sort();

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
    // Data columns get no type affinity, so SQLite stores exactly the value
    // each file had and never coerces one file's string into another's number.
    db.exec(
      `CREATE TABLE docs ("_path" TEXT PRIMARY KEY, "_format" TEXT, "_present" INTEGER, "_data" TEXT${dataColumns
        .map((c) => `, ${quoteIdent(c)}`)
        .join("")})`,
    );
    const insert = db.prepare(
      `INSERT INTO docs VALUES (${["?", "?", "?", "?", ...dataColumns.map(() => "?")].join(", ")})`,
    );
    for (const { label, extracted } of entries) {
      insert.run(
        label,
        extracted.format,
        extracted.present ? 1 : 0,
        JSON.stringify(extracted.data),
        ...dataColumns.map((c) => bindValue(extracted.data[c])),
      );
    }
    if (sql === "") {
      return { columns: [], rows: [], ...(dbInfo ? { db: dbInfo } : {}) };
    }

    // ATTACH and VACUUM INTO write files of their own, outside the table the
    // effect gate below watches — the only statements refused by name. The
    // check runs on the first real token: `/* c */ ATTACH …` must not slip
    // past a first-character regex on the strength of a comment.
    const head = stripLeadingTrivia(sql);
    if (/^(attach|vacuum)\b/i.test(head)) {
      throw new DocmetaError(
        `${head.split(/\s/, 1)[0]?.toUpperCase() ?? "That statement"} is refused: it can write outside the docs table.`,
      );
    }

    // 0024: `SET k = NULL` is the removal spelling, so the literal `k: null`
    // gets a function instead — `explicit_null()` returns a per-run random
    // sentinel no real content can collide with and nothing can type.
    const sentinel = `docmeta:null:${randomBytes(16).toString("hex")}`;
    db.function("explicit_null", () => sentinel);

    // 0022: the statement runs freely against this disposable projection and
    // is judged by its effects, not its syntax. A read leaves no diff. The
    // column snapshot (0024) is what makes DDL an effect too.
    const before = snapshotRows(db);
    const colBefore = snapshotColumns(db);
    let columns: string[];
    let rows: Record<string, unknown>[];
    try {
      const stmt = db.prepare(sql);
      columns = stmt.columns().map((c) => c.name);
      // node:sqlite types rows as unknown[]; each row is a name->value record.
      rows = stmt.all();
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("UNIQUE constraint failed: docs._path")) {
        // INSERT of a loaded path, or a rename onto one — the projection's
        // primary key catches it before any disk check can.
        throw new DocmetaError(
          "That _path already exists in the corpus.",
        );
      }
      throw new DocmetaError(`SQL error: ${message}`);
    }
    let after: Map<string, Record<string, unknown>>;
    try {
      after = snapshotRows(db);
    } catch {
      // The table itself is gone. "Delete the table definition" is the
      // accident-shaped spelling of two real statements; name them both.
      throw new DocmetaError(
        "DROP TABLE is refused. DELETE FROM docs WHERE … strips metadata from files; ALTER TABLE docs DROP COLUMN removes one key.",
      );
    }
    const diff = diffProjection(before, after);
    const schemaOps = columnDiffOps(colBefore, snapshotColumns(db), before, after);
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
    const schemaPlan =
      schemaOps.length > 0
        ? await planSchemaMutation(schemaOps, entries, ctx)
        : undefined;
    const changes = [
      ...(schemaPlan?.changes ?? []),
      ...buildChanges(diff, entries, sentinel, ctx),
    ];
    if (ctx.write) await applyChanges(changes, entries, ctx, schemaPlan?.writes);
    return { columns, rows, changes, ...(dbInfo ? { db: dbInfo } : {}) };
  } finally {
    db.close();
  }
}

/** Every row of the projection, keyed by `_path`. */
function snapshotRows(
  db: { prepare(sql: string): { all(): unknown[] } },
): Map<string, Record<string, unknown>> {
  const rows = db.prepare("SELECT * FROM docs").all() as Record<
    string,
    unknown
  >[];
  return new Map(rows.map((r) => [String(r._path), r]));
}

interface CellEffect {
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
  const removed = [...before.keys()].filter((p) => !after.has(p)).sort();
  const added = [...after.keys()].filter((p) => !before.has(p)).sort();

  const renamedFiles: { from: string; to: string }[] = [];
  for (const from of [...removed]) {
    const was = before.get(from);
    if (!was) continue;
    const toIdx = added.findIndex((p) => {
      const now = after.get(p);
      return now !== undefined && rowsEqualExceptPath(was, now);
    });
    if (toIdx === -1) continue;
    const to = added[toIdx];
    if (to === undefined) continue;
    renamedFiles.push({ from, to });
    removed.splice(removed.indexOf(from), 1);
    added.splice(toIdx, 1);
  }
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
  db: { prepare(sql: string): { all(): unknown[] } },
): Map<string, { type: string; notnull: number }> {
  const rows = db.prepare("PRAGMA table_info(docs)").all() as {
    name: string;
    type: string;
    notnull: number;
  }[];
  return new Map(rows.map((r) => [r.name, { type: r.type, notnull: r.notnull }]));
}

interface SchemaOp {
  op: "add" | "drop" | "rename";
  key: string;
  renamedTo?: string;
  type?: string;
  required?: boolean;
}

/**
 * DDL, read as an effect: the column set changed. A removed/added pair whose
 * per-row values are identical is a column rename; the rest are drops and
 * adds, an add carrying its declared type and NOT NULL as schema intent.
 */
function columnDiffOps(
  before: Map<string, { type: string; notnull: number }>,
  after: Map<string, { type: string; notnull: number }>,
  rowsBefore: Map<string, Record<string, unknown>>,
  rowsAfter: Map<string, Record<string, unknown>>,
): SchemaOp[] {
  const removed = [...before.keys()].filter((c) => !after.has(c));
  const added = [...after.keys()].filter((c) => !before.has(c));
  const ops: SchemaOp[] = [];
  for (const from of [...removed]) {
    const to = added.find((a) =>
      [...rowsBefore.keys()].every((path) =>
        Object.is(rowsBefore.get(path)?.[from], rowsAfter.get(path)?.[a]),
      ),
    );
    if (!to) continue;
    ops.push({ op: "rename", key: from, renamedTo: to });
    removed.splice(removed.indexOf(from), 1);
    added.splice(added.indexOf(to), 1);
  }
  for (const key of removed) ops.push({ op: "drop", key });
  for (const key of added) {
    const decl = after.get(key);
    ops.push({
      op: "add",
      key,
      type: mapDeclaredType(decl?.type ?? ""),
      required: decl?.notnull === 1,
    });
  }
  return ops;
}

/** SQLite declared type → JSON Schema type, by SQLite's own affinity rules. */
function mapDeclaredType(declared: string): string | undefined {
  if (/INT/i.test(declared)) return "integer";
  if (/CHAR|CLOB|TEXT/i.test(declared)) return "string";
  if (/REAL|FLOA|DOUB|NUMERIC|DEC/i.test(declared)) return "number";
  return undefined;
}

interface SchemaPlan {
  changes: QueryChange[];
  writes: { path: string; content: string }[];
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
  // One schema set for the whole run, or nothing mutates.
  let refs: string[] | undefined;
  let source = "default";
  for (const e of entries) {
    const resolved = resolveSchemaSetWithSource({
      filePath: e.label,
      fileSchema: e.extracted.data[FILE_SCHEMA_KEY],
      config: ctx.config,
      fileBase: ctx.cwd,
    });
    if (refs === undefined) {
      refs = resolved.schemas;
      source = resolved.source;
    } else if (JSON.stringify(refs) !== JSON.stringify(resolved.schemas)) {
      throw new DocmetaError(
        `DDL needs the corpus to resolve to one schema set, and this run's is split ("${e.label}" resolves differently). Scope the run to one override group.`,
      );
    }
  }
  if (!refs || source === "default") {
    throw new DocmetaError(
      "DDL edits the resolved schema, and this corpus runs on the built-in default set. Add a config naming a schema to evolve — for data-only edits, the UPDATE spellings cover every case.",
    );
  }

  const kinds = refs.map((ref) => ({ ref, kind: classifyRef(ref).kind }));
  const fileRefs = kinds.filter((k) => k.kind === "file");
  const builtinRefs = kinds.filter((k) => k.kind === "builtin");
  const urlRefs = kinds.filter((k) => k.kind === "url");

  // The target: for DROP/RENAME the schema that declares the key; for ADD the
  // single local file, else the first builtin (forked), else refuse.
  const first = ops[0];
  if (!first) return { changes: [], writes: [] };
  let target: { ref: string; kind: "file" | "builtin" } | undefined;
  if (first.op === "add") {
    if (fileRefs.length === 1) {
      const ref = fileRefs[0];
      if (ref) target = { ref: ref.ref, kind: "file" };
    } else if (fileRefs.length === 0 && builtinRefs.length > 0) {
      const ref = builtinRefs[0];
      if (ref) target = { ref: ref.ref, kind: "builtin" };
    }
  } else {
    for (const k of [...fileRefs, ...builtinRefs]) {
      const schema =
        k.kind === "file"
          ? (JSON.parse(
              await readFile(resolve(ctx.base, k.ref), "utf8"),
            ) as Record<string, unknown>)
          : await loadSchema(k.ref);
      const props = schema.properties as Record<string, unknown> | undefined;
      if (props && first.key in props) {
        target = { ref: k.ref, kind: k.kind as "file" | "builtin" };
        break;
      }
    }
  }
  if (!target) {
    if (urlRefs.length > 0) {
      throw new DocmetaError(
        `No local schema in the set takes this DDL, and "${urlRefs[0]?.ref ?? ""}" is a URL — vendor it first (docmeta schemas vendor), then evolve the local copy.`,
      );
    }
    throw new DocmetaError(
      first.op === "add"
        ? "DDL could not pick a schema to add to; name one with --schema."
        : `No schema in the resolved set declares "${first.key}".`,
    );
  }

  const writes: { path: string; content: string }[] = [];
  const changes: QueryChange[] = [];

  let schemaText: string;
  let schemaOutPath: string;
  let forkedFrom: string | undefined;
  if (target.kind === "file") {
    schemaOutPath = target.ref.replace(/^\.\//, "");
    schemaText = await readFile(resolve(ctx.base, schemaOutPath), "utf8");
  } else {
    // A builtin is immutable by invariant — fork it beside the config and
    // repoint every reference: the config entry, and any in-file `$schema`.
    forkedFrom = target.ref;
    const [, name, ver] = target.ref.split(":");
    schemaOutPath = `schemas/${name ?? "schema"}-${ver ?? "0"}.local.json`;
    if (existsSync(resolve(ctx.base, schemaOutPath))) {
      throw new DocmetaError(
        `"${schemaOutPath}" already exists; refusing to overwrite it with a fork of ${target.ref}.`,
      );
    }
    const bundled = await loadSchema(target.ref);
    schemaText = JSON.stringify(
      { ...bundled, $id: `${target.ref}+local` },
      null,
      2,
    );
    const newRef = `./${schemaOutPath}`;
    if (ctx.config) {
      writes.push(rewriteConfigSchemaRef(ctx, target.ref, newRef));
    }
    for (const e of entries) {
      const fileSchema = e.extracted.data[FILE_SCHEMA_KEY];
      if (fileSchema === target.ref) {
        changes.push({
          file: e.label,
          key: FILE_SCHEMA_KEY,
          from: fileSchema,
          to: newRef,
          written: false,
        });
      }
    }
  }

  const indent = /^\{\s*\n([ \t]+)/.exec(schemaText)?.[1] ?? "  ";
  let schema = JSON.parse(schemaText) as Record<string, unknown>;
  for (const op of ops) {
    schema = mutateSchemaObject(schema, op);
    changes.unshift({
      file: schemaOutPath,
      schema: true,
      op: op.op,
      key: op.key,
      ...(op.renamedTo !== undefined ? { renamedTo: op.renamedTo } : {}),
      ...(op.type !== undefined ? { type: op.type } : {}),
      ...(op.required ? { required: true } : {}),
      ...(forkedFrom !== undefined ? { forkedFrom } : {}),
      written: false,
    });
  }
  writes.unshift({
    path: resolve(ctx.base, schemaOutPath),
    content: `${JSON.stringify(schema, null, indent)}\n`,
  });
  return { changes, writes };
}

/** Apply one DDL op to a schema object, touching properties/required only. */
function mutateSchemaObject(
  schema: Record<string, unknown>,
  op: SchemaOp,
): Record<string, unknown> {
  let props = {
    ...((schema.properties as Record<string, unknown> | undefined) ?? {}),
  };
  let required = Array.isArray(schema.required)
    ? [...(schema.required as unknown[])]
    : [];
  switch (op.op) {
    case "add":
      props[op.key] = op.type !== undefined ? { type: op.type } : {};
      if (op.required && !required.includes(op.key)) required.push(op.key);
      break;
    case "drop": {
      const { [op.key]: _dropped, ...rest } = props;
      void _dropped;
      props = rest;
      required = required.filter((r) => r !== op.key);
      break;
    }
    case "rename": {
      const to = op.renamedTo ?? op.key;
      const { [op.key]: moved, ...rest } = props;
      rest[to] = moved;
      props = rest;
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

/**
 * Repoint one schema ref in docmeta.config.yaml — through the YAML Document
 * API, so every comment and untouched line survives.
 */
function rewriteConfigSchemaRef(
  ctx: RunContext,
  oldRef: string,
  newRef: string,
): { path: string; content: string } {
  const configPath = resolve(ctx.base, "docmeta.config.yaml");
  const doc = parseDocument(readFileSync(configPath, "utf8"));
  const repoint = (node: unknown): void => {
    if (!isSeq(node)) return;
    for (const item of node.items) {
      if (isScalar(item) && item.value === oldRef) item.value = newRef;
    }
  };
  repoint(doc.get("schemas", true));
  const overrides = doc.get("overrides", true);
  if (isSeq(overrides)) {
    for (const entry of overrides.items) {
      if (entry && typeof entry === "object" && "get" in entry) {
        repoint((entry as { get(k: string, keep: true): unknown }).get("schemas", true));
      }
    }
  }
  return { path: configPath, content: doc.toString({ lineWidth: 0 }) };
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
    if (to instanceof Uint8Array) refuse("a BLOB cannot be written back");
    if (to === null || targetType === undefined) return to;
    switch (targetType) {
      case "boolean":
        if (to === 1) return true;
        if (to === 0) return false;
        refuse(`${JSON.stringify(to)} is not a boolean`);
        break;
      case "array":
      case "object": {
        if (typeof to !== "string") {
          refuse(`${JSON.stringify(to)} is not JSON text for a ${targetType}`);
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
          refuse(`${JSON.stringify(to)} is not a number`);
        }
        return to;
      case "string":
        if (typeof to !== "string") {
          refuse(
            `${JSON.stringify(to)} is not a string; quote it in the statement`,
          );
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
  for (const [file, list] of byFile) {
    const data = originals.get(file) ?? {};
    const dels = list.filter(
      (e) =>
        (e.to === null || e.to === undefined) && data[e.key] !== undefined,
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
    const targetType = fileTypeOf(original) ?? dominantFor(key);
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
  for (const file of diff.clearedRows) {
    const extracted = meta.get(file);
    if (!extracted?.present) continue;
    changes.push({ file, cleared: true, from: extracted.data, written: false });
  }

  // INSERT: an added row creates a file.
  for (const [file, row] of diff.createdRows) {
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
  if (!abs.startsWith(resolve(base) + sep)) refuse("it escapes the corpus");
}

/** The statement with leading whitespace and comments removed. */
function stripLeadingTrivia(sql: string): string {
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
  schemaWrites: { path: string; content: string }[] = [],
): Promise<void> {
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
    if ("schema" in c) continue; // satisfied by schemaWrites, below
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

  const pendingWrites: { path: string; content: string }[] = [];
  const pendingRenames: { from: string; to: string }[] = [];
  for (const [label, ops] of grouped) {
    const path = resolve(ctx.base, label);

    if (ops.renamedTo !== undefined) {
      if (!existsSync(path)) {
        throw new DocmetaError(
          `"${label}" is gone from disk since it was read; re-run the query.`,
        );
      }
      pendingRenames.push({ from: path, to: resolve(ctx.base, ops.renamedTo) });
      continue;
    }

    if (ops.created !== undefined) {
      const extractor = extractorForExtension(extname(label));
      if (!extractor?.apply) {
        throw new DocmetaError(
          `"${label}": no writable format for that extension.`,
        );
      }
      pendingWrites.push({
        path,
        content: extractor.apply("", ops.created, {
          filePath: label,
          elements: resolveElements(label, ctx.config),
        }),
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
  // Parent directories first: a fork's schemas/ dir or an INSERT into a new
  // subtree may not exist yet, and atomic writes create files, never dirs.
  for (const w of schemaWrites) {
    await mkdir(dirname(w.path), { recursive: true });
    await writeFileAtomic(w.path, w.content);
  }
  for (const r of pendingRenames) await rename(r.from, r.to);
  for (const p of pendingWrites) {
    await mkdir(dirname(p.path), { recursive: true });
    await writeFileAtomic(p.path, p.content);
  }
  for (const c of changes) c.written = true;
}

/**
 * Column names a statement SETs, so the table can be widened before it runs.
 * Tolerant by design: it walks strings and comments with the same rules as
 * the semicolon scan, and bails out at anything unexpected — a miss merely
 * leaves today's "no such column" error in place.
 */
function collectSetTargets(sql: string): string[] {
  const targets: string[] = [];
  let i = 0;
  const n = sql.length;
  const isWord = (ch: string | undefined): boolean =>
    ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
    } else if (ch === "[") {
      while (i < n && sql[i] !== "]") i++;
      i++;
    } else if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
    } else if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
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
 */
function collectInsertTargets(sql: string): string[] {
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

/** Index just past a quoted region starting at `from` (doubling escapes). */
function skipQuoted(sql: string, from: number, quote: string): number {
  let i = from + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
}

function readIdentifier(
  sql: string,
  from: number,
): { value: string; end: number } | undefined {
  const ch = sql[from];
  if (ch === '"' || ch === "`") {
    const end = skipQuoted(sql, from, ch);
    const raw = sql.slice(from + 1, end - 1);
    return { value: raw.replaceAll(ch + ch, ch), end };
  }
  if (ch === "[") {
    let i = from + 1;
    while (i < sql.length && sql[i] !== "]") i++;
    return { value: sql.slice(from + 1, i), end: i + 1 };
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
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
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

/** Any key becomes a legal quoted identifier by doubling internal quotes. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * One frontmatter value, as SQLite stores it: booleans as 1/0 (`node:sqlite`
 * refuses to bind a boolean), arrays and objects as JSON text (which
 * `json_each` and `->>` then query directly), non-finite numbers as NULL
 * (SQLite has no NaN — it would store NULL anyway, this just does it without
 * an engine error).
 */
function bindValue(value: unknown): SqlValue {
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
 * Refuse a second statement instead of silently dropping it.
 *
 * `prepare()` compiles the first statement and ignores the rest, so
 * `SELECT 1; DROP TABLE docs` would run the SELECT and quietly skip the DROP —
 * a request half-honored with exit 0, the false-green shape 0016 exists to
 * keep out. The scan skips string literals, quoted identifiers, and both
 * comment forms; a trailing `;` (or several) is a terminator, not a chain.
 */
function assertSingleStatement(sql: string): void {
  const cut = topLevelSemicolon(sql);
  if (cut === -1) return;
  if (!isTrivia(sql.slice(cut + 1))) {
    throw new DocmetaError(
      "Run a single SQL statement per query; text after the first `;` would be silently ignored.",
    );
  }
}

/** Index of the first `;` outside literals, identifiers, and comments. */
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
function loadSqlite(): Promise<typeof import("node:sqlite")> {
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
