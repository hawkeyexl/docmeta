import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Validator } from "../src/core/validator.js";
import { PUBLISHED_BASE } from "../src/core/schema-registry.js";
import { startSchemaServer, type SchemaServer } from "./helpers/schema-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const extra = join(here, "fixtures", "extra.schema.json");
const withId = join(here, "fixtures", "with-id.schema.json");
const withIdAlias = join(here, "fixtures", "with-id-alias.schema.json");
const withIdDivergent = join(here, "fixtures", "with-id-divergent.schema.json");
const keywords = join(here, "fixtures", "baseline", "keywords.schema.json");
const extendsPublishedUrl = join(
  here,
  "fixtures",
  "extends-published-url.schema.json",
);
const extendsBuiltinId = join(here, "fixtures", "extends-builtin-id.schema.json");
const extendsPublishedDraft07 = join(
  here,
  "fixtures",
  "extends-published-draft07.schema.json",
);

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

  it("leaves col unset for additionalProperties, as for required", async () => {
    // Both keywords point `instancePath` at the parent and name the property in
    // the message. For a stray key at the document root the parent *is* the
    // root, recorded at 1:1 — so the annotation carried a caret on the first
    // character of the file for a key that could be anywhere in it.
    const dir = await mkdtemp(join(tmpdir(), "docmeta-addprop-"));
    try {
      const strict = join(dir, "strict.schema.json");
      await writeFile(
        strict,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { title: { type: "string" } },
          additionalProperties: false,
        }),
      );
      const errors = await new Validator().validate(
        { stray: "x" },
        [strict],
        lineFor,
        colFor,
      );
      const found = errors.find((e) => e.keyword === "additionalProperties");
      expect(found).toBeDefined();
      expect(found).not.toHaveProperty("col");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it("judges a divergent schema by its own rules, not by the one that took the $id first", async () => {
    // This used to assert the opposite, and the opposite was a documented
    // silent wrong answer: Ajv holds one schema per `$id`, so when two refs
    // disagreed about the rules the first compile won and the second ref was
    // answered from it. Nothing errored; the run just gave the wrong result.
    //
    // Reuse is now conditional on the registration being *the same object*, so
    // a ref naming different content gets its own compile with the contested id
    // dropped. That mattered once `registerBuiltins` began pre-loading the
    // built-ins: the collision stopped being an ordering race and became
    // certain, and a vendored-then-edited built-in would always have lost.
    const data = { title: "Hi", stray: 1 };

    // Alone, the divergent schema rejects the stray key.
    expect(
      await new Validator().validate(data, [withIdDivergent], lineFor),
    ).toHaveLength(1);

    // And behind a permissive schema wearing the same `$id`, it still does.
    const alongside = await new Validator().validate(
      data,
      [withId, withIdDivergent],
      lineFor,
    );
    expect(alongside).toHaveLength(1);
    expect(alongside[0]?.schema).toBe(withIdDivergent);
    expect(alongside[0]?.subject).toBe("stray");
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

describe("a local schema that claims a built-in's $id (0009)", () => {
  it("is judged by its own contents, not by the built-in it shadows", async () => {
    // `schemas vendor` writes a copy of a built-in carrying its `$id`, and 0009
    // encourages vendoring the published URL — so an edited vendored copy is a
    // normal thing to have. Pre-registering the built-ins put one under that
    // `$id` in every Ajv up front, and `compileUncached`'s id short-circuit then
    // handed back the *bundled* schema for a ref naming the local file: the
    // house rule silently did not apply, while the report went on naming the
    // local path. Before the fix this reported 'type' — the bundled OKF's
    // requirement — for a schema that does not mention it.
    const dir = await mkdtemp(join(tmpdir(), "docmeta-idshadow-"));
    try {
      const mine = join(dir, "my-okf.json");
      await writeFile(
        mine,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: "google:okf:0.1",
          type: "object",
          required: ["owner"],
        }),
      );
      const errors = await new Validator().validate(
        { title: "t" },
        [mine],
        () => undefined,
      );
      const said = errors.map((e) => e.message).join();
      expect(said).toMatch(/'owner'/);
      expect(said).not.toMatch(/'type'/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still shares one validator when the object really is the same", async () => {
    // The dedup the short-circuit exists for has to survive the fix: the id and
    // the published URL are two names for one bundled object, so compiling both
    // must not trip Ajv's duplicate-id error.
    const errors = await new Validator().validate(
      { title: "t" },
      ["google:okf:0.1", `${PUBLISHED_BASE}okf/0.1.json`],
      () => undefined,
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 0009 stress test 5 — $ref-ing a built-in, by either of its two names
// ---------------------------------------------------------------------------

describe("a user schema $ref-ing a built-in (0009)", () => {
  let realFetch: typeof globalThis.fetch;
  let attempted: string[];

  /**
   * Ajv is built with no `loadSchema`, so an unresolved `$ref` throws rather
   * than fetching — but that is a property of today's construction, not a
   * promise. Failing the test on *any* request makes "no network" the assertion
   * instead of a side effect.
   */
  beforeAll(() => {
    realFetch = globalThis.fetch;
    attempted = [];
    globalThis.fetch = (input: Parameters<typeof fetch>[0]) => {
      // Not `String(input)`. `fetch` takes a string, a `URL`, **or** a
      // `Request`, and a `Request` has no useful `toString` — it records as
      // "[object Request]", so the assertion below would be about a placeholder
      // rather than about the address something tried to reach.
      attempted.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      return Promise.reject(new Error("the network is not available here"));
    };
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it.each([
    ["its published URL", extendsPublishedUrl],
    ["its docmeta id", extendsBuiltinId],
    ["its published URL, from a draft-07 schema", extendsPublishedDraft07],
  ])("compiles and applies a schema extending OKF by %s", async (_n, ref) => {
    const v = new Validator();
    // The built-in's own rule still applies through the `$ref` …
    const missingType = await v.validate({ title: "Hi" }, [ref], lineFor);
    expect(missingType).toHaveLength(1);
    expect(missingType[0]?.message).toMatch(/type/);
    // … and so does the extending schema's own.
    const missingTitle = await v.validate({ type: "concept" }, [ref], lineFor);
    expect(missingTitle).toHaveLength(1);
    expect(missingTitle[0]?.message).toMatch(/title/);
    // Both satisfied.
    expect(
      await v.validate({ type: "concept", title: "Hi" }, [ref], lineFor),
    ).toEqual([]);
    expect(attempted).toEqual([]);
  });

  it("leaves a top-level built-in ref behaving exactly as before", async () => {
    // Pre-registering the built-ins makes `compileUncached`'s existing
    // `ajv.getSchema($id)` short circuit hit for `-s google:okf:0.1`, which is
    // the hottest path in the tool. It must be the same validator, not a
    // permissive one that quietly passes everything.
    const v = new Validator();
    expect(
      await v.validate({ type: "concept" }, ["google:okf:0.1"], lineFor),
    ).toEqual([]);
    const errors = await v.validate({ title: "Hi" }, ["google:okf:0.1"], lineFor);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.schema).toBe("google:okf:0.1");
    expect(errors[0]?.keyword).toBe("required");
    expect(errors[0]?.subject).toBe("type");
    // A format rule from deeper in the built-in still fires, so the
    // registration is the real schema rather than a shell.
    const bad = await v.validate(
      { type: "concept", timestamp: "not-a-date" },
      ["google:okf:0.1"],
      lineFor,
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]?.keyword).toBe("format");
    expect(attempted).toEqual([]);
  });

  it("compiles the same built-in through its published URL as a top-level ref", async () => {
    const v = new Validator();
    const url = "https://hawkeyexl.github.io/docmeta/schemas/okf/0.1.json";
    const errors = await v.validate({ title: "Hi" }, [url], lineFor);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.schema).toBe(url);
    expect(attempted).toEqual([]);
  });

  it("still fails an unregistered remote $ref rather than silently passing", async () => {
    // The counterpart: pre-registration must not be mistaken for a general
    // `loadSchema` hook. A `$ref` to a URL docmeta does not publish is still
    // unresolvable, and that has to stay a loud compile error.
    const dir = await mkdtemp(join(tmpdir(), "docmeta-ref-"));
    try {
      const ref = join(dir, "extends-elsewhere.schema.json");
      await writeFile(
        ref,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          allOf: [{ $ref: "https://schemas.example.com/house/2.1.json" }],
        }),
        "utf8",
      );
      await expect(
        new Validator().validate({}, [ref], lineFor),
      ).rejects.toThrow(/failed to compile|resolve reference/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
