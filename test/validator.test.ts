import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Validator } from "../src/core/validator.js";
import { startSchemaServer, type SchemaServer } from "./helpers/schema-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const extra = join(here, "fixtures", "extra.schema.json");
const withId = join(here, "fixtures", "with-id.schema.json");
const withIdAlias = join(here, "fixtures", "with-id-alias.schema.json");

const lineFor = (ptr: string) => (ptr === "/timestamp" ? 9 : 1);

describe("Validator", () => {
  it("passes valid OKF metadata", async () => {
    const v = new Validator();
    const errors = await v.validate(
      { type: "concept", title: "Hi" },
      ["google:okf:0.1"],
      lineFor,
    );
    expect(errors).toEqual([]);
  });

  it("flags missing required type, tagged with schema + line", async () => {
    const v = new Validator();
    const errors = await v.validate({ title: "Hi" }, ["google:okf:0.1"], lineFor);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.schema).toBe("google:okf:0.1");
    expect(errors[0]?.message).toMatch(/type/);
    expect(errors[0]?.line).toBe(1);
  });

  it("flags a bad timestamp format with its line", async () => {
    const v = new Validator();
    const errors = await v.validate(
      { type: "concept", timestamp: "not-a-date" },
      ["google:okf:0.1"],
      lineFor,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.instancePath).toBe("/timestamp");
    expect(errors[0]?.line).toBe(9);
  });

  it("allows unknown keys (OKF additionalProperties: true)", async () => {
    const v = new Validator();
    const errors = await v.validate(
      { type: "concept", custom: "anything" },
      ["google:okf:0.1"],
      lineFor,
    );
    expect(errors).toEqual([]);
  });

  it("ignores the $schema key during validation", async () => {
    const v = new Validator();
    const errors = await v.validate(
      { type: "concept", $schema: "google:okf:0.1" },
      [extra, "google:okf:0.1"],
      lineFor,
    );
    // extra requires `title`, so exactly one error (the missing title), and the
    // $schema key itself is not flagged.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.schema).toBe(extra);
    expect(errors[0]?.message).toMatch(/title/);
  });

  it("aggregates errors across every schema in the set", async () => {
    const v = new Validator();
    const errors = await v.validate({}, ["google:okf:0.1", extra], lineFor);
    const schemas = errors.map((e) => e.schema);
    expect(schemas).toContain("google:okf:0.1");
    expect(schemas).toContain(extra);
  });
});

describe("Validator compile cache under concurrency", () => {
  /**
   * A cache keyed on the *resolved* validator is a check-then-act race: every
   * caller that arrives before the first `loadSchema` settles misses the cache,
   * and they all then compile the same schema into the one shared per-dialect
   * Ajv. Ajv registers a schema's `$id` on the first compile and throws
   * "schema with key or id ... already exists" on the second — so this only
   * reproduces with an $id-bearing schema, which is why `with-id.schema.json`
   * exists.
   */
  it("compiles an $id-bearing schema once for concurrent callers", async () => {
    const v = new Validator();
    const runs = Array.from({ length: 4 }, () =>
      v.validate({ title: "Hi" }, [withId], lineFor),
    );
    expect(await Promise.all(runs)).toEqual([[], [], [], []]);
  });

  it("still reports real violations from the shared compile", async () => {
    // The dedupe must hand every caller a working validator, not just avoid
    // throwing — a cache that resolved to a no-op would pass the case above.
    const v = new Validator();
    const runs = Array.from({ length: 4 }, () =>
      v.validate({ title: "" }, [withId], lineFor),
    );
    for (const errors of await Promise.all(runs)) {
      expect(errors).toHaveLength(1);
      expect(errors[0]?.schema).toBe(withId);
      expect(errors[0]?.instancePath).toBe("/title");
    }
  });

  it("reuses one registration when two refs carry the same $id", async () => {
    // The cache is keyed on the ref string, but Ajv's registry is keyed on
    // `$id` — so two spellings of the same schema (a published URL in one
    // document's `$schema`, a local path on the command line) each missed the
    // cache and the second compile was rejected as a duplicate. No concurrency
    // needed: one file and a two-ref schema set was enough.
    const v = new Validator();
    const errors = await v.validate({ title: "" }, [withId, withIdAlias], lineFor);
    // Both refs report, and each violation stays tagged with the ref that the
    // caller actually named — reuse must not relabel errors onto the first one.
    expect(errors.map((e) => e.schema)).toEqual([withId, withIdAlias]);
  });

  it("does not cache a failed load, so a later attempt can still succeed", async () => {
    // Caching the in-flight promise must not turn a transient failure into a
    // permanent one for the life of the Validator.
    const v = new Validator();
    const missing = join(here, "fixtures", "does-not-exist.schema.json");
    await expect(v.validate({}, [missing], lineFor)).rejects.toThrow(/not found/);
    await expect(v.validate({}, [missing], lineFor)).rejects.toThrow(/not found/);
  });
});

describe("Validator with remote schemas of different dialects", () => {
  let server: SchemaServer;

  const dialectSchema = (metaSchema: string) => ({
    $schema: metaSchema,
    type: "object",
    required: ["type"],
    additionalProperties: true,
  });

  beforeAll(async () => {
    server = await startSchemaServer({
      "/2020.json": {
        json: dialectSchema("https://json-schema.org/draft/2020-12/schema"),
      },
      "/draft07.json": {
        json: dialectSchema("http://json-schema.org/draft-07/schema#"),
      },
      "/draft06.json": {
        json: dialectSchema("http://json-schema.org/draft-06/schema#"),
      },
      "/draft04.json": {
        json: dialectSchema("http://json-schema.org/draft-04/schema#"),
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it.each([
    ["2020-12", "/2020.json"],
    ["draft-07", "/draft07.json"],
    ["draft-06", "/draft06.json"],
    ["draft-04", "/draft04.json"],
  ])("compiles and validates a %s schema fetched by URL", async (_d, path) => {
    const v = new Validator();
    const ref = `${server.url}${path}`;
    expect(await v.validate({ type: "concept" }, [ref], lineFor)).toEqual([]);
    const errors = await v.validate({ title: "no type" }, [ref], lineFor);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.schema).toBe(ref);
    expect(errors[0]?.message).toMatch(/type/);
  });
});
