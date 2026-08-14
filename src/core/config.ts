/**
 * Optional lightweight YAML config. Supplies default targets, excludes, the
 * default schema set, and optional per-glob overrides, so CI can run a bare
 * `moose-meta validate`.
 *
 * Three filenames are discovered in cwd, most specific first:
 *
 *   moose-meta.config.yaml   this tool's own config
 *   moose.config.yaml        shared by the tool family; this tool reads `meta:`
 *   docmeta.config.yaml      the pre-rename name — still read, but warns
 *
 * Every source is parsed the same way: top-level keys are the family base, and a
 * `meta:` block is an overlay applied on top. A file with no `meta:` key has an
 * empty overlay and parses exactly as it always did, so the unwrap needs no
 * "is this a family config?" branch — and an explicit `--config` path gets the
 * same treatment without any filename sniffing.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { MooseMetaError } from "../types.js";
import { warn } from "./warn.js";

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

export interface MooseMetaConfig {
  paths?: string[];
  exclude?: string[];
  schemas?: string[];
  overrides?: SchemaOverride[];
  fill?: FillConfig;
}

/** Discovery candidates, most specific first. */
const CONFIG_NAMES = [
  "moose-meta.config.yaml",
  "moose-meta.config.yml",
  "moose.config.yaml",
  "moose.config.yml",
  "docmeta.config.yaml",
  "docmeta.config.yml",
];

/** Pre-rename names: still discovered, but warned about. */
const DEPRECATED_CONFIG_NAMES = new Set([
  "docmeta.config.yaml",
  "docmeta.config.yml",
]);

function asStringList(value: unknown, field: string, source: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new MooseMetaError(
      `${source}: "${field}" must be a list of strings.`,
    );
  }
  return value as string[];
}

/**
 * Read the known keys out of one mapping. `label` prefixes field names in error
 * messages, so a mistake inside the overlay reads `meta.fill.concurrency`
 * rather than pointing at a top-level key the user never wrote.
 */
function readKeys(
  obj: Record<string, unknown>,
  source: string,
  label: string,
): MooseMetaConfig {
  const config: MooseMetaConfig = {};

  if (obj.paths !== undefined)
    config.paths = asStringList(obj.paths, `${label}paths`, source);
  if (obj.exclude !== undefined)
    config.exclude = asStringList(obj.exclude, `${label}exclude`, source);
  if (obj.schemas !== undefined)
    config.schemas = asStringList(obj.schemas, `${label}schemas`, source);

  if (obj.overrides !== undefined) {
    if (!Array.isArray(obj.overrides)) {
      throw new MooseMetaError(`${source}: "${label}overrides" must be a list.`);
    }
    config.overrides = obj.overrides.map((entry, i) => {
      if (typeof entry !== "object" || entry === null) {
        throw new MooseMetaError(
          `${source}: ${label}overrides[${i}] must be a mapping.`,
        );
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.files !== "string") {
        throw new MooseMetaError(
          `${source}: ${label}overrides[${i}].files must be a string glob.`,
        );
      }
      return {
        files: e.files,
        schemas: asStringList(
          e.schemas,
          `${label}overrides[${i}].schemas`,
          source,
        ),
      };
    });
  }

  if (obj.fill !== undefined) config.fill = parseFill(obj.fill, source, label);

  return config;
}

/**
 * Apply the `meta:` overlay onto the family base. Each key combines the way it
 * already combines with its CLI flag: paths, schemas and overrides replace
 * wholesale, exclude concatenates, and fill merges key-by-key.
 */
function applyOverlay(
  base: MooseMetaConfig,
  overlay: MooseMetaConfig,
): MooseMetaConfig {
  const merged: MooseMetaConfig = { ...base };

  if (overlay.paths !== undefined) merged.paths = overlay.paths;
  if (overlay.schemas !== undefined) merged.schemas = overlay.schemas;
  if (overlay.overrides !== undefined) merged.overrides = overlay.overrides;
  if (overlay.exclude !== undefined) {
    merged.exclude = [...(base.exclude ?? []), ...overlay.exclude];
  }
  if (overlay.fill !== undefined) {
    merged.fill = { ...(base.fill ?? {}), ...overlay.fill };
  }

  return merged;
}

