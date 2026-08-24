/**
 * `schemas` command core. Reports built-in schemas and supported input formats,
 * vendors a remote schema into the repository, and infers a coverage report
 * (plus a draft schema) from the metadata a docset already carries.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument, stringify } from "yaml";
import { resolveElements } from "../core/resolve-schema.js";
import { DocmetaError } from "../types.js";
import {
  fetchSchemaBytes,
  listBuiltins,
  type BuiltinInfo,
} from "../core/schema-registry.js";
import {
  extractorByName,
  extractorForExtension,
  listFormats,
  supportedExtensions,
} from "../extractors/index.js";
import { integrityOf } from "../core/integrity.js";
import { gitIgnored } from "../core/gitignore.js";
import {
  parseConfig,
  loadConfig,
  resolveRunConfig,
  type ConfigNotice,
  type SchemaEntry,
} from "../core/config.js";
import {
  assertNonEmpty,
  gitignoreOptions,
  resolveTargetSet,
  STDIN_LABEL,
  STDIN_TOKEN,
} from "../core/load-files.js";
import { writeFileAtomic } from "../core/write-file.js";

export interface SchemasInfo {
  builtins: BuiltinInfo[];
  formats: {
    name: string;
    extensions: string[];
    implemented: boolean;
    /** Whether `docmeta fill` can write metadata back to this format. */
    writable: boolean;
  }[];
}

export function getSchemasInfo(): SchemasInfo {
  return { builtins: listBuiltins(), formats: listFormats() };
}

/**
 * Where a vendored schema lands by default.
 *
 * **Not** `.docmeta/`, which is gitignored wholesale and holds the schema and
 * proposal caches. A vendored schema is the opposite kind of artifact: it has
 * to be committed, because being in the consuming repository's own history is
 * the entire point of vendoring.
 */
export const DEFAULT_VENDOR_DIR = "./schema";

/** The config file `vendor` creates when a repository has none. */
export const DEFAULT_CONFIG_NAME = "docmeta.config.yaml";

export interface VendorOptions {
  /** The `http(s)` URL to download. */
  url: string;
  /** Directory for the vendored copy, relative to `cwd`. Default `./schema`. */
  dir?: string;
  /** `-c/--config`. Absent discovers a config, or creates one in `cwd`. */
  configPath?: string;
  cwd?: string;
  /** Diagnostics for the user; the CLI writes these to stderr. */
  onNotice?: (message: string) => void;
  /** Fetch timeout, in ms. Defaults to the registry's. */
  timeoutMs?: number;
  /** Response size cap, in bytes. Defaults to the registry's. */
  maxBytes?: number;
}

export interface VendorResult {
  /** The URL that was downloaded. */
  url: string;
  /** The vendored file, relative to `cwd`, posix-style. */
  file: string;
  /** The pin recorded for it. */
  integrity: string;
  /** Size of the vendored copy, in bytes. */
  bytes: number;
  /** The config that was written, relative to `cwd`, posix-style. */
  config: string;
  /** Whether that config had to be created. */
  configCreated: boolean;
  /** Whether an existing `schemas:` entry was replaced rather than appended. */
  replaced: boolean;
  /** Whether the downloaded bytes were identical to the copy already on disk. */
  unchanged: boolean;
}

/** A path spelled the way git and a config both want it: relative, posix. */
function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/**
 * The filename for a vendored schema, derived from the URL's last path segment.
 *
 * Sanitized rather than trusted: the segment reaches the filesystem, so
 * anything that is not an ordinary filename character is replaced, and a
 * leading dot is prefixed away so the copy cannot land as a hidden file that
 * directory walks skip.
 */
