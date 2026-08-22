/**
 * XML write-back tests. `applyXml` is pure — content in, content out — so every
 * case here passes text and nothing on disk is mutated.
 *
 * The CRLF and BOM cases use inline strings rather than fixture files, for the
 * reason recorded in `frontmatter-write.test.ts`: git's `text=auto` normalizes a
 * committed CRLF file and can mangle a BOM, so a fixture would silently stop
 * testing what it claims.
 *
 * The line-index cases matter more here than they look. xmldom reports only
 * where each attribute *starts*, as a line and column measured against a copy of
 * the source with its line endings normalized. Every write is an offset
 * reconstructed from that pair, so a break form counted differently by the
 * parser and by us is not a wrong answer — it is a corrupted document.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { applyXml } from "../src/extractors/xml-write.js";
import { lineStarts, offsetAt } from "../src/extractors/xml-locate.js";
import { xmlExtractor } from "../src/extractors/xml.js";
import { DocmetaError } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string =>
  readFileSync(`${here}/fixtures/${name}`, "utf8");

/** What the reader makes of a document — the only thing a write must agree with. */
const read = (s: string): Record<string, unknown> =>
  xmlExtractor.extract(s, "x.xml").data;

const CR = "\r";
const LF = "\n";
const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const BOM = String.fromCharCode(0xfeff);

describe("xml-locate — the line index", () => {
  // xmldom normalizes all six of these to LF before it counts lines, so the
  // index has to treat all six as breaks or every offset after one is wrong.
  for (const [label, sep] of [
    ["LF", LF],
    ["CRLF", CR + LF],
    ["lone CR", CR],
    ["NEL", NEL],
    ["LINE SEPARATOR", LS],
    ["PARAGRAPH SEPARATOR", PS],
  ] as const) {
    it(`counts ${label} as a line break`, () => {
      const src = `a${sep}b${sep}c`;
      const starts = lineStarts(src);
      expect(starts).toHaveLength(3);
      expect(offsetAt(starts, 2, 1)).toBe(1 + sep.length);
      expect(src[offsetAt(starts, 3, 1)]).toBe("c");
    });
  }

  it("handles mixed break forms in one document", () => {
    const src = `a${CR}${LF}b${LS}c${CR}d`;
    const starts = lineStarts(src);
    expect(src[offsetAt(starts, 4, 1)]).toBe("d");
  });
});

