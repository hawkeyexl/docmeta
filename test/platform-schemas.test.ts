/**
 * Behavior of the built-in platform front matter schemas — Starlight, Antora,
 * Sphinx and MyST — exercised through the real validate path (extraction ->
 * resolution -> validation) rather than against the JSON objects directly, so a
 * mistyped field fails here.
 *
 * These extend the pattern the Docusaurus built-ins established: a platform
 * schema describes the contract a *tool* enforces, so it constrains value
 * shapes and tolerates unknown keys. Where they differ is presence. Docusaurus
 * marks no front matter field as required and so requires nothing; Starlight
 * and Antora both *error* without a page title, so both demand it. The rule
 * across all platform built-ins is "require exactly what upstream refuses to
 * build without", and the tests below pin it in both directions.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runValidate } from "../src/commands/validate.js";
import { DEFAULT_SCHEMAS } from "../src/core/resolve-schema.js";
import { loadSchema } from "../src/core/schema-registry.js";
import { getSchemasInfo } from "../src/commands/schemas.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const STARLIGHT = "astro:starlight:0.41";
const ANTORA = "antora:page:3.1";
const SPHINX = "sphinx:docinfo:9.1";
const MYST = "myst:frontmatter:1.10";

/** Validate one platform fixture against an explicit schema set. */
async function check(fixture: string, cliSchemas: string[]) {
  const { results } = await runValidate({
    inputs: [`test/fixtures/platform/${fixture}`],
    cliSchemas,
    cwd: root,
  });
  const r = results[0];
  if (!r) throw new Error(`no result for ${fixture}`);
  return r;
}

/**
 * The field set each schema is expected to carry, transcribed from upstream.
 * Kept here rather than derived from the schema so a dropped or misspelled
 * property fails the completeness tests below.
 */
const STARLIGHT_FIELDS = [
  "title",
  "description",
  "slug",
  "editUrl",
  "head",
  "tableOfContents",
  "template",
  "hero",
  "banner",
  "lastUpdated",
  "prev",
  "next",
  "pagefind",
  "draft",
  "sidebar",
];

const ANTORA_FIELDS = [
  "title",
  "description",
  "keywords",
  "navtitle",
  "page-aliases",
  "page-layout",
  "page-partial",
  "page-role",
  "page-toclevels",
  "page-tags",
];

const SPHINX_FIELDS = [
  "tocdepth",
  "orphan",
  "nocomments",
  "no-search",
  "nosearch",
];

describe("astro:starlight:0.41", () => {
  it("accepts a page carrying every documented field", async () => {
    const r = await check("starlight-valid.md", [STARLIGHT]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("requires `title`, the one field Starlight refuses to build without", async () => {
    const r = await check("starlight-missing-title.md", [STARLIGHT]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(STARLIGHT);
    expect(r.errors[0]?.message).toContain("title");
  });

  it("rejects a template outside the two Starlight ships", async () => {
    const r = await check("starlight-bad-template.md", [STARLIGHT]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(STARLIGHT);
    expect(r.errors[0]?.instancePath).toBe("/template");
  });

  it("rejects a heading level past 6 inside tableOfContents", async () => {
    const r = await check("starlight-bad-toc.md", [STARLIGHT]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/tableOfContents/maxHeadingLevel");
  });

  it("accepts the splash template with a hero block", async () => {
    expect((await check("starlight-splash-hero.md", [STARLIGHT])).ok).toBe(true);
  });

  it("does not report the branch a union-typed field never took", async () => {
    // The union fields are branched with `if`/`then` rather than `anyOf`.
    // Under `anyOf` this document produced five errors for two mistakes, and
    // the extra one was `/sidebar/badge must be string` — a complaint about the
    // string branch, aimed at a value that was plainly meant to be the object
    // branch. Branching on the type drops it. Ajv still appends one summary
    // line per failed branch, but it comes *after* the specific errors rather
    // than between them.
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent:
        '---\ntitle: T\nsidebar:\n  order: "1"\n  badge:\n    variant: shiny\n---\n',
      cliSchemas: [STARLIGHT],
      cwd: root,
    });
    const errors = results[0]?.errors ?? [];
    expect(errors.map((e) => `${e.instancePath} ${e.message}`)).toEqual([
      "/sidebar/order must be number",
      "/sidebar/badge must have required property 'text'",
      "/sidebar/badge/variant must be equal to one of the allowed values",
      '/sidebar/badge must match "then" schema',
    ]);
  });

  it("accepts `tableOfContents: false`, which Starlight allows", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntitle: No TOC\ntableOfContents: false\n---\n",
      cliSchemas: [STARLIGHT],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
  });

  it("accepts every spelling of prev upstream allows", async () => {
    for (const value of [
      "false",
      "true",
      "Previous page",
      "{ link: /a/, label: A }",
    ]) {
      const { results } = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent: `---\ntitle: T\nprev: ${value}\n---\n`,
        cliSchemas: [STARLIGHT],
        cwd: root,
      });
      expect(results[0]?.ok, `prev: ${value}`).toBe(true);
    }
  });

  it("tolerates front matter it does not recognize", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntitle: T\nsomeExperimentalKey: yes\n---\n",
      cliSchemas: [STARLIGHT],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
  });
});

