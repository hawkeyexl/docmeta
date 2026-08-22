/**
 * `fill` command core.
 *
 * Every case here is hermetic: the inference provider is injected as a
 * `MockProvider`, so no API key and no network are involved. Cases that write
 * run inside a fresh mkdtemp copy — the shared fixtures stay read-only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODELS,
  MockProvider,
  type InferenceProvider,
} from "@hawkeyexl/inference";
import {
  runFill,
  collectCandidates,
  collectDefs,
  type FillOptions,
} from "../src/commands/fill.js";
import { buildEnvelopeSchema } from "../src/commands/fill-prompt.js";
import { loadSchema } from "../src/core/schema-registry.js";
import { compileWithFormats } from "../src/core/validator.js";
import { DocmetaError } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(join(here, "fixtures", "fill", name), "utf8");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docmeta-fill-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Copy a fixture into the scratch dir so a test may safely mutate it. */
async function stage(name: string, as = name): Promise<string> {
  await writeFile(join(dir, as), fixture(name), "utf8");
  return as;
}

const propose = (
  fields: Record<string, { value: unknown; confidence: number }>,
): MockProvider =>
  new MockProvider([
    {
      json: Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [
          k,
          { ...v, reasoning: "stated in the page" },
        ]),
      ),
    },
  ]);

const base = { cache: false as const, cwd: () => dir };

