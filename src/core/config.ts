/**
 * Optional lightweight YAML config (`docmeta.config.yaml`). Supplies default
 * targets, excludes, the default schema set, and optional per-glob overrides,
 * so CI can run a bare `docmeta validate`.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { DocmetaError } from "../types.js";

export interface SchemaOverride {
  files: string;
  schemas: string[];
}

export interface DocmetaConfig {
  paths?: string[];
  exclude?: string[];
  schemas?: string[];
  overrides?: SchemaOverride[];
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

  return config;
}

/**
 * Load config from an explicit path (error if missing) or by discovery in cwd.
 * Returns null when no config is found via discovery.
 */
export async function loadConfig(
  explicitPath?: string,
  cwd: string = process.cwd(),
): Promise<{ config: DocmetaConfig; path: string } | null> {
  if (explicitPath) {
    let text: string;
    try {
      text = await readFile(explicitPath, "utf8");
    } catch {
      throw new DocmetaError(`Config file not found: "${explicitPath}".`);
    }
    return { config: parseConfig(text, explicitPath), path: explicitPath };
  }

  for (const name of CONFIG_NAMES) {
    const p = resolve(cwd, name);
    try {
      const text = await readFile(p, "utf8");
      return { config: parseConfig(text, name), path: p };
    } catch {
      // not found; try next
    }
  }
  return null;
}
