/**
 * Resolve the schema *set* for a single file by precedence:
 *   1. CLI --schema overrides (apply to all files)
 *   2. $schema in the file's metadata (string or list)
 *   3. first matching config override (by glob)
 *   4. config default schemas
 *   5. the built-in default set (DEFAULT_SCHEMAS)
 */
import { isAbsolute, resolve } from "node:path";
import picomatch from "picomatch";
import type { DocmetaConfig } from "./config.js";
import { classifyRef } from "./schema-registry.js";

/**
 * Applied when nothing else resolves. Seven-Action is safe to include here
 * because it constrains `action` — a key documents don't otherwise carry — and
 * does not require it, so adding it fails nothing that passed before.
 * Diataxis is deliberately absent: it both requires and constrains `type`, so
 * defaulting it would fail every repo not already on Diataxis.
 */
export const DEFAULT_SCHEMAS: readonly string[] = Object.freeze([
  "google:okf:0.1",
  "passo-uno:seven-action:1.0",
]);
export const FILE_SCHEMA_KEY = "$schema";

/**
 * Re-point a config's **local file** schema refs at the config's own directory.
 *
 * `schemas: ["./house.schema.json"]` means the file next to the config; that is
 * what the person editing the config can see. But `loadSchema` reads a file ref
 * relative to the process's working directory, so once the config lives
 * somewhere other than where the command was invoked — via `-c ../x.yaml`, or
 * via discovery finding an ancestor — the same ref points at nothing.
 *
 * Only refs the *config* supplied are rebased. A document's own `$schema` and a
 * `--schema` on the command line were both written by someone standing in the
 * working directory, so they keep resolving from there. Built-in ids and URLs
 * have no base to speak of and pass through untouched.
 *
 * When the config's directory *is* the working directory — every setup that
 * works today — the config object is returned unchanged, so nothing about an
 * existing run moves, right down to the ref strings that appear in reports.
 * The rebased form is absolute rather than relative on purpose: relative would
 * only be correct while `process.cwd()` matched `cwd`, which is true of the CLI
 * but not of `runValidate` called as a library.
 */
export function rebaseConfigSchemaRefs(
  config: DocmetaConfig,
  configDir: string,
  cwd: string,
): DocmetaConfig {
  if (resolve(configDir) === resolve(cwd)) return config;

  const rebase = (ref: string): string =>
    classifyRef(ref).kind === "file" && !isAbsolute(ref)
      ? resolve(configDir, ref)
      : ref;

  return {
    ...config,
    ...(config.schemas ? { schemas: config.schemas.map(rebase) } : {}),
    ...(config.overrides
      ? {
          overrides: config.overrides.map((o) => ({
            ...o,
            schemas: o.schemas.map(rebase),
          })),
        }
      : {}),
  };
}

export interface ResolveParams {
  /** File path (relative is fine) used for override glob matching. */
  filePath: string;
  /** `$schema` value pulled from the file's metadata. */
  fileSchema?: unknown;
  /** Repeatable `--schema` values; non-empty means override. */
  cliSchemas?: string[];
  /** Loaded config, if any. */
  config?: DocmetaConfig | null;
}

const matcherCache = new Map<string, (p: string) => boolean>();
function matches(glob: string, filePath: string): boolean {
  let m = matcherCache.get(glob);
  if (!m) {
    m = picomatch(glob, { dot: true });
    matcherCache.set(glob, m);
  }
  // Normalize Windows separators so globs written with `/` still match.
  return m(filePath.replace(/\\/g, "/"));
}

function coerceFileSchema(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  throw new Error(
    `Invalid "${FILE_SCHEMA_KEY}": must be a string or a list of strings.`,
  );
}

function dedupe(refs: string[]): string[] {
  return [...new Set(refs)];
}

export function resolveSchemaSet(params: ResolveParams): string[] {
  const { filePath, fileSchema, cliSchemas, config } = params;

  if (cliSchemas && cliSchemas.length > 0) return dedupe(cliSchemas);

  const fromFile = coerceFileSchema(fileSchema);
  if (fromFile && fromFile.length > 0) return dedupe(fromFile);

  if (config?.overrides) {
    for (const ov of config.overrides) {
      if (matches(ov.files, filePath) && ov.schemas.length > 0) {
        return dedupe(ov.schemas);
      }
    }
  }

  if (config?.schemas && config.schemas.length > 0) return dedupe(config.schemas);

  return [...DEFAULT_SCHEMAS];
}
