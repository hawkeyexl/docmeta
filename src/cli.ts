/**
 * docmeta CLI. Thin commander wrapper over the command cores. Follows clig.dev:
 * primary output to stdout, diagnostics to stderr, color only on a TTY (and
 * never when NO_COLOR/--no-color), meaningful exit codes (0 ok, 1 validation
 * failures, 2 operational/usage errors).
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, extname, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Option } from "commander";
import picomatch from "picomatch";
import pkg from "../package.json" with { type: "json" };
import { DocmetaError } from "./types.js";
import { runValidate } from "./commands/validate.js";
import { runGet } from "./commands/get.js";
import { runQuery } from "./commands/query.js";
import {
  DEFAULT_VENDOR_DIR,
  getSchemasInfo,
  runInferSchema,
  runVendorSchema,
} from "./commands/schemas.js";
import { runFill } from "./commands/fill.js";
import { supportedExtensions } from "./extractors/index.js";
import {
  COMMON_FORMATS,
  COMMON_FORMAT_LIST,
  OMITTED_WHEN_CLEAN,
  REPORT_FORMATS,
  REPORT_FORMAT_LIST,
  isCommonFormat,
  isMachineFormat,
  isReportFormat,
  render,
  type CommonFormat,
} from "./reporters/index.js";
import {
  FILL_FORMATS,
  FILL_FORMAT_LIST,
  isFillFormat,
  renderFill,
} from "./reporters/fill.js";
import { renderGet } from "./reporters/get.js";
import { renderQuery } from "./reporters/query.js";
import { renderInfer } from "./reporters/infer.js";
import { shouldColor, palette } from "./reporters/color.js";

function collect(value: string, prev: string[]): string[] {
  return prev.concat([value]);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function fail(err: unknown): never {
  const msg =
    err instanceof DocmetaError
      ? err.message
      : `Unexpected error: ${(err as Error).message}`;
  process.stderr.write(`docmeta: ${msg}\n`);
  process.exit(2);
}

function resolveColor(program: Command): boolean {
  // commander maps --no-color to opts.color === false.
  const noColor = program.opts().color === false;
  // Passed through uncoerced. `@types/node` declares `isTTY` as `boolean`, but
  // Node leaves it **undefined** on a stream that is not a terminal — it is
  // never `false` — and `shouldColor` already takes `isTTY?` and treats a
  // missing one as "not a terminal". A `Boolean()` here only restated that,
  // where the declared type says it restates nothing.
  return shouldColor({ noColor, isTTY: process.stdout.isTTY });
}

/**
 * The `--format` a subcommand was actually given, when its **parent** also
 * declares one.
 *
 * commander lets an option declared on a parent be written anywhere in the
 * argv, so `docmeta schemas infer -f json` binds `json` to the `schemas`
 * command — `infer`'s own `--format` keeps its default and the run answers in
 * `pretty`. Silently. That is the same false green `schemas -f github` was
 * fixed for: a request docmeta could honor, answered in a format nobody asked
 * for, with exit 0.
 *
 * `getOptionValueSource` is the public way to tell a typed value from a
 * default, so this reads both commands and prefers whichever was actually
 * typed, rather than depending on which one commander happens to bind to.
 */
function formatFor(command: Command, own: unknown): unknown {
  if (command.getOptionValueSource("format") === "cli") return own;
  const parent = command.parent;
  if (parent && parent.getOptionValueSource("format") === "cli") {
    return parent.opts().format;
  }
  return own;
}

/** A `--format` value one of the two-format commands (`get`, `schemas`) rejects. */
function assertCommonFormat(value: unknown): CommonFormat {
  const format = String(value);
  if (!isCommonFormat(format)) {
    throw new DocmetaError(
      `Unknown --format "${format}". Use ${COMMON_FORMAT_LIST}.`,
    );
  }
  return format;
}

/** The one input token that is neither a path nor a field: stdin. */
const STDIN = "-";

/**
 * Does this token name a path rather than a field list?
 *
 * `get`'s field list is positional, so a user who forgets it has their *path*
 * bound to `[fields]`. Since the argument became optional the CLI can say so
 * outright instead of reporting the paths that are left as missing.
 *
 * The four positive tests mirror `suggestCommand`'s, `existsSync` included —
 * that leg is the one that catches a bare directory name (`docmeta get docs`),
 * which has neither a dot, a separator, nor a glob character.
 *
 * `existsSync` alone is too eager for a token with **no path shape at all**,
 * though, because field names collide with directory names constantly: `tags`,
 * `docs`, `type`, `content`. In a site repo holding a `tags/` directory,
 * `docmeta get tags docs/a.md` was refused as a path, and the remedy it
 * suggested (`docmeta get title tags`) was nonsense. So a shapeless token is
 * only read as a path when it is **alone** — nothing else was offered as one,
 * which is the shape of someone who forgot the field list. Give a path *and* a
 * bare name and the bare name is the field list: the only reading that makes
 * sense of both.
 *
 * Two negative tests matter more than any of the shape tests, because a false
 * positive rejects a legal field list:
 *
 * - a **comma** makes it a list, and a path holding one is vanishingly rare;
 * - a **leading `/`** is a JSON Pointer, the documented way to address a nested
 *   or dotted key — `docmeta get /author/email page.md` is exactly the usage
 *   the separator test would otherwise refuse.
 *
 * They do not run *first*, though, and the distinction is worth stating because
 * the obvious reading of the list above is that they do: a token that names a
 * file which really exists is taken as a path before either is consulted. So a
 * JSON Pointer that happens to match a real absolute path — `/author/email`, on
 * a machine where that file exists — is read as a path. `--fields` is the
 * escape, and is why the guard can afford to be wrong here.
 */
