/**
 * Source of truth for schemas. Holds the built-in schemas (addressed by
 * `vendor:name:version` ids) and knows how to load any schema reference —
 * a built-in id, a local `.json` path, or an `http(s)` URL.
 */
import { readFile } from "node:fs/promises";
import { DocmetaError } from "../types.js";

import okf01 from "../schemas/okf/0.1.json" with { type: "json" };
import docevals01 from "../schemas/docevals/0.1.json" with { type: "json" };
import dockg01 from "../schemas/dockg/0.1.json" with { type: "json" };

export interface BuiltinInfo {
  id: string;
  title: string;
  description: string;
}

/** Built-in schemas keyed by `vendor:name:version` id. */
const BUILTINS = new Map<string, Record<string, unknown>>([
  ["google:okf:0.1", okf01 as Record<string, unknown>],
  ["docevals:frontmatter:0.1", docevals01 as Record<string, unknown>],
  ["dockg:frontmatter:0.1", dockg01 as Record<string, unknown>],
]);

export function listBuiltins(): BuiltinInfo[] {
  return [...BUILTINS.entries()].map(([id, schema]) => ({
    id,
    title: typeof schema.title === "string" ? schema.title : id,
    description:
      typeof schema.description === "string" ? schema.description : "",
  }));
}

export type RefKind = "builtin" | "file" | "url";

/**
 * A built-in id looks like `seg(:seg)+` using only [a-z0-9._-] segments, with
 * no path separators and not ending in `.json`. This deliberately excludes
 * Windows paths (`C:\...`), URLs, and `.json` files so a typo'd built-in is
 * reported as an unknown id rather than silently treated as a missing file.
 */
const BUILTIN_ID = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$/i;

export function classifyRef(ref: string): { kind: RefKind; ref: string } {
  if (/^https?:\/\//i.test(ref)) return { kind: "url", ref };
  if (
    !ref.includes("/") &&
    !ref.includes("\\") &&
    !ref.toLowerCase().endsWith(".json") &&
    BUILTIN_ID.test(ref)
  ) {
    return { kind: "builtin", ref };
  }
  return { kind: "file", ref };
}

const urlCache = new Map<string, Record<string, unknown>>();

/** Default network timeout for fetching a remote (`http(s)`) schema. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface LoadSchemaOptions {
  /** Abort a remote fetch after this many ms (default 10_000). */
  timeoutMs?: number;
}

/** Load and return the JSON Schema object for a reference. */
export async function loadSchema(
  ref: string,
  options: LoadSchemaOptions = {},
): Promise<Record<string, unknown>> {
  const { kind } = classifyRef(ref);

  if (kind === "builtin") {
    const schema = BUILTINS.get(ref);
    if (!schema) {
      const available = [...BUILTINS.keys()].join(", ");
      throw new DocmetaError(
        `Unknown built-in schema "${ref}". Available: ${available || "(none)"}.`,
      );
    }
    return schema;
  }

  if (kind === "url") {
    const cached = urlCache.get(ref);
    if (cached) return cached;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let res: Response;
    try {
      res = await fetch(ref, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new DocmetaError(
          `Failed to fetch schema "${ref}": timed out after ${timeoutMs}ms.`,
        );
      }
      throw new DocmetaError(`Failed to fetch schema "${ref}": ${e.message}`);
    }
    if (!res.ok) {
      throw new DocmetaError(
        `Failed to fetch schema "${ref}": HTTP ${res.status}.`,
      );
    }
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      throw new DocmetaError(
        `Schema "${ref}" did not return valid JSON: ${(err as Error).message}`,
      );
    }
    urlCache.set(ref, json);
    return json;
  }

  // file
  let raw: string;
  try {
    raw = await readFile(ref, "utf8");
  } catch {
    throw new DocmetaError(`Schema file not found: "${ref}".`);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new DocmetaError(
      `Schema file "${ref}" is not valid JSON: ${(err as Error).message}`,
    );
  }
}
