import { describe, it, expect } from "vitest";
import { markdownExtractor } from "../src/extractors/markdown.js";
import { mdxExtractor } from "../src/extractors/mdx.js";
import {
  extractorForExtension,
  extractorByName,
  supportedExtensions,
} from "../src/extractors/index.js";
import { DocmetaError } from "../src/types.js";

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

describe("extractor registry", () => {
  it("resolves markdown by extension", () => {
    expect(extractorForExtension(".md")?.name).toBe("markdown");
    expect(extractorForExtension(".MARKDOWN")?.name).toBe("markdown");
    expect(extractorForExtension(".mdx")?.name).toBe("mdx");
  });

  it("resolves an extractor by --as name", () => {
    expect(extractorByName("markdown")?.name).toBe("markdown");
  });

  it("lists supported (implemented) extensions", () => {
    expect(supportedExtensions()).toContain(".md");
    expect(supportedExtensions()).not.toContain(".adoc");
  });

  it("returns undefined for an unsupported extension", () => {
    expect(extractorForExtension(".adoc")).toBeUndefined();
  });

  it("stub extractors throw not-implemented", async () => {
    const { asciidocExtractor } = await import(
      "../src/extractors/asciidoc.js"
    );
    expect(asciidocExtractor.implemented).toBe(false);
    expect(() => asciidocExtractor.extract("= Title\n", "x.adoc")).toThrow(
      DocmetaError,
    );
  });
});