function looksLikePath(token: string, cwd: string, alone: boolean): boolean {
  if (token === STDIN) return false;
  // One scan, used twice: `shaped` needs it, and so does the positive test
  // below when `existsSync` did not settle the question.
  const scan = picomatch.scan(token);
  const shaped = /[\\/]/.test(token) || extname(token) !== "" || scan.isGlob;
  // A file that really is there settles it — but only when the token looks
  // like a path, or nothing else was offered as one.
  if ((shaped || alone) && existsSync(resolvePath(cwd, token))) return true;
  if (token.includes(",") || token.startsWith("/")) return false;
  if (scan.isGlob) return true;
  const ext = extname(token).toLowerCase();
  if (ext !== "" && supportedExtensions().includes(ext)) return true;
  return /[\\/]/.test(token);
}

/**
 * `get`'s one input rule: **if `--fields` is present, every positional is a
 * path.** Otherwise the first positional is the field list, exactly as before.
 *
 * The missing-field-list case is handled *here* rather than left to `runGet`.
 * `options.fields ?? fieldsArg` is `undefined` when neither was given, and
 * `String(undefined).split(",")` is `["undefined"]` — a field list of length
 * one, so `runGet`'s `fields.length === 0` guard never fires and a bare
 * `docmeta get` in a repo with config `paths:` prints `undefined=(unset)` per
 * file and exits 0. A successful-looking report for a field nobody named is
 * worse than the error it replaced.
 *
 * The positional is folded in on `fieldsArg !== undefined`, not with
 * `.filter(Boolean)`: an empty-string path is a mistake worth reporting, and
 * filtering it would silently drop it instead.
 */
export function resolveGetInputs(
  fieldsArg: string | undefined,
  pathsArg: string[],
  fieldsOption: unknown,
  cwd: string,
): { fields: string[]; paths: string[] } {
  const flag = typeof fieldsOption === "string" ? fieldsOption : undefined;

  if (
    flag === undefined &&
    fieldsArg !== undefined &&
    looksLikePath(fieldsArg, cwd, pathsArg.length === 0)
  ) {
    throw new DocmetaError(
      `"${fieldsArg}" looks like a path, not a field list. Pass fields first (docmeta get title ${fieldsArg}) or use --fields.`,
    );
  }

  // `-` is stdin, never a field name. Letting it become one made
  // `docmeta get - --as markdown` print `-=(unset)` for every file in the
  // config's `paths:` and exit 0 — the piped document never read, the run
  // looking entirely successful. Dropping it here leaves `fields` empty, so
  // the missing-field-list error below fires instead.
  const source = flag ?? (fieldsArg === STDIN ? undefined : fieldsArg);
  const fields = source === undefined ? [] : splitList(source);
  if (fields.length === 0) {
    throw new DocmetaError(
      "Specify at least one field to get. Pass fields first (docmeta get title docs/a.md) or use --fields.",
    );
  }

  const paths =
    fieldsArg !== undefined && (flag !== undefined || fieldsArg === STDIN)
      ? [fieldsArg, ...pathsArg]
      : pathsArg;
  return { fields, paths };
}

/**
 * `query`'s input rule is `get`'s with SQL in the fields slot: **if `--query`
 * is present, every positional is a path**; otherwise the first positional is
 * the SQL. The same three guards apply and for the same reasons — a token
 * shaped like a path in the SQL slot is a forgotten statement, `-` is stdin
 * and never SQL, and an absent statement is an error rather than a
 * plausible-looking run. Real SQL never trips `looksLikePath`: a statement
 * with a column list contains a comma, and anything else with a space cannot
 * name a file that exists.
 */
export function resolveQueryInputs(
  sqlArg: string | undefined,
  pathsArg: string[],
  queryOption: unknown,
  cwd: string,
): { sql: string; paths: string[] } {
  const flag = typeof queryOption === "string" ? queryOption : undefined;

  if (
    flag === undefined &&
    sqlArg !== undefined &&
    looksLikePath(sqlArg, cwd, pathsArg.length === 0)
  ) {
    throw new DocmetaError(
      `"${sqlArg}" looks like a path, not SQL. Pass the SQL first (docmeta query "SELECT _path FROM docs" ${sqlArg}) or use --query.`,
    );
  }

  const source = flag ?? (sqlArg === STDIN ? undefined : sqlArg);
  const sql = source?.trim() ?? "";
  if (sql === "") {
    throw new DocmetaError(
      'Specify SQL to run. Pass it first (docmeta query "SELECT _path FROM docs" docs/) or use --query.',
    );
  }

  const paths =
    sqlArg !== undefined && (flag !== undefined || sqlArg === STDIN)
      ? [sqlArg, ...pathsArg]
      : pathsArg;
  return { sql, paths };
}

const COMMAND_NAMES = ["validate", "get", "query", "fill", "schemas"];

/** Levenshtein distance. Only used to offer a "did you mean" hint. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(
        Math.min(
          (row[j - 1] ?? 0) + 1,
          (prev[j] ?? 0) + 1,
          (prev[j - 1] ?? 0) + cost,
        ),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/**
 * `validate` is the default command, so an unrecognized first token is parsed as
 * a *path* rather than rejected. Since a named path that does not exist is now
 * an error, `docmeta valdiate docs/` already fails with the right exit code —
 * but it fails as `File not found: "valdiate"`, which does not say what went
 * wrong. Upgrade the message when the token is plainly a misspelled command.
 *
 * The guard is deliberately narrow: anything holding a separator or a dot, any
 * glob, and — crucially — anything that actually exists on disk is a path, not a
 * typo. That last check is what makes a false positive impossible.
 */