describe("antora:page:3.1", () => {
  it("accepts a page header carrying every documented attribute", async () => {
    const r = await check("antora-valid.adoc", [ANTORA]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("requires the page title, the only mandatory header element", async () => {
    const r = await check("antora-missing-title.adoc", [ANTORA]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(ANTORA);
    expect(r.errors[0]?.message).toContain("title");
  });

  it("rejects a non-integer page-toclevels", async () => {
    const r = await check("antora-bad-toclevels.adoc", [ANTORA]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/page-toclevels");
  });

  it("accepts a bare `:page-partial:`, which AsciiDoc types as true", async () => {
    expect((await check("antora-partial-flag.adoc", [ANTORA])).ok).toBe(true);
  });

  it("keeps `keywords` a string, because AsciiDoc attributes are not lists", async () => {
    // `:keywords: a, b` reaches the validator as the string "a, b". Typing it
    // as an array would fail every real Antora page.
    const schema = (await loadSchema(ANTORA)) as {
      properties: { keywords: { type: string } };
    };
    expect(schema.properties.keywords.type).toBe("string");
  });
});

describe("sphinx:docinfo:9.1", () => {
  it("accepts the documented file-wide fields", async () => {
    const r = await check("sphinx-valid.rst", [SPHINX]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects a non-integer tocdepth", async () => {
    const r = await check("sphinx-bad-tocdepth.rst", [SPHINX]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(SPHINX);
    expect(r.errors[0]?.instancePath).toBe("/tocdepth");
  });

  it("still accepts `nosearch`, which Sphinx renamed but has not removed", async () => {
    // Deliberately not an error. Sphinx 9.1 accepts the old spelling, and a
    // platform schema that failed the build on a spelling the platform accepts
    // would be asserting something untrue about the tool.
    expect((await check("sphinx-deprecated-nosearch.rst", [SPHINX])).ok).toBe(
      true,
    );
  });

  it("marks `nosearch` deprecated so the annotation carries the rename", async () => {
    const schema = (await loadSchema(SPHINX)) as {
      properties: { nosearch: { deprecated?: boolean; description?: string } };
    };
    expect(schema.properties.nosearch.deprecated).toBe(true);
    expect(schema.properties.nosearch.description).toContain("no-search");
  });

  it("requires nothing — every docinfo field is optional", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "rst",
      stdinContent: "Title\n=====\n\nBody.\n",
      cliSchemas: [SPHINX],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
  });
});

describe("myst:frontmatter:1.10", () => {
  it("accepts a page carrying the documented page-level fields", async () => {
    const r = await check("myst-valid.md", [MYST]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("enforces the 40-character cap on short_title", async () => {
    const r = await check("myst-bad-short-title.md", [MYST]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(MYST);
    expect(r.errors[0]?.instancePath).toBe("/short_title");
  });

  it("rejects a numeric authors value", async () => {
    const r = await check("myst-bad-authors.md", [MYST]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/authors");
  });

  it("does not enum CRediT roles, which are not transcribed here", async () => {
    // MyST documents 14 roles plus aliases. They are not reproduced in the
    // schema, so `roles` checks shape only — the same discipline applied to
    // `ms.topic`. An enum invented from memory would reject valid documents.
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent:
        "---\ntitle: T\nauthors:\n  - name: A\n    roles:\n      - conceptualisation\n---\n",
      cliSchemas: [MYST],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
  });

  it("requires nothing — MyST infers a missing title from the first heading", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntags:\n  - guide\n---\n",
      cliSchemas: [MYST],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
  });
});

describe("the field sets match what upstream documents", () => {
  const cases: Array<[string, string[]]> = [
    [STARLIGHT, STARLIGHT_FIELDS],
    [ANTORA, ANTORA_FIELDS],
    [SPHINX, SPHINX_FIELDS],
  ];
  for (const [id, expected] of cases) {
    it(`${id} carries exactly its documented fields`, async () => {
      const schema = (await loadSchema(id)) as {
        properties: Record<string, unknown>;
      };
      expect(Object.keys(schema.properties).sort()).toEqual(
        [...expected].sort(),
      );
    });
  }
});

describe("a platform schema requires exactly what upstream errors without", () => {
  it("Starlight and Antora require a title; Sphinx and MyST require nothing", async () => {
    const required = async (id: string) =>
      ((await loadSchema(id)) as { required?: string[] }).required;
    expect(await required(STARLIGHT)).toEqual(["title"]);
    expect(await required(ANTORA)).toEqual(["title"]);
    expect(await required(SPHINX)).toBeUndefined();
    expect(await required(MYST)).toBeUndefined();
  });
});

describe("all four tolerate unknown keys", () => {
  for (const id of [STARLIGHT, ANTORA, SPHINX, MYST]) {
    it(`${id} sets additionalProperties true`, async () => {
      const schema = (await loadSchema(id)) as {
        additionalProperties?: boolean;
      };
      expect(schema.additionalProperties).toBe(true);
    });
  }
});

describe("the platform schemas are opt-in", () => {
  for (const id of [STARLIGHT, ANTORA, SPHINX, MYST]) {
    it(`${id} is not in the default set`, () => {
      expect(DEFAULT_SCHEMAS).not.toContain(id);
    });
  }

  it("all four are listed by the schemas command", () => {
    const ids = getSchemasInfo().builtins.map((b) => b.id);
    for (const id of [STARLIGHT, ANTORA, SPHINX, MYST]) {
      expect(ids).toContain(id);
    }
  });
});

describe("composing a platform schema with an editorial one", () => {
  it("keeps each schema's own errors", async () => {
    // Passes Starlight on every field it names, fails OKF on the missing
    // `type`: the error must be attributed to OKF, not to Starlight.
    const r = await check("starlight-valid.md", [STARLIGHT, "google:okf:0.1"]);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.schema).toBe("google:okf:0.1");
    expect(r.errors[0]?.message).toContain("type");
  });
});
