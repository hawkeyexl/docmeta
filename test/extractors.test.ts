import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { markdownExtractor } from "../src/extractors/markdown.js";
import { mdxExtractor } from "../src/extractors/mdx.js";
import { asciidocExtractor } from "../src/extractors/asciidoc.js";
import { rstExtractor } from "../src/extractors/rst.js";
import { xmlExtractor } from "../src/extractors/xml.js";
import { htmlExtractor } from "../src/extractors/html.js";
import {
  extractorForExtension,
  extractorByName,
  supportedExtensions,
} from "../src/extractors/index.js";
import { createStubExtractor } from "../src/extractors/stub.js";
import { DocmetaError } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const readFixture = (name: string): string =>
  readFileSync(`${here}/fixtures/${name}`, "utf8");

const VALID = `---
type: concept
title: Hello
tags:
  - a
  - b
timestamp: 2026-06-25T10:00:00Z
---

# Body
`;

describe("markdown extractor", () => {
  it("extracts frontmatter data", () => {
    const r = markdownExtractor.extract(VALID, "x.md");
    expect(r.present).toBe(true);
    expect(r.format).toBe("markdown");
    expect(r.data.type).toBe("concept");
    expect(r.data.tags).toEqual(["a", "b"]);
  });

  it("maps top-level keys to source lines", () => {
    const r = markdownExtractor.extract(VALID, "x.md");
    // line 1 is the opening ---, so `type` is line 2
    expect(r.lineFor("/type")).toBe(2);
    expect(r.lineFor("/timestamp")).toBe(7);
  });

  it("maps array items to source lines", () => {
    const r = markdownExtractor.extract(VALID, "x.md");
    expect(r.lineFor("/tags/0")).toBe(5);
    expect(r.lineFor("/tags/1")).toBe(6);
  });

  it("falls back to the block start for the root pointer", () => {
    const r = markdownExtractor.extract(VALID, "x.md");
    expect(r.lineFor("")).toBe(1);
  });

  it("reports absent frontmatter", () => {
    const r = markdownExtractor.extract("# No frontmatter here\n", "x.md");
    expect(r.present).toBe(false);
    expect(r.data).toEqual({});
  });

  it("reports an empty frontmatter block as present with no data", () => {
    const r = markdownExtractor.extract("---\n---\n# Body\n", "x.md");
    expect(r.present).toBe(true);
    expect(r.data).toEqual({});
  });

  it("throws on malformed YAML frontmatter", () => {
    expect(() => markdownExtractor.extract("---\n: : :\n---\n", "x.md")).toThrow();
  });
});

describe("mdx extractor", () => {
  it("reuses frontmatter logic under the mdx format name", () => {
    const r = mdxExtractor.extract(VALID, "x.mdx");
    expect(r.format).toBe("mdx");
    expect(r.data.type).toBe("concept");
  });
});

const ADOC_HEADER = `= My Document Title
:type: concept
:version: 2
:draft:
:!archived:
:tags: a, b

Body text here.
`;

describe("asciidoc extractor", () => {
  it("extracts the title and typed header attributes", () => {
    const r = asciidocExtractor.extract(ADOC_HEADER, "x.adoc");
    expect(r.present).toBe(true);
    expect(r.format).toBe("asciidoc");
    expect(r.data.title).toBe("My Document Title");
    expect(r.data.type).toBe("concept");
    // values are parsed as YAML scalars, so `2` is a number
    expect(r.data.version).toBe(2);
    // a value with no array syntax stays a string
    expect(r.data.tags).toBe("a, b");
  });

  it("treats a valueless attribute as true and a negated one as false", () => {
    const r = asciidocExtractor.extract(ADOC_HEADER, "x.adoc");
    expect(r.data.draft).toBe(true);
    expect(r.data.archived).toBe(false);
  });

  it("maps the title and attributes to source lines", () => {
    const r = asciidocExtractor.extract(ADOC_HEADER, "x.adoc");
    expect(r.lineFor("/title")).toBe(1);
    expect(r.lineFor("/type")).toBe(2);
    expect(r.lineFor("/version")).toBe(3);
    expect(r.lineFor("/tags")).toBe(6);
  });

  it("falls back to the document start for the root pointer", () => {
    const r = asciidocExtractor.extract(ADOC_HEADER, "x.adoc");
    expect(r.lineFor("")).toBe(1);
  });

  it("parses a leading YAML frontmatter block when present", () => {
    const r = asciidocExtractor.extract(VALID, "x.adoc");
    expect(r.present).toBe(true);
    expect(r.format).toBe("asciidoc");
    expect(r.data.type).toBe("concept");
    expect(r.data.tags).toEqual(["a", "b"]);
    expect(r.lineFor("/type")).toBe(2);
  });

  it("supports header attributes with no document title", () => {
    const r = asciidocExtractor.extract(":type: concept\n\nBody\n", "x.adoc");
    expect(r.present).toBe(true);
    expect(r.data.title).toBeUndefined();
    expect(r.data.type).toBe("concept");
    expect(r.lineFor("/type")).toBe(1);
  });

  it("reports absent metadata for a document with no header", () => {
    const r = asciidocExtractor.extract("Just a paragraph.\n\n:x: y\n", "x.adoc");
    expect(r.present).toBe(false);
    expect(r.data).toEqual({});
  });

  it("maps nested pointers to the attribute line via ancestor walk", () => {
    // A YAML-typed array attribute: Ajv may report "/tags/0".
    const r = asciidocExtractor.extract(":type: concept\n:tags: [a, b]\n", "x.adoc");
    expect(r.data.tags).toEqual(["a", "b"]);
    expect(r.lineFor("/tags/0")).toBe(2);
    expect(r.lineFor("/tags")).toBe(2);
  });

  it("falls back to the native header when a frontmatter block is unterminated", () => {
    // Opens with `---` but has no closing delimiter, so it is not frontmatter.
    const r = asciidocExtractor.extract("---\n= Title\n:type: concept\n", "x.adoc");
    expect(r.present).toBe(true);
    expect(r.data.type).toBe("concept");
  });
});