describe("collectCandidates", () => {
  it("picks missing properties and invalid ones, but not valid ones", async () => {
    const okf = await loadSchema("google:okf:0.1");
    const data = { type: "concept", title: "Hello", timestamp: "not-a-date" };
    const errors = [
      {
        schema: "google:okf:0.1",
        instancePath: "/timestamp",
        message: "bad",
        keyword: "format",
        subject: "date-time",
      },
    ];
    const keys = collectCandidates([okf], data, errors).map((c) => c.key);

    expect(keys).toContain("timestamp"); // present but invalid
    expect(keys).toContain("description"); // missing
    expect(keys).toContain("resource"); // missing
    expect(keys).toContain("tags"); // missing
    expect(keys).not.toContain("type"); // present and valid
    expect(keys).not.toContain("title"); // present and valid
  });

  it("marks schema-required properties", async () => {
    const okf = await loadSchema("google:okf:0.1");
    const found = collectCandidates([okf], {}, []);
    expect(found.find((c) => c.key === "type")?.required).toBe(true);
    expect(found.find((c) => c.key === "title")?.required).toBe(false);
  });

  it("narrows to --fields when given", async () => {
    const okf = await loadSchema("google:okf:0.1");
    const keys = collectCandidates([okf], {}, [], new Set(["title"])).map(
      (c) => c.key,
    );
    expect(keys).toEqual(["title"]);
  });

  it("lifts a vocabulary's enum whichever schema is named first", async () => {
    // OKF accepts any non-empty string for `type`, so a first-wins selection
    // would drop the enum from the inference prompt whenever OKF led — and let
    // the model propose a value the next `validate` rejects. The lifted
    // subschema has to accept exactly the same values in both orders.
    const okf = await loadSchema("google:okf:0.1");
    const diataxis = await loadSchema("diataxis:diataxis:1.0");

    const accepts = (schemas: Record<string, unknown>[]) => {
      const found = collectCandidates(schemas, { title: "x" }, []).find(
        (c) => c.key === "type",
      );
      if (!found) throw new Error("expected a `type` candidate");
      return compileWithFormats(found.subschema);
    };

    for (const order of [
      [diataxis, okf],
      [okf, diataxis],
    ]) {
      const validate = accepts(order);
      expect(validate("how-to")).toBe(true);
      // In OKF's vocabulary-free world "guide" is a fine `type`; Diátaxis is
      // what rules it out, and that ruling must survive the merge either way.
      expect(validate("guide")).toBe(false);
    }
  });

  it("keeps every schema's constraints on a shared key, in either order", async () => {
    const long = {
      type: "object",
      properties: { title: { type: "string", minLength: 5 } },
    };
    const short = {
      type: "object",
      properties: { title: { type: "string", maxLength: 10 } },
    };

    for (const order of [
      [long, short],
      [short, long],
    ]) {
      const found = collectCandidates(order, {}, []).find(
        (c) => c.key === "title",
      );
      if (!found) throw new Error("expected a `title` candidate");
      const validate = compileWithFormats(found.subschema);
      expect(validate("middling")).toBe(true);
      expect(validate("tiny")).toBe(false); // minLength, from `long`
      expect(validate("far too long to pass")).toBe(false); // maxLength, from `short`
    }
  });

  it("keeps a description on a merged subschema so the prompt still has one", async () => {
    // `fill` describes each candidate to the model from `subschema.description`.
    // Merging must not bury it where the prompt builder cannot see it.
    const described = {
      type: "object",
      properties: {
        title: { type: "string", description: "Human-readable display name." },
      },
    };
    const bare = { type: "object", properties: { title: { type: "string" } } };

    for (const order of [
      [described, bare],
      [bare, described],
    ]) {
      const found = collectCandidates(order, {}, []).find(
        (c) => c.key === "title",
      );
      expect(found?.subschema.description).toBe("Human-readable display name.");
    }
  });

  it("describes a shared key the same way in either order", async () => {
    // Both schemas describe `type`, in different words. Keeping one of them
    // would leave the prompt text — and so the proposal — dependent on `-s`
    // order, which is exactly what this is supposed to remove.
    const okf = await loadSchema("google:okf:0.1");
    const diataxis = await loadSchema("diataxis:diataxis:1.0");
    const describes = (schemas: Record<string, unknown>[]) =>
      collectCandidates(schemas, { title: "x" }, []).find(
        (c) => c.key === "type",
      )?.subschema.description;

    const merged = describes([okf, diataxis]);
    expect(merged).toBe(describes([diataxis, okf]));
    expect(merged).toContain("kind of concept"); // OKF's wording
    expect(merged).toContain("Diataxis forms"); // and the vocabulary's
  });

  it("does not repeat itself when a third schema joins the merge", async () => {
    // Each merge folds the previous result back in, so the combined description
    // has to be built from distinct sentences rather than from whatever the last
    // wrapper happened to be carrying.
    const describing = (
      description: string,
      extra: Record<string, unknown>,
    ) => ({
      type: "object",
      properties: { title: { type: "string", description, ...extra } },
    });
    const a = describing("Alpha.", { minLength: 1 });
    const b = describing("Beta.", { maxLength: 40 });
    const c = describing("Gamma.", { pattern: "^[A-Z]" });
    const describes = (schemas: Record<string, unknown>[]) =>
      collectCandidates(schemas, {}, []).find((x) => x.key === "title")
        ?.subschema.description;

    expect(describes([a, b, c])).toBe("Alpha. Beta. Gamma.");
    expect(describes([c, b, a])).toBe("Alpha. Beta. Gamma.");
  });

  it("keeps a description that sits on an `allOf` wrapper", async () => {
    // A subschema may already be `{description, allOf: [...]}`. Unwrapping it
    // for the merge must not leave the description behind, or the prompt loses
    // the only sentence saying what the property is for.
    const wrapped = {
      type: "object",
      properties: {
        title: {
          description: "Human-readable display name.",
          allOf: [{ type: "string" }],
        },
      },
    };
    const plain = { type: "object", properties: { title: { type: "string" } } };
    const found = collectCandidates([wrapped, plain], {}, []).find(
      (c) => c.key === "title",
    );
    expect(found?.subschema.description).toBe("Human-readable display name.");
  });

  it("keeps two schemas' same-named `$defs` apart", async () => {
    // Both schemas point `type` at `#/$defs/Slug`, but at different `Slug`s.
    // The envelope holds one `$defs` block, so without renaming both refs
    // resolve to whichever schema was named first and the other's rule is lost
    // — the same order dependence, arriving by a different route.
    const patterned = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: { Slug: { type: "string", pattern: "^[a-z-]+$" } },
      properties: { type: { $ref: "#/$defs/Slug" } },
    };
    const enumerated = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: { Slug: { type: "string", enum: ["tutorial", "how-to"] } },
      properties: { type: { $ref: "#/$defs/Slug" } },
    };

    for (const order of [
      [patterned, enumerated],
      [enumerated, patterned],
    ]) {
      const candidates = collectCandidates(order, {}, []);
      const validate = compileWithFormats(
        buildEnvelopeSchema(candidates, collectDefs(order)),
      );
      const proposal = (value: string) => ({
        type: { value, confidence: 1, reasoning: "x" },
      });
      expect(validate(proposal("how-to"))).toBe(true);
      expect(validate(proposal("guide"))).toBe(false); // not in the enum
      expect(validate(proposal("How To"))).toBe(false); // fails the pattern
    }
  });

  it("follows a renamed definition from inside another definition", async () => {
    // `Outer` is written identically by both schemas, but it points at `Inner`,
    // which is not. A definition is only interchangeable if what it resolves to
    // is interchangeable too, so sharing it on the strength of matching text
    // would route the second schema's property through the first's `Inner`.
    const chain = (inner: string, property: string) => ({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: {
        Outer: { $ref: "#/$defs/Inner" },
        Inner: { type: "string", const: inner },
      },
      properties: { [property]: { $ref: "#/$defs/Outer" } },
    });
    const first = chain("alpha", "alpha");
    const second = chain("beta", "beta");

    const candidates = collectCandidates([first, second], {}, []);
    const validate = compileWithFormats(
      buildEnvelopeSchema(candidates, collectDefs([first, second])),
    );
    const proposal = (key: string, value: string) => ({
      [key]: { value, confidence: 1, reasoning: "x" },
    });
    expect(validate(proposal("alpha", "alpha"))).toBe(true);
    expect(validate(proposal("alpha", "beta"))).toBe(false);
    expect(validate(proposal("beta", "beta"))).toBe(true);
    expect(validate(proposal("beta", "alpha"))).toBe(false);
  });

  it("keeps a `false` branch of an `allOf`, which nothing satisfies", async () => {
    // JSON Schema allows a boolean where a schema is expected. Dropping `false`
    // on the way into the merge would turn a property nothing can satisfy into
    // one `fill` happily proposes for.
    const closed = {
      type: "object",
      properties: { title: { description: "Not for you.", allOf: [false] } },
    };
    const open = { type: "object", properties: { title: { type: "string" } } };
    const found = collectCandidates([closed, open], {}, []).find(
      (c) => c.key === "title",
    );
    if (!found) throw new Error("expected a `title` candidate");
    const validate = compileWithFormats(found.subschema);
    expect(validate("anything")).toBe(false);
    expect(validate(null)).toBe(false);
  });

  it("does not share a definition that resolves through `$dynamicRef`", async () => {
    // Same text, but what it resolves to depends on the schema it was written
    // in, so the two are no more interchangeable than a plain `$ref` chain.
    const dynamic = (values: string[]) => ({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: {
        Tone: { $dynamicRef: "#tone" },
        Anchor: { $dynamicAnchor: "tone", enum: values },
      },
      properties: { tone: { $ref: "#/$defs/Tone" } },
    });
    const defs = collectDefs([dynamic(["formal"]), dynamic(["plain"])]);
    expect(Object.keys(defs.$defs)).toContain("Tone__1");
  });

  it("shares a definition two schemas write identically", async () => {
    // Nothing to tell apart, so nothing to rename — the envelope stays small.
    const tone = { type: "string", enum: ["formal", "plain"] };
    const one = { $defs: { Tone: tone }, properties: { x: { $ref: "#/$defs/Tone" } } };
    const two = { $defs: { Tone: tone }, properties: { y: { $ref: "#/$defs/Tone" } } };
    expect(Object.keys(collectDefs([one, two]).$defs)).toEqual(["Tone"]);
  });

  it("does not overwrite a definition whose name a rename wants", async () => {
    // The renamed slot for the second `Slug` is `Slug__1`, which the first
    // schema already uses for something else. Taking it would silently swap one
    // schema's rule for another's — the very failure the rename exists to stop.
    const first = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: {
        Slug: { type: "string", const: "alpha" },
        Slug__1: { type: "string", const: "already-here" },
      },
      properties: {
        alpha: { $ref: "#/$defs/Slug" },
        taken: { $ref: "#/$defs/Slug__1" },
      },
    };
    const second = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: { Slug: { type: "string", const: "beta" } },
      properties: { beta: { $ref: "#/$defs/Slug" } },
    };

    const defs = collectDefs([first, second]);
    expect(defs.$defs.Slug__1).toEqual({ type: "string", const: "already-here" });

    const candidates = collectCandidates([first, second], {}, []);
    const validate = compileWithFormats(buildEnvelopeSchema(candidates, defs));
    const proposal = (key: string, value: string) => ({
      [key]: { value, confidence: 1, reasoning: "x" },
    });
    expect(validate(proposal("alpha", "alpha"))).toBe(true);
    expect(validate(proposal("alpha", "beta"))).toBe(false);
    expect(validate(proposal("beta", "beta"))).toBe(true);
    expect(validate(proposal("beta", "alpha"))).toBe(false);
    expect(validate(proposal("taken", "already-here"))).toBe(true);
  });

  it("leaves non-colliding `$defs` under their own names", async () => {
    const one = { $defs: { Slug: { type: "string" } }, properties: {} };
    const two = { $defs: { Tag: { type: "string" } }, properties: {} };
    expect(Object.keys(collectDefs([one, two]).$defs).sort()).toEqual([
      "Slug",
      "Tag",
    ]);
  });

  it("leaves a subschema untouched when only one schema defines the key", async () => {
    const okf = await loadSchema("google:okf:0.1");
    const diataxis = await loadSchema("diataxis:diataxis:1.0");
    const found = collectCandidates([diataxis, okf], {}, []).find(
      (c) => c.key === "description",
    );
    // Only OKF has `description`, so there is nothing to merge and no `allOf`
    // wrapper to make the prompt harder to read.
    expect(found?.subschema).toEqual(
      (okf.properties as Record<string, unknown>).description,
    );
  });

  it("never proposes the $schema wiring key", async () => {
    const schema = {
      type: "object",
      properties: { $schema: { type: "string" }, title: { type: "string" } },
    };
    const keys = collectCandidates([schema], {}, []).map((c) => c.key);
    expect(keys).toEqual(["title"]);
  });
});

