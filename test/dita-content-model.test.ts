/**
 * Content-model conformance for every DITA document docmeta writes.
 *
 * Proposal 0020 originally shipped saying DTD validation of written DITA was
 * not covered, because no DITA validator exists in this toolchain — `xmllint`,
 * `xmlstarlet` and a JRE are all absent, and vendoring the OASIS grammar is
 * ~1MB of DTD modules to check element order in a handful of fixtures.
 *
 * This closes that gap in substance rather than by name. It is a real validator
 * for the part of the DTD the writer can actually break: **which children a
 * container may hold, in what order, and how many times**. Those are exactly the
 * constraints `newElementEdits` has to satisfy when it creates an element, and
 * the only ones a splice-only writer can violate — it never invents attributes
 * and never reorders existing children.
 *
 * The models below are transcribed **from the OASIS specification**, by hand,
 * and deliberately **not** imported from `src/extractors/dita.ts`. Checking the
 * writer against the same table it writes from would prove only that the table
 * is self-consistent. This is the discipline `docusaurus-schemas.test.ts`
 * already applies to field sets: "kept here rather than derived from the schema
 * so a dropped or misspelled property fails".
 *
 * What it does **not** cover, stated so nobody reads it as more: attribute
 * value types, required attributes, entity resolution, specialization `@class`
 * ancestry, or any element outside the metadata containers.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { xmlExtractor } from "../src/extractors/xml.js";
import type { XmlElement } from "../src/extractors/xml-read.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DITA_DIR = join(root, "test", "fixtures", "dita");

/** One position in a content model. Several names means a choice group. */
interface Slot {
  names: string[];
  max: number;
}

/**
 * Transcribed from the OASIS DITA 1.3 content-model appendix.
 *
 *   prolog     author*, source?, publisher?, copyright*, critdates?,
 *              permissions?, metadata*, resourceid*, data*
 *   topicmeta  navtitle?, linktext?, searchtitle?, shortdesc?, author*,
 *              source?, publisher?, copyright*, critdates?, permissions?,
 *              metadata*, audience*, category*, keywords, exportanchors*,
 *              prodinfo*, othermeta*, resourceid*, ux-window*, data*
 *   critdates  created?, revised*
 *   copyright  copyryear+, copyrholder
 *   metadata   audience*, category*, keywords*, prodinfo*, othermeta*, data*
 *   keywords   (indexterm | keyword)*
 *   prodinfo   prodname, vrmlist?, (brand | component | featnum | platform |
 *              prognum | series)*
 *   vrmlist    vrm+
 */
const MODELS: Record<string, Slot[]> = {
  prolog: [
    { names: ["author"], max: Infinity },
    { names: ["source"], max: 1 },
    { names: ["publisher"], max: 1 },
    { names: ["copyright"], max: Infinity },
    { names: ["critdates"], max: 1 },
    { names: ["permissions"], max: 1 },
    { names: ["metadata"], max: Infinity },
    { names: ["resourceid"], max: Infinity },
    { names: ["data"], max: Infinity },
  ],
  topicmeta: [
    { names: ["navtitle"], max: 1 },
    { names: ["linktext"], max: 1 },
    { names: ["searchtitle"], max: 1 },
    { names: ["shortdesc"], max: 1 },
    { names: ["author"], max: Infinity },
    { names: ["source"], max: 1 },
    { names: ["publisher"], max: 1 },
    { names: ["copyright"], max: Infinity },
    { names: ["critdates"], max: 1 },
    { names: ["permissions"], max: 1 },
    { names: ["metadata"], max: Infinity },
    { names: ["audience"], max: Infinity },
    { names: ["category"], max: Infinity },
    { names: ["keywords"], max: Infinity },
    { names: ["exportanchors"], max: Infinity },
    { names: ["prodinfo"], max: Infinity },
    { names: ["othermeta"], max: Infinity },
    { names: ["resourceid"], max: Infinity },
    { names: ["ux-window"], max: Infinity },
    { names: ["data"], max: Infinity },
  ],
  critdates: [
    { names: ["created"], max: 1 },
    { names: ["revised"], max: Infinity },
  ],
  copyright: [
    { names: ["copyryear"], max: Infinity },
    { names: ["copyrholder"], max: 1 },
  ],
  metadata: [
    { names: ["audience"], max: Infinity },
    { names: ["category"], max: Infinity },
    { names: ["keywords"], max: Infinity },
    { names: ["prodinfo"], max: Infinity },
    { names: ["othermeta"], max: Infinity },
    { names: ["data"], max: Infinity },
  ],
  keywords: [{ names: ["indexterm", "keyword"], max: Infinity }],
  prodinfo: [
    { names: ["prodname"], max: 1 },
    { names: ["vrmlist"], max: 1 },
    {
      names: ["brand", "component", "featnum", "platform", "prognum", "series"],
      max: Infinity,
    },
  ],
  vrmlist: [{ names: ["vrm"], max: Infinity }],
};

interface Violation {
  container: string;
  message: string;
}

/**
 * Every content-model violation in a document, or an empty list.
 *
 * Children the model does not list are skipped rather than failed: a
 * specialization may legally introduce them, and this is checking the writer,
 * not policing hand-authored DITA.
 */
