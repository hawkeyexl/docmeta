/**
 * HTML write-back tests. `applyHtml` is pure — content in, content out — so
 * every case here passes fixture *text* and nothing on disk is mutated.
 *
 * The CRLF and BOM cases use inline strings rather than fixture files, for the
 * reason recorded in `frontmatter-write.test.ts`: git's `text=auto` normalizes a
 * committed CRLF file and can mangle a BOM, so a fixture would silently stop
 * testing what it claims.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { applyHtml } from "../src/extractors/html-write.js";
import { htmlExtractor } from "../src/extractors/html.js";
import { DocmetaError } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string =>
  readFileSync(`${here}/fixtures/fill/${name}`, "utf8");

/** What the reader makes of a document — the only thing a write must agree with. */
const read = (s: string): Record<string, unknown> =>
  htmlExtractor.extract(s, "x.html").data;

describe("applyHtml — no-ops and refusals", () => {
  it("returns the input identically for an empty patch", () => {
    const content = fx("head-with-meta.html");
    expect(applyHtml(content, {})).toBe(content);
  });

  it("ignores keys explicitly set to undefined", () => {
    const content = fx("head-with-meta.html");
    expect(applyHtml(content, { type: undefined })).toBe(content);
  });

  it("refuses a document whose <head> is implied rather than present", () => {
    expect(() => applyHtml(fx("no-head.html"), { type: "concept" })).toThrow(
      DocmetaError,
    );
  });

  it("refuses on an empty patch too, so fill's pre-flight probe is honest", () => {
    // fill.ts probes with {} before paying for inference; a false all-clear
    // there means the call is billed for a file that could never be written.
    expect(() => applyHtml(fx("no-head.html"), {})).toThrow(DocmetaError);
  });
});

describe("applyHtml — updating an existing value", () => {
  it("replaces a meta tag's content and leaves the rest byte-identical", () => {
    const content = fx("head-with-meta.html");
    const out = applyHtml(content, { type: "reference" });
    expect(read(out).type).toBe("reference");
    // Everything except the one value span is untouched.
    expect(out).toBe(content.replace('content="concept"', 'content="reference"'));
  });

  it("preserves single-quoted attribute style", () => {
    const src = "<html><head><meta name='type' content='concept'></head></html>";
    const out = applyHtml(src, { type: "reference" });
    expect(out).toContain("content='reference'");
    expect(read(out).type).toBe("reference");
  });

  it("quotes an unquoted attribute when the new value needs it", () => {
    // `content=hello world` would tokenize as content="hello" plus a boolean
    // `world` attribute, so replacing an unquoted value has to supply quotes.
    const src = "<html><head><meta name=type content=concept></head></html>";
    const out = applyHtml(src, { type: "hello world" });
    expect(read(out).type).toBe("hello world");
    expect(out).toContain('content="hello world"');
  });

  it("leaves a simple unquoted replacement readable", () => {
    const src = "<html><head><meta name=type content=concept></head></html>";
    expect(read(applyHtml(src, { type: "reference" })).type).toBe("reference");
  });

  it("writes title into the meta tag when one exists, not into <title>", () => {
    // The reader's precedence: a <meta name="title"> beats <title>, in either
    // order. Writing to <title> here would be silently ignored on read.
    const content = fx("title-and-meta.html");
    const out = applyHtml(content, { title: "Chosen" });
    expect(read(out).title).toBe("Chosen");
    expect(out).toContain("<title>From the title element</title>");
  });

  it("falls back to the <title> text when the key has no meta tag", () => {
    const src = "<html><head><title>Old</title></head></html>";
    const out = applyHtml(src, { title: "New" });
    expect(out).toContain("<title>New</title>");
    expect(read(out).title).toBe("New");
  });
});

describe("applyHtml — inserting a new value", () => {
  it("inserts a meta tag after <head>, matching the existing indentation", () => {
    const content = fx("head-with-meta.html");
    const out = applyHtml(content, { audience: "developer" });
    expect(read(out).audience).toBe("developer");
    expect(out).toContain('    <meta name="audience" content="developer">');
    // The body is untouched.
    expect(out.slice(out.indexOf("<body>"))).toBe(
      content.slice(content.indexOf("<body>")),
    );
  });

  it("escapes markup characters in a written value", () => {
    const src = '<html><head><meta name="type" content="a"></head></html>';
    const out = applyHtml(src, { type: 'x & y < z "q"' });
    expect(out).not.toContain('content="x & y < z "q""');
    expect(read(out).type).toBe('x & y < z "q"');
  });
});

describe("applyHtml — fidelity", () => {
  it("preserves CRLF throughout", () => {
    const src =
      '<html>\r\n<head>\r\n<meta name="type" content="concept">\r\n</head>\r\n</html>\r\n';
    const out = applyHtml(src, { audience: "developer" });
    expect(out.match(/(?<!\r)\n/g)).toBeNull();
    expect(read(out).audience).toBe("developer");
  });

  it("keeps exactly one BOM, still at offset 0", () => {
    const src =
      '\uFEFF<html><head><meta name="type" content="concept"></head></html>';
    const out = applyHtml(src, { audience: "developer" });
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.match(/\uFEFF/g)).toHaveLength(1);
    expect(read(out).audience).toBe("developer");
  });

  it("keeps an ambiguous scalar a string, because it emits YAML", () => {
    // Attribute values are read back as YAML scalars, so a bare 2 would return
    // as a number. Emitting YAML too means the quoting survives the round trip.
    const src = '<html><head><meta name="type" content="a"></head></html>';
    const out = applyHtml(src, { version: "2" });
    expect(read(out).version).toBe("2");
  });

  it("refuses a value that cannot fit on one line", () => {
    // An array or a multi-line string emits as block YAML, which an attribute
    // cannot carry. Refusing beats truncating.
    const src = '<html><head><meta name="type" content="a"></head></html>';
    expect(() => applyHtml(src, { tags: ["a", "b"] })).toThrow(DocmetaError);
  });
});

describe("applyHtml — the write-to-source invariant", () => {
  // The one property that catches the whole failure class: whatever the writer
  // does, the reader must see the value afterwards. A write aimed at a tag the
  // reader ignores fails here and nowhere else.
  const cases: [string, string, string, unknown][] = [
    [
      "key already in a meta tag",
      '<html><head><meta name="k" content="old"></head></html>',
      "k",
      "new",
    ],
    [
      "key absent entirely",
      "<html><head><title>T</title></head></html>",
      "k",
      "fresh",
    ],
    [
      "title carried by a meta tag that outranks <title>",
      '<html><head><title>A</title><meta name="title" content="B"></head></html>',
      "title",
      "C",
    ],
    [
      "title carried only by <title>",
      "<html><head><title>A</title></head></html>",
      "title",
      "C",
    ],
  ];
  for (const [label, src, key, value] of cases) {
    it(`round-trips through the reader — ${label}`, () => {
      const out = applyHtml(src, { [key]: value });
      expect(read(out)[key]).toEqual(value);
    });
  }
});