describe("runFill — the confidence gate", () => {
  it("writes a value at or above the threshold and skips one below", async () => {
    const file = await stage("missing-keys.md");
    const { results, summary, threshold } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["description", "resource"],
      confidence: 0.7,
      includeContent: true,
      inferenceProvider: propose({
        description: { value: "A summary.", confidence: 0.7 },
        resource: { value: "https://example.com/x", confidence: 0.69 },
      }),
    });

    expect(threshold).toBe(0.7);
    const fields = results[0]?.fields ?? [];
    const byName = Object.fromEntries(fields.map((f) => [f.field, f]));
    // Exactly at the threshold counts as confident.
    expect(byName["/description"]?.written).toBe(true);
    expect(byName["/resource"]?.written).toBe(false);
    expect(byName["/resource"]?.skipReason).toBe("low-confidence");
    expect(summary.written).toBe(1);
    expect(summary.skipped).toBe(1);

    const written = await readFile(join(dir, file), "utf8");
    expect(written).toContain("description: A summary.");
    expect(written).not.toContain("example.com");
  });

  it("never writes the confidence or reasoning into the document", async () => {
    const file = await stage("missing-keys.md");
    await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["description"],
      inferenceProvider: propose({
        description: { value: "A summary.", confidence: 0.95 },
      }),
    });
    const written = await readFile(join(dir, file), "utf8");
    expect(written).not.toContain("confidence");
    expect(written).not.toContain("stated in the page");
  });

  it("reports a required field skipped below the threshold", async () => {
    const file = await stage("no-block.md");
    const { summary } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["type"],
      inferenceProvider: propose({
        type: { value: "concept", confidence: 0.2 },
      }),
    });
    expect(summary.requiredSkipped).toBe(1);
    expect(summary.written).toBe(0);
  });

  it("records a declined property as no-proposal rather than inventing one", async () => {
    const file = await stage("missing-keys.md");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["description", "resource"],
      inferenceProvider: propose({
        description: { value: "A summary.", confidence: 0.9 },
      }),
    });
    const resource = results[0]?.fields.find((f) => f.field === "/resource");
    expect(resource?.written).toBe(false);
    expect(resource?.skipReason).toBe("no-proposal");
  });
});

