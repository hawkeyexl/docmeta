/**
 * DITA's typed prolog metadata, read through the general element-lifting rule.
 *
 * Before this, docmeta saw exactly one DITA metadata channel: `<othermeta
 * name= content=>`. A topic could carry a full, correct `<prolog>` — author,
 * critical dates, audience, permissions — and be reported as having no metadata
 * at all. The elements OASIS actually defines for the job were invisible.
 *
 * Two things make DITA different from the generic XML convention, and both come
 * from the same source: DITA has a **content model**, and docmeta encodes it.
 *
 *  - **Cardinality is known, so types are exact.** `author*` is a list and
 *    `source?` is a scalar. Generic XML defaults everything to a list precisely
 *    because it has no such statement to follow.
 *  - **Values live in attributes as often as in text.** `<created date=…/>` and
 *    `<permissions entitlement=…/>` carry nothing between their tags, so the
 *    text-bearing rule alone would skip them entirely.
 *
 * Topics and maps differ in a way the naming rule handles without a special
 * case. A topic nests `<audience>` inside `<prolog><metadata>`; a map holds it
 * directly under `<topicmeta>`, which the OASIS content model permits as a peer
 * rather than through a wrapper. So the same fact is `metadata.audience` in one
 * and `topicmeta.audience` in the other — each key naming where the value
 * actually is, which is the whole point of the rule.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { xmlExtractor } from "../src/extractors/xml.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(name: string) {
  const path = join(root, "test", "fixtures", "dita", name);
  return xmlExtractor.extract(readFileSync(path, "utf8"), path);
}

describe("a topic prolog", () => {
  it("lifts repeatable elements as lists", () => {
    const r = read("full-prolog.dita");
    expect(r.data["prolog.author"]).toEqual(["Ada Lovelace", "Charles Babbage"]);
  });

  it("lifts at-most-once elements as scalars", () => {
    // `source?` and `publisher?` in the content model, so a one-item list here
    // would be an invention rather than a reading.
    const r = read("full-prolog.dita");
    expect(r.data["prolog.source"]).toBe("Analytical Engine Notes");
    expect(r.data["prolog.publisher"]).toBe("Example Press");
  });

  it("reads a value out of an attribute where the element carries no text", () => {
    const r = read("full-prolog.dita");
    expect(r.data["critdates.created"]).toBe("2026-01-15");
    expect(r.data["prolog.permissions"]).toBe("public");
    expect(r.data["prolog.resourceid"]).toEqual(["AE-001"]);
  });

  it("lifts a repeatable attribute-valued element as a list", () => {
    const r = read("full-prolog.dita");
    expect(r.data["critdates.revised"]).toEqual(["2026-06-02", "2026-08-23"]);
  });

  it("descends into the nested metadata containers", () => {
    const r = read("full-prolog.dita");
    expect(r.data["metadata.audience"]).toEqual(["programmer"]);
    expect(r.data["metadata.category"]).toEqual(["Reference", "Engines"]);
    expect(r.data["prodinfo.prodname"]).toBe("Analytical Engine");
  });

  it("keeps a date a string, not a parsed Date", () => {
    // `2026-01-15` must reach a schema as a string for `format: date` to mean
    // anything. The YAML core schema leaves it alone; this pins that it stays
    // that way through the attribute path too.
    const r = read("full-prolog.dita");
    expect(typeof r.data["critdates.created"]).toBe("string");
  });
});

describe("both DITA metadata channels are validated", () => {
  it("keeps `<othermeta name=\"audience\">` flat and `<audience>` namespaced", () => {
    // The fixture carries both, deliberately disagreeing: the element says
    // `programmer` and the othermeta says `42`. Neither wins. A precedence rule
    // would discard one of them, and the discarded one is exactly the one
    // nobody is checking.
    const r = read("full-prolog.dita");
    expect(r.data["metadata.audience"]).toEqual(["programmer"]);
    expect(r.data.audience).toBe(42);
  });
});

describe("a map keeps the same facts under topicmeta", () => {
  it("names top-level keys for their own container", () => {
    const r = read("topicmeta-map.ditamap");
    expect(r.data["topicmeta.author"]).toEqual(["Ada Lovelace"]);
  });

  it("shares nested keys with a topic, because the parent is the same", () => {
    const topic = read("full-prolog.dita");
    const map = read("topicmeta-map.ditamap");
    expect(map.data["critdates.created"]).toBe(topic.data["critdates.created"]);
  });

  it("lifts audience and category as topicmeta children, not metadata ones", () => {
    // The OASIS content model makes them peers under `<topicmeta>` rather than
    // wrapping them in `<metadata>`, so the key follows the document.
    const r = read("topicmeta-map.ditamap");
    expect(r.data["topicmeta.audience"]).toEqual(["programmer"]);
    expect(r.data["topicmeta.category"]).toEqual(["Reference"]);
    expect(r.data["metadata.audience"]).toBeUndefined();
  });
});

describe("positions land on the element that failed", () => {
  it("points at the element, not at the prolog or the root", () => {
    const r = read("full-prolog.dita");
    // <author> opens on line 6 of the fixture.
    expect(r.lineFor("/prolog.author")).toBe(6);
    // <created> on line 11.
    expect(r.lineFor("/critdates.created")).toBe(11);
  });
});

describe("a topic with less than a full prolog", () => {
  it("lifts what is there and invents nothing", () => {
    const r = read("prolog-no-metadata.dita");
    expect(r.data["prolog.author"]).toEqual(["A. Writer"]);
    expect(r.data["metadata.audience"]).toBeUndefined();
    expect(r.data["critdates.created"]).toBeUndefined();
  });

  it("lifts nothing from a topic with no prolog at all", () => {
    const r = read("no-prolog.dita");
    for (const key of Object.keys(r.data)) {
      expect(key.startsWith("prolog."), key).toBe(false);
    }
  });
});
