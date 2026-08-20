/**
 * Optional lightweight YAML config (`docmeta.config.yaml`). Supplies default
 * targets, excludes, the default schema set, and optional per-glob overrides,
 * so CI can run a bare `docmeta validate`.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { DocmetaError } from "../types.js";
import { rebaseConfigSchemaRefs } from "./resolve-schema.js";
import { classifyRef } from "./schema-registry.js";
import { INTEGRITY_SHAPE, isIntegrity } from "./integrity.js";

export interface SchemaOverride {
  files: string;
  schemas: string[];
}

/**
 * A `schemas:` entry in its long form: a reference plus where it came from and
 * what it must hash to.
 *
 * Written by `docmeta schemas vendor`, which downloads a remote schema into the
 * repository and records both. `source` keeps the provenance the URL used to
 * carry, so a re-vendor knows where to look and an error can say what to
 * re-download; `integrity` makes an edited or corrupted copy a loud failure
 * rather than a silently changed contract.
 */
export interface SchemaRefEntry {
  /** What is loaded: a built-in id, a local `.json` path, or a URL. */
  ref: string;
  /** Where `ref` was vendored from — a URL, or a path for a local copy. */
  source?: string;
  /** `sha256-<64 hex>` over the bytes of `ref`. Local files only. */
  integrity?: string;
}

/**
 * One `schemas:` entry. A bare string is the original form and is unchanged by
 * 0008; the mapping form adds provenance and a pin.
 */
export type SchemaEntry = string | SchemaRefEntry;

/** The keys a `schemas:` mapping entry may carry. */
const SCHEMA_ENTRY_KEYS = ["ref", "source", "integrity"] as const;

/** Defaults for the `fill` command; every key is overridable by a CLI flag. */
export interface FillConfig {
  provider?: string;
  model?: string;
  /** Minimum self-reported confidence to write a value (0-1). */
  confidenceThreshold?: number;
  maxCostUsd?: number;
  concurrency?: number;
}

/** Settings for the cross-run cache of schemas fetched over `http(s)`. */
export interface SchemaCacheConfig {
  /**
   * Hours a cached schema is served before it is re-fetched. `0` disables the
   * cache entirely, in both directions.
   */
  ttlHours?: number;
}

/**
 * Upper bound on `schemaCache.ttlHours` — one year.
 *
 * Not tidiness: freshness compares elapsed time against `ttlHours * 3_600_000`,
 * and a finite-but-enormous value overflows that product to `Infinity`, so no
 * entry is ever older than the limit and the cache silently stops expiring.
 * `Number.isFinite` alone does not catch it, because `1e308` is finite.
 */
const MAX_TTL_HOURS = 8760;

export interface DocmetaConfig {
  paths?: string[];
  exclude?: string[];
  /**
   * The default schema set. Each entry is either a reference string or a
   * `{ ref, source?, integrity? }` mapping — see `SchemaEntry`.
   */
  schemas?: SchemaEntry[];
  overrides?: SchemaOverride[];
  fill?: FillConfig;
  /**
   * Path to a validation baseline, relative to **this config file**. Setting it
   * implies `--baseline` on every run; `--no-baseline` suppresses it for one.
   */
  baseline?: string;
  /**
   * Treat an input set that resolves to zero files as success rather than an
   * operational error. Off by default: a glob that stops matching would
   * otherwise leave a permanently green gate that checks nothing.
   */
  allowEmpty?: boolean;
  /**
   * Skip files `.gitignore` covers when expanding directories and globs. On by
   * default; set false to check generated or vendored documents the repo does
   * not track. Setting it **true** explicitly also asks to be told when git
   * cannot answer — see `GITIGNORE_UNAVAILABLE`.
   */
  respectGitignore?: boolean;
  /** Defaults for the cross-run schema cache. See `SchemaCacheConfig`. */
  schemaCache?: SchemaCacheConfig;
  /**
   * Never fetch a remote schema. A URL reference resolves from the schema
   * cache; an uncached one is an operational error naming the URL. Built-in and
   * local-file references are unaffected — neither touches the network.
   */
  offline?: boolean;
}

