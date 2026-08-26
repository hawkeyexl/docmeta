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
import { parseElementPath } from "../extractors/element-key.js";

export interface SchemaOverride {
  files: string;
  schemas: string[];
  /**
   * Extra element paths for files matching `files`. Unlike `schemas`, which the
   * first matching override *replaces* because a schema set is a complete
   * statement, these accumulate: every matching override contributes, on top of
   * the top-level `elements:`. A list of extra places to look is additive by
   * nature, and an override that silently dropped the repo-wide ones would be a
   * trap.
   */
  elements?: string[];
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

/**
 * What a **document** is allowed to name in its own `$schema`.
 *
 * - `any` — the default, and today's behavior: a built-in id, a file in the
 *   repository, or a URL. `schemaTrust.hosts` narrows the URL case.
 * - `local` — a built-in id or a file in the repository; a URL is refused.
 * - `none` — the document's `$schema` is ignored and config decides, with a
 *   notice on stderr naming the file whose key was dropped.
 */
export type DocumentRefTrust = "any" | "local" | "none";

/** The values `schemaTrust.documentRefs` accepts, in the order documented. */
export const DOCUMENT_REF_TRUST = ["any", "local", "none"] as const;

/**
 * How far a **document** is trusted to choose the contract it is judged by.
 *
 * Nothing here touches a ref an *operator* supplied: `schemas:`,
 * `overrides[].schemas`, and `-s/--schema` are never filtered, in any mode. A
 * person who can edit the config or pass a flag is not the attacker this key
 * has in mind — a pull request against a public docs repo is.
 */
export interface SchemaTrustConfig {
  /** Defaults to `any`, which is exactly what docmeta has always done. */
  documentRefs?: DocumentRefTrust;
  /**
   * Hosts a document-supplied URL may name. Consulted **only** under
   * `documentRefs: any`; absent means any host, as before.
   *
   * A convenience for pointing at one known publisher, not a security
   * boundary: `fetch` follows redirects, so an allowlisted host that answers
   * `302` sends the fetch anywhere it likes. A repo that genuinely distrusts
   * its contributors wants `documentRefs: local`.
   */
  hosts?: string[];
}

/** The keys a `schemaTrust:` mapping may carry. */
const SCHEMA_TRUST_KEYS = ["documentRefs", "hosts"] as const;

/** The keys a `schemaCache:` mapping may carry. */
const SCHEMA_CACHE_KEYS = ["ttlHours"] as const;

/**
 * Validate an `elements:` list, rejecting a path that cannot produce a key.
 *
 * Parsed here rather than at extraction so a typo is an error when the config
 * loads, naming the file and the key. Left to extraction it would be a silent
 * no-op: the path would match nothing, no key would appear, and the check the
 * author thought they had configured would simply never run.
 */
function asElementPaths(
  value: unknown,
  where: string,
  source: string,
): string[] {
  const list = asStringList(value, where, source);
  for (const path of list) {
    try {
      parseElementPath(path);
    } catch (err) {
      throw new DocmetaError(`${source}: ${where} — ${(err as Error).message}`);
    }
  }
  return list;
}

/** The keys one `overrides:` entry may carry. */
const OVERRIDE_KEYS = ["files", "schemas", "elements"] as const;

/** The keys a `fill:` mapping may carry. */
const FILL_KEYS = [
  "provider",
  "model",
  "confidenceThreshold",
  "maxTurns",
  "chunkChars",
  "concurrency",
] as const;

/**
 * The keys the config's top level may carry.
 *
 * Adding a key to `DocmetaConfig` means adding it here too, or a config using
 * it is rejected. That coupling is the point: the alternative is the silence
 * this list exists to end.
 */
const CONFIG_KEYS = [
  "paths",
  "exclude",
  "schemas",
  "overrides",
  "baseline",
  "allowEmpty",
  "respectGitignore",
  "offline",
  "schemaCache",
  "schemaTrust",
  "fill",
  "elements",
] as const;

/**
 * Reject any key outside `allowed`, naming what was supported.
 *
 * One helper so every level of the config reports a typo the same way. A key
 * the parser does not recognize is dropped in silence otherwise, which is the
 * failure this whole class of check exists to prevent: a misspelled
 * `schemaTust:` leaves a repository that reads as guarded and is not, and a
 * misspelled `intergrity:` leaves a schema that reads as pinned and is not.
 * Neither produces a diagnostic anywhere, at any verbosity.
 *
 * `where` names the mapping as the user would recognize it — `"schemaTrust"`,
 * `schemas[0]`, or `the top level`.
 */
function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  source: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new DocmetaError(
        `${source}: ${where} has unknown key "${key}". Supported keys: ${allowed.join(", ")}.`,
      );
    }
  }
}