export function vendorFileName(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DocmetaError(`"${url}" is not a valid URL.`);
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  // `new URL` carries a malformed escape like `%zz` through untouched — the
  // WHATWG parser does not validate percent-encoding — so the segment reaches
  // here and `decodeURIComponent` throws `URIError`, which is not a
  // `DocmetaError` and escaped as an unhandled stack trace. Decoding is only a
  // nicety: the result is sanitized to `[A-Za-z0-9._-]` regardless, so an
  // undecodable segment is used as written.
  let decoded: string;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }
  let name = decoded.replace(/[^A-Za-z0-9._-]/g, "-");
  // No usable segment at all (`https://host/`): fall back to the host, which is
  // at least recognizable in a diff.
  if (name === "" || /^\.+$/.test(name)) {
    name = parsed.hostname.replace(/[^A-Za-z0-9._-]/g, "-");
  }
  if (name.startsWith(".")) name = `schema${name}`;
  if (!name.toLowerCase().endsWith(".json")) name += ".json";
  return name;
}

/**
 * Refuse a target `.gitignore` covers.
 *
 * The highest-value guard in this command. A vendored schema that git ignores
 * validates perfectly on the machine that downloaded it and is simply *absent*
 * on CI, where the failure arrives as a missing schema file in a repository
 * nobody changed.
 *
 * Three states, all of them enumerated. Git says the path is ignored — refuse,
 * naming whichever of the directory or the file matched, since the fix differs.
 * Git says it is not — proceed. Git cannot answer at all (no repository here,
 * no `git` on `PATH`) — proceed, but say so: refusing every non-repository
 * would make the command unusable in an extracted tarball, and staying silent
 * would claim a check that never ran.
 */
async function assertNotIgnored(
  absFile: string,
  absDir: string,
  cwd: string,
  onNotice: ((message: string) => void) | undefined,
  text: IgnoreGuardText = VENDOR_IGNORE_TEXT,
): Promise<void> {
  const relFile = posixRelative(cwd, absFile);
  const relDir = posixRelative(cwd, absDir);
  const candidates = [relFile];
  // "" is cwd itself, and a path outside cwd is not something git can be asked
  // about relative to here.
  if (relDir !== "" && !relDir.startsWith("..")) candidates.push(relDir);

  const answer = await gitIgnored(candidates, cwd);
  if (!answer.available) {
    onNotice?.(text.unchecked(relDir || "."));
    return;
  }

  const ignoredDir = answer.ignored.has(relDir);
  const ignoredFile = answer.ignored.has(relFile);
  if (!ignoredDir && !ignoredFile) return;

  // Name the broadest thing git actually flagged. Both spellings are asked
  // about because a directory-only pattern (`vendor/`) does not match the bare
  // path `vendor` while the directory does not yet exist on disk — git can only
  // answer for the file underneath it. Which of the two matched is therefore a
  // fact about the pattern's shape, not about which rule the user should edit,
  // so the remedy names both routes rather than guessing.
  throw new DocmetaError(text.refusal(ignoredDir ? relDir : relFile));
}

/**
 * The two messages the guard above needs, so the *mechanic* is shared and the
 * *wording* is not.
 *
 * `vendor` and `infer --out` refuse for the same structural reason — a file git
 * ignores is present locally and absent in CI — but the remedy differs (`--dir`
 * versus `--out`), and a message naming the wrong flag sends the reader to the
 * wrong place. Parameterizing beat writing a second copy of the three-state
 * logic, which is where the subtle half of this check lives.
 */
interface IgnoreGuardText {
  /** Git says the path is ignored. `target` is whichever spelling matched. */
  refusal(target: string): string;
  /** Git could not answer at all. `where` is the directory, or ".". */
  unchecked(where: string): string;
}

const VENDOR_IGNORE_TEXT: IgnoreGuardText = {
  refusal: (target) =>
    `Refusing to vendor into "${target}": git reports it as ignored. A vendored schema has to be committed — an ignored copy validates on this machine and is simply missing in CI, where the failure reads as a schema nobody changed. Vendor into a directory your repository tracks (\`--dir\`, default \`${DEFAULT_VENDOR_DIR}\`), or drop the .gitignore rule covering this path.`,
  unchecked: (where) =>
    `could not check .gitignore for "${where}" (no repository here, or no git on PATH). A vendored schema must be committed — make sure this path is tracked.`,
};