function suggestCommand(token: string | undefined, cwd: string): void {
  if (token === undefined || token === "-") return;
  if (/[\\/.]/.test(token)) return;
  if (picomatch.scan(token).isGlob) return;
  if (existsSync(resolvePath(cwd, token))) return;

  const near = COMMAND_NAMES.map(
    (name) => [name, editDistance(token.toLowerCase(), name)] as const,
  )
    .filter(([, d]) => d > 0 && d <= 2)
    .sort((x, y) => x[1] - y[1]);

  const best = near[0];
  if (!best) return;
  throw new DocmetaError(
    `Unknown command "${token}". Did you mean "${best[0]}"?`,
  );
}

/**
 * Split the one commander attribute that `-c, --config <path>` and
 * `--no-config` share. Verified by experiment: `opts.config` is `undefined`
 * with neither flag, the string with `-c`, and `false` with `--no-config`.
 */
function configOption(value: unknown): {
  configPath?: string;
  noConfig?: boolean;
} {
  if (value === false) return { noConfig: true };
  return typeof value === "string" ? { configPath: value } : {};
}

/**
 * Say which config governed the run, and where it came from.
 *
 * Discovery now walks up to the project boundary, so the answer is no longer
 * obvious from the working directory, and an unexpected ancestor config is the
 * difference between a five-minute diagnosis and an hour of confusion. Goes to
 * stderr for anything a machine reads, so structured output stays parseable.
 */
function reportConfig(
  toStdout: boolean,
  cwd: string,
): (info: { path: string; dir: string }) => void {
  return (info) => {
    const where = (relative(cwd, info.dir) || ".").replace(/\\/g, "/");
    const line = `Using ${basename(info.path)} (${where})\n`;
    (toStdout ? process.stdout : process.stderr).write(line);
  };
}

/**
 * Diagnostics from a command core. Always stderr, never stdout: `json` and
 * `github` output has to stay parseable, and a note is not the report.
 */
function notice(message: string): void {
  process.stderr.write(`docmeta: ${message}\n`);
}

/**
 * `--no-gitignore` for the core. Commander gives `true` when the flag is
 * absent, but that is its *default*, not a choice the user made — passing it
 * on would override config `respectGitignore:`. Only the explicit `false`
 * travels; absence stays `undefined` so config still decides.
 */
function gitignoreFlag(value: unknown): boolean | undefined {
  return value === false ? false : undefined;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Range-check a numeric flag. `parseFloat("abc")` is NaN and every comparison
 * against NaN is false, so the finite check has to be explicit or garbage
 * passes silently.
 */
function numeric(
  name: string,
  value: number | undefined,
  min: number,
  max: number,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new DocmetaError(
      `${name} must be a number between ${min} and ${max}, got ${value}.`,
    );
  }
}

/**
 * Commander hands an `.action()` callback an untyped bag of option values, so
 * each subcommand declares the shape it actually reads.
 *
 * The three-state flags are the reason this is worth writing down rather than
 * coercing at each use site. `-c`/`--no-config`, `--baseline`/`--no-baseline`,
 * `--no-gitignore` and `--no-cache` are only correct while *absent*, *a value*
 * and *an explicit `false`* stay distinguishable — absence leaves config in
 * charge, `false` overrides it. A union that names all three states is the one
 * place a reader finds that out; `String(options.format)` never said anything.
 */

/** The flags the parity rule keeps identical across every input-taking command. */
interface InputCliOptions {
  /** `--ext <list>`; the command splits it. */
  ext?: string;
  /** `--exclude <glob>`, repeatable — commander's default value is `[]`. */
  exclude: string[];
  /** `--as <format>`: force an extractor. */
  as?: string;
  /** `-f, --format <format>`. Always a string: every declaration has a default. */
  format: string;
  /**
   * `-c, --config <path>` and `--no-config` share one commander attribute:
   * `undefined` with neither flag, the path with `-c`, `false` with
   * `--no-config`. Split by `configOption`.
   */
  config?: string | boolean;
}

/** The rest of what `validate`, `get`, and `fill` share. */
interface RunCliOptions extends InputCliOptions {
  quiet?: boolean;
  allowEmpty?: boolean;
  /**
   * `--no-gitignore`. Commander supplies `true` when the flag is absent, so
   * this is `boolean` and never `undefined` — which is exactly why
   * `gitignoreFlag` exists to turn that default back into "no opinion".
   */
  gitignore: boolean;
  offline?: boolean;
}

interface ValidateCliOptions extends RunCliOptions {
  /** `-s, --schema <ref>`, repeatable — commander's default value is `[]`. */
  schema: string[];
  /**
   * `--baseline [path]` / `--no-baseline`, the same three-state split as
   * `config`: absent leaves the config in charge, a string names a file, `true`
   * is a bare `--baseline` (the default path), `false` is `--no-baseline`.
   */
  baseline?: string | boolean;
  /** `--write-baseline [path]`; `true` for the bare flag. See `baseline`. */
  writeBaseline?: string | boolean;
}

interface GetCliOptions extends RunCliOptions {
  /** `--fields <list>`; when present, every positional is a path. */
  fields?: string;
}

/**
 * Not `RunCliOptions`: `query` declares no `-q/--quiet`. `get` uses it to hide
 * files and `validate` to hide passes; a query result has no analogous noise,
 * and a flag that means nothing is what 0016 says not to declare.
 */
