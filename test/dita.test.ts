/**
 * DITA read and write.
 *
 * DITA keeps document metadata in `<prolog><metadata><othermeta/></metadata></prolog>`
 * for topics and in `<topicmeta>` for maps — not on the root element, where the
 * generic XML reader looks. Reading `<othermeta>` and writing it are one change
 * on purpose: a write the reader cannot see leaves the field missing, so
 * `validate` still fails and the next `fill` proposes it again.
 *
 * The write cases below are ordered by the rule the whole feature turns on — a
 * write lands wherever the read took its value from — and only a key absent from
 * every channel gets to choose a location.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { xmlExtractor } from "../src/extractors/xml.js";
import { DocmetaError } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string =>
  readFileSync(`${here}/fixtures/dita/${name}`, "utf8");

const read = (s: string, path = "t.dita"): Record<string, unknown> =>
  xmlExtractor.extract(s, path).data;
const write = (
  s: string,
  patch: Record<string, unknown>,
  path = "t.dita",
): string => {
  const apply = xmlExtractor.apply;
  if (!apply) throw new Error("xml extractor should be writable");
  return apply(s, patch, { filePath: path });
};

describe("DITA — reading prolog metadata", () => {
  it("reads othermeta alongside the root attributes", () => {
    const data = read(fx("with-othermeta.dita"));
    expect(data.id).toBe("has-othermeta"); // root attribute
    expect(data.audience).toBe("developer"); // othermeta
    expect(data.timestamp).toBe("last Tuesday");
  });

  it("reads a map's topicmeta", () => {
    const src = fx("map.ditamap").replace(
      "  <topicref",
      '  <topicmeta><othermeta name="audience" content="admin"/></topicmeta>\n  <topicref',
    );
    expect(read(src, "m.ditamap").audience).toBe("admin");
  });

  it("parses othermeta values as YAML scalars, like every other native path", () => {
    const src = fx("with-othermeta.dita").replace(
      'content="developer"',
      'content="2"',
    );
    expect(read(src).audience).toBe(2);
  });

  it("leaves plain XML alone — no prolog hunting", () => {
    const src = '<doc type="concept"><prolog><metadata/></prolog></doc>';
    expect(read(src, "x.xml")).toEqual({ type: "concept" });
  });

  it("lets othermeta win over a root attribute of the same name", () => {
    const src = fx("with-othermeta.dita").replace(
      'name="audience" content="developer"',
      'name="type" content="reference"',
    );
    // The root element also carries type="concept".
    expect(read(src).type).toBe("reference");
  });
});

describe("DITA — writing to the source of the value", () => {
  it("updates an existing othermeta in place", () => {
    const content = fx("with-othermeta.dita");
    const out = write(content, { timestamp: "2024-03-01T00:00:00Z" });
    expect(read(out).timestamp).toBe("2024-03-01T00:00:00Z");
    expect(out).toBe(content.replace('"last Tuesday"', '"2024-03-01T00:00:00Z"'));
  });

  it("corrects a root attribute in its own tag, not by adding an othermeta", () => {
    // Adding an othermeta beside a stale root attribute would read green while
    // the attribute a DITA toolchain honors still said the wrong thing. It is
    // also the only write that cannot affect DTD validity: the attribute is
    // already declared, because it is already there.
    const content = fx("with-othermeta.dita");
    const out = write(content, { id: "renamed" });
    expect(read(out).id).toBe("renamed");
    expect(out).toBe(content.replace('"has-othermeta"', '"renamed"'));
    expect(out).not.toContain('name="id"');
  });

  it("adds an othermeta to an existing metadata element", () => {
    const content = fx("with-othermeta.dita");
    const out = write(content, { description: "A summary." });
    expect(read(out).description).toBe("A summary.");
    expect(out).toContain('<othermeta name="description" content="A summary."/>');
    // The existing entries are untouched.
    expect(out).toContain('<othermeta name="audience" content="developer"/>');
  });
});

describe("DITA — creating the containers it needs", () => {
  it("creates <metadata> inside an existing <prolog>", () => {
    const content = fx("prolog-no-metadata.dita");
    const out = write(content, { audience: "developer" });
    expect(read(out).audience).toBe("developer");
    expect(out).toContain("<metadata>");
    // The prolog's existing child survives.
    expect(out).toContain("<author>A. Writer</author>");
  });

  it("creates a whole <prolog> after the shortdesc and before the body", () => {
    const content = fx("no-prolog.dita");
    const out = write(content, { audience: "developer" });
    expect(read(out).audience).toBe("developer");
    // DITA's content model puts prolog after title/shortdesc and before the body.
    expect(out.indexOf("<prolog>")).toBeGreaterThan(out.indexOf("</shortdesc>"));
    expect(out.indexOf("<prolog>")).toBeLessThan(out.indexOf("<taskbody>"));
  });

  it("creates a <prolog> in a topic that has no body element", () => {
    const content = fx("title-only.dita");
    const out = write(content, { audience: "developer" });
    expect(read(out).audience).toBe("developer");
    expect(out.indexOf("<prolog>")).toBeGreaterThan(out.indexOf("</title>"));
    expect(out.indexOf("<prolog>")).toBeLessThan(out.indexOf("</topic>"));
  });

  it("uses <topicmeta>, not <prolog>, for a map", () => {
    const content = fx("map.ditamap");
    const out = write(content, { audience: "admin" }, "m.ditamap");
    expect(read(out, "m.ditamap").audience).toBe("admin");
    expect(out).toContain("<topicmeta>");
    expect(out).not.toContain("<prolog>");
    // A map's topicmeta goes after the title and before the topicrefs.
    expect(out.indexOf("<topicmeta>")).toBeGreaterThan(out.indexOf("</title>"));
    expect(out.indexOf("<topicmeta>")).toBeLessThan(out.indexOf("<topicref"));
  });
});

describe("DITA — fidelity and refusals", () => {
  it("returns the input identically for an empty patch", () => {
    const content = fx("with-othermeta.dita");
    expect(write(content, {})).toBe(content);
  });

  it("leaves the DOCTYPE and the body byte-identical", () => {
    const content = fx("with-othermeta.dita");
    const out = write(content, { description: "A summary." });
    expect(out.slice(0, out.indexOf("<concept"))).toBe(
      content.slice(0, content.indexOf("<concept")),
    );
    expect(out.slice(out.indexOf("<conbody>"))).toBe(
      content.slice(content.indexOf("<conbody>")),
    );
  });

  it("does not disturb an unresolvable entity in the content", () => {
    const content = fx("with-othermeta.dita").replace(
      "The prolog is where DITA keeps this.",
      "A&nbsp;B&mdash;C",
    );
    const out = write(content, { description: "A summary." });
    expect(out).toContain("A&nbsp;B&mdash;C");
  });

  it("refuses a value that cannot fit on one line", () => {
    expect(() =>
      write(fx("with-othermeta.dita"), { tags: ["a", "b"] }),
    ).toThrow(DocmetaError);
  });

  it("escapes markup characters in a written value", () => {
    const out = write(fx("with-othermeta.dita"), { description: 'a & b < c "q"' });
    expect(read(out).description).toBe('a & b < c "q"');
  });
});

describe("DITA — the write-to-source invariant", () => {
  const cases: [string, string, string, unknown][] = [
    ["value in an othermeta", "with-othermeta.dita", "audience", "writer"],
    ["value in a root attribute", "with-othermeta.dita", "id", "moved"],
    ["value absent, metadata exists", "with-othermeta.dita", "fresh", "x"],
    ["value absent, prolog exists", "prolog-no-metadata.dita", "fresh", "x"],
    ["value absent, no prolog", "no-prolog.dita", "fresh", "x"],
    ["value absent, no body", "title-only.dita", "fresh", "x"],
  ];
  for (const [label, file, key, value] of cases) {
    it(`round-trips through the reader — ${label}`, () => {
      const out = write(fx(file), { [key]: value });
      expect(read(out)[key]).toEqual(value);
    });
  }

  it("round-trips for a map", () => {
    const out = write(fx("map.ditamap"), { fresh: "x" }, "m.ditamap");
    expect(read(out, "m.ditamap").fresh).toBe("x");
  });
});