const DRAFT_IGNORE_TEXT: IgnoreGuardText = {
  refusal: (target) =>
    `Refusing to write the draft schema into "${target}": git reports it as ignored. A generated schema you cannot commit validates on this machine and is simply absent in CI, where the failure reads as a schema nobody changed. Pass an --out path your repository tracks, or drop the .gitignore rule covering this one.`,
  unchecked: (where) =>
    `could not check .gitignore for "${where}" (no repository here, or no git on PATH). A draft schema has to be committed to be worth anything in CI — make sure this path is tracked.`,
};

/**
 * Fold the vendored entry into a `schemas:` list.
 *
 * Replaces rather than appends whenever the list already speaks about this
 * schema, in any of the three spellings it can take: the bare URL a
 * pre-vendoring config carried, an earlier vendored entry naming the same
 * `source`, or an entry already pointing at the same `ref`. Appending instead
 * would leave the URL live beside its own local copy, so the run would still
 * depend on the host being up — the exact failure vendoring removes.
 */
function foldEntry(
  entries: SchemaEntry[],
  next: { ref: string; source: string; integrity: string },
): { entries: SchemaEntry[]; replaced: boolean; displacedSource?: string } {
  const speaksAbout = (entry: SchemaEntry): boolean =>
    typeof entry === "string"
      ? entry === next.source || entry === next.ref
      : entry.ref === next.ref || entry.source === next.source;

  const index = entries.findIndex(speaksAbout);
  if (index === -1) return { entries: [...entries, next], replaced: false };

  // Matched on `ref` while naming a *different* origin. Two hosts serving
  // different schemas whose URLs end in the same segment both default to the
  // same filename, so this replaces one pinned contract with another and the
  // "already exists and is not ours" guard reads it as a re-vendor. Doing it is
  // right — the command was asked to — but the caller reports it, because a
  // pinned entry silently changing meaning is not something to find out from a
  // diff later.
  const displacedSource = entries
    .filter(speaksAbout)
    .map((entry) => (typeof entry === "string" ? undefined : entry.source))
    .find((source) => source !== undefined && source !== next.source);
  // Every match collapses into the one entry, not just the first. A config
  // carrying both the bare URL and an earlier vendored ref would otherwise keep
  // the one that was not replaced — leaving the list disagreeing with itself
  // about whether the schema is pinned.
  return {
    entries: entries.flatMap((entry, i) =>
      i === index ? [next] : speaksAbout(entry) ? [] : [entry],
    ),
    replaced: true,
    ...(displacedSource !== undefined ? { displacedSource } : {}),
  };
}

/**
 * Serialize the updated config, preserving everything else in the file.
 *
 * `parseDocument` keeps comments and key order, so a config someone documented
 * comes back documented — including one that is nothing *but* comments, which
 * is why an empty file is not special-cased here. Only `schemas:` is rewritten;
 * comments written *inside* the old `schemas:` list are the one thing that does
 * not survive, because the list itself is replaced.
 */
function renderConfig(existing: string | null, entries: SchemaEntry[]): string {
  // No file at all is the one case with nothing to preserve.
  if (existing === null) return stringify({ schemas: entries });
  const doc = parseDocument(existing);
  doc.set("schemas", entries);
  return doc.toString();
}

/**
 * Download a remote schema into the repository and pin it.
 *
 * The order of operations is the contract: everything that can refuse does so
 * *before* the network call or the write, so a refused run leaves the working
 * tree exactly as it found it.
 */
