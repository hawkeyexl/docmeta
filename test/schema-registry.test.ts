import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  listBuiltins,
  classifyRef,
  fetchSchemaBytes,
  isPublishedBuiltinUrl,
  loadSchema,
  publishedBuiltins,
} from "../src/core/schema-registry.js";
import { SchemaCache } from "../src/core/schema-cache.js";
import { DocmetaError } from "../src/types.js";
import { startSchemaServer, type SchemaServer } from "./helpers/schema-server.js";

const here = dirname(fileURLToPath(import.meta.url));

const URL_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["type"],
};

describe("schema registry", () => {
  it("lists every built-in", () => {
    const ids = listBuiltins().map((b) => b.id);
    expect(ids).toContain("google:okf:0.1");
    expect(ids).toContain("diataxis:diataxis:1.0");
    expect(ids).toContain("passo-uno:seven-action:1.0");
    expect(ids).toContain("tgdp:templates:1.0");
    expect(ids).toContain("docusaurus:docs:3.10");
    expect(ids).toContain("docusaurus:blog:3.10");
    expect(ids).toContain("docusaurus:pages:3.10");
  });

  it("classifies a built-in id whose version segment has two dots", () => {
    // `3.10` is a legal segment: the id pattern allows dots, and the ref must
    // not be mistaken for a file path just because it looks like a version.
    expect(classifyRef("docusaurus:docs:3.10").kind).toBe("builtin");
  });

  it("classifies a built-in id", () => {
    expect(classifyRef("google:okf:0.1").kind).toBe("builtin");
    // A hyphenated vendor segment must still classify as a built-in, not a file.
    expect(classifyRef("passo-uno:seven-action:1.0").kind).toBe("builtin");
  });

  it("loads the taxonomy built-ins, keyed on their own property", async () => {
    const diataxis = await loadSchema("diataxis:diataxis:1.0");
    expect(
      (diataxis as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("type");

    const sevenAction = await loadSchema("passo-uno:seven-action:1.0");
    expect(
      (sevenAction as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("action");

    const tgdp = await loadSchema("tgdp:templates:1.0");
    expect(
      (tgdp as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("type");
  });

  it("does not require a key on the vocabulary-only taxonomy schema", async () => {
    const schema = await loadSchema("passo-uno:seven-action:1.0");
    expect((schema as { required?: string[] }).required).toBeUndefined();
  });

  it("requires `type` on both content-type taxonomy schemas", async () => {
    for (const id of ["diataxis:diataxis:1.0", "tgdp:templates:1.0"]) {
      const schema = await loadSchema(id);
      expect((schema as { required?: string[] }).required, id).toEqual(["type"]);
    }
  });

  it("classifies an http(s) url", () => {
    expect(classifyRef("https://example.com/s.json").kind).toBe("url");
  });

  it("classifies a local .json path (incl. Windows-style)", () => {
    expect(classifyRef("./schemas/x.json").kind).toBe("file");
    expect(classifyRef("schemas/x.json").kind).toBe("file");
    expect(classifyRef("C:\\schemas\\x.json").kind).toBe("file");
  });

  it("loads the OKF built-in schema object", async () => {
    const schema = await loadSchema("google:okf:0.1");
    expect((schema as { required?: string[] }).required).toEqual(["type"]);
  });

  it("errors on an unknown built-in id, listing available ones", async () => {
    await expect(loadSchema("google:nope:9.9")).rejects.toBeInstanceOf(
      DocmetaError,
    );
    await expect(loadSchema("google:nope:9.9")).rejects.toThrow(
      /google:okf:0\.1/,
    );
  });

  it("loads a schema from a local file path", async () => {
    const p = join(here, "fixtures", "extra.schema.json");
    const schema = await loadSchema(p);
    expect(schema).toBeTypeOf("object");
  });
});

describe("loadSchema over http(s)", () => {
  let server: SchemaServer;

  beforeAll(async () => {
    server = await startSchemaServer({
      "/ok.json": { json: URL_SCHEMA },
      "/cached.json": { json: URL_SCHEMA },
      "/notjson.json": { body: "<html>nope</html>", contentType: "text/html" },
      "/slow.json": { json: URL_SCHEMA, delayMs: 500 },
      "/gone.json": { status: 404, json: { error: "not found" } },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("fetches and returns the schema object", async () => {
    const schema = await loadSchema(`${server.url}/ok.json`);
    expect((schema as { required?: string[] }).required).toEqual(["type"]);
  });

  it("caches the URL — a second load does not hit the server again", async () => {
    const ref = `${server.url}/cached.json`;
    await loadSchema(ref);
    await loadSchema(ref);
    expect(server.hits("/cached.json")).toBe(1);
  });

  it("errors on a non-2xx response", async () => {
    await expect(loadSchema(`${server.url}/missing.json`)).rejects.toThrow(
      DocmetaError,
    );
    await expect(loadSchema(`${server.url}/missing.json`)).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it("errors on a routed non-2xx response with a JSON body", async () => {
    // The unregistered-path case above only proves the helper's fallback. A
    // real gateway answers 404 *with* a JSON envelope, and the status is what
    // must decide — before the payload guard ever sees the body.
    await expect(loadSchema(`${server.url}/gone.json`)).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it("errors on a non-JSON body", async () => {
    await expect(loadSchema(`${server.url}/notjson.json`)).rejects.toThrow(
      DocmetaError,
    );
    await expect(loadSchema(`${server.url}/notjson.json`)).rejects.toThrow(
      /JSON/,
    );
  });

  it("errors when the request exceeds the timeout", async () => {
    await expect(
      loadSchema(`${server.url}/slow.json`, { timeoutMs: 50 }),
    ).rejects.toThrow(DocmetaError);
    await expect(
      loadSchema(`${server.url}/slow.json`, { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/i);
  });
});

/**
 * Every test here must use a **fresh path**: `urlCache` is module-global and
 * has no reset hook, so a reused path silently replays an earlier test's entry.
 */
describe("loadSchema over http(s) — payload guard", () => {
  let server: SchemaServer;

  beforeAll(async () => {
    server = await startSchemaServer({
      "/guard-envelope.json": {
        json: { error: "not found", requestId: "abc123" },
      },
      "/guard-permissive.json": { json: { type: "object" } },
      "/guard-empty.json": { json: {} },
      "/guard-array.json": { json: [{ type: "object" }] },
      "/guard-boolean.json": { body: "true" },
      "/guard-ref.json": { json: { $ref: "https://example.com/other.json" } },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("rejects a JSON error envelope served with HTTP 200", async () => {
    // The false green this guard exists for: an API gateway, proxy, or
    // misconfigured bucket answers 200 with `{"error":"..."}`, which compiles
    // as a schema with no constraints and therefore passes every document.
    const ref = `${server.url}/guard-envelope.json`;
    // One call, then assert on the captured error. A rejection deliberately
    // stays retryable, so calling twice would make a second real round-trip.
    const err = await loadSchema(ref).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(DocmetaError);
    // Names the URL and shows what actually came back, so the operator can see
    // it is their gateway talking and not a schema at all.
    expect(err.message).toContain(ref);
    expect(err.message).toContain('"error":"not found"');
  });

  it("accepts a legitimately permissive schema", async () => {
    // `{"type":"object"}` constrains almost nothing, and is still a real
    // contract. The guard targets a non-schema served as one, not schema
    // quality, so this must pass.
    const schema = await loadSchema(`${server.url}/guard-permissive.json`);
    expect(schema).toEqual({ type: "object" });
  });

  it("rejects `{}` — it is indistinguishable from an error envelope", async () => {
    // Decision, recorded: an empty object is a *valid* JSON Schema, but over
    // the wire it is exactly the failure shape — it constrains nothing, so
    // every document passes. Nothing in the response separates a deliberate
    // no-op contract from a body that lost its content, so a fetched `{}` is
    // rejected. Local files and built-ins are not guarded, so a deliberate
    // no-op schema is still expressible.
    await expect(
      loadSchema(`${server.url}/guard-empty.json`),
    ).rejects.toBeInstanceOf(DocmetaError);
  });

  it("rejects a JSON array and a bare boolean", async () => {
    await expect(
      loadSchema(`${server.url}/guard-array.json`),
    ).rejects.toBeInstanceOf(DocmetaError);
    // `true` is a legal JSON Schema meaning "everything passes" — the same
    // false green, and never what a published document contract means.
    await expect(
      loadSchema(`${server.url}/guard-boolean.json`),
    ).rejects.toBeInstanceOf(DocmetaError);
  });

  it("accepts a schema that only delegates with $ref", async () => {
    const schema = await loadSchema(`${server.url}/guard-ref.json`);
    expect(schema).toHaveProperty("$ref");
  });
});

describe("loadSchema over http(s) — response size cap", () => {
  let server: SchemaServer;
  /** A real schema roughly 64 KB on the wire — under the 5 MB default cap. */
  const BIG_BUT_FINE = {
    ...URL_SCHEMA,
    description: "x".repeat(64 * 1024),
  };

  beforeAll(async () => {
    server = await startSchemaServer({
      // Chunked, so there is no `content-length` to consult: the cap must
      // count bytes as they arrive.
      "/cap-huge.json": {
        streamChunks: { text: "x".repeat(1024), count: 64 },
      },
      "/cap-under.json": { json: BIG_BUT_FINE },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("rejects a body past the cap, counting bytes rather than content-length", async () => {
    const ref = `${server.url}/cap-huge.json`;
    const err = await loadSchema(ref, { maxBytes: 8 * 1024 }).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(DocmetaError);
    expect(err.message).toContain(ref);
    expect(err.message).toMatch(/too large|exceeds/i);
  });

  it("accepts a large-but-reasonable schema under the default cap", async () => {
    const schema = await loadSchema(`${server.url}/cap-under.json`);
    expect((schema as { description?: string }).description).toHaveLength(
      64 * 1024,
    );
  });
});

describe("loadSchema over http(s) — timeout during the body", () => {
  let server: SchemaServer;

  beforeAll(async () => {
    server = await startSchemaServer({
      "/body-timeout.json": { json: URL_SCHEMA, bodyDelayMs: 1_000 },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("reports a timeout, not a JSON parse failure", async () => {
    // The headers arrive, so `fetch()` resolves and the abort lands while the
    // body is being read. That used to surface as "did not return valid JSON",
    // which points the operator at the schema author instead of the network.
    const ref = `${server.url}/body-timeout.json`;
    const err = await loadSchema(ref, { timeoutMs: 100 }).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(DocmetaError);
    expect(err.message).toMatch(/timed out/i);
    expect(err.message).not.toMatch(/valid JSON/i);
  });
});

describe("loadSchema over http(s) — in-flight dedup", () => {
  let server: SchemaServer;

  beforeAll(async () => {
    server = await startSchemaServer({
      // Delayed so the concurrent callers really do overlap.
      "/dedup.json": { json: URL_SCHEMA, delayMs: 100 },
      "/dedup-fail.json": { status: 500, json: { error: "boom" } },
      "/settled.json": { json: URL_SCHEMA },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("collapses concurrent loads of one URL into a single fetch", async () => {
    // `fill` calls loadSchema directly, once per file, inside a worker pool —
    // and `urlCache` only populates once the response has been read, so N
    // files sharing one remote ref fired N concurrent fetches.
    const ref = `${server.url}/dedup.json`;
    const schemas = await Promise.all(
      Array.from({ length: 8 }, () => loadSchema(ref)),
    );
    expect(server.hits("/dedup.json")).toBe(1);
    // Every caller gets the one schema, not a partially-shared object.
    for (const schema of schemas) expect(schema).toEqual(schemas[0]);
  });

  it("does not retain a settled entry once the fetch has resolved", async () => {
    // The in-flight map exists only to collapse *concurrent* callers; `urlCache`
    // is the real cache. A resolved entry left behind would accumulate one per
    // distinct URL for the life of the process — invisible, because the schema
    // still resolves correctly from either map.
    //
    // Asserted through behavior rather than by reaching into module state: a
    // *sequential* second call must be served by `urlCache` without a new
    // request, which holds whether or not the in-flight entry was evicted, and
    // a concurrent pair must still collapse. Together they pin that eviction did
    // not break either path.
    const ref = `${server.url}/settled.json`;
    await loadSchema(ref);
    await loadSchema(ref);
    expect(server.hits("/settled.json")).toBe(1);

    const again = await Promise.all([loadSchema(ref), loadSchema(ref)]);
    expect(server.hits("/settled.json")).toBe(1);
    expect(again[0]).toEqual(again[1]);
  });

  it("keeps a failed fetch retryable rather than caching the rejection", async () => {
    const ref = `${server.url}/dedup-fail.json`;
    await expect(loadSchema(ref)).rejects.toBeInstanceOf(DocmetaError);
    await expect(loadSchema(ref)).rejects.toBeInstanceOf(DocmetaError);
    // A transient failure must not poison the ref for the life of the process:
    // the second call has to reach the server again.
    //
    // Four requests, not two: a 5xx is retried once within each call, so two
    // calls make two attempts each. That the count is 4 rather than 2 is itself
    // the proof the retry fired on a route that never heals.
    expect(server.hits("/dedup-fail.json")).toBe(4);
  });
});

/**
 * One retry, on network errors and 5xx only.
 *
 * Every route here is dynamic — a static table cannot express "fail once, then
 * succeed", and against a permanently-failing route a retry that fired is
 * indistinguishable from one that did not.
 */
describe("loadSchema over http(s) — retry", () => {
  let server: SchemaServer;

  beforeAll(async () => {
    server = await startSchemaServer({
      "/retry-5xx.json": (hit) =>
        hit === 1 ? { status: 503, json: { error: "unavailable" } } : { json: URL_SCHEMA },
      "/retry-network.json": (hit) =>
        hit === 1 ? { resetSocket: true } : { json: URL_SCHEMA },
      "/retry-404.json": () => ({ status: 404, json: { error: "gone" } }),
      "/retry-400.json": () => ({ status: 400, json: { error: "bad" } }),
      "/retry-timeout.json": () => ({ json: URL_SCHEMA, delayMs: 500 }),
      "/retry-guard.json": () => ({ json: { error: "not found" } }),
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("retries once after a 5xx and succeeds on the second attempt", async () => {
    const schema = await loadSchema(`${server.url}/retry-5xx.json`);
    expect((schema as { required?: string[] }).required).toEqual(["type"]);
    expect(server.hits("/retry-5xx.json")).toBe(2);
  });

  it("retries once after a network-level failure", async () => {
    const schema = await loadSchema(`${server.url}/retry-network.json`);
    expect((schema as { required?: string[] }).required).toEqual(["type"]);
    expect(server.hits("/retry-network.json")).toBe(2);
  });

  it("does not retry a 404 — it will not heal", async () => {
    await expect(
      loadSchema(`${server.url}/retry-404.json`),
    ).rejects.toThrow(/HTTP 404/);
    expect(server.hits("/retry-404.json")).toBe(1);
  });

  it("does not retry any other 4xx", async () => {
    await expect(
      loadSchema(`${server.url}/retry-400.json`),
    ).rejects.toThrow(/HTTP 400/);
    expect(server.hits("/retry-400.json")).toBe(1);
  });

  it("does not retry a timeout — a hung host would cost double", async () => {
    // The timeout is already the budget for a host that is not answering.
    // Retrying it turns a 10 s ceiling into 20 s per URL for no new information.
    await expect(
      loadSchema(`${server.url}/retry-timeout.json`, { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/i);
    expect(server.hits("/retry-timeout.json")).toBe(1);
  });

  it("does not retry a payload the guard rejected", async () => {
    // A 200 that is not a schema is a configuration fact about the server, not
    // a transient one, and the request already succeeded.
    await expect(
      loadSchema(`${server.url}/retry-guard.json`),
    ).rejects.toBeInstanceOf(DocmetaError);
    expect(server.hits("/retry-guard.json")).toBe(1);
  });
});

/**
 * The cross-run disk cache.
 *
 * Two hazards shape every test here. `urlCache` is module-global and has no
 * reset hook, so each test needs a **fresh URL path** or it silently replays an
 * earlier entry — and it would also mask the disk read this suite exists to
 * prove. And the cache writes real files, so each test gets its own temp
 * directory.
 */
describe("loadSchema over http(s) — cross-run cache", () => {
  let server: SchemaServer;
  let dir: string;

  beforeAll(async () => {
    server = await startSchemaServer({
      "/xcache-write.json": { json: URL_SCHEMA },
      "/xcache-fresh.json": { json: URL_SCHEMA },
      "/xcache-stale.json": { json: URL_SCHEMA },
      "/xcache-off.json": { json: URL_SCHEMA },
      "/xcache-corrupt.json": { json: URL_SCHEMA },
      "/xcache-fail.json": { status: 500, json: { error: "boom" } },
      "/offline-hit.json": { json: URL_SCHEMA },
      "/offline-stale.json": { json: URL_SCHEMA },
      "/offline-cold.json": { json: URL_SCHEMA },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docmeta-registry-cache-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Age an entry past any TTL, which is measured on the file's mtime. */
  const backdate = (path: string, hours: number): void => {
    const when = new Date(Date.now() - hours * 3_600_000);
    utimesSync(path, when, when);
  };

  it("writes a successful fetch to disk", async () => {
    const ref = `${server.url}/xcache-write.json`;
    await loadSchema(ref, { cacheDir: dir });
    // Read the file back through a separate cache instance: this is what the
    // *next process* would see, which is the whole point of the feature.
    expect(await new SchemaCache(dir, 24).read(ref)).toEqual(URL_SCHEMA);
  });

  it("serves a fresh entry without touching the network", async () => {
    const ref = `${server.url}/xcache-fresh.json`;
    await new SchemaCache(dir, 24).write(ref, URL_SCHEMA);
    const schema = await loadSchema(ref, { cacheDir: dir });
    expect(schema).toEqual(URL_SCHEMA);
    expect(server.hits("/xcache-fresh.json")).toBe(0);
  });

  it("refetches once the entry is past the TTL", async () => {
    const ref = `${server.url}/xcache-stale.json`;
    const cache = new SchemaCache(dir, 24);
    // A *different* body, so a stale hit would be visible in the result rather
    // than merely in the request count.
    await cache.write(ref, { type: "object", title: "stale copy" });
    backdate(cache.entryPath(ref), 25);
    const schema = await loadSchema(ref, { cacheDir: dir });
    expect(schema).toEqual(URL_SCHEMA);
    expect(server.hits("/xcache-stale.json")).toBe(1);
  });

  it("ttlHours: 0 disables the cache entirely", async () => {
    const ref = `${server.url}/xcache-off.json`;
    await new SchemaCache(dir, 24).write(ref, { type: "object", title: "cached" });
    const schema = await loadSchema(ref, { cacheDir: dir, ttlHours: 0 });
    expect(schema).toEqual(URL_SCHEMA);
    expect(server.hits("/xcache-off.json")).toBe(1);
    // Nothing new was recorded either.
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("treats a corrupt entry as a miss rather than failing the run", async () => {
    const ref = `${server.url}/xcache-corrupt.json`;
    const cache = new SchemaCache(dir, 24);
    await cache.write(ref, URL_SCHEMA);
    writeFileSync(cache.entryPath(ref), "{ this is not json");
    const schema = await loadSchema(ref, { cacheDir: dir });
    expect(schema).toEqual(URL_SCHEMA);
    expect(server.hits("/xcache-corrupt.json")).toBe(1);
  });

  it("does not cache a failed fetch", async () => {
    const ref = `${server.url}/xcache-fail.json`;
    await expect(loadSchema(ref, { cacheDir: dir })).rejects.toBeInstanceOf(
      DocmetaError,
    );
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("--offline serves a cached URL without touching the network", async () => {
    const ref = `${server.url}/offline-hit.json`;
    await new SchemaCache(dir, 24).write(ref, URL_SCHEMA);
    const schema = await loadSchema(ref, { cacheDir: dir, offline: true });
    expect(schema).toEqual(URL_SCHEMA);
    expect(server.hits("/offline-hit.json")).toBe(0);
  });

  it("--offline ignores the TTL — a stale copy beats no answer", async () => {
    const ref = `${server.url}/offline-stale.json`;
    const cache = new SchemaCache(dir, 24);
    await cache.write(ref, URL_SCHEMA);
    backdate(cache.entryPath(ref), 500);
    expect(await loadSchema(ref, { cacheDir: dir, offline: true })).toEqual(
      URL_SCHEMA,
    );
    expect(server.hits("/offline-stale.json")).toBe(0);
  });

  it("--offline fails naming the URL when it is not cached", async () => {
    const ref = `${server.url}/offline-cold.json`;
    const err = await loadSchema(ref, { cacheDir: dir, offline: true }).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(DocmetaError);
    expect(err.message).toContain(ref);
    expect(err.message).toMatch(/offline/i);
    // The point of the flag: no request was made, even to a reachable host.
    expect(server.hits("/offline-cold.json")).toBe(0);
  });

  it("--offline leaves built-ins and local files alone", async () => {
    // Built-ins are bundled imports and file refs are `readFile`; neither
    // touches the network, so `--offline` must not constrain them. Asserted so
    // nobody later "optimizes" a built-in into a fetch and breaks air-gapped
    // users.
    const builtin = await loadSchema("google:okf:0.1", { offline: true });
    expect((builtin as { required?: string[] }).required).toEqual(["type"]);
    const file = await loadSchema(join(here, "fixtures", "extra.schema.json"), {
      offline: true,
    });
    expect(file).toBeTypeOf("object");
  });

});

describe("loadSchema over http(s) — the guard must not reject real schemas", () => {
  let server: SchemaServer;

  beforeAll(async () => {
    server = await startSchemaServer({
      "/real-if-then.json": {
        json: {
          if: { properties: { type: { const: "blog" } } },
          then: { required: ["category"] },
        },
      },
      "/real-pattern-props.json": {
        json: { patternProperties: { "^x-": { type: "string" } } },
      },
      "/real-additional.json": { json: { additionalProperties: false } },
      "/real-defs.json": {
        json: { $defs: { name: { type: "string" } } },
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  // The guard's two failure directions are not symmetric. Letting an odd
  // payload through means it fails at compile time or behaves as the permissive
  // schema it literally is; rejecting a real schema breaks a working setup
  // outright. A schema whose only root keyword is a conditional or an
  // object-shape applicator is perfectly ordinary.
  // Named by the keyword under test rather than the route, so a failure says
  // which keyword the guard rejected without the reader opening the file.
  const ordinary: { keyword: string; path: string }[] = [
    { keyword: "if/then", path: "real-if-then" },
    { keyword: "patternProperties", path: "real-pattern-props" },
    { keyword: "additionalProperties", path: "real-additional" },
    { keyword: "$defs", path: "real-defs" },
  ];

  for (const { keyword, path } of ordinary) {
    it(`accepts a schema whose only root keyword is ${keyword}`, async () => {
      await expect(
        loadSchema(`${server.url}/${path}.json`),
      ).resolves.toBeTypeOf("object");
    });
  }
});

describe("loadSchema over http(s) — offline is not satisfied by a warm memo", () => {
  let server: SchemaServer;

  beforeAll(async () => {
    server = await startSchemaServer({
      "/memo-nocache.json": { json: URL_SCHEMA },
      "/memo-disk.json": { json: URL_SCHEMA },
      "/memo-inflight.json": { json: URL_SCHEMA, delayMs: 150 },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("refuses an offline call for a ref this process fetched over the network", async () => {
    // `urlCache` is a memo, so an entry warmed by an earlier online call would
    // otherwise satisfy a later offline one — the guard short-circuits before it
    // ever runs. Unreachable from the CLI, where every invocation is a fresh
    // process, but `loadSchema` is public API and a long-lived consumer would
    // see offline "work" here and then fail in an air-gapped process.
    //
    // No `cacheDir` at all, so there is genuinely nothing legal to serve.
    const ref = `${server.url}/memo-nocache.json`;
    await expect(loadSchema(ref)).resolves.toBeTypeOf("object");
    await expect(loadSchema(ref, { offline: true })).rejects.toBeInstanceOf(
      DocmetaError,
    );
  });

  it("refuses an offline call that joins an in-flight network fetch", async () => {
    // The concurrent form of the test above, and the one the provenance guard
    // does not reach: `urlFromNetwork` is only consulted against a *settled*
    // memo, so an offline call arriving while the fetch is still open falls
    // through to `urlInflight` and is handed the network result directly.
    //
    // Reachable the moment two differently-configured validators share a
    // process — which `Validator`'s own doc comment describes, and promises is
    // safe: "`offline` is excluded from that sharing on purpose".
    const ref = `${server.url}/memo-inflight.json`;
    const online = loadSchema(ref);
    // Started in the same tick, so `urlInflight` holds the online fetch: the
    // `set` happens before `loadSchema` reaches its first await.
    const offline = loadSchema(ref, { offline: true });
    // The rejection is asserted first on purpose. It arrives long before the
    // 150ms fetch settles, and awaiting `online` ahead of it would leave a
    // rejected promise unhandled for that whole window — which node reports and
    // vitest fails the file on, for a run that is otherwise correct.
    await expect(offline).rejects.toBeInstanceOf(DocmetaError);
    await expect(online).resolves.toBeTypeOf("object");
  });

  it("does serve an offline call once the ref is on disk", async () => {
    // The other half: provenance, not blanket refusal. Once the schema has been
    // written to the disk cache, an offline call is legitimate — that is exactly
    // what a fresh process would find.
    const dir = mkdtempSync(join(tmpdir(), "docmeta-memo-"));
    try {
      const ref = `${server.url}/memo-disk.json`;
      await loadSchema(ref, { cacheDir: dir });
      await expect(
        loadSchema(ref, { cacheDir: dir, offline: true }),
      ).resolves.toBeTypeOf("object");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadSchema over http(s) — offline with the cache disabled", () => {
  // The CLI always supplies a `cacheDir`, so `schemaCache.ttlHours: 0` yields a
  // cache object that exists but reads and writes nothing. Branching on the
  // object rather than on `enabled` told that user to "run once without
  // --offline to populate the cache" — advice that cannot work, because the
  // write is a no-op too. Neither existing test covered the combination: one
  // uses a working cacheDir with an empty cache, the other uses no cacheDir.
  it("does not advise populating a cache that is switched off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docmeta-off0-"));
    try {
      const err = await loadSchema("http://127.0.0.1:9/disabled.json", {
        cacheDir: dir,
        ttlHours: 0,
        offline: true,
      }).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(DocmetaError);
      expect(err.message).toMatch(/ttlHours: 0/);
      expect(err.message).not.toMatch(/Run once without --offline/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes no cache configured from a cache switched off", async () => {
    // The library path: no `cacheDir` was ever passed, so blaming `ttlHours: 0`
    // names a setting the caller never touched. Unreachable from the CLI, which
    // always supplies a directory — which is exactly why it needs its own test.
    const err = await loadSchema("http://127.0.0.1:9/nodir.json", {
      offline: true,
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(DocmetaError);
    expect(err.message).toMatch(/No schema cache is configured/);
    expect(err.message).not.toMatch(/ttlHours: 0/);
  });

  it("still advises populating a cache that is switched on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docmeta-off24-"));
    try {
      const err = await loadSchema("http://127.0.0.1:9/enabled.json", {
        cacheDir: dir,
        ttlHours: 24,
        offline: true,
      }).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(DocmetaError);
      expect(err.message).toMatch(/Run once without --offline/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 0008 — integrity pins on a vendored (local file) schema
// ---------------------------------------------------------------------------

describe("a schema file saved with a UTF-8 BOM", () => {
  // A Windows editor writes EF BB BF at the head of a `.json` file — PowerShell
  // 5.1's `Set-Content -Encoding utf8`, Notepad, older VS Code settings. Node's
  // `JSON.parse` rejects it, so a file every other tool reads happily failed
  // with "unexpected token at line 1 column 1" — which reads as an empty or
  // corrupt file and points the operator nowhere near the real cause.
  const BOM = "\u{FEFF}";
  const fixture = join(here, "fixtures", "bom.schema.json");

  it("has a real BOM on disk, or this whole block proves nothing", () => {
    expect([...readFileSync(fixture).subarray(0, 3)]).toEqual([
      0xef, 0xbb, 0xbf,
    ]);
  });

  it("loads, rather than failing as invalid JSON", async () => {
    const schema = await loadSchema(fixture);
    expect(schema.required).toEqual(["owner"]);
  });

  it("still hashes the BOM, so an integrity pin is taken over the real bytes", async () => {
    // The load-bearing one. Stripping the BOM must be a *parsing* concession
    // and nothing more: `assertIntegrity` hashes what is on disk, and a pin
    // recorded by `schemas vendor` covers the BOM. If stripping moved earlier
    // than the hash, this pin would stop matching and every vendored BOM'd
    // schema would fail its own pin.
    const raw = readFileSync(fixture);
    const pin = `sha256-${createHash("sha256").update(raw).digest("hex")}`;
    const schema = await loadSchema(fixture, {
      pins: new Map([[fixture, { integrity: pin }]]),
    });
    expect(schema.required).toEqual(["owner"]);
  });

  it("rejects a pin taken over the de-BOM'd bytes", async () => {
    // The other direction, and the reason the test above is not enough on its
    // own: a pin over the stripped content must NOT match, or "hashes the raw
    // bytes" would be satisfied by hashing whatever we happened to parse.
    const stripped = readFileSync(fixture).toString("utf8").replace(BOM, "");
    const wrong = `sha256-${createHash("sha256").update(Buffer.from(stripped, "utf8")).digest("hex")}`;
    const err = await loadSchema(fixture, {
      pins: new Map([[fixture, { integrity: wrong }]]),
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(DocmetaError);
    // On the message, not just the type: before the fix this rejected as
    // invalid JSON, which is also a DocmetaError — so a type-only assertion
    // passed for entirely the wrong reason.
    expect((err as Error).message).toMatch(/integrity/i);
  });

  it("parses a fetched body that carries one", async () => {
    const server = await startSchemaServer({
      "/bom.json": { body: BOM + JSON.stringify(URL_SCHEMA) },
    });
    try {
      const schema = await loadSchema(`${server.url}/bom.json`);
      expect(schema.required).toEqual(["type"]);
    } finally {
      await server.close();
    }
  });

  it("hands `schemas vendor` the bytes as served, BOM included", async () => {
    // `runVendorSchema` writes these bytes and hashes them, so the BOM has to
    // survive the round trip — the vendored copy should be what the server
    // sent, byte for byte.
    const body = BOM + JSON.stringify(URL_SCHEMA);
    const server = await startSchemaServer({ "/keep.json": { body } });
    try {
      const { bytes, schema } = await fetchSchemaBytes(`${server.url}/keep.json`);
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(schema.required).toEqual(["type"]);
    } finally {
      await server.close();
    }
  });
});

describe("integrity pins (0008)", () => {
  let dir: string;
  let file: string;
  const BODY = '{\n  "type": "object",\n  "required": ["type"]\n}\n';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docmeta-pin-"));
    file = join(dir, "house.json");
    writeFileSync(file, BODY);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const pinFor = (contents: string): string =>
    `sha256-${createHash("sha256").update(Buffer.from(contents, "utf8")).digest("hex")}`;

  const pins = (pin: { source?: string; integrity?: string }) =>
    new Map([[file, pin]]);

  it("loads a file whose bytes match the pin", async () => {
    const schema = await loadSchema(file, {
      pins: pins({ integrity: pinFor(BODY) }),
    });
    expect(schema.required).toEqual(["type"]);
  });

  it("loads a file with a source recorded but no pin", async () => {
    const schema = await loadSchema(file, {
      pins: pins({ source: "https://e.example/house.json" }),
    });
    expect(schema.type).toBe("object");
  });

  // The whole point: a changed vendored copy is loud, never a silent fallback
  // to whatever is on disk.
  it("fails loudly when the bytes do not match", async () => {
    writeFileSync(file, '{"type":"object"}');
    const err = await loadSchema(file, {
      pins: pins({
        integrity: pinFor(BODY),
        source: "https://e.example/house.json",
      }),
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(DocmetaError);
    expect(err.message).toMatch(/does not match its recorded integrity/);
    expect(err.message).toContain(pinFor(BODY));
    expect(err.message).toContain(pinFor('{"type":"object"}'));
    expect(err.message).toMatch(/contents have changed/);
    expect(err.message).toContain("docmeta schemas vendor https://e.example/house.json");
  });

  // A committed schema plus `core.autocrlf` is a mismatch on a file nobody
  // edited. Reporting it as "contents have changed" is accurate for the other
  // case and useless for this one, which is how a user ends up deleting the pin.
  it("names a line-ending difference as such", async () => {
    writeFileSync(file, BODY.replace(/\n/g, "\r\n"));
    const err = await loadSchema(file, {
      pins: pins({ integrity: pinFor(BODY) }),
    }).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/differ only in line endings/);
    expect(err.message).toContain(".gitattributes");
    expect(err.message).not.toMatch(/contents have changed/);
  });

  it("names the line-ending case in the other direction too", async () => {
    // Vendored from a host that served CRLF, checked out as LF.
    writeFileSync(file, BODY);
    const err = await loadSchema(file, {
      pins: pins({ integrity: pinFor(BODY.replace(/\n/g, "\r\n")) }),
    }).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/differ only in line endings/);
  });

  it("advises differently when no source was recorded", async () => {
    writeFileSync(file, '{"type":"string"}');
    const err = await loadSchema(file, {
      pins: pins({ integrity: pinFor(BODY) }),
    }).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/Restore the file from version control/);
    expect(err.message).not.toMatch(/vendor https/);
  });

  it("names the source when a vendored file is missing entirely", async () => {
    rmSync(file);
    const err = await loadSchema(file, {
      pins: pins({
        integrity: pinFor(BODY),
        source: "https://e.example/house.json",
      }),
    }).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/Schema file not found/);
    expect(err.message).toContain("vendored from https://e.example/house.json");
  });

  it("rejects an unverifiable pin rather than ignoring it", async () => {
    const err = await loadSchema(file, {
      pins: pins({ integrity: "sha512-abc" }),
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(DocmetaError);
    expect(err.message).toMatch(/cannot verify/);
  });

  // A pin on a URL or a built-in can never be checked, so accepting one would
  // leave a config that reads as pinned and is not.
  it("refuses a pin on a reference that is not a local file", async () => {
    const onUrl = await loadSchema("https://e.example/s.json", {
      pins: new Map([
        ["https://e.example/s.json", { integrity: pinFor(BODY) }],
      ]),
    }).catch((e: unknown) => e as Error);
    expect(onUrl).toBeInstanceOf(DocmetaError);
    expect(onUrl.message).toMatch(/only be verified against a local file/);

    const onBuiltin = await loadSchema("google:okf:0.1", {
      pins: new Map([["google:okf:0.1", { integrity: pinFor(BODY) }]]),
    }).catch((e: unknown) => e as Error);
    expect(onBuiltin).toBeInstanceOf(DocmetaError);
    expect(onBuiltin.message).toMatch(/built-in id/);
  });

  it("leaves an unpinned reference exactly as it was", async () => {
    writeFileSync(file, '{"type":"object"}');
    const schema = await loadSchema(file, { pins: new Map() });
    expect(schema.type).toBe("object");
  });
});

describe("fetchSchemaBytes (0008)", () => {
  let server: SchemaServer;
  // Deliberately not pretty-printed: `vendor` writes exactly what the server
  // sent, so the bytes have to survive the round trip unaltered.
  const RAW = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}';

  beforeAll(async () => {
    server = await startSchemaServer({
      "/raw.json": { body: RAW },
      "/envelope.json": { json: { error: "not found" } },
    });
  });
  afterAll(async () => server.close());

  it("returns the exact bytes alongside the parsed schema", async () => {
    const got = await fetchSchemaBytes(`${server.url}/raw.json`);
    expect(got.bytes.toString("utf8")).toBe(RAW);
    expect(got.schema.type).toBe("object");
  });

  // Vendoring an error envelope would commit a schema that passes every
  // document, so the payload guard has to apply on this path too.
  it("applies the payload guard", async () => {
    await expect(
      fetchSchemaBytes(`${server.url}/envelope.json`),
    ).rejects.toBeInstanceOf(DocmetaError);
  });
});

// ---------------------------------------------------------------------------
// 0015 — a schema FILE's bytes must not reach the error message
// ---------------------------------------------------------------------------

describe("0015 · a schema file that is not JSON", () => {
  let dir: string | undefined;

  /**
   * `dir`, or a failure that names the cause. The suite clears it after every
   * test, so it really can be `undefined` here.
   */
  const tempDir = (): string => {
    if (dir === undefined) throw new Error("the temp directory was never made");
    return dir;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docmeta-not-json-"));
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const failing = async (content: string): Promise<string> => {
    const file = join(tempDir(), "schema.json");
    writeFileSync(file, content, "utf8");
    const err = await loadSchema(file, {}).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(DocmetaError);
    return err?.message ?? "";
  };

  /**
   * `JSON.parse`'s own message embeds a prefix of what it was handed — on Node
   * 24, `Unexpected token 'r', "root:x:0:0"... is not valid JSON` — and that
   * message was interpolated verbatim. The excerpt reached stderr *and* the
   * json/sarif reports the formats workflow uploads to code scanning, so it was
   * readable by whoever opened the pull request: roughly ten bytes of an
   * arbitrary readable file per run, repeatable with a different path.
   */
  it("does not quote the file's contents back", async () => {
    const message = await failing("root:x:0:0:root:/root:/bin/bash\n");
    expect(message).not.toContain("root:x:0:0");
    expect(message).not.toContain("/bin/bash");
    // The ref is still named, and where the parse failed is still reported —
    // dropping the excerpt must not leave the operator with nothing.
    expect(message).toContain("schema.json");
    expect(message).toMatch(/line 1 column 1/);
  });

  it("reports a later position, not just the first line", async () => {
    const message = await failing('{\n  "type": "object"\n  secret-value\n}\n');
    expect(message).not.toContain("secret-value");
    expect(message).toMatch(/line 3/);
  });

  it("keeps a positional message that carries no content", async () => {
    // `Expected double-quoted property name in JSON at position 8 (line 1
    // column 9)` quotes nothing back, so it survives as it is.
    const message = await failing('{"a": 1,}');
    expect(message).toMatch(/position 8/);
    expect(message).toMatch(/line 1 column 9/);
  });

  it("still says something useful for an empty file", async () => {
    const message = await failing("");
    expect(message).toContain("schema.json");
    expect(message).toMatch(/not valid JSON/);
  });
});

describe("0015 · the remote response excerpt is deliberately kept", () => {
  /**
   * The counterpart to the redaction above, pinned so a later "consistency"
   * pass does not strip both. `73c625f` put the response excerpt in front of
   * the operator on purpose: a body from a URL the operator configured is what
   * tells them their gateway is talking, and it is not bytes off their disk.
   */
  it("shows what a URL actually returned when it is not JSON", async () => {
    const server = await startSchemaServer({
      "/gateway.html": {
        body: "<!doctype html><title>502 Bad Gateway</title>",
        contentType: "application/json",
      },
    });
    try {
      const ref = `${server.url}/gateway.html`;
      const err = await loadSchema(ref).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(DocmetaError);
      expect(err.message).toContain(ref);
      expect(err.message).toMatch(/doctype|502/i);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 0009 — the built-ins are also published at stable URLs
// ---------------------------------------------------------------------------

describe("0009 · a published built-in URL resolves from the bundle", () => {
  let server: SchemaServer;
  let realFetch: typeof globalThis.fetch;

  /**
   * Every request that escapes the alias is rerouted to a local server, which
   * counts what it received.
   *
   * Asserting on the returned object alone would not tell "served from the
   * bundle" apart from "fetched, and happened to match", and letting a real
   * request out would make the test depend on GitHub Pages being up. The
   * assertion that carries the weight is therefore the empty request log.
   */
  beforeAll(async () => {
    server = await startSchemaServer({});
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const target = new URL(href);
      return realFetch(
        new URL(target.pathname + target.search, server.url),
        init,
      );
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("covers exactly the built-in registry — no built-in without a URL", () => {
    expect(
      publishedBuiltins()
        .map((b) => b.id)
        .sort(),
    ).toEqual(listBuiltins().map((b) => b.id).sort());
  });

  it("serves every published URL from the bundle, with zero requests", async () => {
    for (const { id, url } of publishedBuiltins()) {
      // Identity, not deep equality: the alias must hand back the very object
      // the built-in id resolves to, so both spellings share one registration
      // downstream in Ajv.
      expect(await loadSchema(url), url).toBe(await loadSchema(id));
    }
    expect(server.requests()).toEqual([]);
  });

  it("serves a published URL under --offline, with no cache configured", async () => {
    // The consequence stress test 1 names: a published URL that only worked
    // online would make docmeta strictly worse for anyone who used it.
    for (const { id, url } of publishedBuiltins()) {
      expect(await loadSchema(url, { offline: true }), url).toBe(
        await loadSchema(id),
      );
    }
    expect(server.requests()).toEqual([]);
  });

  it("classifies a published URL as a url — the alias is not a reclassification", () => {
    const url = publishedBuiltins()[0]?.url ?? "";
    expect(classifyRef(url).kind).toBe("url");
    expect(isPublishedBuiltinUrl(url)).toBe(true);
  });

  it("does not alias a neighbouring path on the same host", async () => {
    // A prefix check would swallow every URL under /docmeta/schemas/, including
    // versions that do not exist. This one must stay an ordinary remote ref.
    const notPublished =
      "https://hawkeyexl.github.io/docmeta/schemas/okf/9.9.json";
    expect(isPublishedBuiltinUrl(notPublished)).toBe(false);
    await expect(loadSchema(notPublished)).rejects.toThrow();
    expect(server.requests().map((r) => r.path)).toEqual([
      "/docmeta/schemas/okf/9.9.json",
    ]);
  });

  it("still refuses an integrity pin on a published URL", async () => {
    // A deliberate non-change, pinned so it is a decision rather than an
    // oversight. `loadSchema` refuses a pin on anything that is not a local
    // file, and that guard runs before the alias — a published URL is served
    // from the bundle, so there are no fetched bytes for a pin to hash, and a
    // pin that silently verified nothing is worse than one that fails.
    const url = publishedBuiltins()[0]?.url ?? "";
    await expect(
      loadSchema(url, {
        pins: new Map([[url, { integrity: `sha256-${"0".repeat(64)}` }]]),
      }),
    ).rejects.toThrow(/integrity pin/);
  });
});
