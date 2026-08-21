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
import type { ExtractedMetadata } from "../types.js";

type XmlDocument = ReturnType<DOMParser["parseFromString"]>;
export type XmlElement = NonNullable<XmlDocument["documentElement"]>;

export interface XmlRead {
  data: Record<string, unknown>;
  lineMap: Map<string, number>;
  colMap: Map<string, number>;
  /** The root element, or undefined for a document that has none. */
  root: XmlElement | undefined;
  /** The text actually parsed — the source minus any leading BOM. */
  body: string;
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
export function readXml(content: string): XmlRead {
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
  const root = doc.documentElement ?? undefined;
  if (!root) return { data, lineMap, colMap, root: undefined, body };

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

  return { data, lineMap, colMap, root, body };
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
