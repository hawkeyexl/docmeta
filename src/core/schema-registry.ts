/**
 * Source of truth for schemas. Holds the built-in schemas (addressed by
 * `vendor:name:version` ids) and knows how to load any schema reference —
 * a built-in id, a local `.json` path, or an `http(s)` URL.
 */
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { DocmetaError } from "../types.js";

import okf01 from "../schemas/okf/0.1.json" with { type: "json" };
import diataxis10 from "../schemas/diataxis/1.0.json" with { type: "json" };
import sevenAction10 from "../schemas/seven-action/1.0.json" with { type: "json" };
import tgdp10 from "../schemas/tgdp/1.0.json" with { type: "json" };
import docusaurusDocs310 from "../schemas/docusaurus-docs/3.10.json" with { type: "json" };
import docusaurusBlog310 from "../schemas/docusaurus-blog/3.10.json" with { type: "json" };
import docusaurusPages310 from "../schemas/docusaurus-pages/3.10.json" with { type: "json" };

export interface BuiltinInfo {
  id: string;
  title: string;
  description: string;
}

/** Built-in schemas keyed by `vendor:name:version` id. */
const BUILTINS = new Map<string, Record<string, unknown>>([
  ["google:okf:0.1", okf01 as Record<string, unknown>],
  ["diataxis:diataxis:1.0", diataxis10 as Record<string, unknown>],
  ["passo-uno:seven-action:1.0", sevenAction10 as Record<string, unknown>],
  ["tgdp:templates:1.0", tgdp10 as Record<string, unknown>],
  ["docusaurus:docs:3.10", docusaurusDocs310 as Record<string, unknown>],
  ["docusaurus:blog:3.10", docusaurusBlog310 as Record<string, unknown>],
  ["docusaurus:pages:3.10", docusaurusPages310 as Record<string, unknown>],
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

/**
 * In-flight fetches, keyed on the *promise* rather than the resolved schema.
 *
 * `urlCache` only populates once the response has been read, so it collapses
 * repeat loads but not concurrent ones — and `fill` calls `loadSchema`
 * directly, once per file, inside a worker pool. Every worker therefore missed
 * the cache while the first fetch was still pending, and N files sharing one
 * remote ref fired N concurrent requests at the same host.
 *
 * Mirrors `Validator.compile`, including its two disciplines: the entry is
 * stored before the first await, and a rejection evicts it through a detached
 * `.catch()`. See the comments at the `set` below for why each matters.
 */
const urlInflight = new Map<string, Promise<Record<string, unknown>>>();

/** Default network timeout for fetching a remote (`http(s)`) schema. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Default cap on a fetched schema's body, in bytes.
 *
 * `AbortSignal.timeout` covers a *slow* body but not a *fast, huge* one, so
 * without a cap a hostile or misconfigured endpoint can stream until the
 * process runs out of memory. The largest schema docmeta itself ships is the
 * 112 KB SARIF meta-schema, so 5 MB is roughly two orders of magnitude of
 * headroom over anything a real document contract needs.
 */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Keys that make a JSON object a *contract* — something that can reject a
 * document. An object carrying none of them constrains nothing, so every
 * document passes it, and it is far likelier to be an error envelope served
 * with HTTP 200 (an API gateway, a proxy, a misconfigured bucket) than a
 * schema.
 *
 * This is deliberately **not** meta-schema validation. docmeta compiles four
 * dialects, and schema quality is the author's business: a sparse but real
 * schema must keep working. The guard targets one specific failure — a
 * non-schema served as one — and nothing else.
 */
const SCHEMA_KEYS = [
  "$schema",
  "$id",
  "$ref",
  "type",
  "properties",
  "required",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "enum",
  "const",
  "items",
] as const;

export interface LoadSchemaOptions {
  /** Abort a remote fetch after this many ms (default 10_000). */
  timeoutMs?: number;
  /** Reject a remote schema whose body exceeds this many bytes (default 5 MB). */
  maxBytes?: number;
}

/** An abort — ours are only ever raised by the request's timeout signal. */
function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** A short, single-line sample of a response body, for an error message. */
function excerpt(raw: string, limit = 200): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Read a response body, aborting once it exceeds `maxBytes`.
 *
 * Counts the bytes actually received. `content-length` is advisory — it may be
 * absent on a chunked response and it may simply be a lie — so it is never
 * consulted; trusting it is what leaves the cap bypassable.
 */
async function readCappedBody(
  ref: string,
  res: Response,
  maxBytes: number,
): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new DocmetaError(
          `Schema "${ref}" is too large: the response exceeds the ${maxBytes}-byte limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    // Drop the rest of the response when we bailed out early; a no-op once the
    // stream has already completed.
    void reader.cancel().catch(() => {});
  }
  // Concatenate before decoding: a multi-byte character can straddle a chunk
  // boundary, and decoding per chunk would corrupt it.
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reject a fetched payload that is not a schema.
 *
 * Only remote refs are guarded. A local file or a built-in is something the
 * user chose deliberately and can inspect, and a no-op contract there is their
 * call; a URL is a live third party that can answer with anything.
 */
function assertFetchedSchema(
  ref: string,
  value: unknown,
  raw: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    // A bare `true` is a legal JSON Schema meaning "everything passes" — the
    // same false green as an envelope, and never what a published document
    // contract means.
    return failNotASchema(
      ref,
      raw,
      `expected a JSON object, got ${Array.isArray(value) ? "an array" : `a ${typeof value}`}`,
    );
  }
  const schema = value as Record<string, unknown>;
  if (!SCHEMA_KEYS.some((key) => key in schema)) {
    return failNotASchema(
      ref,
      raw,
      "it constrains nothing, so every document would pass it. Expected an " +
        `object using at least one of: ${SCHEMA_KEYS.join(", ")}`,
    );
  }
  return schema;
}

function failNotASchema(ref: string, raw: string, reason: string): never {
  throw new DocmetaError(
    `Schema "${ref}" does not look like a JSON Schema: ${reason}. ` +
      `The server returned: ${excerpt(raw)}`,
  );
}

/** Fetch, size-cap, parse, and guard a remote schema. One request per call. */
async function fetchSchema(
  ref: string,
  options: LoadSchemaOptions,
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timedOut = new DocmetaError(
    `Failed to fetch schema "${ref}": timed out after ${timeoutMs}ms.`,
  );

  let res: Response;
  try {
    res = await fetch(ref, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (isAbort(err)) throw timedOut;
    throw new DocmetaError(
      `Failed to fetch schema "${ref}": ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new DocmetaError(
      `Failed to fetch schema "${ref}": HTTP ${res.status}.`,
    );
  }

  let raw: string;
  try {
    raw = await readCappedBody(ref, res, maxBytes);
  } catch (err) {
    if (err instanceof DocmetaError) throw err;
    // The headers arrive first, so a timeout during the body lands here rather
    // than on the `fetch` above. Reporting it as a parse failure — which is
    // what reading the body as JSON in one step did — points the operator at
    // the schema author instead of at the network.
    if (isAbort(err)) throw timedOut;
    throw new DocmetaError(
      `Failed to fetch schema "${ref}": ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DocmetaError(
      `Schema "${ref}" did not return valid JSON: ${(err as Error).message}`,
    );
  }

  const schema = assertFetchedSchema(ref, parsed, raw);
  urlCache.set(ref, schema);
  return schema;
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
    const inflight = urlInflight.get(ref);
    if (inflight) return inflight;
    // Synchronous by design: the `set` has to happen in the same tick as the
    // miss, or a second caller slips in before the entry exists and fetches
    // again.
    const pending = fetchSchema(ref, options);
    urlInflight.set(ref, pending);
    // A failed fetch is not cached — a transient failure must stay retryable
    // rather than poisoning the ref for the life of the process. The extra
    // `catch` keeps the eviction off the returned promise's chain, so it does
    // not convert the rejection into a handled one for the caller. On success
    // `urlCache` holds the schema and is consulted first, so the settled entry
    // left here is only a duplicate handle.
    pending.catch(() => {
      if (urlInflight.get(ref) === pending) urlInflight.delete(ref);
    });
    return pending;
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