describe("rst extractor", () => {
  it("extracts typed docinfo fields and skips the title", () => {
    const r = rstExtractor.extract(readFixture("valid.rst"), "x.rst");
    expect(r.present).toBe(true);
    expect(r.format).toBe("rst");
    expect(r.data.type).toBe("concept");
    // `title` comes from the `:title:` field, not the page heading
    expect(r.data.title).toBe("Hello");
    // values are parsed as YAML scalars, so `[a, b]` is an array
    expect(r.data.tags).toEqual(["a", "b"]);
    expect(r.data.timestamp).toBe("2026-06-25T10:00:00Z");
  });

  it("maps docinfo fields to source lines past the skipped title", () => {
    const r = rstExtractor.extract(readFixture("valid.rst"), "x.rst");
    expect(r.lineFor("/type")).toBe(4);
    expect(r.lineFor("/title")).toBe(5);
    expect(r.lineFor("/tags")).toBe(6);
    expect(r.lineFor("/timestamp")).toBe(7);
  });

  it("treats a valueless field as true", () => {
    const r = rstExtractor.extract(":draft:\n:type: concept\n", "x.rst");
    expect(r.data.draft).toBe(true);
    expect(r.data.type).toBe("concept");
  });

  it("falls back to the first field line for the root pointer", () => {
    const r = rstExtractor.extract(readFixture("valid.rst"), "x.rst");
    expect(r.lineFor("")).toBe(4);
  });

  it("parses a leading YAML frontmatter block when present", () => {
    const r = rstExtractor.extract(VALID, "x.rst");
    expect(r.present).toBe(true);
    expect(r.format).toBe("rst");
    expect(r.data.type).toBe("concept");
    expect(r.data.tags).toEqual(["a", "b"]);
    expect(r.lineFor("/type")).toBe(2);
  });

  it("supports a docinfo field list with no preceding title", () => {
    const r = rstExtractor.extract(":type: concept\n\nBody\n", "x.rst");
    expect(r.present).toBe(true);
    expect(r.data.type).toBe("concept");
    expect(r.lineFor("/type")).toBe(1);
  });

  it("reports absent metadata for a document with no field list", () => {
    const r = rstExtractor.extract(readFixture("no-frontmatter.rst"), "x.rst");
    expect(r.present).toBe(false);
    expect(r.data).toEqual({});
    // No block present, so positions are unknown — don't annotate at line 1.
    expect(r.lineFor("")).toBeUndefined();
    expect(r.lineFor("/type")).toBeUndefined();
  });

  it("maps nested pointers to the field line via ancestor walk", () => {
    // A YAML-typed array field: Ajv may report "/tags/0".
    const r = rstExtractor.extract(":type: concept\n:tags: [a, b]\n", "x.rst");
    expect(r.data.tags).toEqual(["a", "b"]);
    expect(r.lineFor("/tags/0")).toBe(2);
    expect(r.lineFor("/tags")).toBe(2);
  });
});

const XML_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<document type="concept"
          version="2"
          draft="true"
          title="Hello">
  <body>Text</body>
</document>
`;

describe("xml extractor", () => {
  it("extracts root-element attributes, typed as YAML scalars", () => {
    const r = xmlExtractor.extract(XML_DOC, "x.xml");
    expect(r.present).toBe(true);
    expect(r.format).toBe("xml");
    expect(r.data.type).toBe("concept");
    expect(r.data.title).toBe("Hello");
    // attribute values are parsed as YAML scalars, so `2` is a number
    expect(r.data.version).toBe(2);
    expect(r.data.draft).toBe(true);
  });

  it("maps the root element and each attribute to its source line", () => {
    const r = xmlExtractor.extract(XML_DOC, "x.xml");
    // the root <document> tag opens on line 3 (after the decl and comment)
    expect(r.lineFor("")).toBe(3);
    expect(r.lineFor("/type")).toBe(3);
    expect(r.lineFor("/version")).toBe(4);
    expect(r.lineFor("/draft")).toBe(5);
    expect(r.lineFor("/title")).toBe(6);
  });

  it("falls back to the root line for unknown pointers", () => {
    const r = xmlExtractor.extract(XML_DOC, "x.xml");
    expect(r.lineFor("/missing")).toBe(3);
  });

  it("ignores xmlns namespace declarations", () => {
    const r = xmlExtractor.extract(
      `<doc xmlns="http://example.com/ns" xmlns:x="http://example.com/x" type="ref"/>`,
      "x.xml",
    );
    expect(r.data.type).toBe("ref");
    expect(r.data.xmlns).toBeUndefined();
  });

  it("reports a root element with no attributes as absent", () => {
    const r = xmlExtractor.extract(`<document><body/></document>`, "x.xml");
    expect(r.present).toBe(false);
    expect(r.data).toEqual({});
  });

  it("throws on malformed XML", () => {
    expect(() => xmlExtractor.extract("<a><b></a>", "x.xml")).toThrow();
  });
});

const HTML_DOC = `<!DOCTYPE html>
<html>
  <head>
    <title>Hello</title>
    <meta name="type" content="concept">
    <meta name="version" content="2">
    <meta property="og:title" content="OG Hello">
    <meta charset="utf-8">
  </head>
  <body>Text</body>
