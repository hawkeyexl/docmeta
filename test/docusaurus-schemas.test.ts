/**
 * Behavior of the built-in Docusaurus front matter schemas, exercised through
 * the real validate path (extraction -> resolution -> validation) rather than
 * against the JSON objects directly, so a mistyped field fails here.
 *
 * These differ in kind from the taxonomy built-ins: Docusaurus requires no
 * front matter field at all, so they are *format* schemas. Every assertion
 * about a failure is therefore about a value's shape, never its absence.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { runValidate } from "../src/commands/validate.js";
import { DEFAULT_SCHEMAS } from "../src/core/resolve-schema.js";
import { loadSchema } from "../src/core/schema-registry.js";
import { getSchemasInfo } from "../src/commands/schemas.js";
import { collectCandidates } from "../src/commands/fill.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const DOCS = "docusaurus:docs:3.10";
const BLOG = "docusaurus:blog:3.10";
const PAGES = "docusaurus:pages:3.10";

/**
 * The field set each schema is expected to carry, transcribed from the
 * Docusaurus 3.10 front matter reference. Order is irrelevant; membership is
 * not. Kept here rather than derived from the schema so a dropped or misspelled
 * property fails the completeness test below.
 */
const DOCS_FIELDS = [
  "id",
  "title",
  "pagination_label",
  "sidebar_label",
  "sidebar_position",
  "sidebar_class_name",
  "sidebar_key",
  "sidebar_custom_props",
  "displayed_sidebar",
  "hide_title",
  "hide_table_of_contents",
  "toc_min_heading_level",
  "toc_max_heading_level",
  "pagination_next",
  "pagination_prev",
  "parse_number_prefixes",
  "custom_edit_url",
  "keywords",
  "description",
  "image",
  "slug",
  "tags",
  "draft",
  "unlisted",
  "last_update",
];

const BLOG_FIELDS = [
  "authors",
  "author",
  "author_url",
  "author_image_url",
  "author_title",
  "title",
  "title_meta",
  "sidebar_label",
  "date",
  "tags",
  "draft",
  "unlisted",
  "hide_table_of_contents",
  "toc_min_heading_level",
  "toc_max_heading_level",
  "keywords",
  "description",
  "image",
  "slug",
  "last_update",
];

const PAGES_FIELDS = [
  "title",
  "description",
  "keywords",
  "image",
  "slug",
  "wrapperClassName",
  "hide_table_of_contents",
  "draft",
  "unlisted",
];

/** Validate one fixture against an explicit schema set. */
async function check(fixture: string, cliSchemas: string[]) {
  const { results } = await runValidate({
    inputs: [`test/fixtures/docusaurus/${fixture}`],
    cliSchemas,
    cwd: root,
  });
  const r = results[0];
  if (!r) throw new Error(`no result for ${fixture}`);
  return r;
}

/** Validate inline front matter against an explicit schema set. */
async function checkInline(frontmatter: string, cliSchemas: string[]) {
  const { results } = await runValidate({
    inputs: ["-"],
    as: "markdown",
    stdinContent: `---\n${frontmatter}\n---\n`,
    cliSchemas,
    cwd: root,
  });
  const r = results[0];
  if (!r) throw new Error("no result for stdin");
  return r;
}