describe("applyXml — no-ops and refusals", () => {
  it("returns the input identically for an empty patch", () => {
    const content = fx("bad-timestamp.xml");
    expect(applyXml(content, {})).toBe(content);
  });

  it("ignores keys explicitly set to undefined", () => {
    const content = fx("bad-timestamp.xml");
    expect(applyXml(content, { type: undefined })).toBe(content);
  });

  it("refuses a DITA document, naming the reason", () => {
    // Root attributes are not where DITA keeps metadata, and adding one the DTD
    // does not declare makes the topic invalid. Handled in a later change.
    expect(() => applyXml(fx("topic.dita"), { audience: "dev" })).toThrow(
      /DITA/,
    );
  });

  it("refuses DITA on an empty patch too, so the pre-flight probe is honest", () => {
    expect(() => applyXml(fx("topic.dita"), {})).toThrow(DocmetaError);
  });

  it("sees the DOCTYPE past a comment that looks like a tag", () => {
    // `<!-- covers <integration> -->` before the DOCTYPE used to end the search
    // window inside the comment, hiding the declaration. A hand-authored topic
    // has no @class or @DITAArchVersion to fall back on, so the file would be
    // taken for plain XML and given a root attribute its DTD does not declare —
    // exactly the write DITA detection exists to prevent.
    const src = [
      "<!-- This topic covers <integration> scenarios. -->",
      '<!DOCTYPE concept PUBLIC "-//OASIS//DTD DITA Concept//EN" "concept.dtd">',
      '<concept id="x"><title>T</title><conbody><p>b</p></conbody></concept>',
    ].join("\n");
    expect(() =>
      applyXml(src, { audience: "dev" }, { filePath: "no-hint" }),
    ).toThrow(/DITA/);
  });

  it("detects DITA by @class, with no DOCTYPE at all", () => {
    // DITA-OT output routinely carries the specialization ancestry in @class
    // and no doctype, so this path stands alone rather than backing up the
    // DOCTYPE check.
    const src = [
      '<concept class="- topic/topic concept/concept " id="c">',
      "  <title>T</title>",
      "  <conbody><p>b</p></conbody>",
      "</concept>",
    ].join("\n");
    expect(() =>
      applyXml(src, { audience: "dev" }, { filePath: "no-hint.xml" }),
    ).toThrow(/DITA/);
  });

  it("detects DITA by DITAArchVersion", () => {
    const src = '<map DITAArchVersion="1.3" id="m"><title>T</title></map>';
    expect(() =>
      applyXml(src, { audience: "dev" }, { filePath: "no-hint.xml" }),
    ).toThrow(/DITA/);
  });

  it("sees a DITA doctype that declares only a SYSTEM identifier", () => {
    // No public identifier to match, which is how DITA written against a local
    // DTD copy looks. Root name and system identifier are each weak alone, so
    // detection requires both.
    const src = [
      '<!DOCTYPE concept SYSTEM "concept.dtd" [',
      '  <!ENTITY nbsp "&#160;">',
      "]>",
      '<concept id="c"><title>T</title><conbody><p>a&nbsp;b</p></conbody></concept>',
    ].join("\n");
    expect(() =>
      applyXml(src, { audience: "dev" }, { filePath: "no-hint.xml" }),
    ).toThrow(/DITA/);
  });

  it("reads past an internal subset full of > characters", () => {
    // `[^>]*` would have stopped at the first `>` inside the subset. Here the
    // public identifier sits before it, so this pins the scan rather than the
    // luck of the ordering.
    const src = [
      '<!DOCTYPE concept PUBLIC "-//OASIS//DTD DITA Concept//EN" "concept.dtd" [',
      '  <!ENTITY nbsp "&#160;">',
      '  <!ENTITY mdash "&#8212;">',
      "]>",
      '<concept id="c"><title>T</title></concept>',
    ].join("\n");
    expect(() =>
      applyXml(src, { audience: "dev" }, { filePath: "no-hint.xml" }),
    ).toThrow(/DITA/);
  });

  it("does not take an ordinary SYSTEM doctype for DITA", () => {
    // The control: a non-DITA root name means the .dtd name alone is not enough.
    const src = '<!DOCTYPE doc SYSTEM "concept.dtd">\n<doc type="concept"/>';
    const out = applyXml(src, { audience: "dev" }, { filePath: "a.xml" });
    expect(out).toContain('audience="dev"');
  });

  it("does not take an unrelated class attribute for DITA", () => {
    // The control for the two above: `class` is an ordinary attribute name.
    const src = '<concept class="something else" id="c"><title>T</title></concept>';
    const out = applyXml(src, { audience: "dev" }, { filePath: "a.xml" });
    expect(out).toContain('audience="dev"');
  });

  it("is not fooled by a comment that merely mentions a DITA DTD", () => {
    const src = [
      "<!-- migrated from //DTD DITA Concept, now plain XML -->",
      '<doc type="concept"/>',
    ].join("\n");
    const out = applyXml(src, { audience: "dev" }, { filePath: "a.xml" });
    expect(out).toContain('audience="dev"');
  });

  it("refuses malformed XML rather than guessing at offsets", () => {
    expect(() => applyXml("<doc><unclosed></doc>", { a: 1 })).toThrow(
      DocmetaError,
    );
  });

  it("refuses a key that cannot be an XML attribute name", () => {
    // A value is escaped on the way in, so any value is writable. A *name* has
    // no escape hatch: `og:title` is an undeclared namespace prefix and the
    // document would stop parsing. docmeta reads OpenGraph-style keys in HTML,
    // so a schema carrying one and an XML target is not a contrived pairing.
    const src = '<doc type="concept"/>';
    expect(() => applyXml(src, { "og:title": "v" })).toThrow(
      /not a valid XML attribute name, or uses a namespace prefix/,
    );
    expect(() => applyXml(src, { "1bad": "v" })).toThrow(DocmetaError);
    expect(() => applyXml(src, { "has space": "v" })).toThrow(DocmetaError);
    // An xmlns: key would rewrite a namespace declaration rather than add data.
    expect(() => applyXml(src, { "xmlns:xsi": "v" })).toThrow(DocmetaError);
  });

  it("still writes a key that is a legal XML name", () => {
    const out = applyXml('<doc type="concept"/>', { "dc.title": "v" });
    expect(read(out)["dc.title"]).toBe("v");
  });

  it("refuses a value that cannot fit on one line", () => {
    const content = fx("bad-timestamp.xml");
    expect(() => applyXml(content, { tags: ["a", "b"] })).toThrow(DocmetaError);
  });
});