const CONFIG_NAMES = ["docmeta.config.yaml", "docmeta.config.yml"];

function asStringList(value: unknown, field: string, source: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new DocmetaError(
      `${source}: "${field}" must be a list of strings.`,
    );
  }
  return value as string[];
}

/**
 * Parse the top-level `schemas:` list, which accepts both forms.
 *
 * Separate from `asStringList` on purpose. That helper also validates `paths`,
 * `exclude`, and `overrides[].schemas`, and widening it in place would have
 * quietly widened all four — `paths: [{ref: …}]` would have started parsing and
 * then failed somewhere far from the config file.
 */
function asSchemaList(
  value: unknown,
  field: string,
  source: string,
): SchemaEntry[] {
  if (!Array.isArray(value)) {
    throw new DocmetaError(
      `${source}: "${field}" must be a list of schema references.`,
    );
  }
  return value.map((entry, i) => parseSchemaEntry(entry, `${field}[${i}]`, source));
}

function parseSchemaEntry(
  entry: unknown,
  where: string,
  source: string,
): SchemaEntry {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new DocmetaError(
      `${source}: ${where} must be a schema reference string, or a mapping with "ref" (and optionally "source" and "integrity").`,
    );
  }
  const raw = entry as Record<string, unknown>;

  // A misspelled key is the failure worth catching here: `intergrity:` would
  // otherwise be dropped in silence, leaving a config that reads as pinned and
  // a schema that is not.
  for (const key of Object.keys(raw)) {
    if (!(SCHEMA_ENTRY_KEYS as readonly string[]).includes(key)) {
      throw new DocmetaError(
        `${source}: ${where} has unknown key "${key}". Supported keys: ${SCHEMA_ENTRY_KEYS.join(", ")}.`,
      );
    }
  }

  if (typeof raw.ref !== "string" || raw.ref.trim() === "") {
    throw new DocmetaError(
      `${source}: ${where}.ref must be a non-empty schema reference string.`,
    );
  }
  const parsed: SchemaRefEntry = { ref: raw.ref };

  if (raw.source !== undefined) {
    if (typeof raw.source !== "string" || raw.source.trim() === "") {
      throw new DocmetaError(
        `${source}: ${where}.source must be a non-empty string naming where "${raw.ref}" was vendored from.`,
      );
    }
    parsed.source = raw.source;
  }

  if (raw.integrity !== undefined) {
    if (typeof raw.integrity !== "string" || !isIntegrity(raw.integrity)) {
      throw new DocmetaError(
        `${source}: ${where}.integrity must look like "${INTEGRITY_SHAPE}". Record one with \`docmeta schemas vendor\`.`,
      );
    }
    // A pin is checked against bytes on disk. On a built-in id there are no
    // bytes to read, and on a URL the copy that satisfies a run may come from
    // the schema cache, which stores the parsed schema rather than what the
    // server sent. Accepting either would record a pin nothing ever verifies —
    // a config that reads as pinned and is not.
    const kind = classifyRef(parsed.ref).kind;
    if (kind !== "file") {
      throw new DocmetaError(
        `${source}: ${where}.integrity applies to a vendored local file, but "${parsed.ref}" is a ${kind === "url" ? "URL" : "built-in id"}. Vendor it first with \`docmeta schemas vendor\`, or drop the pin.`,
      );
    }
    parsed.integrity = raw.integrity;
  }

  return parsed;
}