interface QueryCliOptions extends InputCliOptions {
  /** `--query <sql>`; when present, every positional is a path. */
  query?: string;
  /** `--check`: any row returned is a finding, so exit 1. */
  check?: boolean;
  allowEmpty?: boolean;
  /** `--no-gitignore`; commander's `true` default, see `gitignoreFlag`. */
  gitignore: boolean;
  offline?: boolean;
}

interface FillCliOptions extends RunCliOptions {
  /** `-s, --schema <ref>`, repeatable — commander's default value is `[]`. */
  schema: string[];
  fields?: string;
  /** Parsed by `parseFloat`, so possibly NaN — `numeric` is the range check. */
  confidence?: number;
  dryRun?: boolean;
  provider?: string;
  model?: string;
  /**
   * `--no-cache`. Commander supplies `true` when the flag is absent; unlike
   * `gitignore` that default is passed straight through, because the core's
   * `cache` has no config counterpart for it to override.
   */
  cache: boolean;
  local?: boolean;
  maxTurns?: number;
  chunkChars?: number;
  concurrency?: number;
}

interface SchemasCliOptions {
  format: string;
}

interface InferCliOptions extends InputCliOptions {
  out?: string;
  /** `--min-coverage <pct>`; commander's default value is `0`. */
  minCoverage: number;
}

interface VendorCliOptions {
  /** `--dir <path>`; commander's default value is `DEFAULT_VENDOR_DIR`. */
  dir: string;
  /** `-c, --config <path>`. `vendor` declares no `--no-config`, so no `false`. */
  config?: string;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("docmeta")
    .description(
      "Validate the presence and format of document metadata against JSON Schema.",
    )
    .version(pkg.version, "-V, --version")
    .option("--no-color", "disable colored output")
    // A pointer, not the whole help screen. Commander appends this after every
    // usage error, and ~40 lines of options per typo is noise in a CI log — the
    // message that precedes it already names the offending flag.
    .showHelpAfterError("(add --help for usage)")
    // MUST come before the `.command()` calls below. `copyInheritedSettings`
    // copies `_exitCallback` **by value** at subcommand-creation time, so an
    // `exitOverride()` installed afterwards (including
    // `buildProgram().exitOverride()` from main) leaves every subcommand still
    // calling `process.exit(1)` while the program-level case looks fixed.
    .exitOverride();

