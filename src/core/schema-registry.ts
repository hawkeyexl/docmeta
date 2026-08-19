/**
 * Source of truth for schemas. Holds the built-in schemas (addressed by
 * `vendor:name:version` ids) and knows how to load any schema reference —
 * a built-in id, a local `.json` path, or an `http(s)` URL.
 */
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { DocmetaError } from "../types.js";
import {
  DEFAULT_TTL_HOURS,
  SchemaCache,
  schemaCacheDir,
} from "./schema-cache.js";

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
 * Refs whose `urlCache` entry came off the **network** in this process.
 *
 * `urlCache` is a memo, so an entry warmed by an earlier online call would
 * satisfy a later `offline` one — the guard never runs, because the short
 * circuit happens before it. For the CLI that is unreachable (each invocation
 * is a fresh process), but `loadSchema` is public API, and a long-lived
 * consumer doing `loadSchema(url)` then `loadSchema(url, { offline: true })`
 * would see offline "work" and then fail in an air-gapped process. Worse, it
 * holds even with no disk cache configured at all, so the run has nothing
 * legal to serve.
 *
 * Tracking provenance keeps the memo for entries an offline run may legally
 * use — anything read from the disk cache — while sending network-sourced refs
 * back through `resolveRemote`, which applies the guard.
 */
const urlFromNetwork = new Set<string>();

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
 *
 * The list is therefore deliberately **generous**, covering the standard
 * validation and applicator vocabularies across draft-04 through 2020-12. The
 * two failure directions are not symmetric: letting an odd payload through
 * means it fails at compile time or behaves as the permissive schema it
 * literally is, while rejecting a real schema breaks a working setup outright.
 * A schema whose only root keyword is `if`/`then` or `patternProperties` is
 * perfectly ordinary, and an error envelope carries none of these.
 */
const SCHEMA_KEYS = [
  // Core identity and reference
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  // Applicators
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependencies",
  // Object shape
  "type",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "dependentRequired",
  "minProperties",
  "maxProperties",
  // Array shape
  "items",
  "prefixItems",
  "contains",
  "unevaluatedItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  // Scalar constraints
  "enum",
  "const",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
] as const;

/**
 * Backoff before the single retry.
 *
 * One attempt, not three: the timeout already means a hung host costs
 * `timeoutMs`, and three retries would make that three times over per URL. One
 * removes the most common flake at a bounded cost.
 */
const RETRY_DELAY_MS = 500;

/**
 * Not `unref`'d, deliberately. During the backoff this timer is frequently the
 * only thing left on the event loop — an unref'd one lets node exit **0 with no
 * output at all**, turning a failed fetch into a silent green run.
 */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface LoadSchemaOptions {
  /** Abort a remote fetch after this many ms (default 10_000). */
  timeoutMs?: number;
  /** Reject a remote schema whose body exceeds this many bytes (default 5 MB). */
  maxBytes?: number;
  /**
   * Directory for the cross-run schema cache. Omitted means **no disk cache**:
   * the registry never guesses a project root, so a library caller gets the
   * in-process behavior until it opts in. The command cores pass
   * `schemaCacheDir(configDir ?? cwd)`.
   */
  cacheDir?: string;
  /** Hours a cached entry stays fresh; `0` disables the cache (default 24). */
  ttlHours?: number;
  /**
   * Never touch the network. A URL ref resolves from the disk cache — ignoring
   * the TTL, since there is no re-fetch to fall back on — and an uncached one
   * fails naming the URL. Built-ins and local files are unaffected.
   *
   * NOTE for whoever implements the remote-schema allowlist (proposal 0015): a
   * document's own `$schema` sits *above* config in the precedence chain, so a
   * document can name any URL and trigger a fetch, bypassing `schemas:`
   * entirely. `offline` blocks that **by accident** rather than by design. It
   * is not the guard, but it is currently the only thing standing there, so do
   * not remove it while "simplifying" until the real allowlist exists.
   */
  offline?: boolean;
}

/**
 * A fetch failure a second attempt might not hit: a network-level error, or a
 * 5xx. Never a 4xx — a 404 will not heal, and retrying it only doubles the
 * cost of a misconfiguration.
 *
 * Extends `DocmetaError` so that if the retry also fails, the error escaping
 * this module is already the operational error the CLI knows how to report.
 */
class RetryableFetchError extends DocmetaError {}

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
      // `Uint8Array` is always truthy, even at length 0, so this only ever
      // means "no chunk this turn" — not "skip an empty chunk".
      if (value === undefined) continue;
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
  // boundary, and decoding per chunk would corrupt it. `total` is already exact,
  // so passing it spares `concat` a second pass to re-derive the same length.
  return Buffer.concat(chunks, total).toString("utf8");
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
      // Diagnosis only. Naming all ~47 accepted keywords here pushed several
      // hundred characters between the operator and the response excerpt below,
      // which is the part that actually identifies the culprit. The full list
      // is reference material and lives in the schema-resolution docs.
      "it carries no JSON Schema keyword, so it constrains nothing and every " +
        "document would pass it",
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

/**
 * One request, returning an OK response.
 *
 * A network error and a 5xx are raised as `RetryableFetchError`; a 4xx and a
 * timeout are not. The timeout is deliberate: it is already the budget for a
 * host that is not answering, so retrying it buys no new information and
 * doubles the ceiling per URL.
 */
