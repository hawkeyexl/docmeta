/**
 * The XML read model, split out so that `xml.ts` (which extracts) and
 * `xml-write.ts` (which writes back) share one implementation of it.
 *
 * Metadata comes from the root element's attributes. Namespace declarations
 * (`xmlns`, `xmlns:*`) are dropped as transport noise. Attribute values are
 * parsed as YAML scalars so `"2"` -> number and `"true"` -> boolean, consistent
 * with the AsciiDoc and HTML extractors.
 *
 * The parsed root is handed back along with the data, because the writer needs
 * the same node the reader drew its values from. Deciding "which attribute is
 * this key" twice, in two modules, is how a write ends up landing somewhere the
 * read does not look.
 */
import { DOMParser } from "@xmldom/xmldom";
import { parse as parseYamlScalar } from "yaml";
import { escapePointerSegment, positionForFactory } from "./pointer.js";
import {
  ditaShape,
  metadataContainers,
  otherMetaEntries,
  type DitaShape,
} from "./dita.js";
import type { ExtractedMetadata } from "../types.js";

type XmlDocument = ReturnType<DOMParser["parseFromString"]>;
export type XmlElement = NonNullable<XmlDocument["documentElement"]>;

/** Where a key's effective value came from. */
export type XmlSource =
  | { kind: "attr"; name: string }
  | { kind: "othermeta"; el: XmlElement };

export interface XmlRead {
  data: Record<string, unknown>;
  lineMap: Map<string, number>;
  colMap: Map<string, number>;
  /** The root element, or undefined for a document that has none. */
  root: XmlElement | undefined;
  /** The text actually parsed — the source minus any leading BOM. */
  body: string;
  /**
   * The element each key's effective value was read from, so a write can land
   * on the same one. DITA has two channels; plain XML has one.
   */
  sources: Map<string, XmlSource>;
  /** Set when the document is DITA, describing where its metadata belongs. */
  dita: DitaShape | undefined;
}

/** Parse a raw attribute value as a YAML scalar, falling back to the string. */
export function typeValue(raw: string): unknown {
  // An explicitly empty attribute (`title=""`) is the empty string, not the
  // YAML `null` that parsing "" would yield.
  if (raw === "") return "";
  try {
    return parseYamlScalar(raw);
  } catch {
    return raw;
  }
}

/** Whether an attribute carries metadata, as opposed to describing the document. */
export function isMetadataAttribute(name: string): boolean {
  return name !== "xmlns" && !name.startsWith("xmlns:");
}

/**
 * Parse and read. Throws for malformed XML, which the command layer records as
 * a per-file failure so the rest of the run continues (mirroring frontmatter).
 */
export function readXml(content: string, filePath?: string): XmlRead {
  // A BOM stays part of line 1; it doesn't shift line numbers.
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (level, msg) => {
      if (level !== "error" && level !== "fatalError") return;
      // An entity the parser can't resolve is not structural damage. Only the
      // five built-in XML entities are known, and no external DTD is ever
      // fetched, so every DTD-declared entity (`&nbsp;`, `&mdash;` — the norm
      // in DITA) lands here while the document itself is fine. The root
      // element and its attributes still parse, so extraction continues; a
      // reference that is genuinely malformed reports a different error.
      // Matches the @xmldom/xmldom >=0.9 message; re-check on a major bump.
      // The DITA entity test fails loudly if the wording changes.
      if (/entity not found/i.test(msg)) return;
      errors.push(msg);
    },
  }).parseFromString(body, "text/xml");

  if (errors.length > 0) {
    throw new Error(`Invalid XML: ${errors[0] ?? "parse error"}`);
  }

  const lineMap = new Map<string, number>();
  const colMap = new Map<string, number>();
  const data: Record<string, unknown> = {};
  const sources = new Map<string, XmlSource>();
  const root = doc.documentElement ?? undefined;
  if (!root) {
    return {
      data,
      lineMap,
      colMap,
      root: undefined,
      body,
      sources,
      dita: undefined,
    };
  }

  // Both are 1-based, verified against the parser rather than its typings:
  // `@xmldom/xmldom` documents `lineNumber` as zero-based and `columnNumber`
  // as one-based, but it reports a root element opening on source line 3 as
  // `lineNumber: 3`. The doc comment is wrong; both count from 1.
  const rootLine = root.lineNumber ?? 1;
  const rootCol = root.columnNumber ?? 1;
  lineMap.set("", rootLine);
  colMap.set("", rootCol);

  const attrs = root.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs.item(i);
    if (!attr) continue;
    const name = attr.name;
    if (!isMetadataAttribute(name)) continue;
    data[name] = typeValue(attr.value);
    sources.set(name, { kind: "attr", name });
    const pointer = `/${escapePointerSegment(name)}`;
    lineMap.set(pointer, attr.lineNumber ?? rootLine);
    // An attribute's `columnNumber` is the opening quote of its value, so
    // the caret lands on the value that failed. Recorded only when the line
    // came from the same attribute: pairing a real column with the root's
    // fallback line would point at a character on the wrong line, and an
    // absent entry falls back to the root pair, which is at least coherent.
    if (attr.lineNumber != null && attr.columnNumber != null) {
      colMap.set(pointer, attr.columnNumber);
    }
  }

  // DITA keeps document metadata in <prolog>/<topicmeta>, not on the root
  // element. Reading it is not optional once `fill` can write it: a value the
  // writer puts in an <othermeta> that the reader cannot see leaves the field
  // missing, so `validate` fails again and the next run rewrites it forever.
  const dita = ditaShape(body, root, filePath);
  if (dita) {
    const { container } = metadataContainers(root, dita);
    if (container) {
      for (const { key, value, el } of otherMetaEntries(container)) {
        // othermeta wins over a root attribute of the same name: it is the
        // explicit metadata channel, while root attributes are mostly
        // structural.
        data[key] = typeValue(value);
        sources.set(key, { kind: "othermeta", el });
        const pointer = `/${escapePointerSegment(key)}`;
        if (el.lineNumber != null) lineMap.set(pointer, el.lineNumber);
        if (el.columnNumber != null) colMap.set(pointer, el.columnNumber);
      }
    }
  }

  return { data, lineMap, colMap, root, body, sources, dita };
}

/** Shape the read into the generic extractor result. */
export function toExtracted(read: XmlRead): ExtractedMetadata {
  return {
    data: read.data,
    present: Object.keys(read.data).length > 0,
    format: "xml",
    lineFor: positionForFactory(read.lineMap),
    colFor: positionForFactory(read.colMap),
  };
}
