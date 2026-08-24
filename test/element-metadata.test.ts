/**
 * Element-derived metadata: the general pattern by which XML and HTML documents
 * expose values that live in *elements* rather than in attributes or `<meta>`.
 *
 * The rule is that **the containing element is the namespace**: a lifted key is
 * `<immediate parent>.<element name>`. That keeps every existing flat key
 * exactly where it is — root attributes, `<meta>`, `<othermeta>`, `<title>` —
 * while giving element values a name of their own, so both channels are
 * validated and neither silently discards the other.
 *
 * Two conventions in here are worth stating because they are choices, not
 * consequences:
 *
 *  - **Empty elements are not lifted by convention.** An element with no
 *    non-whitespace text and no designated attribute yields nothing, which is
 *    what keeps `<body/>` and other structural elements out of the key set
 *    without a hardcoded ignore list. A path named explicitly in `elements:`
 *    config *is* lifted even when empty, because "present but empty" is
 *    precisely what someone naming it wants checked.
 *
 *  - **Generic XML lifts arrays, always.** Plain XML carries no cardinality
 *    information, so docmeta cannot know whether a second `<tag>` is coming.
 *    A type that changed with document content would be unwritable against, so
 *    the convention commits to a list and lets a schema say `maxItems: 1` when
 *    one is what it means. DITA is different, and typed element by element,
 *    because its content model states the cardinality outright.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { xmlExtractor } from "../src/extractors/xml.js";
import { htmlExtractor } from "../src/extractors/html.js";
import { runGet } from "../src/commands/get.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The fixture both halves of this file exercise, so they cannot drift apart. */
const ARTICLE_PATH = "test/fixtures/element/article.xml";
const ARTICLE = readFileSync(resolve(root, ARTICLE_PATH), "utf8");

describe("generic XML lifts the root's text-bearing children", () => {
  it("keys each one by its parent element", () => {
    const r = xmlExtractor.extract(ARTICLE, "a.xml");
    expect(r.data["article.title"]).toEqual(["Configure the gateway"]);
    expect(r.data["article.byline"]).toEqual(["Ada Lovelace"]);
  });

  it("leaves root attributes flat, exactly as before", () => {
    const r = xmlExtractor.extract(ARTICLE, "a.xml");
    expect(r.data.type).toBe("reference");
  });

  it("types values as YAML scalars, as attributes already are", () => {
    const r = xmlExtractor.extract(ARTICLE, "a.xml");
    expect(r.data["article.version"]).toEqual([2]);
  });

  it("does not lift a container, or descend into one", () => {
    // <body> has element children, so it is structure rather than a value.
    // Generic XML has no content model to say otherwise, so the convention
    // stops at the root's children — reaching <p> needs an `elements:` path.
    const r = xmlExtractor.extract(ARTICLE, "a.xml");
    expect(r.data["article.body"]).toBeUndefined();
    expect(r.data["body.p"]).toBeUndefined();
  });

  it("lifts every occurrence, so a repeated element loses nothing", () => {
    const r = xmlExtractor.extract(
      `<doc><tag>alpha</tag><tag>beta</tag></doc>`,
      "a.xml",
    );
    expect(r.data["doc.tag"]).toEqual(["alpha", "beta"]);
  });

  it("is an array even when the element occurs once", () => {
    // The point of the previous test: the type does not change with the
    // document. A schema written against one file works on all of them.
    const r = xmlExtractor.extract(`<doc><tag>only</tag></doc>`, "a.xml");
    expect(Array.isArray(r.data["doc.tag"])).toBe(true);
  });
});

describe("what the convention declines to lift", () => {
  it("skips an element with no text and no attributes", () => {
    const r = xmlExtractor.extract(`<document><body/></document>`, "a.xml");
    expect(r.data).toEqual({});
    expect(r.present).toBe(false);
  });

  it("skips an element holding only whitespace", () => {
    const r = xmlExtractor.extract(`<doc><title>   </title></doc>`, "a.xml");
    expect(r.data["doc.title"]).toBeUndefined();
  });

  it("still reports a document as present when only elements carried metadata", () => {
    const r = xmlExtractor.extract(`<doc><title>Set up</title></doc>`, "a.xml");
    expect(r.present).toBe(true);
  });
});

describe("positions point at the element, not the root", () => {
  it("maps a lifted key to the line its element opens on", () => {
    const r = xmlExtractor.extract(ARTICLE, "a.xml");
    // <article> opens line 2, <title> line 3, <byline> line 4.
    expect(r.lineFor("/article.title")).toBe(3);
    expect(r.lineFor("/article.byline")).toBe(4);
  });

  it("maps a lifted key to its element's column", () => {
    const r = xmlExtractor.extract(ARTICLE, "a.xml");
    // Both are indented two spaces, so the `<` sits at column 3.
    expect(r.colFor?.("/article.title")).toBe(3);
  });
});

