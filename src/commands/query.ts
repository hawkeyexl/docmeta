/**
 * `query` command core. Runs one SQL statement over an in-memory SQLite
 * database built per run from the metadata extracted from every input file.
 * Input handling (positional paths, globs, directories, `-` for stdin, and
 * config `paths:` fallback) mirrors `get` so the two commands behave
 * identically. Proposal 0021 is the design record.
 */
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { resolveElements } from "../core/resolve-schema.js";
import { DocmetaError, type ExtractedMetadata } from "../types.js";
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
import { resolveRunConfig, type ConfigNotice } from "../core/config.js";

export interface QueryOptions {
  /** One SQL statement. The table is `docs`; see the system columns below. */
  sql: string;
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
}

export interface QueryRun {
  /** Result column names, in SELECT order — present even for zero rows. */
  columns: string[];
  rows: Record<string, unknown>[];
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
  if (sql === "") {
    throw new DocmetaError("Specify SQL to run.");
  }
  assertSingleStatement(sql);

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

  const entries: { label: string; extracted: ExtractedMetadata }[] = [];

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
    entries.push({ label, extracted });
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

  return runSql(sql, entries);
}

/** Build the in-memory `docs` table and run the user's statement over it. */
async function runSql(
  sql: string,
  entries: { label: string; extracted: ExtractedMetadata }[],
): Promise<QueryRun> {
  // Data columns are the union of top-level keys across the corpus — the same
  // scan boundary `schemas infer` chose. Sorted, so the column order (and any
  // `SELECT *`) is deterministic regardless of file order.
  const keys = new Set<string>();
  for (const { extracted } of entries) {
    for (const key of Object.keys(extracted.data)) {
      if (key !== "" && !RESERVED.has(key)) keys.add(key);
    }
  }
  const dataColumns = [...keys].sort();

  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(":memory:");
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
    // From here on the database is the user's to read, never to write.
    db.exec("PRAGMA query_only = 1");

    try {
      const stmt = db.prepare(sql);
      const columns = stmt.columns().map((c) => c.name);
      // node:sqlite types rows as unknown[]; each row is a name->value record.
      const rows = stmt.all() as Record<string, unknown>[];
      return { columns, rows };
    } catch (err) {
      if (err instanceof DocmetaError) throw err;
      throw new DocmetaError(`SQL error: ${(err as Error).message}`);
    }
  } finally {
    db.close();
  }
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