export async function runVendorSchema(
  opts: VendorOptions,
): Promise<VendorResult> {
  const cwd = opts.cwd ?? process.cwd();
  const url = opts.url;

  if (!/^https?:\/\//i.test(url)) {
    throw new DocmetaError(
      `\`docmeta schemas vendor\` takes an http(s) URL to download; "${url}" is ${/^[a-z0-9][a-z0-9._-]*:/i.test(url) && !url.includes("/") ? "a built-in id, which is already bundled" : "a local reference, which is already in your repository"}.`,
    );
  }

  // Load first, so a malformed or missing config fails before anything is
  // downloaded or written.
  const loaded = await loadConfig(opts.configPath, cwd);
  const configPath = loaded?.path ?? resolve(cwd, DEFAULT_CONFIG_NAME);
  const configDir = loaded?.dir ?? cwd;

  const absDir = resolve(cwd, opts.dir ?? DEFAULT_VENDOR_DIR);
  const absFile = join(absDir, vendorFileName(url));

  await assertNotIgnored(absFile, absDir, cwd, opts.onNotice);

  // The ref is written into the config, so it is relative to the **config**,
  // not to wherever the command was run from — that is what makes it resolve
  // the same way from a subdirectory, from the repo root, and in CI.
  const fromConfig = posixRelative(configDir, absFile);
  const ref =
    isAbsolute(fromConfig) || fromConfig === ""
      ? absFile
      : fromConfig.startsWith(".")
        ? fromConfig
        : `./${fromConfig}`;

  const { bytes } = await fetchSchemaBytes(url, {
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });
  const integrity = integrityOf(bytes);

  const entries = loaded?.config.schemas ?? [];
  const folded = foldEntry(entries, { ref, source: url, integrity });
  if (folded.displacedSource !== undefined) {
    opts.onNotice?.(
      `"${ref}" was vendored from ${folded.displacedSource}; replacing it with ${url}.`,
    );
  }

  // Whether this path is already ours. Three states: nothing there, our own
  // earlier copy (a re-vendor, which is the update path), or a file that
  // belongs to something else — which must not be silently overwritten just
  // because two schemas share a last URL segment.
  let unchanged = false;
  if (existsSync(absFile)) {
    const current = await readFile(absFile);
    unchanged = bytes.equals(current);
    if (!unchanged && !folded.replaced) {
      throw new DocmetaError(
        `"${posixRelative(cwd, absFile)}" already exists and is not the copy this config points at, so vendoring ${url} here would overwrite it. Vendor into a different directory with --dir, or remove that file first.`,
      );
    }
  }

  await mkdir(absDir, { recursive: true });
  await writeFileAtomic(absFile, bytes);

  const existing = loaded ? await readFile(configPath, "utf8") : null;
  const text = renderConfig(existing, folded.entries);
  // Parse what is about to be written rather than trusting the serializer. A
  // config docmeta itself cannot read is worse than a failed vendor, and this
  // is the last moment it can be caught before it reaches disk.
  parseConfig(text, posixRelative(cwd, configPath) || DEFAULT_CONFIG_NAME);
  await writeFileAtomic(configPath, text);

  return {
    url,
    file: posixRelative(cwd, absFile),
    integrity,
    bytes: bytes.byteLength,
    config: posixRelative(cwd, configPath),
    configCreated: loaded === null,
    replaced: folded.replaced,
    unchanged,
  };
}

// ---------------------------------------------------------------------------
// `docmeta schemas infer` (0010)
//
// Purely statistical and **offline**: no provider, no network, no schema
// resolution. It counts the metadata keys a docset already carries, so the
// question "should I require this field?" has an answer before anyone edits a
// schema. The coverage report is the product; the draft schema is a by-product.
//
// Deliberate limits, stated here rather than discovered later:
//
// - **Top-level keys only.** Coverage of `author` is the standard-level
//   question; `author.name` is a schema-authoring detail, and reporting both
//   would bury the first under the second on any docset with nested metadata.
// - **`-` (stdin) is accepted** for input-model parity, and yields a one-file
//   report. Not useful, not wrong: excluding it would be the exceptional case
//   needing an argument, and every other path-taking command takes it.
// - **`--min-coverage` defaults to 0.** A default that hid the long tail would
//   hide exactly the "3% is one team's convention, not a standard" signal the
//   report exists to surface.
// ---------------------------------------------------------------------------

/** Draft schemas are written against the same dialect the built-ins use. */
const DRAFT_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * Enum thresholds — **both** must hold (0010 stress test 4).
 *
 * The absolute cap alone would turn a 10-file repo with 7 hand-written `type`
 * values into a 7-value vocabulary; the ratio alone would turn a 30-file repo
 * of unique titles into a 30-value enum for prose.
 *
 * The ratio is measured against the files that **carry the key**, not against
 * every file scanned. Against the corpus, a key present in 5 files of 1,000
 * with 5 distinct values — every single occurrence unique, which is what free
 * text looks like — passes both thresholds and gets an enum of exactly those
 * five. The sixth value anyone writes is then rejected by a schema generated
 * from their own docset, which is the opposite of a draft that "constrains only
 * what it observed". Against occurrences the same key needs 5 <= 0.25 and is
 * correctly refused: whether a vocabulary exists is a question about this key's
 * own values, and corpus size has no bearing on it.
 */