describe("the dotted key survives the JSON Pointer round trip", () => {
  it("resolves a pointer whose single segment contains dots", () => {
    // RFC 6901 escapes `~` and `/` only, so a dot needs no handling — the
    // same reason `/ms.date` already works in microsoft:learn:1.0.
    const r = xmlExtractor.extract(ARTICLE, "a.xml");
    expect(r.lineFor("/article.title")).toBe(3);
    expect(r.lineFor("article.title")).toBe(3);
  });
});

describe("HTML lifts the text-bearing children of `<head>`", () => {
  const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>Validate metadata in CI</title>
    <meta name="description" content="Fail the build when frontmatter is missing." />
    <link rel="canonical" href="https://example.com/ci" />
    <base href="https://example.com/" />
    <style>body { color: red }</style>
    <script>console.log("hi")</script>
  </head>
  <body></body>
</html>`;

  it("keeps the flat `title` exactly as it was", () => {
    // The whole point of lifting alongside rather than instead: every schema
    // naming `title` behaves identically to before this existed.
    const r = htmlExtractor.extract(PAGE, "p.html");
    expect(r.data.title).toBe("Validate metadata in CI");
  });

  it("adds `head.title` beside it", () => {
    const r = htmlExtractor.extract(PAGE, "p.html");
    expect(r.data["head.title"]).toBe("Validate metadata in CI");
  });

  it("makes `head.title` a scalar, because HTML permits exactly one", () => {
    // Unlike generic XML, HTML has a content model. Where it states the
    // cardinality, the key follows it rather than defaulting to a list.
    const r = htmlExtractor.extract(PAGE, "p.html");
    expect(Array.isArray(r.data["head.title"])).toBe(false);
  });

  it("does not lift `<script>` or `<style>`", () => {
    // Both are text-bearing and neither is metadata. Lifting them would put a
    // stylesheet and a line of JavaScript into the key set of every page.
    const r = htmlExtractor.extract(PAGE, "p.html");
    expect(r.data["head.style"]).toBeUndefined();
    expect(r.data["head.script"]).toBeUndefined();
  });

  it("does not lift void elements, which carry no text", () => {
    // `<link>` and `<base>` hold their value in an attribute. Lifting `<link>`
    // by `href` would collapse a canonical URL and three stylesheets into one
    // list and discard the `rel` that told them apart, so the convention
    // declines and an `elements:` path with `@href` addresses them instead.
    const r = htmlExtractor.extract(PAGE, "p.html");
    expect(r.data["head.link"]).toBeUndefined();
    expect(r.data["head.base"]).toBeUndefined();
    expect(r.data["head.meta"]).toBeUndefined();
  });

  it("leaves `<meta>` keys flat", () => {
    const r = htmlExtractor.extract(PAGE, "p.html");
    expect(r.data.description).toBe(
      "Fail the build when frontmatter is missing.",
    );
  });

  it("maps `head.title` to the line its element opens on", () => {
    const r = htmlExtractor.extract(PAGE, "p.html");
    expect(r.lineFor("/head.title")).toBe(4);
  });

  it("ignores a `<title>` outside `<head>`", () => {
    // An SVG `<title>` in the body is a label on a graphic, not page metadata.
    const r = htmlExtractor.extract(
      `<html><head><title>Real</title></head><body><svg><title>Icon</title></svg></body></html>`,
      "p.html",
    );
    expect(r.data["head.title"]).toBe("Real");
  });

  it("lifts nothing from a document with no head", () => {
    const r = htmlExtractor.extract(`<html><body><p>Hi</p></body></html>`, "p.html");
    expect(r.data["head.title"]).toBeUndefined();
  });

  it("moves `head.title` when a write updates `title`, because they share an element", () => {
    // Two keys, one `<title>`. Writing either necessarily moves the other, and
    // `applyHtml` re-reads to confirm the page says what it should — so before
    // that check learned about co-derived keys, every `<title>` write was
    // refused with "did not read back as expected". Pinned here because the
    // failure is a refusal at write time, far from the reader that caused it.
    const page = `<html><head><title>Old</title></head><body></body></html>`;
    const next = htmlExtractor.apply?.(page, { title: "New" }, {}) ?? "";
    expect(next).toContain("<title>New</title>");

    const r = htmlExtractor.extract(next, "p.html");
    expect(r.data.title).toBe("New");
    expect(r.data["head.title"]).toBe("New");
  });
});

describe("`get` can address a lifted key", () => {
  // `resolveField` reads a dotted reference as nested traversal, which is right
  // for frontmatter objects and wrong for a key that literally contains a dot.
  // Before the fallback, `get article.title` returned *empty* rather than an
  // error — a silent wrong answer, and one every lifted key would hit.
  const file = ARTICLE_PATH;

  it("resolves the natural dotted spelling", async () => {
    const results = await runGet({
      inputs: [file],
      fields: ["article.title"],
      cwd: root,
    });
    expect(results[0]?.values["article.title"]).toEqual([
      "Configure the gateway",
    ]);
  });

  it("still resolves the JSON Pointer spelling", async () => {
    const results = await runGet({
      inputs: [file],
      fields: ["/article.title"],
      cwd: root,
    });
    expect(results[0]?.values["/article.title"]).toEqual([
      "Configure the gateway",
    ]);
  });

  it("keeps nested traversal winning where it actually resolves", async () => {
    // The fallback must not change an answer that already worked: a document
    // with a genuine `a: { b: … }` object still resolves `a.b` by descent.
    const results = await runGet({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\nauthor:\n  name: Ada\n---\n",
      fields: ["author.name"],
      cwd: root,
    });
    expect(results[0]?.values["author.name"]).toBe("Ada");
  });
});

describe("writing an element-derived key in HTML", () => {
  // The reference page promises that *updating* an element works "in any
  // dialect", because replacing a span changes content and not shape. HTML was
  // refusing every element-derived key, which made that claim false.
  const page = `<html><head><title>Old</title>
<link rel="canonical" href="https://example.com/a"/></head><body></body></html>`;
  const write = (patch: Record<string, unknown>, elements?: string[]) =>
    htmlExtractor.apply?.(page, patch, elements ? { elements } : {}) ?? "";

  it("updates head.title, the key the convention lifts", () => {
    const next = write({ "head.title": "New" });
    expect(next).toContain("<title>New</title>");
    expect(htmlExtractor.extract(next, "p.html").data["head.title"]).toBe("New");
  });

  it("updates an attribute a config path reached", () => {
    const elements = ["html/head/link@href"];
    const next = write({ "head.link": ["https://example.com/b"] }, elements);
    expect(next).toContain('href="https://example.com/b"');
    const r = htmlExtractor.extract(next, "p.html", { elements });
    expect(r.data["head.link"]).toEqual(["https://example.com/b"]);
  });

  it("escapes markup, sharing one rule with the XML side", () => {
    expect(write({ "head.title": "a < b & c" })).toContain(
      "<title>a &lt; b &amp; c</title>",
    );
  });

  it("holds to the same count rule as XML", () => {
    const elements = ["html/head/link@href"];
    expect(() => write({ "head.link": ["a", "b"] }, elements)).toThrow(
      /1 element .* 2 values/,
    );
  });

  it("is idempotent, so fill cannot loop on it", () => {
    const once = write({ "head.title": "New" });
    const twice = htmlExtractor.apply?.(once, { "head.title": "New" }, {}) ?? "";
    expect(twice).toBe(once);
  });
});

describe("table lookups do not answer from the prototype chain", () => {
  // A document supplies these names, and `Object.prototype` answers to plenty
  // of them. `get.ts` already guards the same way where a *field* name indexes
  // an object; the element tables index by element name, which is worse — the
  // document controls it directly.
  it("does not treat a <constructor> element as a known DITA container", () => {
    const topic = `<?xml version="1.0"?>
<!DOCTYPE concept PUBLIC "-//OASIS//DTD DITA Concept//EN" "concept.dtd">
<concept id="p"><title>T</title><prolog><constructor><name>x</name></constructor></prolog></concept>`;
    const r = xmlExtractor.extract(topic, "p.dita");
    // `DITA_LIFTS.constructor` is Object's constructor and `.name` is "Object";
    // an unguarded lookup finds both and lifts a key that does not exist.
    expect(r.data["constructor.name"]).toBeUndefined();
  });

  it("does not descend into a <toString> element", () => {
    const topic = `<?xml version="1.0"?>
<!DOCTYPE concept PUBLIC "-//OASIS//DTD DITA Concept//EN" "concept.dtd">
<concept id="p"><title>T</title><prolog><toString><author>Ada</author></toString></prolog></concept>`;
    const r = xmlExtractor.extract(topic, "p.dita");
    // `DITA_CONTENT_MODEL.toString` is a function, so an unguarded `!== undefined`
    // makes it a container and lifts the <author> inside as `tostring.author`.
    expect(r.data["tostring.author"]).toBeUndefined();
    expect(r.data["prolog.author"]).toBeUndefined();
  });
});