/** Parse and validate config YAML text. */
export function parseConfig(text: string, source: string): DocmetaConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new DocmetaError(
      `${source}: invalid YAML: ${(err as Error).message}`,
    );
  }
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new DocmetaError(`${source}: top level must be a mapping.`);
  }
  const obj = raw as Record<string, unknown>;
  const config: DocmetaConfig = {};

  if (obj.paths !== undefined) config.paths = asStringList(obj.paths, "paths", source);
  if (obj.exclude !== undefined)
    config.exclude = asStringList(obj.exclude, "exclude", source);
  if (obj.schemas !== undefined)
    config.schemas = asSchemaList(obj.schemas, "schemas", source);

  if (obj.overrides !== undefined) {
    if (!Array.isArray(obj.overrides)) {
      throw new DocmetaError(`${source}: "overrides" must be a list.`);
    }
    config.overrides = obj.overrides.map((entry, i) => {
      if (typeof entry !== "object" || entry === null) {
        throw new DocmetaError(`${source}: overrides[${i}] must be a mapping.`);
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.files !== "string") {
        throw new DocmetaError(
          `${source}: overrides[${i}].files must be a string glob.`,
        );
      }
      return {
        files: e.files,
        schemas: asStringList(e.schemas, `overrides[${i}].schemas`, source),
      };
    });
  }

  if (obj.baseline !== undefined) {
    if (typeof obj.baseline !== "string" || obj.baseline.trim() === "") {
      throw new DocmetaError(
        `${source}: "baseline" must be a path to a baseline file.`,
      );
    }
    config.baseline = obj.baseline;
  }

  if (obj.allowEmpty !== undefined) {
    if (typeof obj.allowEmpty !== "boolean") {
      throw new DocmetaError(`${source}: "allowEmpty" must be a boolean.`);
    }
    config.allowEmpty = obj.allowEmpty;
  }

  if (obj.respectGitignore !== undefined) {
    if (typeof obj.respectGitignore !== "boolean") {
      throw new DocmetaError(`${source}: "respectGitignore" must be a boolean.`);
    }
    config.respectGitignore = obj.respectGitignore;
  }

  if (obj.offline !== undefined) {
    if (typeof obj.offline !== "boolean") {
      throw new DocmetaError(`${source}: "offline" must be a boolean.`);
    }
    config.offline = obj.offline;
  }

  if (obj.schemaCache !== undefined) {
    config.schemaCache = parseSchemaCache(obj.schemaCache, source);
  }

  if (obj.fill !== undefined) config.fill = parseFill(obj.fill, source);

  return config;
}

function parseSchemaCache(value: unknown, source: string): SchemaCacheConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DocmetaError(`${source}: "schemaCache" must be a mapping.`);
  }
  const raw = value as Record<string, unknown>;
  const schemaCache: SchemaCacheConfig = {};

  const ttl = raw.ttlHours;
  if (ttl !== undefined) {
    // A YAML `1e999` parses to Infinity, and a bare range check would accept
    // it. A negative TTL is worse than useless: every entry would read as
    // stale, so the cache would silently do nothing at all.
    //
    // The upper bound is not tidiness. Freshness compares against
    // `ttlHours * 3_600_000`, and a finite-but-huge value overflows that
    // product to Infinity, so `elapsed >= Infinity` is never true and every
    // entry is served forever — a cache that silently stops expiring, which is
    // the opposite of what a TTL is for. One year is well past any real
    // setting, and anyone wanting "never expire" has a clearer way to say it.
    if (
      typeof ttl !== "number" ||
      !Number.isFinite(ttl) ||
      ttl < 0 ||
      ttl > MAX_TTL_HOURS
    ) {
      throw new DocmetaError(
        `${source}: "schemaCache.ttlHours" must be a number of hours between 0 and ${MAX_TTL_HOURS} (0 disables the cache).`,
      );
    }
    schemaCache.ttlHours = ttl;
  }

  return schemaCache;
}