const ENUM_MAX_DISTINCT = 20;
const ENUM_MAX_DISTINCT_RATIO = 0.05;

/**
 * How many distinct values are tracked per key before counting stops.
 *
 * Only the report's `distinct` column is affected, and it says so via
 * `distinctCapped`. The enum decision is unaffected: a key past this cap is
 * orders of magnitude past `ENUM_MAX_DISTINCT` already.
 */
const DISTINCT_CAP = 1000;

/** Outlier locations kept per non-dominant type, so one bad key cannot blow up memory. */
const OUTLIER_SAMPLE_CAP = 20;

export interface InferOptions {
  /** Positional inputs: files, directories, globs, and `-` for stdin. */
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
  /** `--out`: write the draft schema here, relative to `cwd`. */
  out?: string;
  /** `--min-coverage`: hide keys below this percentage. 0–100, default 0. */
  minCoverage?: number;
  /** Diagnostics for the user; the CLI writes these to stderr. */
  onNotice?: (message: string) => void;
  /** Called once when a config governs the run, so the CLI can report it. */
  onConfigLoaded?: (info: ConfigNotice) => void;
}

/** One observed type and how many files carried the key at that type. */
export interface InferTypeCount {
  type: string;
  count: number;
}

/** A file whose value for a key is not the dominant type. */
export interface InferOutlier {
  file: string;
  /** 1-based source line, when the extractor knows one. */
  line?: number;
  type: string;
}

export interface InferKeyReport {
  key: string;
  /** Files carrying this key. */
  present: number;
  /** `present` as a percentage of every file scanned, 0–100. */
  coverage: number;
  /** Observed types with counts, most common first. */
  types: InferTypeCount[];
  /** The type the draft encodes. Never a union — see stress test 3. */
  dominantType: string;
  /** Files at some other type, with locations. Capped; see `outlierCount`. */
  outliers: InferOutlier[];
  /** Every non-dominant occurrence, including any beyond `outliers`. */
  outlierCount: number;
  /** Distinct values seen, across all types. */
  distinct: number;
  /** Whether `distinct` stopped counting at `DISTINCT_CAP`. */
  distinctCapped: boolean;
  /** The candidate vocabulary, when both enum thresholds hold. */
  enumValues?: unknown[];
  /** The most common value, for the report's sample column. */
  sample?: unknown;
  /** `date`, `date-time`, or `uri` when every observed string matched one. */
  format?: string;
}

export interface InferResult {
  /** Every file read, including those with no metadata block. */
  filesScanned: number;
  /**
   * Files with no metadata block at all. Reported on its own line rather than
   * folded into a denominator: these pass a require-nothing schema and fail the
   * moment any key becomes required, which is the surprise worth naming.
   */
  filesWithoutMetadata: number;
  /** Files whose metadata block could not be parsed, with the reason. */
  unreadable: { file: string; message: string }[];
  /** Keys at or above `--min-coverage`, most-covered first. */
  keys: InferKeyReport[];
  /** Keys `--min-coverage` removed from `keys`. */
  hiddenByMinCoverage: number;
  /** The draft schema. Always produced; `--out` decides whether it is written. */
  draft: Record<string, unknown>;
  /** Where the draft was written, posix-relative to `cwd`. Absent without `--out`. */
  out?: string;
  /** Candidate documents `.gitignore` removed from the walk. */
  gitignoreSkipped: number;
}

/** Everything accumulated for one top-level key while scanning. */
interface KeyStats {
  present: number;
  /** type -> files seen at that type. */
  types: Map<string, number>;
  /** type -> where they were, capped at OUTLIER_SAMPLE_CAP each. */
  locations: Map<string, InferOutlier[]>;
  /** JSON of the value -> the value, its count, and its type. */
  values: Map<string, { value: unknown; count: number; type: string }>;
  distinctCapped: boolean;
  /** Whether an empty string was ever the value. Gates `minLength: 1`. */
  sawEmptyString: boolean;
}