describe("docusaurus:docs:3.10", () => {
  it("accepts a document carrying every documented field", async () => {
    const r = await check("docs-valid.md", [DOCS]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects a quoted sidebar_position, naming the schema", async () => {
    const r = await check("docs-bad-sidebar-position.md", [DOCS]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(DOCS);
    expect(r.errors[0]?.instancePath).toBe("/sidebar_position");
  });

  it("rejects a heading level past 6", async () => {
    const r = await check("docs-bad-toc-level.md", [DOCS]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(DOCS);
    expect(r.errors[0]?.instancePath).toBe("/toc_max_heading_level");
  });

  it("rejects a heading level below 2", async () => {
    const r = await checkInline("toc_min_heading_level: 1", [DOCS]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/toc_min_heading_level");
  });

  it("accepts a fractional heading level, as Docusaurus does", async () => {
    // Upstream is `Joi.number().min(2).max(6)` with no `.integer()`, so 2.5
    // builds. Typing these `integer` would be stricter than the generator and
    // would fail a page that was already building — the one thing a platform
    // schema must never do.
    expect((await checkInline("toc_max_heading_level: 2.5", [DOCS])).ok).toBe(
      true,
    );
    expect((await checkInline("toc_max_heading_level: 2.5", [BLOG])).ok).toBe(
      true,
    );
    // `sidebar_position` is `Joi.number()` upstream too.
    expect((await checkInline("sidebar_position: 2.5", [DOCS])).ok).toBe(true);
  });

  it("rejects an unknown key inside last_update", async () => {
    const r = await check("docs-bad-last-update.md", [DOCS]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(DOCS);
    expect(r.errors[0]?.instancePath).toBe("/last_update");
  });

  it("rejects an empty last_update", async () => {
    // Upstream requires at least one of `author` / `date`.
    const r = await checkInline("last_update: {}", [DOCS]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/last_update");
  });

  it("rejects a page that is both draft and unlisted, naming the field", async () => {
    // The one cross-field rule Docusaurus enforces, and the one this schema
    // can express: the two flags are mutually exclusive. Encoded as if/then
    // rather than a root-level `not`, so at least one error anchors to
    // `/unlisted` with its line. A bare `not` reports only
    // "(root) must NOT be valid", which tells a reader nothing to fix.
    const r = await check("docs-draft-and-unlisted.md", [DOCS]);
    expect(r.ok).toBe(false);
    expect(r.errors.every((e) => e.schema === DOCS)).toBe(true);
    const anchored = r.errors.find((e) => e.instancePath === "/unlisted");
    expect(anchored).toBeDefined();
    expect(anchored?.line).toBe(4);
  });

  it("accepts an explicit `unlisted: false` alongside a draft", async () => {
    // The `then` clause pins `unlisted` to `false` rather than forbidding the
    // key, so spelling out the default must still pass. Both flags on their
    // own are covered for all three schemas further down.
    expect((await checkInline("draft: true\nunlisted: false", [DOCS])).ok).toBe(
      true,
    );
  });

  it("tolerates front matter it does not recognize", async () => {
    // Docusaurus calls `.unknown()` on its own Joi schema, so a theme or
    // plugin key must not fail here either.
    expect((await check("docs-unknown-key.md", [DOCS])).ok).toBe(true);
  });

  it("accepts a relative image path", async () => {
    // `image` and `custom_edit_url` are URI *references* upstream, so a
    // site-root path is legal and `format: uri` would wrongly reject it.
    expect((await checkInline("image: /img/social/card.png", [DOCS])).ok).toBe(
      true,
    );
  });

  it("accepts null where Docusaurus allows it", async () => {
    const r = await checkInline(
      "pagination_next: null\npagination_prev: null\ndisplayed_sidebar: null",
      [DOCS],
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("accepts both tag spellings and rejects a half-written tag object", async () => {
    expect((await checkInline("tags:\n  - setup", [DOCS])).ok).toBe(true);
    // `required` binds only to the object form, so the string tag above passes
    // and this reports the one missing key rather than every anyOf branch.
    const bad = await checkInline("tags:\n  - label: Getting started", [DOCS]);
    expect(bad.ok).toBe(false);
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]?.instancePath).toBe("/tags/0");
    expect(bad.errors[0]?.message).toContain("permalink");
  });
});

describe("docusaurus:blog:3.10", () => {
  it("accepts a post carrying every documented field", async () => {
    const r = await check("blog-valid.md", [BLOG]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects a numeric authors value in a single error", async () => {
    // `authors` is typed as a union with `properties` and `items` alongside it
    // rather than as an anyOf, so a wrong scalar reports once instead of once
    // per alternative.
    const r = await check("blog-bad-authors.md", [BLOG]);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.schema).toBe(BLOG);
    expect(r.errors[0]?.instancePath).toBe("/authors");
  });

  it("checks inside an inline author and inside a list of them", async () => {
    const inline = await checkInline("authors:\n  name: 42", [BLOG]);
    expect(inline.ok).toBe(false);
    expect(inline.errors[0]?.instancePath).toBe("/authors/name");

    const listed = await checkInline("authors:\n  - name: 42", [BLOG]);
    expect(listed.ok).toBe(false);
    expect(listed.errors[0]?.instancePath).toBe("/authors/0/name");
  });

  it("types the single-author and list forms from one definition", async () => {
    // Both forms `$ref` the same `authorFields`, so they cannot drift apart.
    // Checking every field in both spellings is what makes that structural
    // claim testable: a field defined in only one of them fails here.
    const schema = (await loadSchema(BLOG)) as {
      $defs: { authorFields: { properties: Record<string, unknown> } };
    };
    const fields = Object.keys(schema.$defs.authorFields.properties);
    expect(fields.length).toBeGreaterThan(0);

    for (const field of fields) {
      // `page` accepts a boolean, so a string is the value no author field
      // accepts. Everything else rejects a bare list.
      const bad = `${field}:\n    - nope`;
      const inline = await checkInline(`authors:\n  ${bad}`, [BLOG]);
      expect(inline.ok, `inline ${field}`).toBe(false);
      expect(inline.errors[0]?.instancePath, `inline ${field}`).toBe(
        `/authors/${field}`,
      );

      const listed = await checkInline(`authors:\n  - ${bad}`, [BLOG]);
      expect(listed.ok, `listed ${field}`).toBe(false);
      expect(listed.errors[0]?.instancePath, `listed ${field}`).toBe(
        `/authors/0/${field}`,
      );
    }
  });

  it("accepts every authors spelling upstream allows", async () => {
    for (const authors of [
      "authors: dana",
      "authors:\n  - dana\n  - sam",
      "authors:\n  name: Dana\n  title: Writer",
      "authors:\n  - dana\n  - name: Sam",
    ]) {
      expect((await checkInline(authors, [BLOG])).ok, authors).toBe(true);
    }
  });
});

describe("docusaurus:pages:3.10", () => {
  it("accepts a page carrying every documented field", async () => {
    const r = await check("pages-valid.md", [PAGES]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects a non-string wrapperClassName", async () => {
    const r = await check("pages-bad-wrapper-class.md", [PAGES]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(PAGES);
    expect(r.errors[0]?.instancePath).toBe("/wrapperClassName");
  });
});

describe("the visibility rule holds in all three", () => {
  // All three carry the same if/then encoding, but only the docs schema was
  // exercised through a fixture. The rule is duplicated per schema, so an edit
  // that drops it from one would otherwise go unnoticed.
  for (const id of [DOCS, BLOG, PAGES]) {
    it(`${id} rejects draft and unlisted together`, async () => {
      const r = await checkInline("draft: true\nunlisted: true", [id]);
      expect(r.ok).toBe(false);
      expect(r.errors.every((e) => e.schema === id)).toBe(true);
      expect(
        r.errors.find((e) => e.instancePath === "/unlisted"),
      ).toBeDefined();
    });

    it(`${id} accepts either flag alone`, async () => {
      expect((await checkInline("draft: true", [id])).ok).toBe(true);
      expect((await checkInline("unlisted: true", [id])).ok).toBe(true);
    });
  }
});

describe("all three require nothing", () => {
  // Docusaurus marks no front matter field as required in any of the three
  // plugins, so these are format checks only. A document with a lone `title`
  // — or none at all — must pass every one of them.
  for (const id of [DOCS, BLOG, PAGES]) {
    it(`${id} passes a document with only a title`, async () => {
      expect((await checkInline("title: Anything", [id])).ok).toBe(true);
    });

    it(`${id} passes a document with no front matter`, async () => {
      const { results } = await runValidate({
        inputs: ["test/fixtures/no-frontmatter.md"],
        cliSchemas: [id],
        cwd: root,
      });
      expect(results[0]?.ok).toBe(true);
    });
  }
});

describe("the field sets match the Docusaurus 3.10 reference", () => {
  // The analogue of the TGDP enum-completeness test: an accept-each loop can
  // never fail on a field it does not try, so a dropped or misspelled property
  // would otherwise ship unnoticed.
  const cases: [string, string[]][] = [
    [DOCS, DOCS_FIELDS],
    [BLOG, BLOG_FIELDS],
    [PAGES, PAGES_FIELDS],
  ];

  for (const [id, expected] of cases) {
    it(`${id} carries exactly its documented fields`, async () => {
      const schema = (await loadSchema(id)) as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(Object.keys(schema.properties).sort()).toEqual(
        [...expected].sort(),
      );
      // No Docusaurus front matter field is mandatory.
      expect(schema.required).toBeUndefined();
    });
  }
});

describe("the reference page matches the shipped schemas", () => {
  // Source-of-truth guard in the spirit of `docs:check-cli`. The field tables
  // in reference/docusaurus-schemas.mdx are hand-written, so a type changed in
  // the JSON and not in the table ships a page that contradicts the tool —
  // which is exactly what happened when these were retyped from `integer` to
  // `number`.
  const PRIMITIVES = new Set([
    "string",
    "number",
    "integer",
    "boolean",
    "object",
    "array",
    "null",
  ]);

  /** Every primitive the schema permits for a field, `items` included. */
  function allowedTypes(sub: Record<string, unknown>): Set<string> {
    const out = new Set<string>();
    const add = (t: unknown) => {
      if (typeof t === "string") out.add(t);
      else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") out.add(x);
    };
    add(sub.type);
    const items = sub.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      add((items as Record<string, unknown>).type);
    }
    return out;
  }

  /** The Type cell of the `| \`field\` | type | constraint |` row. */
  function docType(page: string, field: string): string | undefined {
    const row = new RegExp(
      `^\\|\\s*\`${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`\\s*\\|([^|]*)\\|`,
      "m",
    ).exec(page);
    return row?.[1]?.trim();
  }

  for (const id of [DOCS, BLOG, PAGES]) {
    it(`${id} field types agree with the reference page`, async () => {
      const page = await readFile(
        resolve(root, "docs/src/content/docs/reference/docusaurus-schemas.mdx"),
        "utf8",
      );
      const schema = (await loadSchema(id)) as {
        properties: Record<string, Record<string, unknown>>;
      };

      for (const [field, sub] of Object.entries(schema.properties)) {
        const cell = docType(page, field);
        expect(cell, `${field} is missing from the reference page`).toBeDefined();

        const claimed = (cell ?? "")
          .split(/[^a-z]+/i)
          .filter((w) => PRIMITIVES.has(w));
        const allowed = allowedTypes(sub);
        for (const word of claimed) {
          expect(
            allowed.has(word),
            `${id} documents \`${field}\` as "${cell}" but the schema allows ${[...allowed].join(", ")}`,
          ).toBe(true);
        }
      }
    });
  }
});

describe("the Docusaurus schemas are opt-in", () => {
  it("is not in the default set", () => {
    for (const id of [DOCS, BLOG, PAGES]) {
      expect(DEFAULT_SCHEMAS).not.toContain(id);
    }
  });

  it("does not apply to a file validated with no flags", async () => {
    // docs-bad-toc-level.md fails DOCS but carries no `type`, so a bare run
    // must report the OKF failure and nothing from Docusaurus.
    const { results } = await runValidate({
      inputs: ["test/fixtures/docusaurus/docs-bad-toc-level.md"],
      cwd: root,
    });
    expect(results[0]?.schemas).toEqual([...DEFAULT_SCHEMAS]);
    for (const err of results[0]?.errors ?? []) {
      expect(err.schema).not.toBe(DOCS);
    }
  });

  it("is listed by the schemas command", () => {
    const ids = getSchemasInfo().builtins.map((b) => b.id);
    for (const id of [DOCS, BLOG, PAGES]) expect(ids).toContain(id);
  });
});

describe("what `fill` does with a platform schema", () => {
  // `collectCandidates` offers every *absent* property, not just the required
  // ones, which is right for a descriptive schema like OKF and wrong for this
  // one: most Docusaurus fields are structural, and a model cannot know them
  // from page content. A proposed `pagination_next` or `slug` that clears the
  // confidence gate is written to the file and silently rewires navigation or
  // changes a URL. These tests pin the hazard so it cannot widen unnoticed,
  // and pin `--fields` as the mitigation the reference page documents.
  const STRUCTURAL = [
    "sidebar_position",
    "pagination_next",
    "pagination_prev",
    "displayed_sidebar",
    "custom_edit_url",
    "slug",
    "id",
  ];

  it("offers structural fields a model cannot infer", async () => {
    const schema = await loadSchema(DOCS);
    const keys = collectCandidates([schema], {}, []).map((c) => c.key);
    for (const field of STRUCTURAL) expect(keys).toContain(field);
    // None are required, so none of these count as work left undone: `fill`
    // exits 0 whether or not the model declines them.
    expect(collectCandidates([schema], {}, []).every((c) => !c.required)).toBe(
      true,
    );
  });

  it("narrows to exactly the fields named by --fields", async () => {
    const schema = await loadSchema(DOCS);
    const only = new Set(["description", "keywords"]);
    const keys = collectCandidates([schema], {}, [], only).map((c) => c.key);
    expect(keys.sort()).toEqual(["description", "keywords"]);
  });
});

describe("composing a platform schema with an editorial one", () => {
  it("keeps each schema's own errors", async () => {
    // The reason these are worth shipping: one run enforces the generator's
    // contract and the docs set's own standard, attributing each failure.
    const r = await check("docs-unknown-key.md", [DOCS, "diataxis:diataxis:1.0"]);
    expect(r.ok).toBe(true);
    expect(r.schemas).toEqual([DOCS, "diataxis:diataxis:1.0"]);

    const bad = await checkInline("type: howto\nsidebar_position: \"2\"", [
      DOCS,
      "diataxis:diataxis:1.0",
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => e.schema).sort()).toEqual(
      [DOCS, "diataxis:diataxis:1.0"].sort(),
    );
  });

  it("conflicts with OKF on `tags`, the one key whose definitions disagree", async () => {
    // OKF allows a list of strings only; Docusaurus also allows a tag object.
    // Every schema in a set applies in full, so the object form cannot satisfy
    // both. Pinned because the reference page documents this exact pairing as
    // the exception to "platform and editorial schemas compose".
    const r = await check("docs-okf-tag-conflict.md", ["google:okf:0.1", DOCS]);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.schema).toBe("google:okf:0.1");
    expect(r.errors[0]?.instancePath).toBe("/tags/0");

    // The string form satisfies both, which is the documented way out.
    const strings = await checkInline("type: how-to\ntags:\n  - setup", [
      "google:okf:0.1",
      DOCS,
    ]);
    expect(strings.ok).toBe(true);

    // Pairing with a vocabulary instead of OKF is the other way out.
    const vocab = await check("docs-okf-tag-conflict.md", [
      DOCS,
      "diataxis:diataxis:1.0",
    ]);
    expect(vocab.ok).toBe(true);
  });
});