/** Parse and validate config YAML text. */
export function parseConfig(text: string, source: string): MooseMetaConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new MooseMetaError(
      `${source}: invalid YAML: ${(err as Error).message}`,
    );
  }
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MooseMetaError(`${source}: top level must be a mapping.`);
  }
  const obj = raw as Record<string, unknown>;
  const base = readKeys(obj, source, "");

  // A bare `meta:` parses to null; treat it as absent, the same way a null
  // document is treated as an empty config above.
  const rawMeta = obj.meta;
  if (rawMeta == null) return base;
  if (typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
    throw new MooseMetaError(`${source}: "meta" must be a mapping.`);
  }

  return applyOverlay(
    base,
    readKeys(rawMeta as Record<string, unknown>, source, "meta."),
  );
}

function parseFill(value: unknown, source: string, label: string): FillConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MooseMetaError(`${source}: "${label}fill" must be a mapping.`);
  }
  const raw = value as Record<string, unknown>;
  const fill: FillConfig = {};

  const asString = (key: "provider" | "model"): void => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v !== "string") {
      throw new MooseMetaError(
        `${source}: "${label}fill.${key}" must be a string.`,
      );
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
      throw new MooseMetaError(
        `${source}: "${label}fill.${key}" must be a number between ${min} and ${max}.`,
      );
    }
    // A fractional worker count would be silently truncated downstream rather
    // than rejected, so catch it where the user can see the mistake.
    if (integer && !Number.isInteger(v)) {
      throw new MooseMetaError(
        `${source}: "${label}fill.${key}" must be a whole number.`,
      );
    }
    fill[key] = v;
  };
  asNumber("confidenceThreshold", 0, 1);
  asNumber("maxCostUsd", 0, Number.MAX_SAFE_INTEGER);
  asNumber("concurrency", 1, 64, true);

  return fill;
}

/**
 * Load config from an explicit path (error if missing) or by discovery in cwd.
 * Returns null when no config is found via discovery.
 */
export async function loadConfig(
  explicitPath?: string,
  cwd: string = process.cwd(),
): Promise<{ config: MooseMetaConfig; path: string } | null> {
  if (explicitPath) {
    let text: string;
    try {
      text = await readFile(explicitPath, "utf8");
    } catch {
      throw new MooseMetaError(`Config file not found: "${explicitPath}".`);
    }
    // No deprecation warning here. The deprecation is about discovery *by name*;
    // an explicit path is a path, and users may name their file anything.
    return { config: parseConfig(text, explicitPath), path: explicitPath };
  }

  const found: { name: string; path: string; text: string }[] = [];
  for (const name of CONFIG_NAMES) {
    const p = resolve(cwd, name);
    try {
      found.push({ name, path: p, text: await readFile(p, "utf8") });
    } catch {
      // not found; try next
    }
  }

  const winner = found[0];
  if (!winner) return null;

  if (found.length > 1) {
    const ignored = found
      .slice(1)
      .map((f) => `"${f.name}"`)
      .join(", ");
    warn(`using "${winner.name}"; ignoring ${ignored}.`);
  }
  if (DEPRECATED_CONFIG_NAMES.has(winner.name)) {
    warn(
      `"${winner.name}" is a deprecated config file name and will stop being read in a future major version. ` +
        `Rename it to "moose-meta.config.yaml", or move its keys under \`meta:\` in a shared "moose.config.yaml".`,
    );
  }

  // Parsed outside the not-found catch above: a discovered config with a typo
  // must fail loudly rather than fall through to the next candidate.
  return { config: parseConfig(winner.text, winner.name), path: winner.path };
}