/**
 * The JSON Schema type name for a runtime value.
 *
 * Integers are **not** split out from `number`. JSON Schema's `number` already
 * accepts them, and separating the two would report a key written `2` in some
 * files and `2.5` in others as having outliers it does not have.
 *
 * A `Date` reaches here only from TOML frontmatter, whose parser materializes
 * timestamps. It is reported as `string`, because that is how every other
 * frontmatter flavor carries a date and the draft describes the metadata
 * standard rather than one parser's object graph.
 */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "string";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
    case "bigint":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

/** The comparable form of a value: a Date is its ISO spelling, per `jsonTypeOf`. */
function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }
  return value;
}

const FORMAT_TESTS: [string, RegExp][] = [
  ["date", /^\d{4}-\d{2}-\d{2}$/],
  ["date-time", /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}/],
  ["uri", /^[a-z][a-z0-9+.-]*:\/\//i],
];

/**
 * A format annotation for the report's types column — `string (date)`.
 *
 * Report only. It is **not** written into the draft: whether `2026-04-01` is
 * *required* to be a date, or merely what everyone happened to write, is a
 * policy call, and the draft's rule is to encode only the shape it observed
 * (stress test 1). Skipped entirely once distinct counting was capped, since a
 * claim about "every value" cannot be made from a truncated sample.
 */
function formatOf(stats: KeyStats, dominantType: string): string | undefined {
  if (dominantType !== "string" || stats.distinctCapped) return undefined;
  const strings = [...stats.values.values()]
    .filter((v) => v.type === "string")
    .map((v) => String(v.value));
  if (strings.length === 0) return undefined;
  for (const [name, re] of FORMAT_TESTS) {
    if (strings.every((s) => re.test(s))) return name;
  }
  return undefined;
}

function emptyStats(): KeyStats {
  return {
    present: 0,
    types: new Map(),
    locations: new Map(),
    values: new Map(),
    distinctCapped: false,
    sawEmptyString: false,
  };
}

function recordValue(
  stats: KeyStats,
  label: string,
  value: unknown,
  line: number | undefined,
): void {
  const type = jsonTypeOf(value);
  stats.present += 1;
  stats.types.set(type, (stats.types.get(type) ?? 0) + 1);

  const where = stats.locations.get(type) ?? [];
  if (where.length < OUTLIER_SAMPLE_CAP) {
    where.push({ file: label, type, ...(line !== undefined ? { line } : {}) });
  }
  stats.locations.set(type, where);

  const normalized = normalizeValue(value);
  if (normalized === "") stats.sawEmptyString = true;

  // Objects and arrays are keyed by their JSON too, so a repeated `tags: []`
  // counts once. They are never enum candidates, so the only cost is an
  // accurate `distinct` column.
  const key = JSON.stringify(normalized) ?? "undefined";
  const seen = stats.values.get(key);
  if (seen) {
    seen.count += 1;
  } else if (stats.values.size < DISTINCT_CAP) {
    stats.values.set(key, { value: normalized, count: 1, type });
  } else {
    stats.distinctCapped = true;
  }
}

/** The type most files used, ties broken by name so output is deterministic. */
function dominantTypeOf(stats: KeyStats): string {
  return [...stats.types.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0] ?? "string";
}

/**
 * Propose a vocabulary, or don't.
 *
 * Candidates are the values at the **dominant** type only. Including an
 * outlier's value would write the typo into the contract — the same failure
 * `dominantTypeOf` exists to avoid, one level down.
 */