describe("applyXml — updating an existing attribute", () => {
  it("replaces the value span and leaves the rest byte-identical", () => {
    const content = fx("bad-timestamp.xml");
    const out = applyXml(content, { timestamp: "2024-03-01T00:00:00Z" });
    expect(read(out).timestamp).toBe("2024-03-01T00:00:00Z");
    expect(out).toBe(
      content.replace('"last Tuesday"', '"2024-03-01T00:00:00Z"'),
    );
  });

  it("preserves single-quoted attribute style", () => {
    const src = "<doc type='concept'/>";
    const out = applyXml(src, { type: "reference" });
    expect(out).toBe("<doc type='reference'/>");
  });

  it("updates an attribute that wrapped onto a later line", () => {
    const content = fx("bad-timestamp.xml");
    const out = applyXml(content, { title: "Fixed" });
    expect(read(out).title).toBe("Fixed");
    expect(out).toBe(content.replace('"Bad Timestamp"', '"Fixed"'));
  });
});

describe("applyXml — inserting a new attribute", () => {
  it("adds the attribute to the root element", () => {
    const src = '<doc type="concept"/>';
    const out = applyXml(src, { audience: "developer" });
    expect(read(out).audience).toBe("developer");
    expect(read(out).type).toBe("concept");
  });

  it("leaves the document body untouched", () => {
    const content = fx("bad-timestamp.xml");
    const out = applyXml(content, { audience: "developer" });
    const marker = "<body>";
    expect(out.slice(out.indexOf(marker))).toBe(
      content.slice(content.indexOf(marker)),
    );
  });

  it("escapes markup characters in a written value", () => {
    const src = '<doc type="concept"/>';
    const out = applyXml(src, { note: 'a & b < c "q"' });
    expect(read(out).note).toBe('a & b < c "q"');
  });
});

describe("applyXml — fidelity", () => {
  it("preserves CRLF throughout", () => {
    const src = `<doc a="1"${CR}${LF}b="2"/>${CR}${LF}`;
    const out = applyXml(src, { c: "3" });
    expect(out.match(/(?<!\r)\n/g)).toBeNull();
    expect(read(out).c).toBe("3");
  });

  it("keeps exactly one BOM, still at offset 0", () => {
    const src = BOM + '<doc a="1"/>';
    const out = applyXml(src, { b: "2" });
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.match(new RegExp(BOM, "g"))).toHaveLength(1);
    expect(read(out).b).toBe("2");
  });

  it("writes correctly after an exotic line break", () => {
    // The break form that would desynchronize a naive LF-only index.
    const src = `<doc a="1"${LS}b="2"/>`;
    const out = applyXml(src, { b: "changed" });
    expect(read(out).b).toBe("changed");
    expect(read(out).a).toBe(1);
  });

  it("keeps an ambiguous scalar a string, because it emits YAML", () => {
    const src = '<doc a="1"/>';
    const out = applyXml(src, { version: "2" });
    expect(read(out).version).toBe("2");
  });

  it("does not disturb an unresolvable entity elsewhere in the document", () => {
    // Re-serializing would turn &nbsp; into &amp;nbsp;. Splicing cannot.
    const src = '<doc a="1"><p>x&nbsp;y</p></doc>';
    const out = applyXml(src, { b: "2" });
    expect(out).toContain("x&nbsp;y");
  });
});

describe("applyXml — the write-to-source invariant", () => {
  const cases: [string, string, string, unknown][] = [
    ["attribute already present", '<doc k="old"/>', "k", "new"],
    ["attribute absent", '<doc other="x"/>', "k", "fresh"],
    ["numeric value", '<doc k="1"/>', "k", 42],
    ["boolean value", '<doc k="no"/>', "k", true],
  ];
  for (const [label, src, key, value] of cases) {
    it(`round-trips through the reader — ${label}`, () => {
      const out = applyXml(src, { [key]: value });
      expect(read(out)[key]).toEqual(value);
    });
  }
});
