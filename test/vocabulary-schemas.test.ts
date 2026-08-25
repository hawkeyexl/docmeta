/**
 * Behavior of the built-in metadata *vocabulary* schemas — Open Graph, Dublin
 * Core, Microsoft Learn and X Cards — exercised through the real validate path.
 *
 * These are editorial rather than platform schemas: they describe an agreement
 * about what a document says about itself, not the front matter one tool will
 * parse. Three of the four demand fields, and for different reasons. Open Graph
 * names four properties as required in the protocol itself; Microsoft Learn
 * names five that its publishing build refuses; X Cards names exactly one,
 * because it is the only card tag with no `og:` fallback to stand in for it.
 * Dublin Core requires nothing at all — the DCMI Recommendation marks no
 * element mandatory — so it is a format check over fifteen optional elements.
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

const OGP = "ogp:article:1.0";
const DCMI = "dcmi:elements:1.1";
const MSLEARN = "microsoft:learn:1.0";
const XCARDS = "x:cards:1.0";

/** Validate one vocabulary fixture against an explicit schema set. */
async function check(fixture: string, cliSchemas: string[]) {
  const { results } = await runValidate({
    inputs: [`test/fixtures/vocabulary/${fixture}`],
    cliSchemas,
    cwd: root,
  });
  const r = results[0];
  if (!r) throw new Error(`no result for ${fixture}`);
  return r;
}

/** The fifteen elements of the Dublin Core Metadata Element Set 1.1. */
const DC_ELEMENTS = [
  "contributor",
  "coverage",
  "creator",
  "date",
  "description",
  "format",
  "identifier",
  "language",
  "publisher",
  "relation",
  "rights",
  "source",
  "subject",
  "title",
  "type",
];

