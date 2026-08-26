/**
 * `query` command core. Runs one SQL statement over an in-memory SQLite
 * database built per run from the metadata extracted from every input file.
 * Input handling (positional paths, globs, directories, `-` for stdin, and
 * config `paths:` fallback) mirrors `get` so the two commands behave
 * identically. Proposal 0021 is the design record.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve, extname } from "node:path";
import { resolveElements } from "../core/resolve-schema.js";
import { writeFileAtomic } from "../core/write-file.js";
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
 * One cell a statement changed, in file-space values on both sides. The two
 * variants are exclusive by type: a set carries `to`, a deletion —
 * `drop_key()` or a dropped column, as opposed to an explicit `null` —
 * carries `deleted: true`.
 */
export type QueryChange = {
  file: string;
  key: string;
  from: unknown;
  /** True once `write` has applied it; always false in a preview. */
  written: boolean;
} & ({ to: unknown; deleted?: never } | { deleted: true; to?: never });

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
    for (const key of collectSetTargets(sql)) {
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

    // `drop_key()` marks a cell for key deletion. The sentinel is random per
    // run, so no real content can collide with it and nothing can type it.
    const sentinel = `docmeta:drop:${randomBytes(16).toString("hex")}`;
    db.function("drop_key", () => sentinel);

    // 0022: the statement runs freely against this disposable projection and
    // is judged by its effects, not its syntax. A read leaves no diff.
    const before = snapshotRows(db);
    let columns: string[];
    let rows: Record<string, unknown>[];
    try {
      const stmt = db.prepare(sql);
      columns = stmt.columns().map((c) => c.name);
      // node:sqlite types rows as unknown[]; each row is a name->value record.
      rows = stmt.all();
    } catch (err) {
      throw new DocmetaError(`SQL error: ${(err as Error).message}`);
    }
    let after: Map<string, Record<string, unknown>>;
    try {
      after = snapshotRows(db);
    } catch {
      // The table itself is gone — DROP is the limit case of deleting rows.
      throw new DocmetaError(ROW_SET_MESSAGE);
    }
    const effects = diffSnapshots(before, after);
    // Structural, not textual: a read always yields result columns, DML and
    // DDL (without RETURNING) never do — so `WITH … UPDATE …` classifies
    // correctly even when it matches zero rows. The residual: RETURNING DML
    // that matches nothing reads as an empty result, which is what it shows.
    const mutatingIntent = columns.length === 0;
    if (effects.length === 0 && !mutatingIntent) {
      return { columns, rows, ...(dbInfo ? { db: dbInfo } : {}) };
    }

    const changes = restoreChanges(effects, entries, sentinel);
    if (ctx.write) await applyChanges(changes, entries, ctx);
    return { columns, rows, changes, ...(dbInfo ? { db: dbInfo } : {}) };
  } finally {
    db.close();
  }
}

const ROW_SET_MESSAGE =
  "The statement would create or delete rows; files are not created or deleted through SQL.";

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

/**
 * What the statement did, judged cell by cell. Row creation or deletion and
 * any system-column change refuse the whole run — since only the projection
 * changed, refusing costs nothing.
 */
function diffSnapshots(
  before: Map<string, Record<string, unknown>>,
  after: Map<string, Record<string, unknown>>,
): CellEffect[] {
  if (before.size !== after.size) throw new DocmetaError(ROW_SET_MESSAGE);
  const effects: CellEffect[] = [];
  for (const [path, was] of before) {
    const now = after.get(path);
    if (!now) {
      // Same row count but a path is gone: the statement rewrote `_path`,
      // which the keying otherwise disguises as an add-and-remove.
      throw new DocmetaError(
        `The statement changed system column "_path" for "${path}"; system columns are read-only.`,
      );
    }
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
      effects.push({ file: path, key, to: now[key] });
    }
  }
  effects.sort((a, b) =>
    a.file === b.file ? a.key.localeCompare(b.key) : a.file.localeCompare(b.file),
  );
  return effects;
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
 * File-space restoration of SQL-space cells — proposal 0022's inverse map.
 * Target type precedence: the file's own original type, then the column's
 * dominant type across the corpus, then the storage type as-is. Failures
 * refuse by file and key rather than guess.
 */
