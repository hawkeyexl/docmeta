/**
 * Behavior of the built-in static-site-generator schemas — Hugo, Jekyll and
 * VitePress — exercised through the real validate path (extraction ->
 * resolution -> validation) rather than against the JSON objects directly.
 *
 * These are platform schemas and follow the rule the earlier ones established:
 * require exactly what the generator refuses to build without. All three
 * require *nothing*, because all three build a page with no front matter at
 * all. That makes every one of them a pure shape check, and the shapes worth
 * checking are the ones a generator accepts silently and then gets wrong — a
 * quoted `weight` that sorts as a string, a `published: "false"` that publishes
 * because every string is truthy, an `outline` level past 6 that is ignored.
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

const HUGO = "hugo:page:0.165";
const JEKYLL = "jekyll:page:4.4";
const VITEPRESS = "vitepress:page:1.6";

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
 * property fails the completeness test below.
 */
const HUGO_FIELDS = [
  "aliases",
  "build",
  "cascade",
  "date",
  "description",
  "draft",
  "expiryDate",
  "headless",
  "isCJKLanguage",
  "keywords",
  "lastmod",
  "layout",
  "linkTitle",
  "markup",
  "menus",
  "outputs",
  "params",
  "publishDate",
  "resources",
  "sitemap",
  "sites",
  "slug",
  "summary",
  "title",
  "translationKey",
  "type",
  "url",
  "weight",
];

const JEKYLL_FIELDS = [
  "layout",
  "permalink",
  "published",
  "date",
  "category",
  "categories",
  "tags",
];

const VITEPRESS_FIELDS = [
  "title",
  "titleTemplate",
  "description",
  "head",
  "layout",
  "hero",
  "features",
  "navbar",
  "sidebar",
  "aside",
  "outline",
  "lastUpdated",
  "editLink",
  "footer",
  "pageClass",
  "isHome",
];

describe("hugo:page:0.165", () => {
  it("accepts a page using the documented fields", async () => {
    const r = await check("hugo-valid.md", [HUGO]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("accepts the same page under a TOML fence, native dates and all", async () => {
    // Hugo's default fence is TOML, where an unquoted date is a real date
    // rather than a string. This is the case the schema would reject if the
    // extractor did not normalize it back to the authored spelling.
    const r = await check("hugo-toml-valid.md", [HUGO]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects a quoted weight, which sorts as a string", async () => {
    const r = await check("hugo-bad-weight.md", [HUGO]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/weight");
  });

  it("rejects a quoted draft, which is truthy and hides the page", async () => {
    const r = await check("hugo-bad-draft.md", [HUGO]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/draft");
  });

  it("rejects a changefreq outside the seven the sitemap protocol defines", async () => {
    const r = await check("hugo-bad-changefreq.md", [HUGO]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/sitemap/changefreq");
  });

  it("keeps build.list and build.render on their own vocabularies", async () => {
    // Hugo gives the two options different name sets: `list` takes
    // always/never/local and `render` takes always/never/link. One shared
    // enum of the union would accept each other's odd one out, so the schema
    // carries two $defs rather than one.
    const bad = await check("hugo-bad-render.md", [HUGO]);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]?.instancePath).toBe("/build/render");

    const alsoBad = await check("hugo-bad-list.md", [HUGO]);
    expect(alsoBad.ok).toBe(false);
    expect(alsoBad.errors[0]?.instancePath).toBe("/build/list");

    // and the valid fixture still uses `list: always` + `render: true`
    expect((await check("hugo-valid.md", [HUGO])).ok).toBe(true);
  });

  it("requires nothing — Hugo builds a page with no front matter", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\n---\n\n# Body\n",
      cliSchemas: [HUGO],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
  });
});

describe("jekyll:page:4.4", () => {
  it("accepts a post using the documented fields", async () => {
    const r = await check("jekyll-valid.md", [JEKYLL]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("accepts a null layout, which is how a layout is suppressed", async () => {
    const r = await check("jekyll-null-layout.md", [JEKYLL]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects a quoted published, which publishes the post anyway", async () => {
    const r = await check("jekyll-bad-published.md", [JEKYLL]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/published");
  });

  it("requires nothing — an empty front matter block is valid Jekyll", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\n---\n\nBody.\n",
      cliSchemas: [JEKYLL],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
  });
});

describe("vitepress:page:1.6", () => {
  it("accepts a page using the documented fields", async () => {
    const r = await check("vitepress-valid.md", [VITEPRESS]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("accepts the non-numeric outline forms", async () => {
    const r = await check("vitepress-deep-outline.md", [VITEPRESS]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("reports a bad outline against outline itself, not the parent", async () => {
    // `outline` is the field most worth checking and the easiest to get wrong,
    // so its errors are held to the house shape: the specific complaint first,
    // pointing at the key that is wrong, then Ajv's one summary line for the
    // branch that failed. Nothing about the array branch, which this value
    // plainly never took.
    const r = await check("vitepress-bad-outline.md", [VITEPRESS]);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => `${e.instancePath} ${e.message}`)).toEqual([
      "/outline must be equal to one of the allowed values",
      '/outline must match "else" schema',
    ]);
  });

  it("rejects an aside position VitePress does not define", async () => {
    const r = await check("vitepress-bad-aside.md", [VITEPRESS]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/aside");
  });

  it("requires nothing — every option has a default", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\n---\n\n# Body\n",
      cliSchemas: [VITEPRESS],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
  });
});

describe("a platform schema requires exactly what upstream errors without", () => {
  it("all three require nothing, because all three build without front matter", async () => {
    for (const id of [HUGO, JEKYLL, VITEPRESS]) {
      const schema = (await loadSchema(id)) as { required?: string[] };
      expect(schema.required).toBeUndefined();
    }
  });
});

describe("all three tolerate unknown keys", () => {
  for (const id of [HUGO, JEKYLL, VITEPRESS]) {
    it(`${id} sets additionalProperties true`, async () => {
      // Theme and plugin keys — Jekyll's `nav_order`, Hugo's taxonomy terms —
      // are not defined by the generator, so they must pass through.
      const schema = (await loadSchema(id)) as {
        additionalProperties?: boolean;
      };
      expect(schema.additionalProperties).toBe(true);
    });
  }
});

describe("the SSG schemas are opt-in", () => {
  for (const id of [HUGO, JEKYLL, VITEPRESS]) {
    it(`${id} is not in the default set`, () => {
      expect(DEFAULT_SCHEMAS).not.toContain(id);
    });
  }

  it("all three are listed by the schemas command", () => {
    const ids = getSchemasInfo().builtins.map((b) => b.id);
    for (const id of [HUGO, JEKYLL, VITEPRESS]) {
      expect(ids).toContain(id);
    }
  });
});

describe("the field sets match what upstream documents", () => {
  const cases: Array<[string, string[]]> = [
    [HUGO, HUGO_FIELDS],
    [JEKYLL, JEKYLL_FIELDS],
    [VITEPRESS, VITEPRESS_FIELDS],
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

describe("composing an SSG schema with an editorial one", () => {
  it("keeps each schema's own errors", async () => {
    // Passes Hugo on every field it names, fails OKF on the missing `type`:
    // the error must be attributed to OKF, not to Hugo.
    const r = await check("hugo-valid.md", [HUGO, "google:okf:0.1"]);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.schema).toBe("google:okf:0.1");
  });
});