function violations(xml: string): Violation[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const found: Violation[] = [];

  const walk = (el: XmlElement): void => {
    const name = el.nodeName.toLowerCase();
    const model = Object.prototype.hasOwnProperty.call(MODELS, name)
      ? MODELS[name]
      : undefined;

    const children: XmlElement[] = [];
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) children.push(n as unknown as XmlElement);
    }

    if (model) {
      let highest = -1;
      const counts = new Map<number, number>();
      for (const child of children) {
        const childName = child.nodeName.toLowerCase();
        const slot = model.findIndex((s) => s.names.includes(childName));
        if (slot === -1) continue;
        if (slot < highest) {
          found.push({
            container: name,
            message: `<${childName}> appears after <${
              model[highest]?.names.join("|") ?? "?"
            }>, but the content model puts it before`,
          });
        }
        highest = Math.max(highest, slot);
        const seen = (counts.get(slot) ?? 0) + 1;
        counts.set(slot, seen);
        const max = model[slot]?.max ?? Infinity;
        if (seen > max) {
          found.push({
            container: name,
            message: `<${childName}> appears ${seen} times, but the content model allows ${max}`,
          });
        }
      }
    }

    for (const child of children) walk(child);
  };

  const rootEl = doc.documentElement;
  if (rootEl) walk(rootEl);
  return found;
}

const apply = (content: string, patch: Record<string, unknown>, path: string) =>
  xmlExtractor.apply?.(content, patch, { filePath: path }) ?? "";

describe("the validator itself catches what it claims to", () => {
  // A checker that never fails is worse than none, so break the document on
  // purpose first — the same discipline the schema tests use.
  it("flags an out-of-order child", () => {
    const bad = `<prolog><metadata/><critdates><created date="2026-01-15"/></critdates></prolog>`;
    expect(violations(bad).map((v) => v.message).join(" ")).toMatch(
      /<critdates> appears after <metadata>/,
    );
  });

  it("flags a child that repeats past its cardinality", () => {
    const bad = `<critdates><created date="2026-01-01"/><created date="2026-01-02"/></critdates>`;
    expect(violations(bad).map((v) => v.message).join(" ")).toMatch(
      /<created> appears 2 times, but the content model allows 1/,
    );
  });

  it("passes a conforming document", () => {
    const good = `<prolog><author>A</author><critdates><created date="2026-01-15"/></critdates><metadata/></prolog>`;
    expect(violations(good)).toEqual([]);
  });
});

describe("every DITA fixture conforms", () => {
  const fixtures = readdirSync(DITA_DIR).filter(
    (f) => f.endsWith(".dita") || f.endsWith(".ditamap"),
  );

  it("has fixtures to check", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const name of fixtures) {
    it(name, () => {
      const xml = readFileSync(join(DITA_DIR, name), "utf8");
      expect(violations(xml)).toEqual([]);
    });
  }
});

describe("what the writer creates conforms", () => {
  const PROLOG_ONLY = readFileSync(join(DITA_DIR, "prolog-no-metadata.dita"), "utf8");
  const P_PATH = "test/fixtures/dita/prolog-no-metadata.dita";
  const NO_PROLOG = readFileSync(join(DITA_DIR, "no-prolog.dita"), "utf8");
  const N_PATH = "test/fixtures/dita/no-prolog.dita";
  const MAP = readFileSync(join(DITA_DIR, "map.ditamap"), "utf8");
  const M_PATH = "test/fixtures/dita/map.ditamap";

  const cases: Array<[string, string, Record<string, unknown>, string]> = [
    ["one element into an existing prolog", PROLOG_ONLY, { "prolog.source": "Notes" }, P_PATH],
    ["a container and its child", PROLOG_ONLY, { "critdates.created": "2026-01-15" }, P_PATH],
    ["keywords, which live under metadata", PROLOG_ONLY, { "keywords.keyword": ["gw"] }, P_PATH],
    ["the prodinfo tail, two levels down", PROLOG_ONLY, { "prodinfo.brand": ["Babbage"] }, P_PATH],
    ["copyright, whose year is an attribute", PROLOG_ONLY, { "copyright.copyryear": [2026] }, P_PATH],
    [
      "several containers at one anchor",
      PROLOG_ONLY,
      {
        "critdates.created": "2026-01-15",
        "prolog.source": "Notes",
        "metadata.audience": ["writer"],
        "copyright.copyryear": [2026],
        "keywords.keyword": ["gw"],
        "prodinfo.brand": ["Babbage"],
      },
      P_PATH,
    ],
    ["a whole prolog from nothing", NO_PROLOG, { "critdates.created": "2026-01-15" }, N_PATH],
    ["othermeta into a topic with no prolog", NO_PROLOG, { audience: "writer" }, N_PATH],
    ["into a map's topicmeta", MAP, { "topicmeta.author": ["Ada"] }, M_PATH],
  ];

  for (const [name, doc, patch, path] of cases) {
    it(name, () => {
      const next = apply(doc, patch, path);
      expect(violations(next)).toEqual([]);
    });
  }
});