function enumFor(
  stats: KeyStats,
  dominantType: string,
): unknown[] | undefined {
  // A vocabulary is a set of scalars. An enum of objects or arrays compares by
  // deep equality and is never what someone adopting a standard meant.
  if (!["string", "number", "boolean"].includes(dominantType)) return undefined;
  if (stats.distinctCapped) return undefined;

  const candidates = [...stats.values.values()].filter(
    (v) => v.type === dominantType,
  );
  if (candidates.length === 0) return undefined;
  if (candidates.length > ENUM_MAX_DISTINCT) return undefined;
  // Against occurrences of this key, not against the corpus — see the constant.
  if (candidates.length > stats.present * ENUM_MAX_DISTINCT_RATIO) {
    return undefined;
  }

  return candidates
    .sort(
      (a, b) =>
        b.count - a.count ||
        JSON.stringify(a.value).localeCompare(JSON.stringify(b.value)),
    )
    .map((v) => v.value);
}

/** `sawEmptyString` is a scan detail, not part of the public report. */
type ReportWithEmptyFlag = InferKeyReport & { sawEmptyString: boolean };

/** One key's `properties` entry: the dominant type, and nothing about policy. */
function draftPropertyFor(report: ReportWithEmptyFlag): Record<string, unknown> {
  const property: Record<string, unknown> = { type: report.dominantType };
  if (report.enumValues) {
    property.enum = report.enumValues;
  } else if (report.dominantType === "string" && !report.sawEmptyString) {
    // Observed, not assumed: nobody in this docset wrote an empty string, so
    // requiring a non-empty one when the key *is* present rejects the
    // fat-fingered `title:` without demanding anybody supply a title.
    property.minLength = 1;
  }
  return property;
}