describe("runFill — mechanical checks precede confidence", () => {
  it("rejects a malformed value at the envelope, before the gate is consulted", async () => {
    // `timestamp` carries `format: date-time`, so a confidence of 1 cannot get
    // "still-not-a-date" past the schema-constrained response itself.
    const file = await stage("missing-keys.md");
    const before = await readFile(join(dir, file), "utf8");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["timestamp"],
      inferenceProvider: new MockProvider([
        {
          json: {
            timestamp: {
              value: "still-not-a-date",
              confidence: 1,
              reasoning: "x",
            },
          },
        },
      ]),
    });
    expect(results[0]?.error).toMatch(/schema validation/i);
    expect(await readFile(join(dir, file), "utf8")).toBe(before);
  });

  it("reverts a high-confidence value that another schema in the set rejects", async () => {
    // The envelope carries every schema's rules *for that property*, but a rule
    // stated elsewhere — here an `if`/`then` keyed on `type` — is not part of
    // any `properties` entry and so cannot be lifted into it. Re-validating
    // after the merge is what catches that.
    const file = await stage("missing-keys.md");
    const before = await readFile(join(dir, file), "utf8");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      cliSchemas: [
        "google:okf:0.1",
        join(here, "fixtures", "fill", "conditional-title.schema.json"),
      ],
      fields: ["title"],
      inferenceProvider: propose({
        title: { value: "Hi", confidence: 1 },
      }),
    });
    const field = results[0]?.fields.find((f) => f.field === "/title");
    expect(field?.written).toBe(false);
    expect(field?.skipReason).toBe("schema-mismatch");
    expect(await readFile(join(dir, file), "utf8")).toBe(before);
  });

  it("constrains the proposal to a stacked vocabulary's enum with OKF named first", async () => {
    // The order that used to lose the enum. `guide` satisfies OKF's `type`
    // rule, so before the merge it sailed through the envelope, was written at
    // confidence 1, and only then failed `validate`.
    const file = await stage("no-block.md");
    const before = await readFile(join(dir, file), "utf8");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      cliSchemas: ["google:okf:0.1", "diataxis:diataxis:1.0"],
      fields: ["type"],
      inferenceProvider: propose({ type: { value: "guide", confidence: 1 } }),
    });
    expect(results[0]?.error).toMatch(/schema validation/i);
    expect(await readFile(join(dir, file), "utf8")).toBe(before);
  });

  it("keeps an uncompilable proposal schema to one file instead of aborting the run", async () => {
    // A draft-07 `#/definitions/X` ref must still resolve in the envelope, and
    // if a schema genuinely cannot compile it must not take the run down.
    await writeFile(
      join(dir, "d7.schema.json"),
      JSON.stringify({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        definitions: { Tag: { type: "string", minLength: 1 } },
        properties: {
          type: { type: "string" },
          tags: { type: "array", items: { $ref: "#/definitions/Tag" } },
        },
      }),
      "utf8",
    );
    const file = await stage("no-block.md");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      cliSchemas: [join(dir, "d7.schema.json")],
      fields: ["tags"],
      dryRun: true,
      inferenceProvider: propose({
        tags: { value: ["a", "b"], confidence: 0.9 },
      }),
    });
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.fields[0]?.written).toBe(true);
  });

  it("does not pay for inference on a document it cannot write", async () => {
    // `description` is genuinely absent from the fixture, so there is a
    // candidate and the run would otherwise reach the provider.
    const file = await stage("native-docinfo.rst");
    const provider = propose({
      description: { value: "A summary.", confidence: 1 },
    });
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["description"],
      inferenceProvider: provider,
    });
    expect(results[0]?.error).toMatch(/fenced/i);
    // The point of the check: no request was ever made.
    expect(provider.requests).toHaveLength(0);
    // Schema resolution already succeeded, so the result must say so — "never
    // resolved" and "resolved, then writing refused" need different follow-up.
    expect(results[0]?.schemas).toEqual([
      "google:okf:0.1",
      "passo-uno:seven-action:1.0",
    ]);
  });

  it("writes HTML metadata into <head> and leaves the rest byte-identical", async () => {
    const file = await stage("head-with-meta.html");
    const before = await readFile(join(dir, file), "utf8");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      inferenceProvider: propose({
        description: { value: "A short summary.", confidence: 0.95 },
      }),
    });
    expect(results[0]?.error).toBeUndefined();
    const after = await readFile(join(dir, file), "utf8");
    expect(after).toContain('<meta name="description" content="A short summary.">');
    // Only <head> grew; everything from <body> on is untouched.
    expect(after.slice(after.indexOf("<body>"))).toBe(
      before.slice(before.indexOf("<body>")),
    );
  });

  it("corrects an invalid HTML value in the tag it was read from", async () => {
    // fill rewrites present-but-invalid values, not just missing ones. The
    // correction has to land in the existing tag: a second <meta> beside the
    // stale one would leave the wrong value in the page while docmeta reports
    // green, because the reader would never see the correction.
    const file = "bad.html";
    await writeFile(
      join(dir, file),
      fixture("head-with-meta.html").replace(
        "  </head>",
        `    <meta name="timestamp" content="last Tuesday">
  </head>`,
      ),
      "utf8",
    );
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      inferenceProvider: propose({
        timestamp: { value: "2024-03-01T00:00:00Z", confidence: 0.95 },
      }),
    });
    expect(results[0]?.error).toBeUndefined();
    const after = await readFile(join(dir, file), "utf8");
    expect(after).toContain('content="2024-03-01T00:00:00Z"');
    expect(after).not.toContain("last Tuesday");
    // Corrected in place, not duplicated alongside the stale tag.
    expect(after.match(/name="timestamp"/g)).toHaveLength(1);
  });

  it("writes XML metadata onto the root element, leaving the body alone", async () => {
    const file = await stage("root-attrs.xml");
    const before = await readFile(join(dir, file), "utf8");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      inferenceProvider: propose({
        description: { value: "A short summary.", confidence: 0.95 },
      }),
    });
    expect(results[0]?.error).toBeUndefined();
    const after = await readFile(join(dir, file), "utf8");
    expect(after).toContain('description="A short summary."');
    const marker = "<body>";
    expect(after.slice(after.indexOf(marker))).toBe(
      before.slice(before.indexOf(marker)),
    );
  });

  it("writes a DITA topic's metadata into its prolog, not onto the root", async () => {
    // Putting it on the root element would produce a topic the user's own DITA
    // toolchain rejects, so the value has to land in <prolog><metadata>.
    const file = await stage("topic.dita");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      inferenceProvider: propose({
        description: { value: "A short summary.", confidence: 0.95 },
      }),
    });
    expect(results[0]?.error).toBeUndefined();
    const after = await readFile(join(dir, file), "utf8");
    expect(after).toContain(
      '<othermeta name="description" content="A short summary."/>',
    );
    expect(after).not.toContain('description="A short summary."');
    // The DOCTYPE and the body are untouched.
    expect(after).toContain('<!DOCTYPE concept PUBLIC "-//OASIS//DTD DITA Concept//EN"');
    expect(after.slice(after.indexOf("<conbody>"))).toBe(
      fixture("topic.dita").slice(fixture("topic.dita").indexOf("<conbody>")),
    );
  });

  it("reports an unwritable document as a per-file error, not a run abort", async () => {
    const file = await stage("no-head.html");
    const { results, summary } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      inferenceProvider: propose({}),
    });
    expect(results[0]?.error).toMatch(/<head>/);
    expect(summary.errors).toBe(1);
  });

  it("refuses to touch a document with an unterminated fence", async () => {
    const file = await stage("unterminated.md");
    const before = await readFile(join(dir, file), "utf8");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["title"],
      inferenceProvider: propose({
        title: { value: "Hello", confidence: 1 },
      }),
    });
    expect(results[0]?.error).toMatch(/[Uu]nterminated/);
    expect(await readFile(join(dir, file), "utf8")).toBe(before);
  });
});

