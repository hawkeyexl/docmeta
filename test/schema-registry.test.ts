import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  listBuiltins,
  classifyRef,
  loadSchema,
} from "../src/core/schema-registry.js";
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
      // Schemas whose only root keyword is a conditional or an object-shape
      // applicator. Ordinary, and rejected by a too-narrow allowlist.
      "/guard-if-then.json": {
        json: {
          if: { properties: { type: { const: "blog" } } },
          then: { required: ["category"] },
        },
      },
      "/guard-pattern-props.json": {
        json: { patternProperties: { "^x-": { type: "string" } } },
      },
      "/guard-additional.json": { json: { additionalProperties: false } },
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
    const err = await loadSchema(ref).catch((e: Error) => e);
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
      (e: Error) => e,
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
      (e: Error) => e,
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

  it("keeps a failed fetch retryable rather than caching the rejection", async () => {
    const ref = `${server.url}/dedup-fail.json`;
    await expect(loadSchema(ref)).rejects.toBeInstanceOf(DocmetaError);
    await expect(loadSchema(ref)).rejects.toBeInstanceOf(DocmetaError);
    // A transient failure must not poison the ref for the life of the process:
    // the second call has to reach the server again.
    expect(server.hits("/dedup-fail.json")).toBe(2);
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
  const ordinary = [
    "real-if-then",
    "real-pattern-props",
    "real-additional",
    "real-defs",
  ];

  for (const name of ordinary) {
    it(`accepts a schema whose only root keyword is in ${name}`, async () => {
      await expect(
        loadSchema(`${server.url}/${name}.json`),
      ).resolves.toBeTypeOf("object");
    });
  }
});