export async function runInferSchema(
  opts: InferOptions,
): Promise<InferResult> {
  const cwd = opts.cwd ?? process.cwd();

  const minCoverage = opts.minCoverage ?? 0;
  if (!Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 100) {
    throw new DocmetaError(
      `--min-coverage must be a percentage between 0 and 100, got ${minCoverage}.`,
    );
  }

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
      "No files to scan. Pass paths/globs, or add `paths:` to docmeta.config.yaml.",
    );
  }

  const forced = opts.as ? extractorByName(opts.as) : undefined;
  if (opts.as && !forced) {
    throw new DocmetaError(
      `Unknown format "${opts.as}". Supported extensions: ${supportedExtensions().join(", ")}.`,
    );
  }
  if (usingStdin && !forced) {
    throw new DocmetaError(
      "Reading from stdin (`-`) requires --as <format> to choose an extractor.",
    );
  }

  // Every refusal happens **before** the scan, so a refused run leaves the
  // working tree exactly as it found it — the ordering `vendor` established.
  let absOut: string | undefined;
  if (opts.out !== undefined) {
    absOut = resolve(cwd, opts.out);
    await assertNotIgnored(
      absOut,
      dirname(absOut),
      cwd,
      opts.onNotice,
      DRAFT_IGNORE_TEXT,
    );
    if (existsSync(absOut)) {
      throw new DocmetaError(
        `"${posixRelative(cwd, absOut) || opts.out}" already exists, and \`schemas infer\` will not overwrite it. The draft is a starting point you then edit, so clobbering it would throw away the edits. Pass a different --out path, or remove that file first.`,
      );
    }
  }

  const exts = opts.exts ?? (forced ? forced.extensions : undefined);
  const fileInputs = inputs.filter((i) => i !== STDIN_TOKEN);
  const allowEmpty = config?.allowEmpty;
  const exclude = [...(config?.exclude ?? []), ...(opts.exclude ?? [])];
  const { files, gitignoreSkipped } = await resolveTargetSet({
    inputs: fileInputs,
    exts,
    exclude,
    cwd: base,
    allowEmpty,
    ...gitignoreOptions({
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
    action: "scanned",
  });

  const stats = new Map<string, KeyStats>();
  const unreadable: { file: string; message: string }[] = [];
  let filesScanned = 0;
  let filesWithoutMetadata = 0;

  const scanOne = (label: string, content: string, extension: string): void => {
    const extractor = forced ?? extractorForExtension(extension);
    if (!extractor) {
      throw new DocmetaError(
        `Unsupported file type "${extension}" for "${label}". Supported: ${supportedExtensions().join(", ")}. Use --as to override.`,
      );
    }
    filesScanned += 1;
    let extracted;
    try {
      extracted = extractor.extract(content, label, {
        elements: resolveElements(label, config),
      });
    } catch (err) {
      // One malformed block must not end the scan: the coverage question is
      // about the rest of the docset, and the bad file is itself a finding.
      unreadable.push({
        file: label,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!extracted.present) {
      filesWithoutMetadata += 1;
      return;
    }
    // Top-level keys only — see the note at the head of this section.
    for (const [key, value] of Object.entries(extracted.data)) {
      const stat = stats.get(key) ?? emptyStats();
      recordValue(stat, label, value, extracted.lineFor(key));
      stats.set(key, stat);
    }
  };

  if (usingStdin && forced) {
    scanOne(STDIN_LABEL, opts.stdinContent ?? "", forced.extensions[0] ?? "");
  }
  for (const file of files) {
    const content = await readFile(resolve(base, file), "utf8");
    scanOne(file, content, extname(file));
  }

  for (const u of unreadable) {
    opts.onNotice?.(`could not read metadata from "${u.file}": ${u.message}`);
  }

  const all: ReportWithEmptyFlag[] = [...stats.entries()].map(([key, stat]) => {
    const dominantType = dominantTypeOf(stat);
    const enumValues = enumFor(stat, dominantType);
    const format = formatOf(stat, dominantType);
    const outliers = [...stat.locations.entries()]
      .filter(([type]) => type !== dominantType)
      .flatMap(([, where]) => where);
    const outlierCount = [...stat.types.entries()]
      .filter(([type]) => type !== dominantType)
      .reduce((sum, [, count]) => sum + count, 0);
    // From the dominant type only. Ranked across every type, a clustered
    // *outlier* outranks unique dominant values: 50 distinct string titles and
    // three files writing `title: 42` put `42` in the sample column, because it
    // is the one value with a count above 1. The row then reported
    // `string ×50, number ×3` and offered a number as the representative value,
    // three lines above naming those same files as the outliers.
    const sample = [...stat.values.values()]
      .filter((v) => v.type === dominantType)
      .sort((a, b) => b.count - a.count)[0]?.value;
    return {
      key,
      present: stat.present,
      coverage: filesScanned === 0 ? 0 : (stat.present / filesScanned) * 100,
      types: [...stat.types.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([type, count]) => ({ type, count })),
      dominantType,
      outliers,
      outlierCount,
      distinct: stat.values.size,
      distinctCapped: stat.distinctCapped,
      ...(enumValues ? { enumValues } : {}),
      ...(sample !== undefined ? { sample } : {}),
      ...(format !== undefined ? { format } : {}),
      sawEmptyString: stat.sawEmptyString,
    };
  });

  const kept = all
    .filter((k) => k.coverage >= minCoverage)
    .sort((a, b) => b.coverage - a.coverage || a.key.localeCompare(b.key));

  // Alphabetical in the draft, not coverage order: this file is committed and
  // hand-edited, and a stable key order keeps its diffs readable.
  const properties: Record<string, unknown> = {};
  for (const report of [...kept].sort((a, b) => a.key.localeCompare(b.key))) {
    properties[report.key] = draftPropertyFor(report);
  }

  const draft: Record<string, unknown> = {
    $schema: DRAFT_DIALECT,
    $comment:
      "Generated by `docmeta schemas infer`. Nothing is required, deliberately: what your docset happens to contain is not the same as what your standard should demand. Promote keys into a `required` list yourself, one at a time, behind a baseline.",
    type: "object",
    properties,
  };

  // Public reports carry no scan bookkeeping.
  const keys: InferKeyReport[] = kept.map(({ sawEmptyString: _drop, ...rest }) => rest);

  if (absOut !== undefined) {
    await mkdir(dirname(absOut), { recursive: true });
    await writeFileAtomic(absOut, `${JSON.stringify(draft, null, 2)}\n`);
  }

  return {
    filesScanned,
    filesWithoutMetadata,
    unreadable,
    keys,
    hiddenByMinCoverage: all.length - kept.length,
    draft,
    ...(absOut !== undefined ? { out: posixRelative(cwd, absOut) } : {}),
    gitignoreSkipped,
  };
}