  program
    .command("validate", { isDefault: true })
    .description("Validate metadata in the given files/dirs/globs")
    .argument(
      "[paths...]",
      "files, directories, or globs to validate (use - for stdin)",
    )
    .option(
      "-s, --schema <ref>",
      "schema to validate against; repeatable; overrides $schema/config",
      collect,
      [],
    )
    .option("--ext <list>", "comma-separated extensions for directory walks")
    .option("--exclude <glob>", "glob to exclude; repeatable", collect, [])
    .option("--as <format>", "force an input format (e.g. markdown, mdx)")
    .option(
      "-f, --format <format>",
      `output: ${REPORT_FORMATS.join(" | ")}`,
      "pretty",
    )
    .option("-c, --config <path>", "path to a docmeta config file")
    .option("--no-config", "ignore any discovered config file")
    .option("-q, --quiet", "in pretty output, hide passing files")
    .option("--allow-empty", "treat zero matched files as success")
    .option("--no-gitignore", "check files .gitignore covers")
    .option(
      "--offline",
      "never fetch a remote schema; resolve URL refs from the schema cache",
    )
    // Neither flag carries `.preset()`, and neither carries a `defaultValue`.
    //
    // No `defaultValue`, because that would make the baseline active on runs
    // where the flag was never typed — semantically wrong, and it would oblige
    // the docs to carry a matching Default cell.
    //
    // No `.preset()` either, which is subtler. A preset hands the core the
    // default path as a *string*, making a bare `--baseline` indistinguishable
    // from an explicitly typed `--baseline .docmeta-baseline.json`. A typed path
    // is rightly relative to where the user is standing; an omitted one has to
    // mean "the file this project's baseline lives in" — `baseline:` from config
    // when there is one, resolved against the config's directory. Collapsing the
    // two made `--baseline` from a subdirectory look for the file beside the
    // user instead of beside the config, so the ratchet broke the moment anyone
    // ran from `docs/`, and a bare `--write-baseline` in a repo with a custom
    // `baseline:` recorded into a second file nothing reads.
    //
    // Commander hands the core `true` for an omitted value, which is exactly the
    // signal needed to tell the two cases apart.
    .addOption(
      new Option(
        "--baseline [path]",
        "compare against a baseline; fail only on new findings",
      ),
    )
    .addOption(
      new Option(
        "--write-baseline [path]",
        "record current findings as the baseline, then exit 0 (stdin findings are not recorded and still fail)",
      ),
    )
    .option("--no-baseline", "ignore a baseline configured by `baseline:`")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  docmeta validate docs/                       # walk a directory",
        '  docmeta validate "**/*.md" -f github         # CI annotations',
        '  docmeta validate "**/*.md" -f sarif > o.sarif # code scanning',
        "  docmeta validate page.md -s google:okf:0.1 -s ./my.schema.json",
        "  cat page.md | docmeta validate - --as markdown",
        "  docmeta validate --write-baseline            # record today's backlog",
        "  docmeta validate --baseline                  # fail only on new findings",
      ].join("\n"),
    )
    .action(
      async (paths: string[], options: ValidateCliOptions, command: Command) => {
        try {
          // `validate` is the default command, so a misspelled subcommand lands
          // here as a path. Upgrade the message before it becomes "not found".
          suggestCommand(paths[0], process.cwd());
          const format = options.format;
          if (!isReportFormat(format)) {
            throw new DocmetaError(
              `Unknown --format "${format}". Use ${REPORT_FORMAT_LIST}.`,
            );
          }
          const exts: string[] | undefined = options.ext
            ? splitList(options.ext)
            : undefined;
          const stdinContent = paths.includes("-")
            ? await readStdin()
            : undefined;

          const { results, summary, frame } = await runValidate({
            inputs: paths,
            cliSchemas: options.schema,
            exts,
            exclude: options.exclude,
            as: options.as,
            ...configOption(options.config),
            onConfigLoaded: reportConfig(
              !isMachineFormat(format),
              process.cwd(),
            ),
            stdinContent,
            // `undefined` rather than `false` when the flag is absent, so config
            // `allowEmpty:` still wins (the cores do `opts ?? config`).
            allowEmpty: options.allowEmpty ? true : undefined,
            respectGitignore: gitignoreFlag(options.gitignore),
            // `undefined` rather than `false` when absent, so config `offline:`
            // still decides.
            offline: options.offline ? true : undefined,
            onNotice: notice,
            // `--baseline` and `--no-baseline` share one commander attribute, the
            // same three-state `undefined | string | false` split as `-c` /
            // `--no-config`: absent leaves the config in charge, a string names a
            // file, `false` suppresses a configured one for this run.
            baseline: options.baseline,
            writeBaseline: options.writeBaseline,
          });

          const color = resolveColor(command.parent ?? command);
          const text = render(format, results, summary, {
            color,
            quiet: Boolean(options.quiet),
            // Non-presentational: SARIF needs to know where the run stood before
            // it can name a file the way the repository does.
            frame,
            onNotice: notice,
          });
          // Only `github` may say nothing on a clean run. Every other format owes
          // its envelope even when it is empty — see `OMITTED_WHEN_CLEAN`.
          if (text.length > 0 || !OMITTED_WHEN_CLEAN.has(format)) {
            process.stdout.write(`${text}\n`);
          }
          process.exitCode = summary.failed > 0 ? 1 : 0;
        } catch (err) {
          fail(err);
        }
      },
    );

  program
    .command("get")
    .description("Print metadata field values from the given files/dirs/globs")
    // Optional, and the flag below is the unambiguous spelling. A required
    // positional ate the user's *path* when the field list was forgotten, and
    // reported the paths — which were never the problem — as missing.
    .argument(
      "[fields]",
      "comma-separated metadata fields to print, unless --fields is given",
    )
    .argument(
      "[paths...]",
      "files, directories, or globs to read (use - for stdin)",
    )
    .option(
      "--fields <list>",
      "comma-separated metadata fields to print; every positional is then a path",
    )
    .option("--ext <list>", "comma-separated extensions for directory walks")
    .option("--exclude <glob>", "glob to exclude; repeatable", collect, [])
    .option("--as <format>", "force an input format (e.g. markdown, mdx)")
    .option(
      "-f, --format <format>",
      `output: ${COMMON_FORMATS.join(" | ")}`,
      "pretty",
    )
    .option("-c, --config <path>", "path to a docmeta config file")
    .option("--no-config", "ignore any discovered config file")
    .option(
      "-q, --quiet",
      "in pretty output, hide files where every requested field is unset",
    )
    .option("--allow-empty", "treat zero matched files as success")
    .option("--no-gitignore", "read files .gitignore covers")
    .option(
      "--offline",
      "never fetch a remote schema; resolve URL refs from the schema cache",
    )
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  docmeta get title,type docs/intro.md",
        "  docmeta get --fields title,type docs/intro.md",
        "  docmeta get author.name,/author/email docs/intro.md",
        '  docmeta get type "**/*.md" -f json',
        "  cat page.md | docmeta get title - --as markdown",
      ].join("\n"),
    )
    .action(
      async (
        fieldsArg: string | undefined,
        pathsArg: string[],
        options: GetCliOptions,
        command: Command,
      ) => {
        try {
          const format = assertCommonFormat(options.format);
          const { fields, paths } = resolveGetInputs(
            fieldsArg,
            pathsArg,
            options.fields,
            process.cwd(),
          );
          const exts: string[] | undefined = options.ext
            ? splitList(options.ext)
            : undefined;
          const stdinContent = paths.includes("-")
            ? await readStdin()
            : undefined;

          const results = await runGet({
            fields,
            inputs: paths,
            as: options.as,
            exclude: options.exclude,
            exts,
            ...configOption(options.config),
            onConfigLoaded: reportConfig(format === "pretty", process.cwd()),
            stdinContent,
            allowEmpty: options.allowEmpty ? true : undefined,
            respectGitignore: gitignoreFlag(options.gitignore),
            offline: options.offline ? true : undefined,
            onNotice: notice,
          });
          switch (format) {
            case "json":
              // `--quiet` is a pretty-output affordance; a filtered array would
              // be indistinguishable from an empty run to whatever parses this.
              process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
              break;
            case "pretty": {
              const text = renderGet(results, fields, {
                color: resolveColor(command.parent ?? command),
                quiet: Boolean(options.quiet),
              });
              if (text.length > 0) process.stdout.write(`${text}\n`);
              break;
            }
            default: {
              const unreachable: never = format;
              throw new DocmetaError(
                `Unknown --format ${JSON.stringify(unreachable)}. Use ${COMMON_FORMAT_LIST}.`,
              );
            }
          }
        } catch (err) {
          fail(err);
        }
      },
    );

  program
    .command("query")
    .description("Run SQL over the metadata of the given files/dirs/globs")
    // Optional for the same reason `get`'s `[fields]` is: a required
    // positional would eat the user's *path* when the SQL was forgotten.
    .argument("[sql]", "SQL to run against the `docs` table, unless --query is given")
    .argument(
      "[paths...]",
      "files, directories, or globs to load (use - for stdin)",
    )
    .option(
      "--query <sql>",
      "SQL to run against the `docs` table; every positional is then a path",
    )
    .option(
      "--check",
      "treat returned rows as findings: exit 1 if the query returns any",
    )
    .option("--ext <list>", "comma-separated extensions for directory walks")
    .option("--exclude <glob>", "glob to exclude; repeatable", collect, [])
    .option("--as <format>", "force an input format (e.g. markdown, mdx)")
    .option(
      "-f, --format <format>",
      `output: ${COMMON_FORMATS.join(" | ")}`,
      "pretty",
    )
    .option("-c, --config <path>", "path to a docmeta config file")
    .option("--no-config", "ignore any discovered config file")
    .option("--allow-empty", "treat zero matched files as success")
    .option("--no-gitignore", "load files .gitignore covers")
    .option(
      "--offline",
      "never fetch a remote schema; resolve URL refs from the schema cache",
    )
    .addHelpText(
      "after",
      [
        "",
        "One row per file in a table named `docs`: your top-level metadata keys",
        "as columns, plus _path, _format, _present, and _data (all metadata as",
        "JSON, for json_each/->> reach into nested values).",
        "",
        "Examples:",
        '  docmeta query "SELECT _path, title FROM docs WHERE draft = 1" docs/',
        '  docmeta query "SELECT t.value tag, count(*) n FROM docs, json_each(docs.tags) t GROUP BY tag" docs/',
        '  docmeta query --check "SELECT slug, count(*) n FROM docs GROUP BY slug HAVING n > 1" docs/',
        '  cat page.md | docmeta query "SELECT title FROM docs" - --as markdown',
      ].join("\n"),
    )
    .action(
      async (
        sqlArg: string | undefined,
        pathsArg: string[],
        options: QueryCliOptions,
        command: Command,
      ) => {
        try {
          const format = assertCommonFormat(options.format);
          const { sql, paths } = resolveQueryInputs(
            sqlArg,
            pathsArg,
            options.query,
            process.cwd(),
          );
          const exts: string[] | undefined = options.ext
            ? splitList(options.ext)
            : undefined;
          const stdinContent = paths.includes(STDIN)
            ? await readStdin()
            : undefined;

          const run = await runQuery({
            sql,
            inputs: paths,
            as: options.as,
            exclude: options.exclude,
            exts,
            ...configOption(options.config),
            onConfigLoaded: reportConfig(format === "pretty", process.cwd()),
            stdinContent,
            allowEmpty: options.allowEmpty ? true : undefined,
            respectGitignore: gitignoreFlag(options.gitignore),
            offline: options.offline ? true : undefined,
            onNotice: notice,
          });
          switch (format) {
            case "json":
              // The bare row array, mirroring `get`'s bare result array. The
              // `--check` verdict travels in the exit code, not the envelope.
              process.stdout.write(`${JSON.stringify(run.rows, null, 2)}\n`);
              break;
            case "pretty": {
              const text = renderQuery(run, {
                color: resolveColor(command.parent ?? command),
                check: Boolean(options.check),
              });
              if (text.length > 0) process.stdout.write(`${text}\n`);
              break;
            }
            default: {
              const unreachable: never = format;
              throw new DocmetaError(
                `Unknown --format ${JSON.stringify(unreachable)}. Use ${COMMON_FORMAT_LIST}.`,
              );
            }
          }
          // Rows from a `--check` run are findings; a plain query's rows are
          // the answer the user asked for, so both outcomes are success.
          process.exitCode = options.check && run.rows.length > 0 ? 1 : 0;
        } catch (err) {
          fail(err);
        }
      },
    );

  program
    .command("fill")
    .description(
      "Infer missing or invalid metadata and write values above the confidence threshold",
    )
    .argument(
      "[paths...]",
      "files, directories, or globs to fill (use - for stdin)",
    )
    .option(
      "-s, --schema <ref>",
      "schema to fill against; repeatable; overrides $schema/config",
      collect,
      [],
    )
    .option("--ext <list>", "comma-separated extensions for directory walks")
    .option("--exclude <glob>", "glob to exclude; repeatable", collect, [])
    .option("--as <format>", "force an input format (e.g. markdown, mdx)")
    .option("--fields <list>", "comma-separated fields to fill")
    .option("--confidence <n>", "minimum confidence to write (0-1)", parseFloat)
    .option("--dry-run", "report proposals without writing them")
    .option(
      "--provider <name>",
      "provider: auto (default), anthropic, openai, claude-cli, llama-cpp, mock",
    )
    .option(
      "--model <model>",
      "model override; needs a named provider, from here or config",
    )
    .option("--no-cache", "bypass the proposal cache")
    .option(
      "--local",
      "run inference on this machine; refuses any hosted provider, claude-cli included",
    )
    .option("--max-turns <n>", "stop after this many inference calls", parseFloat)
    .option(
      "--chunk-chars <n>",
      "characters of document per call (default 12000)",
      parseFloat,
    )
    // parseFloat, not parseInt: parseInt("3.5") silently yields 3, which would
    // defeat runFill's integer check and hide the mistake from the user.
    .option("--concurrency <n>", "files inferred in parallel", parseFloat)
    .option(
      "-f, --format <format>",
      `output: ${FILL_FORMATS.join(" | ")}`,
      "pretty",
    )
    .option("-c, --config <path>", "path to a docmeta config file")
    .option("--no-config", "ignore any discovered config file")
    .option(
      "-q, --quiet",
      "in pretty output, hide files with nothing written and nothing required left undone",
    )
    .option("--allow-empty", "treat zero matched files as success")
    .option("--no-gitignore", "fill files .gitignore covers")
    .option(
      "--offline",
      "never fetch a remote schema; resolve URL refs from the schema cache",
    )
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  docmeta fill docs/ --dry-run                 # preview proposals",
        "  docmeta fill docs/ --confidence 0.9          # only near-certain values",
        "  docmeta fill page.md --fields description",
        "  docmeta fill docs/ -f github                 # CI annotations",
        "  cat page.md | docmeta fill - --as markdown   # filled doc to stdout",
      ].join("\n"),
    )
    .action(async (paths: string[], options: FillCliOptions, command: Command) => {
      try {
        const format = options.format;
        if (!isFillFormat(format)) {
          throw new DocmetaError(
            `Unknown --format "${format}". Use ${FILL_FORMAT_LIST}.`,
          );
        }
        // parseFloat("abc") is NaN, and every comparison against NaN is false,
        // so a bare range check would silently accept garbage.
        numeric("--confidence", options.confidence, 0, 1);
        numeric("--max-turns", options.maxTurns, 1, Number.MAX_SAFE_INTEGER);
        numeric(
          "--chunk-chars",
          options.chunkChars,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        numeric("--concurrency", options.concurrency, 1, 64);

        const exts: string[] | undefined = options.ext
          ? splitList(options.ext)
          : undefined;
        const usingStdin = paths.includes(STDIN);
        // With `-` the filled document owns stdout and the report is a
        // diagnostic on stderr — where GitHub never reads `::error`. The
        // annotations would be produced, and nothing would ever render them.
        // Refuse the combination rather than degrade to a silent no-op, which
        // is the exact false green this parity work exists to remove.
        if (usingStdin && format === "github") {
          throw new DocmetaError(
            'Cannot use --format github with stdin ("-"): the filled document owns stdout, so the annotations would go to stderr, where GitHub ignores them. Pass file paths instead.',
          );
        }
        const stdinContent = usingStdin ? await readStdin() : undefined;

        const run = await runFill({
          inputs: paths,
          cliSchemas: options.schema,
          exts,
          exclude: options.exclude,
          as: options.as,
          ...configOption(options.config),
          // With `-` the filled document owns stdout, so the notice is a
          // diagnostic there just as the report is.
          onConfigLoaded: reportConfig(
            format === "pretty" && !usingStdin,
            process.cwd(),
          ),
          stdinContent,
          allowEmpty: options.allowEmpty ? true : undefined,
          respectGitignore: gitignoreFlag(options.gitignore),
          offline: options.offline ? true : undefined,
          onNotice: notice,
          fields: options.fields ? splitList(options.fields) : undefined,
          confidence: options.confidence,
          dryRun: Boolean(options.dryRun),
          provider: options.provider,
          model: options.model,
          cache: options.cache,
          local: Boolean(options.local),
          maxTurns: options.maxTurns,
          chunkChars: options.chunkChars,
          concurrency: options.concurrency,
          includeContent: usingStdin,
        });

        const color = resolveColor(command.parent ?? command);
        const report = renderFill(format, run, {
          color,
          quiet: Boolean(options.quiet),
        });
        if (usingStdin) {
          // The filled document owns stdout here; the report is a diagnostic.
          const filled = run.results[0]?.content;
          if (filled != null) process.stdout.write(filled);
          if (report.length > 0) process.stderr.write(`${report}\n`);
        } else if (report.length > 0) {
          process.stdout.write(`${report}\n`);
        }

        // A field the schema requires that could not be filled confidently is
        // work left undone, so CI should see it. Optional fields are not.
        process.exitCode =
          run.summary.requiredSkipped > 0 || run.summary.errors > 0 ? 1 : 0;
      } catch (err) {
        fail(err);
      }
    });

  // `-f, --format` stays on the parent rather than moving to a `list`
  // subcommand: bare `docmeta schemas` is a *default action*, not group help,
  // and both are part of the documented surface.
  const schemas = program
    .command("schemas")
    .description("List built-in schemas and supported input formats")
    .option(
      "-f, --format <format>",
      `output: ${COMMON_FORMATS.join(" | ")}`,
      "pretty",
    )
    .action((options: SchemasCliOptions, command: Command) => {
      try {
        // A closed set, checked like every other command's --format. This used
        // to be a bare `=== "json" ? json : pretty`, so `schemas -f github`
        // printed a pretty listing and exited 0 — a request docmeta cannot
        // honor, answered with success in a different format. `github` is the
        // case that matters: it is a real docmeta format, just not one this
        // command produces, so nothing about the invocation looked wrong.
        const format = assertCommonFormat(options.format);
        const info = getSchemasInfo();
        if (format === "json") {
          process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
          return;
        }
        const c = palette(resolveColor(command.parent ?? command));
        const lines: string[] = [c.bold("Built-in schemas:")];
        for (const b of info.builtins) {
          lines.push(`  ${c.cyan(b.id)}  ${c.dim("—")}  ${b.title}`);
        }
        lines.push("", c.bold("Input formats:"));
        for (const f of info.formats) {
          const tags = [
            f.implemented ? c.green("implemented") : c.dim("planned"),
          ];
          // Only worth surfacing on formats that can actually be read.
          if (f.implemented) {
            tags.push(f.writable ? c.green("writable") : c.dim("read-only"));
          }
          lines.push(
            `  ${f.name} (${f.extensions.join(", ")})  [${tags.join(", ")}]`,
          );
        }
        process.stdout.write(`${lines.join("\n")}\n`);
      } catch (err) {
        fail(err);
      }
    });

  schemas
    .command("infer")
    .description(
      "Report metadata coverage across a docset, and draft a schema from what is there",
    )
    .argument(
      "[paths...]",
      "files, directories, or globs to scan (use - for stdin)",
    )
    .option("--out <path>", "write the draft schema here")
    // Default 0, and it must stay 0. A default that hid the long tail would
    // hide exactly the "3% is one team's convention, not a standard" signal the
    // report exists to surface.
    .option(
      "--min-coverage <pct>",
      "hide keys below this coverage percentage",
      parseFloat,
      0,
    )
    .option("--ext <list>", "comma-separated extensions for directory walks")
    .option("--exclude <glob>", "glob to exclude; repeatable", collect, [])
    .option("--as <format>", "force an input format (e.g. markdown, mdx)")
    .option(
      "-f, --format <format>",
      `output: ${COMMON_FORMATS.join(" | ")}`,
      "pretty",
    )
    .option("-c, --config <path>", "path to a docmeta config file")
    .option("--no-config", "ignore any discovered config file")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  docmeta schemas infer docs/                  # what does this repo have?",
        "  docmeta schemas infer docs/ --min-coverage 5 # drop the long tail",
        "  docmeta schemas infer docs/ --out ./schemas/permissive.json",
        "  docmeta schemas infer docs/ -f json",
        "",
        "Purely statistical and offline: no provider, no network, no model. The",
        "draft never marks anything `required` — coverage is your decision to",
        "make, not the tool's.",
      ].join("\n"),
    )
    .action(async (paths: string[], options: InferCliOptions, command: Command) => {
      try {
        const format = assertCommonFormat(formatFor(command, options.format));
        numeric("--min-coverage", options.minCoverage, 0, 100);
        const exts: string[] | undefined = options.ext
          ? splitList(options.ext)
          : undefined;
        const stdinContent = paths.includes(STDIN)
          ? await readStdin()
          : undefined;

        const result = await runInferSchema({
          inputs: paths,
          exts,
          exclude: options.exclude,
          as: options.as,
          ...configOption(options.config),
          onConfigLoaded: reportConfig(format === "pretty", process.cwd()),
          stdinContent,
          out: options.out,
          minCoverage: options.minCoverage,
          onNotice: notice,
        });

        if (format === "json") {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        const text = renderInfer(result, {
          color: resolveColor(command.parent?.parent ?? command),
        });
        process.stdout.write(`${text}\n`);
      } catch (err) {
        fail(err);
      }
    });

  schemas
    .command("vendor")
    .description(
      "Download a remote schema into this repository and pin it in config",
    )
    .argument("<url>", "http(s) URL of the schema to vendor")
    .option(
      "--dir <path>",
      "directory for the committed copy",
      DEFAULT_VENDOR_DIR,
    )
    .option("-c, --config <path>", "path to a docmeta config file")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  docmeta schemas vendor https://schemas.example.com/house/2.1.json",
        "  docmeta schemas vendor https://schemas.example.com/house/2.1.json --dir ./contracts",
        "",
        "Commit both the downloaded file and the config change: the point of",
        "vendoring is that CI validates against a copy in your own history.",
      ].join("\n"),
    )
    .action(async (url: string, options: VendorCliOptions) => {
      try {
        const result = await runVendorSchema({
          url,
          dir: options.dir,
          // `typeof === "string"`, not `!== undefined`. `vendor` is the one
          // config-taking command with no `--no-config`, and the parity rule in
          // CLAUDE.md points straight at adding one — at which point commander
          // starts passing `false` here. The annotation on `VendorCliOptions`
          // says that cannot happen, so it would not be caught at the point the
          // flag is declared; this test is what keeps a `false` out of a field
          // that must be a path.
          ...(typeof options.config === "string"
            ? { configPath: options.config }
            : {}),
          onNotice: notice,
        });
        // Three states, and the operator needs to be able to tell them apart in
        // a diff: a config was created, an existing reference was replaced (the
        // re-vendor and the bare-URL migration both land here), or an entry was
        // added beside what was already there.
        const configNote = result.configCreated
          ? "created"
          : result.replaced
            ? "reference updated"
            : "reference added";
        process.stdout.write(
          [
            `Vendored ${result.url}`,
            `  file       ${result.file} (${result.bytes} bytes${result.unchanged ? ", unchanged" : ""})`,
            `  integrity  ${result.integrity}`,
            `  config     ${result.config} (${configNote})`,
            "",
            `Commit ${result.file} and ${result.config} so CI validates against this copy.`,
          ].join("\n") + "\n",
        );
      } catch (err) {
        fail(err);
      }
    });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    // `exitOverride()` makes commander throw on every terminating condition,
    // including the successful ones. Branch on `err.exitCode`, not on a list of
    // code strings: `--help` is `commander.helpDisplayed`, `-V` is
    // `commander.version`, and `docmeta help get` is a third code,
    // `commander.help` — all carrying exitCode 0, and a hand-written list would
    // eventually miss one and turn a success into a usage error.
    if (err instanceof CommanderError) {
      // Say nothing. `Command.error()` has already written the message and the
      // after-error hint; `fail()` would add "Unexpected error: …" on top,
      // because a CommanderError is not a DocmetaError.
      //
      // `process.exitCode`, not `process.exit()`: Node does not flush queued
      // async stderr writes on `process.exit`, which truncates the very message
      // the user needs.
      process.exitCode = err.exitCode === 0 ? 0 : 2;
      return;
    }
    throw err;
  }
}

/** Run only when executed directly (not when imported by tests). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch(fail);
}
