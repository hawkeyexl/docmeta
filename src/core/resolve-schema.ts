/**
 * Resolve the schema *set* for a single file by precedence:
 *   1. CLI --schema overrides (apply to all files)
 *   2. $schema in the file's metadata (string or list)
 *   3. first matching config override (by glob)
 *   4. config default schemas
 *   5. built-in default (google:okf:0.1)
 */
import picomatch from "picomatch";
import type { DocmetaConfig } from "./config.js";

export const DEFAULT_SCHEMA = "google:okf:0.1";
export const FILE_SCHEMA_KEY = "$schema";

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

  return [DEFAULT_SCHEMA];
}