function restoreChanges(
  effects: CellEffect[],
  entries: QueryEntry[],
  sentinel: string,
): QueryChange[] {
  const originals = new Map(entries.map((e) => [e.label, e.extracted.data]));
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

  const changes: QueryChange[] = [];
  for (const { file, key, to } of effects) {
    const original = originals.get(file)?.[key];
    // The variable annotation (not just the return position) is what lets
    // control-flow analysis treat a `refuse(...)` call as terminating.
    const refuse: (why: string) => never = (why) => {
      throw new DocmetaError(`"${key}" in ${file}: ${why}`);
    };
    // Deletion: `drop_key()` marked the cell, or a dropped column removed it.
    // Deleting a key the file never had is a no-op, not a change.
    if (to === sentinel || to === undefined) {
      if (original !== undefined) {
        changes.push({ file, key, from: original, deleted: true, written: false });
      }
      continue;
    }
    if (to instanceof Uint8Array) refuse("a BLOB cannot be written back");
    const targetType = fileTypeOf(original) ?? dominantFor(key);
    let restored: unknown = to;
    if (to !== null && targetType !== undefined) {
      switch (targetType) {
        case "boolean":
          if (to === 1) restored = true;
          else if (to === 0) restored = false;
          else refuse(`${JSON.stringify(to)} is not a boolean`);
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
          restored = parsed;
          break;
        }
        case "number":
        case "bigint":
          if (typeof to !== "number" && typeof to !== "bigint") {
            refuse(`${JSON.stringify(to)} is not a number`);
          }
          break;
        case "string":
          if (typeof to !== "string") {
            refuse(
              `${JSON.stringify(to)} is not a string; quote it in the statement`,
            );
          }
          break;
      }
    }
    // `from` stays `undefined` for a key the file never had — JSON output
    // omits it — which keeps "absent" distinguishable from an explicit null.
    changes.push({ file, key, from: original, to: restored, written: false });
  }
  return changes;
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
): Promise<void> {
  if (changes.length === 0) return;
  const byLabel = new Map(entries.map((e) => [e.label, e]));
  const grouped = new Map<string, { patch: MetadataPatch; deletions: string[] }>();
  for (const c of changes) {
    if (c.file === STDIN_LABEL) {
      throw new DocmetaError(
        "A write cannot touch <stdin>: there is no file behind it.",
      );
    }
    const group = grouped.get(c.file) ?? { patch: {}, deletions: [] };
    if (c.deleted) group.deletions.push(c.key);
    else group.patch[c.key] = c.to;
    grouped.set(c.file, group);
  }

  const pending: { path: string; content: string }[] = [];
  for (const [label, { patch, deletions }] of grouped) {
    const entry = byLabel.get(label);
    if (!entry) throw new DocmetaError(`No loaded entry for "${label}".`);
    if (!entry.extractor.apply) {
      throw new DocmetaError(
        `"${label}": the ${entry.extractor.name} format is read-only.`,
      );
    }
    const path = resolve(ctx.base, label);
    const content = await readFile(path, "utf8");
    // The patch was computed against load-time data; if the file moved since,
    // applying it would encode a state nobody previewed.
    const current = entry.extractor.extract(content, label, {
      elements: resolveElements(label, ctx.config),
    });
    for (const key of [...Object.keys(patch), ...deletions]) {
      if (!deepEqual(current.data[key], entry.extracted.data[key])) {
        throw new DocmetaError(
          `"${label}" changed on disk since it was read ("${key}" moved); re-run the query.`,
        );
      }
    }
    const applied = entry.extractor.apply(content, patch, {
      filePath: label,
      elements: resolveElements(label, ctx.config),
      deletions,
    });
    if (deletions.length > 0) {
      // `deletions` is advisory in the ApplyOptions contract — a writer that
      // cannot remove a key ignores it. Certainty comes from reading back.
      const check = entry.extractor.extract(applied, label, {
        elements: resolveElements(label, ctx.config),
      });
      for (const key of deletions) {
        if (check.data[key] !== undefined) {
          throw new DocmetaError(
            `"${label}": the ${entry.extractor.name} writer cannot delete "${key}".`,
          );
        }
      }
    }
    pending.push({ path, content: applied });
  }
  for (const p of pending) await writeFileAtomic(p.path, p.content);
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
