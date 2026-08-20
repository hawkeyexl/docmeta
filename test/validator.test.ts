import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Validator } from "../src/core/validator.js";
import { startSchemaServer, type SchemaServer } from "./helpers/schema-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const extra = join(here, "fixtures", "extra.schema.json");
const withId = join(here, "fixtures", "with-id.schema.json");
const withIdAlias = join(here, "fixtures", "with-id-alias.schema.json");
const withIdDivergent = join(here, "fixtures", "with-id-divergent.schema.json");
const keywords = join(here, "fixtures", "baseline", "keywords.schema.json");

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

describe("Validator: the optional column", () => {
  const colFor = (ptr: string) => (ptr === "/timestamp" ? 14 : 3);

  it("leaves col unset when the extractor supplies no colFor", async () => {
    const v = new Validator();
    const errors = await v.validate(
      { type: "concept", timestamp: "not-a-date" },
      ["google:okf:0.1"],
      lineFor,
    );
    expect(errors[0]?.line).toBe(9);
    expect(errors[0]).not.toHaveProperty("col");
  });

  it("carries col through when the extractor supplies one", async () => {
    const v = new Validator();
    const errors = await v.validate(
      { type: "concept", timestamp: "not-a-date" },
      ["google:okf:0.1"],
      lineFor,
      colFor,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.instancePath).toBe("/timestamp");
    expect(errors[0]?.line).toBe(9);
    expect(errors[0]?.col).toBe(14);
  });

  it("omits col for `required`, which points at the parent, not a token", async () => {
    // The missing property has no source position at all. `toFieldError`
    // already points `required` at the parent object and names the property in
    // the message, so a column here would draw a caret at an arbitrary spot.
    const v = new Validator();
    const errors = await v.validate({ title: "Hi" }, ["google:okf:0.1"], lineFor, colFor);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.keyword).toBe("required");
    expect(errors[0]?.line).toBe(1);
    expect(errors[0]).not.toHaveProperty("col");
  });

  it("omits col when colFor knows no position for the pointer", async () => {
    const v = new Validator();
    const errors = await v.validate(
      { type: "concept", timestamp: "not-a-date" },
      ["google:okf:0.1"],
      lineFor,
      () => undefined,
    );
    expect(errors[0]).not.toHaveProperty("col");
  });
});

describe("FieldError machine identity", () => {
  /**
   * One document that trips six different keywords, so the identity fields can
   * be asserted keyword by keyword against a single run.
   */
  const subject = {
    slug: "A1",
    timestamp: "not-a-date",
    count: "three",
    stray: 1,
  };

  const errorsByKeyword = async () => {
    const v = new Validator();
    const errors = await v.validate(subject, [keywords], lineFor);
    return new Map(errors.map((e) => [e.keyword, e]));
  };

  it("records the Ajv keyword on every violation", async () => {
    const found = await errorsByKeyword();
    expect([...found.keys()].sort()).toEqual([
      "additionalProperties",
      "format",
      "minLength",
      "pattern",
      "required",
      "type",
    ]);
  });

  it.each([
    ["required", "title"],
    ["additionalProperties", "stray"],
    ["format", "date-time"],
    ["type", "number"],
  ])("sets subject for %s to a stable identifier", async (keyword, expected) => {
    const found = await errorsByKeyword();
    expect(found.get(keyword)?.subject).toBe(expected);
  });

  it("leaves subject unset for pattern — the regex source is schema-authored", async () => {
    // Including it would invalidate every fingerprint the moment the schema
    // author touched the regex, which is the opposite of a ratchet.
    const found = await errorsByKeyword();
    expect(found.get("pattern")?.subject).toBeUndefined();
  });

  it("leaves subject unset for keywords whose params are values, not identifiers", async () => {
    const found = await errorsByKeyword();
    expect(found.get("minLength")?.subject).toBeUndefined();
  });

  it("distinguishes two violations that differ only by keyword", async () => {
    // minLength and pattern both fire at /slug under the same schema. Without
    // `keyword` they are indistinguishable once the prose is dropped.
    const v = new Validator();
    const errors = await v.validate({ title: "Hi", slug: "A1" }, [keywords], lineFor);
    expect(errors.map((e) => e.instancePath)).toEqual(["/slug", "/slug"]);
    expect(errors.map((e) => e.keyword).sort()).toEqual(["minLength", "pattern"]);
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

  it("silently checks a divergent schema against the first one under the same $id", async () => {
    // The cost the reuse above buys, pinned rather than left to a comment.
    // Ajv can hold only one schema per `$id`, so when two refs disagree about
    // the rules, the first compile wins and the second ref is answered from it.
    // Nothing errors — the run just gives the wrong answer.
    //
    // This is why the schema-authoring guide tells readers to change the `$id`
    // when they copy a built-in: a local copy that keeps `google:okf:0.1` is
    // this case exactly, and the symptom is a check that passes when it should
    // have failed.
    const data = { title: "Hi", stray: 1 };

    // Alone, the divergent schema rejects the stray key.
    expect(
      await new Validator().validate(data, [withIdDivergent], lineFor),
    ).toHaveLength(1);

    // Behind a permissive schema wearing the same `$id`, it does not — the
    // second ref reports clean because it never got its own compile.
    const shadowed = await new Validator().validate(
      data,
      [withId, withIdDivergent],
      lineFor,
    );
    expect(shadowed).toEqual([]);
  });

  it("does not cache a failed load, so a later attempt can still succeed", async () => {
    // Caching the in-flight promise must not turn a transient failure into a
    // permanent one for the life of the Validator.
    //
    // Asserting that a second attempt *also* rejects would prove nothing — it
    // rejects either way, cached or not. The load has to actually SUCCEED the
    // second time, which it can only do if the rejected entry was evicted. So
    // the schema appears on disk between the two calls, standing in for the
    // transient fetch failure this guards.
    const dir = await mkdtemp(join(tmpdir(), "docmeta-validator-"));
    try {
      const ref = join(dir, "late.schema.json");
      const v = new Validator();

      await expect(v.validate({}, [ref], lineFor)).rejects.toThrow(/not found/);

      await writeFile(
        ref,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["title"],
          properties: { title: { type: "string" } },
        }),
        "utf8",
      );

      const errors = await v.validate({}, [ref], lineFor);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toMatch(/title/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