/** Defaults for the `fill` command; every key is overridable by a CLI flag. */
export interface FillConfig {
  provider?: string;
  model?: string;
  /** Minimum self-reported confidence to write a value (0-1). */
  confidenceThreshold?: number;
  /** Stop after this many inference calls. Counts calls, not files. */
  maxTurns?: number;
  /** Characters of document per call. Default 12000. */
  chunkChars?: number;
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
  /**
   * Element paths to lift in addition to each format's convention. See
   * `parseElementPath` for the syntax.
   */
  elements?: string[];
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
  /**
   * How far a document's own `$schema` is trusted. Absent means `any` — every
   * setup that exists today, unchanged. See `SchemaTrustConfig`.
   */
  schemaTrust?: SchemaTrustConfig;
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
  rejectUnknownKeys(raw, SCHEMA_ENTRY_KEYS, where, source);

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
  rejectUnknownKeys(obj, CONFIG_KEYS, "the top level", source);
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
      // Before the field checks, so a misspelling is reported as the typo it
      // is. `schemass:` beside a correct `schemas:` was dropped in silence and
      // the run passed — the false green this whole check exists to end, in the
      // one section it had not reached. Alone, it produced `"overrides[0].
      // schemas" must be a list of strings`, blaming the key that is missing
      // rather than the one that is wrong.
      rejectUnknownKeys(e, OVERRIDE_KEYS, `overrides[${i}]`, source);
      if (typeof e.files !== "string") {
        throw new DocmetaError(
          `${source}: overrides[${i}].files must be a string glob.`,
        );
      }
      const schemas =
        e.schemas === undefined
          ? []
          : asStringList(e.schemas, `overrides[${i}].schemas`, source);
      const elements =
        e.elements === undefined
          ? undefined
          : asElementPaths(e.elements, `overrides[${i}].elements`, source);
      // An override naming neither is a rule that does nothing, which reads as
      // configured and is not — the same silence `rejectUnknownKeys` exists to
      // end, one level down.
      if (schemas.length === 0 && (elements === undefined || elements.length === 0)) {
        throw new DocmetaError(
          `${source}: overrides[${i}] sets neither "schemas" nor "elements", so it has no effect.`,
        );
      }
      return { files: e.files, schemas, ...(elements ? { elements } : {}) };
    });
  }

  if (obj.elements !== undefined) {
    config.elements = asElementPaths(obj.elements, "elements", source);
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

  if (obj.schemaTrust !== undefined) {
    config.schemaTrust = parseSchemaTrust(obj.schemaTrust, source);
  }

  if (obj.fill !== undefined) config.fill = parseFill(obj.fill, source);

  return config;
}

function parseSchemaCache(value: unknown, source: string): SchemaCacheConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DocmetaError(`${source}: "schemaCache" must be a mapping.`);
  }
  const raw = value as Record<string, unknown>;
  rejectUnknownKeys(raw, SCHEMA_CACHE_KEYS, '"schemaCache"', source);
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

/**
 * Parse `schemaTrust:`, shaped after `parseSchemaCache` — a nested mapping with
 * every key optional, so an absent one leaves the default in exactly one place.
 *
 * Unknown nested keys are rejected the way a `schemas:` mapping entry rejects
 * them, and for the same reason: a misspelled `documentRef:` would otherwise be
 * dropped in silence, leaving a repo that reads as guarded and is not. A
 * misspelled `schemaTrust:` is now rejected too — `parseConfig` checks the top
 * level against `CONFIG_KEYS` rather than walking only the keys it knows. What
 * remains, and cannot be fixed here, is an *older* docmeta reading a config
 * written for a newer one: it has never heard of the key and ignores it. See
 * the version-floor note in the configuration reference.
 */