describe("runFill — writing", () => {
  it("leaves the file byte-identical under --dry-run", async () => {
    const file = await stage("missing-keys.md");
    const before = await readFile(join(dir, file), "utf8");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["description"],
      dryRun: true,
      includeContent: true,
      inferenceProvider: propose({
        description: { value: "A summary.", confidence: 0.95 },
      }),
    });
    // The proposed document is still computed and reported...
    expect(results[0]?.changed).toBe(true);
    expect(results[0]?.content).toContain("description: A summary.");
    // ...but nothing reached the disk.
    expect(await readFile(join(dir, file), "utf8")).toBe(before);
  });

  it("creates a block on a file with no metadata at all", async () => {
    const file = await stage("no-block.md");
    await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["type", "title"],
      inferenceProvider: propose({
        type: { value: "concept", confidence: 0.95 },
        title: { value: "Hello", confidence: 0.95 },
      }),
    });
    const out = await readFile(join(dir, file), "utf8");
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("type: concept");
    expect(out).toContain("# Hello");
  });

  it("makes no inference call when nothing needs filling", async () => {
    // "Complete" is relative to the resolved schema set, which by default is
    // OKF *and* Seven-Action — hence `action` alongside the OKF fields.
    await writeFile(
      join(dir, "complete.md"),
      "---\ntype: concept\naction: understand\ntitle: T\ndescription: D\nresource: https://e.com/x\ntags: [a]\ntimestamp: 2026-06-25T10:00:00Z\n---\n\n# T\n",
      "utf8",
    );
    const provider = propose({});
    const { results, summary } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["complete.md"],
      inferenceProvider: provider,
    });
    expect(provider.requests).toHaveLength(0);
    expect(results[0]?.fields).toEqual([]);
    expect(summary.changed).toBe(0);
  });

  it("processes stdin *and* the named paths, not stdin instead of them", async () => {
    // Parity with validate/get: `-` is one more input, not a mode switch.
    const file = await stage("missing-keys.md");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["-", file],
      as: "markdown",
      fields: ["description"],
      dryRun: true,
      stdinContent: fixture("no-block.md"),
      inferenceProvider: new MockProvider([
        {
          json: {
            description: { value: "A.", confidence: 0.9, reasoning: "r" },
          },
        },
      ]),
    });
    expect(results.map((r) => r.file)).toEqual(["<stdin>", file]);
  });

  it("fills from stdin without touching disk", async () => {
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["-"],
      as: "markdown",
      fields: ["description"],
      stdinContent: fixture("missing-keys.md"),
      includeContent: true,
      inferenceProvider: propose({
        description: { value: "A summary.", confidence: 0.95 },
      }),
    });
    expect(results[0]?.file).toBe("<stdin>");
    expect(results[0]?.content).toContain("description: A summary.");
  });
});

describe("runFill — concurrency", () => {
  it("fills several files against an $id-bearing schema in parallel", async () => {
    // Every worker missed the compile cache while the first `loadSchema` was
    // still pending, so they all compiled the same schema into the one shared
    // Ajv — which registers the `$id` on the first compile and rejects the
    // second. That made `fill` unusable on any multi-file run whose schema
    // declared an `$id`, and it aborted the whole run rather than one file.
    const schema = join(here, "fixtures", "with-id.schema.json");
    for (const n of ["a", "b", "c", "d"]) {
      await writeFile(join(dir, `${n}.md`), fixture("no-block.md"), "utf8");
    }

    const { results, summary } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["a.md", "b.md", "c.md", "d.md"],
      cliSchemas: [schema],
      fields: ["title"],
      dryRun: true,
      // The default, and the value the bug needed: > 1.
      concurrency: 4,
      inferenceProvider: new MockProvider(
        Array.from({ length: 4 }, () => ({
          json: { title: { value: "Hello", confidence: 0.9, reasoning: "r" } },
        })),
      ),
    });

    expect(results.map((r) => r.error)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(summary.written).toBe(4);
  });
});

