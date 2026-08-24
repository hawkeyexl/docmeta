/**
 * `elements:` config — naming element paths the convention does not reach.
 *
 * The convention deliberately stops short. Generic XML lifts only the root's
 * direct text-bearing children, because guessing which nested element is
 * metadata and which is prose is how a document body turns into a key per
 * paragraph. HTML lifts only text-bearing `<head>` children, so `<link>` and
 * `<base>` — which hold their value in an attribute — are left alone. Config is
 * how a repo says "this one, specifically".
 *
 * Three things about the syntax are decisions rather than accidents:
 *
 *  - **Paths are slash-separated and absolute from the document root.** XML
 *    element names may legally contain dots, so a dotted path cannot be parsed:
 *    `a.b.c` could be `<a.b><c>`, `<a><b.c>` or `<a><b><c>`. `/` cannot appear
 *    in an element name. The key is still derived by the parent-is-the-namespace
 *    rule and is never spelled in config.
 *  - **`@attr` selects an attribute** instead of the element's text, which is
 *    the only way to reach a void element like `<link href=…>`.
 *  - **A config path yields a list**, because a path states no cardinality — the
 *    same reason generic XML defaults to one.
 *
 * Config *extends* the convention rather than overriding it: a path producing a
 * key the convention already filled is a no-op, so adding one cannot silently
 * retype a DITA key that the content model typed exactly.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { xmlExtractor } from "../src/extractors/xml.js";
import { htmlExtractor } from "../src/extractors/html.js";
import { resolveElements } from "../src/core/resolve-schema.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTICLE = readFileSync(
  resolve(root, "test/fixtures/element/article.xml"),
  "utf8",
);

describe("a config path reaches past the convention", () => {
  it("lifts a nested element the convention stops short of", () => {
    const r = xmlExtractor.extract(ARTICLE, "a.xml", {
      elements: ["article/body/p"],
    });
    expect(r.data["body.p"]).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("keys it by its parent, not by the path", () => {
    // The path is a location; the key is derived. Two ways to name one key is
    // the ambiguity the whole design removes.
    const r = xmlExtractor.extract(ARTICLE, "a.xml", {
      elements: ["article/body/p"],
    });
    expect(r.data["article.body.p"]).toBeUndefined();
  });

  it("yields a list even for a single match", () => {
    const r = xmlExtractor.extract(ARTICLE, "a.xml", {
      elements: ["article/title"],
    });
    expect(Array.isArray(r.data["article.title"])).toBe(true);
  });

  it("ignores a path that matches nothing", () => {
    const r = xmlExtractor.extract(ARTICLE, "a.xml", {
      elements: ["article/nonexistent"],
    });
    expect(r.data["article.nonexistent"]).toBeUndefined();
  });

  it("rejects a path with no parent segment", () => {
    // `title` alone names an element with no container, so there is no
    // namespace to build a key from.
    expect(() =>
      xmlExtractor.extract(ARTICLE, "a.xml", { elements: ["title"] }),
    ).toThrow(/at least two segments/i);
  });
});

describe("@attr selects an attribute instead of element text", () => {
  const PAGE = `<html><head><title>Docs</title>
<link rel="canonical" href="https://example.com/a"/>
<base href="https://example.com/"/></head><body></body></html>`;

  it("reaches a void element the convention cannot", () => {
    const r = htmlExtractor.extract(PAGE, "p.html", {
      elements: ["html/head/link@href", "html/head/base@href"],
    });
    expect(r.data["head.link"]).toEqual(["https://example.com/a"]);
    expect(r.data["head.base"]).toEqual(["https://example.com/"]);
  });

  it("works on XML too, which is where DITA needs it", () => {
    const r = xmlExtractor.extract(
      `<doc><stamp when="2026-08-23"/></doc>`,
      "a.xml",
      { elements: ["doc/stamp@when"] },
    );
    expect(r.data["doc.stamp"]).toEqual(["2026-08-23"]);
  });

  it("skips an element that lacks the named attribute", () => {
    const r = xmlExtractor.extract(
      `<doc><stamp/></doc>`,
      "a.xml",
      { elements: ["doc/stamp@when"] },
    );
    expect(r.data["doc.stamp"]).toBeUndefined();
  });
});

describe("a config path lifts an empty element, unlike the convention", () => {
  it("keeps a deliberately empty element as an empty string", () => {
    // The convention skips it, because it has to keep structural elements out
    // of the key set without an ignore list. Someone who names the path wants
    // "present but empty" checked — that is the whole point of naming it.
    const r = xmlExtractor.extract(`<doc><title></title></doc>`, "a.xml", {
      elements: ["doc/title"],
    });
    expect(r.data["doc.title"]).toEqual([""]);
  });
});

describe("config extends the convention rather than overriding it", () => {
  it("leaves a key the convention already filled alone", () => {
    // article.title is already lifted by the convention. Naming it again must
    // not retype or duplicate it.
    const conventionOnly = xmlExtractor.extract(ARTICLE, "a.xml");
    const withConfig = xmlExtractor.extract(ARTICLE, "a.xml", {
      elements: ["article/title"],
    });
    expect(withConfig.data["article.title"]).toEqual(
      conventionOnly.data["article.title"],
    );
  });

  it("does not retype an exactly-typed DITA key", () => {
    // prolog.source is a scalar because the content model says `source?`. A
    // config path yields a list, so overriding here would silently change the
    // type of a key a schema is already written against.
    const dita = readFileSync(
      resolve(root, "test/fixtures/dita/full-prolog.dita"),
      "utf8",
    );
    const r = xmlExtractor.extract(dita, "test/fixtures/dita/full-prolog.dita", {
      elements: ["concept/prolog/source"],
    });
    expect(r.data["prolog.source"]).toBe("Analytical Engine Notes");
  });
});

describe("resolveElements accumulates rather than replacing", () => {
  // Unlike `schemas:`, where the first matching override *replaces* the set
  // because a schema set is a complete statement, `elements:` is a list of
  // extra places to look. Every matching override contributes.
  it("combines the top-level list with every matching override", () => {
    const got = resolveElements("docs/specs/a.xml", {
      elements: ["article/title"],
      overrides: [
        { files: "docs/**", schemas: [], elements: ["article/byline"] },
        { files: "docs/specs/**", schemas: [], elements: ["spec/revision"] },
        { files: "other/**", schemas: [], elements: ["nope/nope"] },
      ],
    });
    expect(got).toEqual(["article/title", "article/byline", "spec/revision"]);
  });

  it("de-duplicates a path named twice", () => {
    const got = resolveElements("a.xml", {
      elements: ["article/title"],
      overrides: [{ files: "**", schemas: [], elements: ["article/title"] }],
    });
    expect(got).toEqual(["article/title"]);
  });

  it("is empty when nothing declares anything", () => {
    expect(resolveElements("a.xml", {})).toEqual([]);
    expect(resolveElements("a.xml", undefined)).toEqual([]);
  });
});
