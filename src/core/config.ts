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

export interface SchemaOverride {
  files: string;
  schemas: string[];
}

/** Defaults for the `fill` command; every key is overridable by a CLI flag. */
export interface FillConfig {
  provider?: string;
  model?: string;
  /** Minimum self-reported confidence to write a value (0-1). */
  confidenceThreshold?: number;
  maxCostUsd?: number;
  concurrency?: number;
}

export interface DocmetaConfig {
  paths?: string[];
  exclude?: string[];
  schemas?: string[];
  overrides?: SchemaOverride[];
  fill?: FillConfig;
  /**
   * Treat an input set that resolves to zero files as success rather than an
   * operational error. Off by default: a glob that stops matching would
   * otherwise leave a permanently green gate that checks nothing.
   */
  allowEmpty?: boolean;
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
    config.schemas = asStringList(obj.schemas, "schemas", source);

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

  if (obj.allowEmpty !== undefined) {
    if (typeof obj.allowEmpty !== "boolean") {
      throw new DocmetaError(`${source}: "allowEmpty" must be a boolean.`);
    }
    config.allowEmpty = obj.allowEmpty;
  }

  if (obj.fill !== undefined) config.fill = parseFill(obj.fill, source);

  return config;
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
 * The directories a discovery walk may look in, nearest first.
 *
 * The walk stops at a **project boundary**: a directory containing `.git`,
 * which is included in the search. `existsSync` rather than `isDirectory()`,
 * because a git *file* — what a worktree or a submodule carries — bounds a
 * project just as a directory does, and this repo's own worktrees are exactly
 * that case. `existsSync` never dereferences the `gitdir:` target, so one line
 * covers Windows, Linux, submodules, and worktrees alike.
 *
 * With **no** boundary anywhere above cwd, only cwd is considered. A
 * project-scoped config has no meaning without a project, and walking on would
 * let a stray `docmeta.config.yaml` in a home or temp directory silently govern
 * unrelated runs — including this repo's own tests, which work in OS temp
 * directories under the user's home.
 */
function searchPath(cwd: string): string[] {
  const chain: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    chain.push(dir);
    if (existsSync(join(dir, ".git"))) return chain;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain.slice(0, 1);
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
      const source = (relative(cwd, p) || name).replace(/\\/g, "/");
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
  cwd: string;
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
  const loaded = opts.noConfig
    ? null
    : await loadConfig(opts.configPath, opts.cwd);
  if (loaded) opts.onConfigLoaded?.({ path: loaded.path, dir: loaded.dir });

  const config = loaded
    ? rebaseConfigSchemaRefs(loaded.config, loaded.dir, opts.cwd)
    : null;

  const fromConfig = opts.inputs.length === 0;
  const inputs = fromConfig ? (config?.paths ?? []) : opts.inputs;
  const base =
    fromConfig && inputs.length > 0 && loaded ? loaded.dir : opts.cwd;

  return { config, inputs, base };
}