describe("runFill — cost budget", () => {
  /**
   * MockProvider's default model has no entry in the price table, so its cost
   * is always $0 and the budget can never trigger. Naming a priced model makes
   * each call cost $0.001 (500 in / 100 out at haiku rates), which is what
   * makes this gate observable at all.
   */
  const priced = (): MockProvider =>
    new MockProvider(
      [
        {
          json: {
            description: { value: "A.", confidence: 0.9, reasoning: "r" },
          },
        },
      ],
      "claude-haiku-4-5",
    );

  it("stops scheduling new files once the budget is reached", async () => {
    await writeFile(join(dir, "a.md"), fixture("missing-keys.md"), "utf8");
    await writeFile(join(dir, "b.md"), fixture("missing-keys.md"), "utf8");

    const { results, summary, budgetExhausted } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["a.md", "b.md"],
      fields: ["description"],
      dryRun: true,
      // Serial, so the first call's cost is banked before the second is
      // considered — otherwise both would clear the check concurrently.
      concurrency: 1,
      maxCostUsd: 0.0005, // less than one call
      inferenceProvider: priced(),
    });

    expect(budgetExhausted).toBe(true);
    expect(summary.costUsd).toBeGreaterThan(0);
    expect(results[0]?.error).toBeUndefined();
    expect(results[1]?.error).toMatch(/cost budget reached/);
  });

  it("processes everything when the budget is ample", async () => {
    await writeFile(join(dir, "a.md"), fixture("missing-keys.md"), "utf8");
    await writeFile(join(dir, "b.md"), fixture("missing-keys.md"), "utf8");

    const { results, budgetExhausted } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["a.md", "b.md"],
      fields: ["description"],
      dryRun: true,
      concurrency: 1,
      maxCostUsd: 10,
      inferenceProvider: priced(),
    });

    expect(budgetExhausted).toBe(false);
    expect(results.every((r) => r.error === undefined)).toBe(true);
  });

  /**
   * MockProvider resolves within a microtask, so workers never actually
   * overlap and the concurrency behavior is untestable with it. This provider
   * takes real time, which lets every worker reach the budget check before any
   * call has completed — the situation a network provider creates and the one
   * the priming gate exists for.
   */
  class SlowProvider implements InferenceProvider {
    readonly requests: unknown[] = [];
    provider(): string {
      return "mock";
    }
    modelName(): string {
      return "claude-haiku-4-5";
    }
    async completeJSON(req: unknown): Promise<{
      json: unknown;
      usage: { inputTokens: number; outputTokens: number };
    }> {
      this.requests.push(req);
      await new Promise((r) => setTimeout(r, 25));
      return {
        json: { description: { value: "A.", confidence: 0.9, reasoning: "r" } },
        usage: { inputTokens: 500, outputTokens: 100 },
      };
    }
  }

  it("does not let a parallel first wave blow past the budget", async () => {
    // Four files, concurrency 4, budget 0.0015 — room for one $0.001 call, not
    // two. Every worker reaches the budget check before any call has completed,
    // so without the priming gate all four would clear a check made against $0
    // and bill $0.004. With it, the first call runs alone; the rest then see a
    // real per-call cost and only one more fits.
    for (const n of ["a", "b", "c", "d"]) {
      await writeFile(join(dir, `${n}.md`), fixture("missing-keys.md"), "utf8");
    }
    const provider = new SlowProvider();
    const { summary, budgetExhausted } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["a.md", "b.md", "c.md", "d.md"],
      fields: ["description"],
      dryRun: true,
      concurrency: 4,
      maxCostUsd: 0.0015,
      inferenceProvider: provider,
    });

    // Exactly two: the primer, then one more that fits before the reservation
    // for it pushes the projection over the limit.
    expect(provider.requests).toHaveLength(2);
    expect(summary.costUsd).toBeCloseTo(0.002, 6);
    expect(budgetExhausted).toBe(true);
  });
});

describe("runFill — cache", () => {
  it("re-gates a cached proposal at a new threshold with no provider call", async () => {
    const file = await stage("missing-keys.md");
    const first = propose({
      description: { value: "A summary.", confidence: 0.8 },
    });
    const opts = {
      cwd: dir,
      inputs: [file],
      fields: ["description"],
      dryRun: true,
      inferenceProvider: first,
    };

    const lenient = await runFill({ ...opts, confidence: 0.7 });
    expect(first.requests).toHaveLength(1);
    expect(lenient.results[0]?.fields[0]?.written).toBe(true);

    // A different threshold must re-gate from cache, not re-ask the model —
    // that is what makes tuning the gate on a real docset free.
    const second = propose({
      description: { value: "Different.", confidence: 0.99 },
    });
    const strict = await runFill({
      ...opts,
      inferenceProvider: second,
      confidence: 0.9,
    });
    expect(second.requests).toHaveLength(0);
    expect(strict.summary.cached).toBe(1);
    expect(strict.results[0]?.fields[0]?.written).toBe(false);
    expect(strict.results[0]?.fields[0]?.skipReason).toBe("low-confidence");
  });
});