describe("ogp:article:1.0", () => {
  it("accepts a page carrying the four required properties and the article set", async () => {
    const r = await check("og-valid.html", [OGP]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("reads `property=` attributes, not just `name=`", async () => {
    // The whole schema depends on this: Open Graph uses `property`, and an
    // extractor that only read `name` would make every og: key invisible.
    const r = await check("og-valid.html", [OGP]);
    expect(r.ok).toBe(true);
  });

  it("requires og:image, naming the missing property", async () => {
    const r = await check("og-missing-image.html", [OGP]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(OGP);
    expect(r.errors[0]?.message).toContain("og:image");
  });

  it("requires all four basic properties", async () => {
    const schema = (await loadSchema(OGP)) as { required: string[] };
    expect([...schema.required].sort()).toEqual(
      ["og:image", "og:title", "og:type", "og:url"].sort(),
    );
  });

  it("rejects a non-ISO article:published_time", async () => {
    const r = await check("og-bad-time.html", [OGP]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/article:published_time");
  });

  it("rejects a determiner outside the five the protocol lists", async () => {
    const r = await check("og-bad-determiner.html", [OGP]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/og:determiner");
  });

  it("accepts every determiner the protocol lists, including the empty one", async () => {
    for (const value of ["a", "an", "the", '""', "auto"]) {
      const { results } = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent:
          "---\n" +
          '"og:title": T\n"og:type": article\n' +
          '"og:url": https://example.com/\n"og:image": https://example.com/i.png\n' +
          `"og:determiner": ${value}\n---\n`,
        cliSchemas: [OGP],
        cwd: root,
      });
      expect(results[0]?.ok, `og:determiner: ${value}`).toBe(true);
    }
  });
});

describe("dcmi:elements:1.1", () => {
  it("accepts a document carrying every element", async () => {
    const r = await check("dcmi-valid.md", [DCMI]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects a date that is not W3CDTF", async () => {
    const r = await check("dcmi-bad-date.md", [DCMI]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(DCMI);
    expect(r.errors[0]?.instancePath).toBe("/date");
  });

  it("accepts the reduced W3CDTF precisions the profile allows", async () => {
    for (const value of ["2026", "2026-08", "2026-08-23", "2026-08-23T09:00:00Z"]) {
      const { results } = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent: `---\ndate: "${value}"\n---\n`,
        cliSchemas: [DCMI],
        cwd: root,
      });
      expect(results[0]?.ok, `date: ${value}`).toBe(true);
    }
  });

  it("carries exactly the fifteen elements and nothing more", async () => {
    const schema = (await loadSchema(DCMI)) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(
      [...DC_ELEMENTS].sort(),
    );
  });

  it("requires nothing, because DCMI marks no element mandatory", async () => {
    const schema = (await loadSchema(DCMI)) as { required?: string[] };
    expect(schema.required).toBeUndefined();
  });

  it("does not enum `type`, because the DCMI Type Vocabulary is a recommendation", async () => {
    // DCMI says "recommended best practice is to use a controlled vocabulary
    // such as the DCMI Type Vocabulary". Enumerating it would reject the
    // conforming documents that use a different one.
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntype: Annual report\n---\n",
      cliSchemas: [DCMI],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
  });

  it("accepts an element repeated as a list, as the element set allows", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ncreator:\n  - A\n  - B\n---\n",
      cliSchemas: [DCMI],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
  });
});

describe("microsoft:learn:1.0", () => {
  it("accepts an article carrying the five required attributes", async () => {
    const r = await check("mslearn-valid.md", [MSLEARN]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("requires all five, reporting each missing one", async () => {
    const r = await check("mslearn-missing-required.md", [MSLEARN]);
    expect(r.ok).toBe(false);
    const messages = r.errors.map((e) => e.message).join(" ");
    for (const field of ["description", "author", "ms.author", "ms.date"]) {
      expect(messages, field).toContain(field);
    }
  });

  it("enforces the documented 75-character description floor", async () => {
    const r = await check("mslearn-short-description.md", [MSLEARN]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(MSLEARN);
    expect(r.errors[0]?.instancePath).toBe("/description");
  });

  it("rejects an ISO ms.date, because Microsoft Learn specifies MM/DD/YYYY", async () => {
    // The trap this exists for: `2026-08-23` is the correct spelling almost
    // everywhere else, and it is wrong here.
    const r = await check("mslearn-bad-date.md", [MSLEARN]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/ms.date");
  });

  it("does not enum ms.topic, whose authoritative list is not public", async () => {
    // The docfx-era set and what Azure repos actually use disagree, and the
    // real taxonomy is internal to Microsoft. A guessed enum would fail valid
    // articles, so this checks shape only.
    for (const topic of ["how-to", "conceptual", "quickstart", "language-reference"]) {
      const { results } = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent:
          "---\ntitle: T\n" +
          "description: Learn how to configure diagnostic settings so that platform logs reach a workspace.\n" +
          `author: a\nms.author: b\nms.date: 08/23/2026\nms.topic: ${topic}\n---\n`,
        cliSchemas: [MSLEARN],
        cwd: root,
      });
      expect(results[0]?.ok, `ms.topic: ${topic}`).toBe(true);
    }
  });
});

describe("x:cards:1.0", () => {
  it("accepts a summary_large_image card", async () => {
    const r = await check("x-card-valid.html", [XCARDS]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fails a page with card tags but no twitter:card", async () => {
    // The one tag with no `og:` fallback. Without it X picks no card type at
    // all, so the other three tags do nothing — which is exactly the state
    // this fixture is in and nothing else would report.
    const r = await check("x-card-missing-card.html", [XCARDS]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toBe(
      "must have required property 'twitter:card'",
    );
  });

  it("fails an image served over plain HTTP", async () => {
    const r = await check("x-card-http-image.html", [XCARDS]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/twitter:image");
  });

  it("fails an email address written into a handle field", async () => {
    const r = await check("x-card-bad-handle.html", [XCARDS]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/twitter:site");
  });

  it("requires the player tags once the card type is player", async () => {
    const r = await check("x-card-player-incomplete.html", [XCARDS]);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.message)).toContain(
      "must have required property 'twitter:player'",
    );
  });

  it("does not demand the player tags of any other card type", async () => {
    // The conditional keys off `player` alone, so a summary card carrying no
    // player tags is complete rather than half-written.
    const r = await check("x-card-valid.html", [XCARDS]);
    expect(r.ok).toBe(true);
  });

  it("requires only twitter:card, because the rest fall back to og:", async () => {
    const schema = (await loadSchema(XCARDS)) as { required?: string[] };
    expect(schema.required).toEqual(["twitter:card"]);
  });

  it("reads dimensions from HTML, where every attribute is a string", async () => {
    // `twitter:player:width` is typed for both channels: an HTML `content=`
    // attribute is always a string, while front matter can carry a number.
    // Typing it `integer` alone would fail every real HTML page.
    const { results } = await runValidate({
      inputs: ["-"],
      as: "html",
      stdinContent:
        '<!doctype html><html><head><title>T</title>\n' +
        '<meta name="twitter:card" content="player" />\n' +
        '<meta name="twitter:title" content="T" />\n' +
        '<meta name="twitter:image" content="https://example.com/p.png" />\n' +
        '<meta name="twitter:player" content="https://example.com/embed" />\n' +
        '<meta name="twitter:player:width" content="640" />\n' +
        '<meta name="twitter:player:height" content="360" />\n' +
        "</head><body></body></html>\n",
      cliSchemas: [XCARDS],
      cwd: root,
    });
    expect(results[0]?.errors).toEqual([]);
    expect(results[0]?.ok).toBe(true);
  });
});

describe("the vocabulary schemas are opt-in", () => {
  for (const id of [OGP, DCMI, MSLEARN, XCARDS]) {
    it(`${id} is not in the default set`, () => {
      expect(DEFAULT_SCHEMAS).not.toContain(id);
    });
  }

  it("all four are listed by the schemas command", () => {
    const ids = getSchemasInfo().builtins.map((b) => b.id);
    for (const id of [OGP, DCMI, MSLEARN, XCARDS]) expect(ids).toContain(id);
  });

  it("all four tolerate unknown keys", async () => {
    for (const id of [OGP, DCMI, MSLEARN, XCARDS]) {
      const schema = (await loadSchema(id)) as {
        additionalProperties?: boolean;
      };
      expect(schema.additionalProperties, id).toBe(true);
    }
  });
});

describe("composing a vocabulary schema with the default set", () => {
  it("keeps Dublin Core and OKF from fighting over `title`", async () => {
    // Both name `title` as an optional string, so a document carrying one
    // satisfies both rather than tripping either.
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntype: concept\ntitle: Shared\n---\n",
      cliSchemas: ["google:okf:0.1", DCMI],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.schemas).toEqual(["google:okf:0.1", DCMI]);
  });
});