function parseSchemaTrust(value: unknown, source: string): SchemaTrustConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DocmetaError(
      `${source}: "schemaTrust" must be a mapping. Write it as \`schemaTrust:\` with \`documentRefs:\` and optionally \`hosts:\` beneath it.`,
    );
  }
  const raw = value as Record<string, unknown>;
  rejectUnknownKeys(raw, SCHEMA_TRUST_KEYS, '"schemaTrust"', source);
  const schemaTrust: SchemaTrustConfig = {};

  const mode = raw.documentRefs;
  if (mode !== undefined) {
    if (
      typeof mode !== "string" ||
      !(DOCUMENT_REF_TRUST as readonly string[]).includes(mode)
    ) {
      throw new DocmetaError(
        `${source}: "schemaTrust.documentRefs" must be one of: ${DOCUMENT_REF_TRUST.join(", ")}. Use \`documentRefs: any\` for today's behavior, \`local\` to refuse a URL a document names, or \`none\` to let the config decide alone.`,
      );
    }
    schemaTrust.documentRefs = mode as DocumentRefTrust;
  }

  const hosts = raw.hosts;
  if (hosts !== undefined) {
    if (
      !Array.isArray(hosts) ||
      hosts.some((h) => typeof h !== "string" || h.trim() === "")
    ) {
      throw new DocmetaError(
        `${source}: "schemaTrust.hosts" must be a list of host names, such as "schemas.example.com". Remove the key to allow any host.`,
      );
    }
    schemaTrust.hosts = hosts as string[];
  }

  return schemaTrust;
}

function parseFill(value: unknown, source: string): FillConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DocmetaError(`${source}: "fill" must be a mapping.`);
  }
  const raw = value as Record<string, unknown>;
  rejectUnknownKeys(raw, FILL_KEYS, '"fill"', source);
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
    key: "confidenceThreshold" | "maxTurns" | "chunkChars" | "concurrency",
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
  asNumber("maxTurns", 1, Number.MAX_SAFE_INTEGER, true);
  asNumber("chunkChars", 1, Number.MAX_SAFE_INTEGER, true);
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
 * The directory a **document-supplied** local schema path must stay inside.
 *
 * The git root rather than the config's directory, so a monorepo package whose
 * documents reference `../shared/x.json` keeps working — that path is still
 * inside the repository, which is what "a schema in this project" means.
 *
 * `source` is not decoration, and it has **three** values rather than a
 * boolean: with no repository the boundary falls back to the config's
 * directory, and with no config either it falls back to the run's `cwd`. Those
 * are progressively narrower and less obvious rules, and the refusal message
 * has to name the one it actually applied — telling someone with no config file
 * that "the config's own directory is the boundary" sends them looking for a
 * file that is not there.
 *
 * Same reasoning as `SARIF_NO_GIT_ROOT`: "there is no repository" and "the
 * repository root is where you are standing" must stay distinguishable.
 */
export interface SchemaTrustRoot {
  /** Absolute directory the path must resolve inside. */
  dir: string;
  /** Which rule produced `dir`, so a refusal can name it accurately. */
  source: "git" | "config" | "cwd";
}

/** Settle the containment root once per run, for `resolveSchemaSet`. */
export function schemaTrustRoot(
  cwd: string,
  configDir?: string,
): SchemaTrustRoot {
  const git = findGitRoot(cwd);
  if (git !== null) return { dir: git, source: "git" };
  if (configDir !== undefined) return { dir: resolve(configDir), source: "config" };
  return { dir: resolve(cwd), source: "cwd" };
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
  /**
   * Absolute path of the config file itself, when one governs the run. The
   * one honest way to edit the governing config: discovery accepts both
   * `docmeta.config.yaml` and `.yml`, `-c` accepts any name, and the file may
   * live in an ancestor — so re-deriving the path from a directory plus an
   * assumed filename names the wrong file in every one of those setups.
   */
  configPath?: string;
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

  return {
    config,
    inputs,
    base,
    ...(loaded ? { configDir: loaded.dir, configPath: loaded.path } : {}),
  };
}