describe("runFill — operational errors", () => {
  it("errors when there are no inputs and no config", async () => {
    await expect(
      runFill({ ...base, cwd: dir, inputs: [], inferenceProvider: propose({}) }),
    ).rejects.toBeInstanceOf(DocmetaError);
  });

  it("errors on an unknown provider even when no file needs filling", async () => {
    // resolveProviderIdentity happily returns a bogus identity, and makeProvider
    // is lazy — so without an explicit check this exits 0 having done nothing.
    await writeFile(
      join(dir, "complete.md"),
      "---\ntype: concept\ntitle: T\ndescription: D\nresource: https://e.com/x\ntags: [a]\ntimestamp: 2026-06-25T10:00:00Z\n---\n\n# T\n",
      "utf8",
    );
    await expect(
      runFill({
        ...base,
        cwd: dir,
        inputs: ["complete.md"],
        provider: "nonsense",
      }),
    ).rejects.toThrow(/Unknown provider/);
  });

  it("validates numeric options rather than trusting its caller", async () => {
    // runFill is a public API and also reads config, so bad numbers must be
    // rejected here — not just by the CLI's flag parsing. A NaN threshold
    // would otherwise skip every field silently.
    const file = await stage("missing-keys.md");
    const bad = { ...base, cwd: dir, inputs: [file], inferenceProvider: propose({}) };
    await expect(runFill({ ...bad, confidence: Number.NaN })).rejects.toThrow(
      /confidence/,
    );
    await expect(runFill({ ...bad, confidence: 1.5 })).rejects.toThrow(
      /between 0 and 1/,
    );
    await expect(runFill({ ...bad, concurrency: 2.5 })).rejects.toThrow(
      /whole number/,
    );
    await expect(
      runFill({ ...bad, maxCostUsd: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/maxCostUsd/);
  });

  it("errors on an unknown --as format, naming extractors not extensions", async () => {
    // `--as` takes "markdown", so listing ".md" would point at the wrong value.
    const run = runFill({
      ...base,
      cwd: dir,
      inputs: ["-"],
      as: "nonsense",
      inferenceProvider: propose({}),
    });
    await expect(run).rejects.toThrow(/Unknown format/);
    await expect(run).rejects.toThrow(/markdown/);
    await expect(run).rejects.not.toThrow(/\.md/);
  });

  it("errors when stdin is used without --as", async () => {
    await expect(
      runFill({
        ...base,
        cwd: dir,
        inputs: ["-"],
        inferenceProvider: propose({}),
      }),
    ).rejects.toThrow(/--as/);
  });

  it("reports the detected provider, not the literal selector", async () => {
    // `provider` and `model` are echoed for CI to assert against, so they must
    // name what actually ran. "auto" in that field would be useless — and, if it
    // ever reached a cache key, actively wrong.
    const file = await stage("no-block.md");
    const run = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["title"],
      dryRun: true,
      inferenceProvider: propose({
        title: { value: "Hello", confidence: 0.9 },
      }),
    });
    expect(run.provider).toBe("mock");
    expect(run.model).toBe("mock-model");
  });

  it("takes the threshold from config when no flag is given", async () => {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(
      join(dir, "docmeta.config.yaml"),
      "paths:\n  - 'docs/**/*.md'\nfill:\n  confidenceThreshold: 0.95\n",
      "utf8",
    );
    await writeFile(join(dir, "docs", "page.md"), fixture("no-block.md"), "utf8");

    const { threshold, summary } = await runFill({
      ...base,
      cwd: dir,
      inputs: [],
      fields: ["title"],
      dryRun: true,
      inferenceProvider: propose({
        title: { value: "Hello", confidence: 0.9 },
      }),
    });
    expect(threshold).toBe(0.95);
    expect(summary.written).toBe(0);
  });
});

describe("provider selection", () => {
  /**
   * Injects a provider throughout, so nothing here probes the environment,
   * spawns the Claude CLI, or touches a GPU. Validating the NAME has to happen
   * regardless of injection — it is cheap, and a typo must fail on a fully
   * cached run too, where nothing is ever constructed to catch it.
   *
   * `missing.md` resolves to nothing on purpose, which keeps these cases away
   * from any file handling; `allowEmpty` is what stops the empty input set from
   * becoming the error under test.
   */
  const runWith = (over: Record<string, unknown>): Promise<unknown> =>
    runFill({
      ...base,
      cwd: dir,
      inputs: ["missing.md"],
      allowEmpty: true,
      dryRun: true,
      inferenceProvider: propose({}),
      ...over,
    });

  it("rejects an unknown provider", async () => {
    await expect(runWith({ provider: "antropic" })).rejects.toThrow(DocmetaError);
    await expect(runWith({ provider: "antropic" })).rejects.toThrow(/antropic/);
  });

  it("lists the real provider names in that error, including auto", async () => {
    // Sourced from the library rather than a hardcoded copy, so a provider
    // added upstream cannot leave this list silently stale.
    await expect(runWith({ provider: "antropic" })).rejects.toThrow(/auto/);
    await expect(runWith({ provider: "antropic" })).rejects.toThrow(/llama-cpp/);
  });

  it("accepts auto as an explicit value", async () => {
    await expect(runWith({ provider: "auto" })).resolves.toBeDefined();
  });

  it("accepts every provider the library actually offers", async () => {
    for (const name of Object.keys(DEFAULT_MODELS)) {
      await expect(runWith({ provider: name })).resolves.toBeDefined();
    }
  });

  it("still gets `mock` from the library, which docmeta's own tests rely on", async () => {
    // The accepted names are derived from DEFAULT_MODELS rather than hardcoded,
    // which is what stopped the list going stale — but it also means docmeta
    // silently inherits whatever the library drops. `mock` is the one entry
    // docmeta itself depends on, so assert it directly: if a future version
    // removes it, this fails with a reason instead of an `Unknown provider
    // "mock"` from an unrelated test.
    //
    // Re-adding "mock" to the local list would be worse — docmeta would accept a
    // provider the library could no longer construct, moving the failure later
    // and making it harder to read.
    expect(Object.keys(DEFAULT_MODELS)).toContain("mock");
  });

  it("refuses a model without a provider, as an operational error", async () => {
    // A model name belongs to one provider, so under detection it is ambiguous.
    // Carried through, it reached the API and 404'd after the run had started.
    await expect(runWith({ model: "gpt-4o-mini" })).rejects.toThrow(DocmetaError);
    await expect(runWith({ model: "gpt-4o-mini" })).rejects.toThrow(/--provider/);
  });

  it("still refuses it when auto was named explicitly", async () => {
    await expect(
      runWith({ provider: "auto", model: "gpt-4o-mini" }),
    ).rejects.toThrow(DocmetaError);
  });

  it("allows a model once the provider is named", async () => {
    await expect(
      runWith({ provider: "openai", model: "gpt-4o" }),
    ).resolves.toBeDefined();
  });

  it("counts a config provider as naming one, not just the flag", async () => {
    // The rule is about the EFFECTIVE provider. `fill.provider` in config
    // satisfies it exactly as --provider does, so a bare --model alongside it is
    // fine — the flag and the config key are not different rules.
    await writeFile(
      join(dir, "docmeta.config.yaml"),
      "paths:\n  - '**/*.md'\nfill:\n  provider: openai\n",
      "utf8",
    );
    await expect(
      runFill({
        ...base,
        cwd: dir,
        inputs: ["missing.md"],
        allowEmpty: true,
        dryRun: true,
        inferenceProvider: propose({}),
        model: "gpt-4o",
      }),
    ).resolves.toBeDefined();
  });

  it("constructs the resolved provider, not the selector it started from", async () => {
    // No `inferenceProvider` here, deliberately: every other case injects one,
    // which skips construction entirely. That blind spot let `makeProvider` keep
    // receiving the literal "auto" long after detection had resolved it — the
    // synchronous guard then threw on every real run that needed inference.
    const file = await stage("no-block.md");
    const run = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["title"],
      dryRun: true,
      provider: "mock",
    });
    expect(run.provider).toBe("mock");
    expect(run.results[0]?.error).toBeUndefined();
  });

  it("defaults to auto when no provider is given anywhere", async () => {
    // Pinned through the ambiguity rule rather than by running detection, which
    // would depend on whatever credentials the machine happens to hold. Only
    // `auto` makes a bare --model ambiguous: under a named default this would
    // resolve happily, so the rejection IS the assertion that auto is the
    // default.
    await expect(
      runFill({
        ...base,
        cwd: dir,
        inputs: ["missing.md"],
        dryRun: true,
        inferenceProvider: propose({}),
        model: "gpt-4o-mini",
      }),
    ).rejects.toThrow(/--provider/);
  });

  it("treats an omitted provider and an explicit auto identically", async () => {
    // Awaited one at a time on purpose. Starting both first and attaching the
    // matchers afterwards leaves the second promise rejected with no handler
    // for the duration of the first `await`, which Node reports as an unhandled
    // rejection and vitest turns into a failed run — intermittently, since it
    // depends on which side settles first.
    const run = (extra: Partial<FillOptions>) =>
      runFill({
        ...base,
        cwd: dir,
        inputs: ["missing.md"],
        dryRun: true,
        inferenceProvider: propose({}),
        model: "gpt-4o",
        ...extra,
      });
    await expect(run({})).rejects.toThrow(/--provider/);
    await expect(run({ provider: "auto" })).rejects.toThrow(/--provider/);
  });

  it("reads the provider from config when no flag is given", async () => {
    await writeFile(
      join(dir, "docmeta.config.yaml"),
      "paths:\n  - '**/*.md'\nfill:\n  provider: antropic\n",
      "utf8",
    );
    // A typo in config is as operational as a typo on the command line.
    await expect(
      runFill({ ...base, cwd: dir, inputs: [], dryRun: true }),
    ).rejects.toThrow(/antropic/);
  });
});