async function requestSchema(
  ref: string,
  timeoutMs: number,
  timedOut: DocmetaError,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(ref, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (isAbort(err)) throw timedOut;
    throw new RetryableFetchError(
      `Failed to fetch schema "${ref}": ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    // Discard the body: nothing reads it, and leaving it undrained can hold the
    // socket open — which matters now that a second request may follow.
    void res.body?.cancel().catch(() => {});
    const message = `Failed to fetch schema "${ref}": HTTP ${res.status}.`;
    throw res.status >= 500
      ? new RetryableFetchError(message)
      : new DocmetaError(message);
  }
  return res;
}

/** Fetch, size-cap, parse, and guard a remote schema. At most two requests. */
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
    res = await requestSchema(ref, timeoutMs, timedOut);
  } catch (err) {
    if (!(err instanceof RetryableFetchError)) throw err;
    await wait(RETRY_DELAY_MS);
    // The second attempt is the last one. If it fails the same way, the error
    // is already a `DocmetaError` and propagates as the operational failure it
    // is.
    res = await requestSchema(ref, timeoutMs, timedOut);
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

  return assertFetchedSchema(ref, parsed, raw);
}

/**
 * Resolve one remote ref: disk cache, then the network.
 *
 * Runs **inside** the in-flight promise the url branch stores, not beside it.
 * Hoisting the cache read out would put an `await` between the miss and the
 * `set`, which is the check-then-act race `urlInflight` exists to close — and
 * it would also let `fill`'s worker pool race N writes onto one cache file.
 */
async function resolveRemote(
  ref: string,
  options: LoadSchemaOptions,
): Promise<Record<string, unknown>> {
  const cache = options.cacheDir
    ? new SchemaCache(options.cacheDir, options.ttlHours ?? DEFAULT_TTL_HOURS)
    : null;

  if (cache) {
    // Offline ignores the TTL: expiry exists to trigger a re-fetch, and there
    // is none available, so a stale contract beats no contract at all.
    const hit = await cache.read(ref, { ignoreTtl: options.offline === true });
    if (hit) {
      urlCache.set(ref, hit);
      // Served from disk, so an offline call may use this memo from now on.
      urlFromNetwork.delete(ref);
      return hit;
    }
  }

  if (options.offline === true) {
    // The remedy depends on the configuration, and the old wording named a
    // hard-coded directory while advising a re-run that could never help. With
    // no cache configured, or with the TTL set to 0, running online populates
    // nothing — so saying "run once online" there sends the operator in a
    // circle.
    const remedy = cache
      ? `Run once without --offline to populate ${options.cacheDir}, or point the reference at a local file.`
      : "No schema cache is configured for this run (`schemaCache.ttlHours: 0` disables it), so there is nothing for --offline to read. Enable the cache, or point the reference at a local file or a built-in id.";
    throw new DocmetaError(
      `Cannot resolve schema "${ref}": --offline is set and it could not be served from cache. ${remedy}`,
    );
  }

  const schema = await fetchSchema(ref, options);
  urlCache.set(ref, schema);
  urlFromNetwork.add(ref);
  if (cache && (await cache.write(ref, schema))) {
    // Only once the entry really landed. `write` swallows its failures by
    // design — a read-only checkout must not fail the run — so clearing the
    // mark unconditionally would tell a later offline call it may use the memo
    // for a schema that never reached disk: the same false pass, one step
    // narrower.
    urlFromNetwork.delete(ref);
  }
  return schema;
}

/**
 * Settle the remote-schema options for one run, from the config and the flag.
 *
 * Lives here rather than in a command core because all three commands need the
 * same answer, and because "where does the cache live" is a property of schema
 * loading, not of `validate`. `root` is the config's directory when a config
 * governs the run, so a developer running from `docs/` shares the cache with
 * CI running from the repo root instead of quietly keeping a second one.
 */
export function schemaLoadOptions(args: {
  root: string;
  /** Config `schemaCache.ttlHours`. */
  ttlHours?: number;
  /** `--offline`, else config `offline:`. */
  offline?: boolean;
}): LoadSchemaOptions {
  return {
    cacheDir: schemaCacheDir(args.root),
    ...(args.ttlHours !== undefined ? { ttlHours: args.ttlHours } : {}),
    ...(args.offline !== undefined ? { offline: args.offline } : {}),
  };
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
    // An offline call must not be satisfied by something this process pulled
    // over the network; it goes back through `resolveRemote` so the disk cache
    // and the guard both apply, exactly as they would in a fresh process.
    if (cached && !(options.offline === true && urlFromNetwork.has(ref))) {
      return cached;
    }
    const inflight = urlInflight.get(ref);
    // A caller joining an in-flight fetch inherits the first caller's
    // `timeoutMs`/`maxBytes` — there is one request, so there is one set of
    // limits. Every production call site uses the defaults, so this is only
    // reachable from a library consumer passing custom options for a URL
    // another call is already fetching.
    if (inflight) return inflight;
    // Synchronous by design: the `set` has to happen in the same tick as the
    // miss, or a second caller slips in before the entry exists and fetches
    // again.
    const pending = resolveRemote(ref, options);
    urlInflight.set(ref, pending);
    // Evict once settled, either way. This map exists only to collapse
    // *concurrent* callers onto one request; `urlCache` is the actual cache and
    // is consulted first, so a resolved entry left here is a duplicate handle
    // that would accumulate one per distinct URL for the life of the process.
    // Eviction is safe at this point because `fetchSchema` populates `urlCache`
    // before it resolves, so a caller arriving after the delete finds the
    // schema rather than re-fetching.
    //
    // A failed fetch is likewise not retained, so a transient failure stays
    // retryable rather than poisoning the ref. The `catch` before `finally`
    // keeps this chain off the returned promise: without it, a rejection would
    // surface here as an unhandled one, and the caller's own rejection must
    // remain theirs to handle.
    void pending
      .catch(() => {})
      .finally(() => {
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