function parseFill(value: unknown, source: string): FillConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DocmetaError(`${source}: "fill" must be a mapping.`);
  }
  const raw = value as Record<string, unknown>;
  const fill: FillConfig = {};

  const asString = (key: "provider" | "model"): void => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v !== "string") {
      throw new DocmetaError(`${source}: "fill.${key}" must be a string.`);
    }
    fill[key] = v;
  };
  asString("provider");
  asString("model");

  const asNumber = (
    key: "confidenceThreshold" | "maxCostUsd" | "concurrency",
    min: number,
    max: number,
    integer = false,
  ): void => {
    const v = raw[key];
    if (v === undefined) return;
    // A YAML `1e999` parses to Infinity, and a bare range check would accept
    // it, so require a finite number explicitly.
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      throw new DocmetaError(
        `${source}: "fill.${key}" must be a number between ${min} and ${max}.`,
      );
    }
    // A fractional worker count would be silently truncated downstream rather
    // than rejected, so catch it where the user can see the mistake.
    if (integer && !Number.isInteger(v)) {
      throw new DocmetaError(
        `${source}: "fill.${key}" must be a whole number.`,
      );
    }
    fill[key] = v;
  };
  asNumber("confidenceThreshold", 0, 1);
  asNumber("maxCostUsd", 0, Number.MAX_SAFE_INTEGER);
  asNumber("concurrency", 1, 64, true);

  return fill;
}

export interface LoadedConfig {
  config: DocmetaConfig;
  /** Absolute path to the file the config was read from. */
  path: string;
  /**
   * Directory holding that file. Relative paths written *in* the config —
   * `paths:`, `exclude:`, local-file schema refs — are meaningful relative to
   * this, not to the directory the command happened to be invoked from.
   */
  dir: string;
}

/**
 * The nearest **project boundary** at or above `cwd`: a directory holding
 * `.git`. Null when there is none.
 *
 * `existsSync` rather than `isDirectory()`, because a git *file* — what a
 * worktree or a submodule carries — bounds a project just as a directory does,
 * and this repo's own worktrees are exactly that case. `existsSync` never
 * dereferences the `gitdir:` target, so one line covers Windows, Linux,
 * submodules, and worktrees alike.
 *
 * The answer is returned as a *fact*, not as a search path, because two callers
 * need it for opposite reasons and only one of them wants a chain. Config
 * discovery walks the chain and stops here. The SARIF reporter needs the root
 * itself, and needs "there is no repository" to be distinguishable from "the
 * repository root is where you are standing" — a one-element chain conflates
 * the two, and getting that wrong means emitting paths GitHub silently drops.
 */
export function findGitRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The directories a discovery walk may look in, nearest first.
 *
 * The walk stops at the project boundary `findGitRoot` reports, which is
 * included in the search. Only that one call touches the filesystem; the chain
 * itself is then assembled from path strings.
 *
 * With **no** boundary anywhere above cwd, only cwd is considered. A
 * project-scoped config has no meaning without a project, and walking on would
 * let a stray `docmeta.config.yaml` in a home or temp directory silently govern
 * unrelated runs — including this repo's own tests, which work in OS temp
 * directories under the user's home.
 */
function searchPath(cwd: string): string[] {
  const start = resolve(cwd);
  const root = findGitRoot(start);
  if (root === null) return [start];
  const chain: string[] = [];
  let dir = start;
  for (;;) {
    chain.push(dir);
    if (dir === root) return chain;
    const parent = dirname(dir);
    // `root` is an ancestor of `start` by construction, so this is unreachable
    // — but a filesystem race (the boundary removed mid-walk) must not loop.
    if (parent === dir) return chain;
    dir = parent;
  }
}

/**
 * Load config from an explicit path (error if missing) or by discovery.
 *
 * Discovery checks cwd and then each ancestor up to and including the nearest
 * `.git` boundary (see `searchPath`). Within a directory the order is
 * `docmeta.config.yaml` then `docmeta.config.yml`. The **first file found
 * wins** and the walk stops there — ancestor configs are never merged, because
 * `schemas:` is a set a file must satisfy in full and `overrides:` is
 * first-match-wins ordered, so a partial merge would silently redefine what
 * "the contract" means.
 *
 * Returns null when no config is found via discovery.
 */