describe("the llama-cpp provider", () => {
  // No `inferenceProvider` anywhere in here: the point is to drive the real
  // llama-cpp path.
  //
  // Both variables are load-bearing, and the second one is easy to miss.
  // `node-llama-cpp` is not a docmeta dependency, so it is absent from
  // node_modules — but the library also looks in its own runtime prefix, and
  // anything that has ever run a local model on this machine populates that.
  // Running the doc-detective suite does exactly that, and it broke these tests:
  // the binding became available, so runs that should have failed succeeded, and
  // "expected +0 to be 1" was the whole diagnosis.
  //
  // Pointing the prefix at the per-test scratch directory makes absence a
  // property of the test rather than of the machine. The opt-out then keeps a
  // miss from turning into a multi-gigabyte install partway through the suite.
  const saved: Record<string, string | undefined> = {};
  const VARS = ["INFERENCE_NO_AUTO_INSTALL", "INFERENCE_RUNTIME_DIR"] as const;

  beforeEach(() => {
    for (const v of VARS) saved[v] = process.env[v];
    process.env["INFERENCE_NO_AUTO_INSTALL"] = "1";
    process.env["INFERENCE_RUNTIME_DIR"] = dir;
  });

  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it("resolves a concrete catalog model without the native binding", async () => {
    // Naming a model skips the hardware probe, so identity — and therefore the
    // cache key and the cost lookup — resolves with nothing installed.
    //
    // This doubles as the check that `llama-cpp` is an accepted name at all: it
    // was not, for a while, because the hardcoded provider list here never
    // gained it and a valid provider was rejected as a typo.
    const file = await stage("no-block.md");
    const run = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["title"],
      dryRun: true,
      provider: "llama-cpp",
      model: "gemma-4-e4b",
    });

    expect(run.provider).toBe("llama-cpp");
    expect(run.model).toBe("gemma-4-e4b");
  });

  it("reports a missing runtime as a per-file error naming the opt-out", async () => {
    // One run, both assertions: these were two tests issuing byte-identical
    // calls, which doubled the work without doubling the coverage.
    //
    // Whoever set the opt-out needs to recognise their own decision in the
    // message rather than reading it as "local models are broken", so the error
    // has to name it — not merely mention the package.
    const file = await stage("no-block.md");
    const run = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["title"],
      dryRun: true,
      provider: "llama-cpp",
      model: "gemma-4-e4b",
    });

    expect(run.results[0]?.error).toMatch(/node-llama-cpp/);
    expect(run.results[0]?.error).toMatch(/INFERENCE_NO_AUTO_INSTALL/);
    expect(run.summary.errors).toBe(1);
    expect(run.summary.written).toBe(0);
  });

  it("fails operationally when the model selector needs an absent runtime", async () => {
    // Without a model, `llama-cpp` defaults to the `auto` selector, and sizing a
    // tier probes the machine — which needs the binding. That is a setup
    // failure, not a per-file one, so it aborts the run rather than erroring
    // once per document.
    const file = await stage("no-block.md");
    await expect(
      runFill({
        ...base,
        cwd: dir,
        inputs: [file],
        fields: ["title"],
        dryRun: true,
        provider: "llama-cpp",
      }),
    ).rejects.toThrow(DocmetaError);
  });

});
