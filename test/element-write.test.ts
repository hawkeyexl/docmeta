/**
 * Writing back to element-derived metadata.
 *
 * Everything here **replaces a span that already exists** — the text between an
 * element's tags, or the value inside an attribute's quotes. That is what makes
 * it safe in a dialect docmeta knows nothing about: neither edit can change
 * whether the document is valid, because neither changes its shape.
 *
 * The rule these tests exist to hold is proposal 0018's: *a write updates the
 * location the effective value was read from*, and its consequence, *asymmetry
 * is a loop*. If `validate` reads `article.title` from an element and `fill`
 * writes it to a root attribute, the field stays invalid, the next run proposes
 * it again, and CI never goes green. The idempotence test below is the direct
 * guard for that, and it is the one worth keeping if any are dropped.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { xmlExtractor } from "../src/extractors/xml.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LF = String.fromCharCode(10);

const apply = (content: string, patch: Record<string, unknown>, filePath = "a.xml") =>
  xmlExtractor.apply?.(content, patch, { filePath }) ?? "";

const ARTICLE = readFileSync(
  resolve(root, "test/fixtures/element/article.xml"),
  "utf8",
);
const DITA = readFileSync(
  join(root, "test/fixtures/dita/full-prolog.dita"),
  "utf8",
);
const DITA_PATH = "test/fixtures/dita/full-prolog.dita";

describe("updating element text in plain XML", () => {
  it("replaces the text and leaves every other byte alone", () => {
    const next = apply(ARTICLE, { "article.title": ["Configure the router"] });
    expect(next).toContain("<title>Configure the router</title>");
    expect(next).toContain("<byline>Ada Lovelace</byline>");
    expect(next).toContain('<article type="reference">');
  });

  it("round-trips through the reader", () => {
    const next = apply(ARTICLE, { "article.title": ["Configure the router"] });
    const r = xmlExtractor.extract(next, "a.xml");
    expect(r.data["article.title"]).toEqual(["Configure the router"]);
  });

  it("escapes markup written into element text", () => {
    const next = apply(ARTICLE, { "article.title": ["a < b & c"] });
    expect(next).toContain("<title>a &lt; b &amp; c</title>");
    const r = xmlExtractor.extract(next, "a.xml");
    expect(r.data["article.title"]).toEqual(["a < b & c"]);
  });

  it("updates a repeated element position by position", () => {
    const doc = `<doc><tag>alpha</tag><tag>beta</tag></doc>`;
    const next = apply(doc, { "doc.tag": ["one", "two"] });
    expect(next).toBe(`<doc><tag>one</tag><tag>two</tag></doc>`);
  });
});

describe("the count rule", () => {
  it("refuses to add an element by writing more values than exist", () => {
    const doc = `<doc><tag>alpha</tag></doc>`;
    expect(() => apply(doc, { "doc.tag": ["one", "two"] })).toThrow(
      /1 element .* 2 values/,
    );
  });

  it("refuses to drop an element by writing fewer", () => {
    const doc = `<doc><tag>alpha</tag><tag>beta</tag></doc>`;
    expect(() => apply(doc, { "doc.tag": ["only"] })).toThrow(
      /2 elements .* 1 value/,
    );
  });

  it("refuses a self-closing element, which has no text span", () => {
    // A config path lifts it as `[""]` — present but empty, which is exactly
    // what naming the path asks to have checked. Writing to it is the problem:
    // turning `<tag/>` into `<tag>x</tag>` is a shape change, so it refuses
    // rather than performing one on the author's behalf.
    const doc = `<doc><tag/></doc>`;
    const read = xmlExtractor.extract(doc, "a.xml", { elements: ["doc/tag"] });
    expect(read.data["doc.tag"]).toEqual([""]);
    expect(() =>
      xmlExtractor.apply?.(doc, { "doc.tag": ["x"] }, {
        filePath: "a.xml",
        elements: ["doc/tag"],
      }),
    ).toThrow(/self-closing/);
  });
});

describe("a dotted key that would collide with an element is not created", () => {
  it("refuses, and says where the value belongs instead", () => {
    // The trap this exists for: a dot is legal in an XML Name, so nothing in
    // the name check stops `article.summary` becoming an attribute — and the
    // moment the document grows an <article><summary>, the reader stops
    // looking at it.
    expect(() => apply(ARTICLE, { "article.summary": "x" })).toThrow(
      /Refusing to create "article\.summary" as an attribute of <article>/,
    );
  });

  it("still creates an ordinary undotted attribute", () => {
    const next = apply(ARTICLE, { status: "draft" });
    expect(next).toContain('status="draft"');
  });

  it("still creates a dotted attribute that cannot collide", () => {
    // The guard is narrow on purpose: only a first segment matching *this*
    // root's name can ever be read from an element instead. `dc.title` on an
    // `<article>` root cannot, so it stays writable exactly as before.
    const next = apply(ARTICLE, { "dc.title": "Gateway" });
    expect(next).toContain('dc.title="Gateway"');
    expect(xmlExtractor.extract(next, "a.xml").data["dc.title"]).toBe("Gateway");
  });
});

describe("updating DITA's typed prolog elements", () => {
  it("replaces element text where the value is text", () => {
    const next = apply(
      DITA,
      { "prolog.author": ["Ada L.", "Charles B."] },
      DITA_PATH,
    );
    expect(next).toContain("<author>Ada L.</author>");
    expect(next).toContain("<author>Charles B.</author>");
  });

  it("replaces an attribute where the value is an attribute", () => {
    const next = apply(DITA, { "critdates.created": "2026-09-01" }, DITA_PATH);
    expect(next).toContain('<created date="2026-09-01"/>');
  });

  it("leaves the othermeta channel untouched when writing the element one", () => {
    // The fixture carries <audience type="programmer"/> and
    // <othermeta name="audience" content="42"/>. They are different keys, so a
    // write to one must not disturb the other.
    const next = apply(DITA, { "metadata.audience": ["writer"] }, DITA_PATH);
    expect(next).toContain('<audience type="writer"/>');
    expect(next).toContain('<othermeta name="audience" content="42"/>');
  });

  it("writes the othermeta channel without disturbing the element one", () => {
    const next = apply(DITA, { audience: "writer" }, DITA_PATH);
    expect(next).toContain('<othermeta name="audience" content="writer"/>');
    expect(next).toContain('<audience type="programmer"/>');
  });

  it("round-trips every shape it writes", () => {
    const patch = {
      "prolog.author": ["Ada L.", "Charles B."],
      "critdates.created": "2026-09-01",
      "prolog.source": "Notes",
      "metadata.category": ["Ref", "Eng"],
    };
    const next = apply(DITA, patch, DITA_PATH);
    const r = xmlExtractor.extract(next, DITA_PATH);
    for (const [key, value] of Object.entries(patch)) {
      expect(r.data[key], key).toEqual(value);
    }
  });
});

describe("idempotence — the loop guard", () => {
  // 0018: "asymmetry is a loop". If a write landed anywhere but where the read
  // takes its value from, the second run would still see the old value and
  // produce another edit. Byte-identical output is the proof that it does not.
  const cases: Array<[string, string, Record<string, unknown>, string]> = [
    ["plain XML text", ARTICLE, { "article.title": ["Once"] }, "a.xml"],
    ["DITA element text", DITA, { "prolog.source": "Notes" }, DITA_PATH],
    ["DITA attribute", DITA, { "critdates.created": "2026-09-01" }, DITA_PATH],
    ["DITA othermeta", DITA, { audience: "writer" }, DITA_PATH],
  ];
  for (const [name, doc, patch, path] of cases) {
    it(`writing ${name} twice changes nothing the second time`, () => {
      const once = apply(doc, patch, path);
      const twice = apply(once, patch, path);
      expect(twice).toBe(once);
    });
  }
});

describe("creating a DITA element that is not there yet", () => {
  const PROLOG_ONLY = readFileSync(
    join(root, "test/fixtures/dita/prolog-no-metadata.dita"),
    "utf8",
  );
  const P_PATH = "test/fixtures/dita/prolog-no-metadata.dita";

  it("adds a child to a container that exists, in content-model order", () => {
    // <prolog> holds only <author>. `source?` follows `author*` in the model,
    // so the new element goes after it, not merely at the end by luck.
    const next = apply(PROLOG_ONLY, { "prolog.source": "Notes" }, P_PATH);
    expect(next).toContain("<source>Notes</source>");
    expect(next.indexOf("<author>")).toBeLessThan(next.indexOf("<source>"));
  });

  it("builds a missing container along with the element inside it", () => {
    const next = apply(PROLOG_ONLY, { "critdates.created": "2026-01-15" }, P_PATH);
    expect(next).toContain("<critdates>");
    expect(next).toContain('<created date="2026-01-15"/>');
    expect(next).toContain("</critdates>");
  });

  it("places a created container where the content model requires", () => {
    // prolog: author*, source?, publisher?, copyright*, critdates?, …
    // so <critdates> must come after <author>, and before a </prolog>.
    const next = apply(PROLOG_ONLY, { "critdates.created": "2026-01-15" }, P_PATH);
    expect(next.indexOf("<author>")).toBeLessThan(next.indexOf("<critdates>"));
    expect(next.indexOf("<critdates>")).toBeLessThan(next.indexOf("</prolog>"));
  });

  it("round-trips what it created", () => {
    const next = apply(PROLOG_ONLY, { "critdates.created": "2026-01-15" }, P_PATH);
    const r = xmlExtractor.extract(next, P_PATH);
    expect(r.data["critdates.created"]).toBe("2026-01-15");
  });

  it("creates it once — writing twice is byte-identical", () => {
    const once = apply(PROLOG_ONLY, { "critdates.created": "2026-01-15" }, P_PATH);
    const twice = apply(once, { "critdates.created": "2026-01-15" }, P_PATH);
    expect(twice).toBe(once);
  });

  it("creates several containers at one anchor without overlapping edits", () => {
    // The regression this exists for. Three new keys resolve to three
    // containers, and all three land at the end of <prolog> — one insertion
    // point, three edits, which `spliceAll` refuses as overlapping. Grouping by
    // container is not enough; they have to be grouped by anchor.
    const next = apply(
      PROLOG_ONLY,
      {
        "critdates.created": "2026-01-15",
        "prolog.source": "Notes",
        "metadata.audience": ["writer"],
      },
      P_PATH,
    );
    // Content-model order among the created siblings, and the right indent:
    // the anchor is </prolog>, which sits a level out from its children.
    expect(next).toContain(
      [
        "    <author>A. Writer</author>",
        "    <source>Notes</source>",
        "    <critdates>",
        '      <created date="2026-01-15"/>',
        "    </critdates>",
        "    <metadata>",
        '      <audience type="writer"/>',
        "    </metadata>",
        "  </prolog>",
      ].join(LF),
    );
  });

  it("still uses othermeta for a key with no place in the content model", () => {
    const next = apply(PROLOG_ONLY, { audience: "writer" }, P_PATH);
    expect(next).toContain('<othermeta name="audience" content="writer"/>');
  });
});