</html>
`;

describe("html extractor", () => {
  it("extracts <title> and <meta> name/content pairs", () => {
    const r = htmlExtractor.extract(HTML_DOC, "x.html");
    expect(r.present).toBe(true);
    expect(r.format).toBe("html");
    expect(r.data.title).toBe("Hello");
    expect(r.data.type).toBe("concept");
    // meta content is parsed as a YAML scalar, so `2` is a number
    expect(r.data.version).toBe(2);
  });

  it("reads OpenGraph property= meta tags", () => {
    const r = htmlExtractor.extract(HTML_DOC, "x.html");
    expect(r.data["og:title"]).toBe("OG Hello");
  });

  it("ignores meta tags with neither name nor property (charset, http-equiv)", () => {
    const r = htmlExtractor.extract(HTML_DOC, "x.html");
    expect(Object.keys(r.data)).not.toContain("charset");
    expect(Object.keys(r.data)).not.toContain("utf-8");
  });

  it("maps the title and meta tags to source lines", () => {
    const r = htmlExtractor.extract(HTML_DOC, "x.html");
    expect(r.lineFor("/title")).toBe(4);
    expect(r.lineFor("/type")).toBe(5);
    expect(r.lineFor("/version")).toBe(6);
    expect(r.lineFor("/og:title")).toBe(7);
  });

  it("falls back to the document start for the root pointer", () => {
    const r = htmlExtractor.extract(HTML_DOC, "x.html");
    expect(r.lineFor("")).toBe(1);
    expect(r.lineFor("/missing")).toBe(1);
  });

  it("decodes HTML entities in values", () => {
    const r = htmlExtractor.extract(
      `<meta name="summary" content="A &amp; B">`,
      "x.html",
    );
    expect(r.data.summary).toBe("A & B");
  });

  it("reports a document with no title or meta as absent", () => {
    const r = htmlExtractor.extract(`<html><body>Hi</body></html>`, "x.html");
    expect(r.present).toBe(false);
    expect(r.data).toEqual({});
  });
});

describe("extractor registry", () => {
  it("resolves markdown by extension", () => {
    expect(extractorForExtension(".md")?.name).toBe("markdown");
    expect(extractorForExtension(".MARKDOWN")?.name).toBe("markdown");
    expect(extractorForExtension(".mdx")?.name).toBe("mdx");
  });

  it("resolves asciidoc by extension", () => {
    expect(extractorForExtension(".adoc")?.name).toBe("asciidoc");
    expect(extractorForExtension(".ASCIIDOC")?.name).toBe("asciidoc");
  });

  it("resolves rst by extension", () => {
    expect(extractorForExtension(".rst")?.name).toBe("rst");
    expect(extractorForExtension(".RST")?.name).toBe("rst");
  });

  it("resolves xml by extension", () => {
    expect(extractorForExtension(".xml")?.name).toBe("xml");
    expect(extractorForExtension(".XML")?.name).toBe("xml");
  });

  it("resolves html by extension", () => {
    expect(extractorForExtension(".html")?.name).toBe("html");
    expect(extractorForExtension(".htm")?.name).toBe("html");
    expect(extractorForExtension(".HTML")?.name).toBe("html");
  });

  it("resolves an extractor by --as name", () => {
    expect(extractorByName("markdown")?.name).toBe("markdown");
  });

  it("lists supported (implemented) extensions", () => {
    expect(supportedExtensions()).toContain(".md");
    expect(supportedExtensions()).toContain(".adoc");
    expect(supportedExtensions()).toContain(".rst");
    expect(supportedExtensions()).toContain(".xml");
    expect(supportedExtensions()).toContain(".html");
  });

  it("returns undefined for an unsupported extension", () => {
    expect(extractorForExtension(".txt")).toBeUndefined();
  });

  it("stub extractors throw not-implemented", () => {
    // No registered format is a stub anymore; exercise the factory directly.
    const stub = createStubExtractor("planned", [".planned"], "future format");
    expect(stub.implemented).toBe(false);
    expect(() => stub.extract("x", "x.planned")).toThrow(DocmetaError);
  });
});