export async function loadConfig(
  explicitPath?: string,
  cwd: string = process.cwd(),
): Promise<LoadedConfig | null> {
  if (explicitPath) {
    // An explicit path never falls back to discovery: a `-c` pointing at a
    // file that is not there is a mistake worth failing on, not a reason to
    // quietly validate against something else.
    const abs = resolve(cwd, explicitPath);
    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      // Report the spelling the user typed, not the resolved absolute path.
      throw new DocmetaError(`Config file not found: "${explicitPath}".`);
    }
    return {
      config: parseConfig(text, explicitPath),
      path: abs,
      dir: dirname(abs),
    };
  }

  for (const dir of searchPath(cwd)) {
    for (const name of CONFIG_NAMES) {
      const p = join(dir, name);
      let text: string;
      try {
        text = await readFile(p, "utf8");
      } catch {
        continue; // not here; try the next name, then the next directory
      }
      // Name the file the way the user would have to type it, so a parse
      // error from an ancestor config says which one.
      const source = relative(cwd, p).replace(/\\/g, "/");
      return { config: parseConfig(text, source), path: p, dir };
    }
  }
  return null;
}

/** Told to a caller once, when a run turns out to be governed by a config. */
export interface ConfigNotice {
  /** Absolute path to the config file. */
  path: string;
  /** Directory holding it. */
  dir: string;
}

export interface RunConfigOptions {
  /** Defaults to `process.cwd()`, matching `loadConfig`. */
  cwd?: string;
  /** `-c/--config`. */
  configPath?: string;
  /** `--no-config`: skip discovery and run on the built-in defaults. */
  noConfig?: boolean;
  /** Positional inputs; empty means fall back to the config's `paths:`. */
  inputs: string[];
  onConfigLoaded?: (info: ConfigNotice) => void;
}

export interface RunConfig {
  /** The config, with its local file schema refs already rebased. */
  config: DocmetaConfig | null;
  /** What to resolve: the positional inputs, or the config's `paths:`. */
  inputs: string[];
  /**
   * Directory those inputs — and so every resolved file path, and every file
   * read — are relative to.
   *
   * A run uses *either* positional paths *or* config `paths:`, never both, so
   * there is exactly one base per run and no ambiguity about which it is.
   * Positional paths are typed by a person standing in a shell, so they stay
   * relative to the working directory; `paths:` globs were written next to the
   * config, so they resolve from there.
   */
  base: string;
  /**
   * Directory holding the config that governed the run, when one did.
   *
   * Distinct from `base`: `base` follows *the inputs*, so it is the working
   * directory whenever positional paths were given. Anything written **in** the
   * config — the `baseline:` path — is relative to the config itself no matter
   * where the command was run from, which is the whole point of discovering an
   * ancestor config in the first place.
   */
  configDir?: string;
}

/**
 * Settle the three things every command core needs from config before it can
 * touch the filesystem: which config governs the run, what to resolve, and
 * what those relative paths are relative to.
 */
export async function resolveRunConfig(
  opts: RunConfigOptions,
): Promise<RunConfig> {
  // `--no-config` wins over an explicit path. The CLI cannot supply both (they
  // are one commander option), but the cores are public API.
  const cwd = opts.cwd ?? process.cwd();

  const loaded = opts.noConfig ? null : await loadConfig(opts.configPath, cwd);
  if (loaded) opts.onConfigLoaded?.({ path: loaded.path, dir: loaded.dir });

  const config = loaded
    ? rebaseConfigSchemaRefs(loaded.config, loaded.dir, cwd)
    : null;

  const fromConfig = opts.inputs.length === 0;
  const inputs = fromConfig ? (config?.paths ?? []) : opts.inputs;
  const base = fromConfig && inputs.length > 0 && loaded ? loaded.dir : cwd;

  return { config, inputs, base, ...(loaded ? { configDir: loaded.dir } : {}) };
}
