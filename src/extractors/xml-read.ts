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
  childElements,
  ditaShape,
  liftRoot,
  metadataContainers,
  otherMetaEntries,
  DITA_CONTENT_MODEL,
  DITA_LIFTS,
  type DitaLift,
  type DitaShape,
} from "./dita.js";
import { liftKey } from "./element-key.js";
import type { ExtractedMetadata } from "../types.js";

type XmlDocument = ReturnType<DOMParser["parseFromString"]>;
export type XmlElement = NonNullable<XmlDocument["documentElement"]>;

/** Where a key's effective value came from. */
export type XmlSource =
  | { kind: "attr"; name: string }
  | { kind: "othermeta"; el: XmlElement }
  /**
   * A value read from element text. `els` carries every occurrence, in document
   * order, because the key is a list — a write replaces the whole set, and one
   * element out of several is not a location a write can aim at.
   */
  | { kind: "element-text"; els: XmlElement[] };

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
 * The text an element carries, or `undefined` when it carries none worth
 * lifting.
 *
 * Two exclusions, and both are the reason this returns `undefined` rather than
 * an empty string:
 *
 * - **An element with element children is structure, not a value.** `<body>`
 *   full of `<p>` is a container; lifting it would concatenate the prose of the
 *   whole document into one key.
 * - **Whitespace-only text is not a value either.** Indented markup puts a
 *   newline and some spaces inside every container, so treating that as content
 *   would lift every element in the file.
 *
 * Comments and processing instructions are ignored rather than disqualifying,
 * so `<title><!-- note -->Set up</title>` is still a value.
 *
 * A deliberately empty element (`<title></title>`) therefore yields nothing by
 * convention. That is right for the convention, which has to keep structural
 * elements out of the key set without a hardcoded ignore list, and wrong for a
 * path someone named in `elements:` config — where "present but empty" is
 * exactly what they want checked. The config path passes `allowEmpty`.
 */
export function elementText(
  el: XmlElement,
  allowEmpty = false,
): string | undefined {
  let text = "";
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) return undefined;
    if (n.nodeType === 3 || n.nodeType === 4) text += n.nodeValue ?? "";
  }
  if (!allowEmpty && text.trim() === "") return undefined;
  return text.trim();
}

/**
 * DITA's typed metadata elements, grouped by the key each contributes.
 *
 * Walks down from `<prolog>` or `<topicmeta>`, descending into any child the
 * content-model table knows — which is how `<critdates>`, `<metadata>` and
 * `<prodinfo>` are reached without either being named here. What is lifted, and
 * whether from text or an attribute, is `DITA_LIFTS`' decision; this only
 * traverses.
 */
function ditaLiftedElements(
  container: XmlElement,
): Map<string, { els: XmlElement[]; spec: DitaLift }> {
  const out = new Map<string, { els: XmlElement[]; spec: DitaLift }>();
  const walk = (parent: XmlElement): void => {
    const parentName = parent.nodeName.toLowerCase();
    const lifts = DITA_LIFTS[parentName];
    for (const child of childElements(parent)) {
      const childName = child.nodeName.toLowerCase();
      const spec = lifts?.[childName];
      if (spec) {
        const key = liftKey(parentName, childName);
        const found = out.get(key);
        if (found) found.els.push(child);
        else out.set(key, { els: [child], spec });
      }
      if (DITA_CONTENT_MODEL[childName] !== undefined) walk(child);
    }
  };
  walk(container);
  return out;
}

/**
 * The root's direct children that are values, grouped by the key they
 * contribute, in document order.
 *
 * Grouped rather than emitted one at a time because repeated element names
 * share a key, and every occurrence has to survive — dropping all but the first
 * would discard data silently, which is the failure this whole mechanism exists
 * to avoid.
 */
function liftableChildren(root: XmlElement): Map<string, XmlElement[]> {
  const out = new Map<string, XmlElement[]>();
  for (const child of childElements(root)) {
    if (elementText(child) === undefined) continue;
    const key = liftKey(root.nodeName, child.nodeName);
    const group = out.get(key);
    if (group) group.push(child);
    else out.set(key, [child]);
  }
  return out;
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

  // Element-derived metadata. Plain XML carries no content model, so the
  // convention stops at the root's direct children and lifts only the ones that
  // are values rather than structure — see `elementText`. Anything deeper needs
  // an explicit `elements:` path, because guessing which nested element is
  // metadata and which is prose is how a document body turns into a key per
  // paragraph.
  for (const [key, els] of liftableChildren(root)) {
    // Always a list. XML says nothing about cardinality, so a type that
    // depended on how many elements this document happened to carry would be
    // unwritable against; a schema that means "exactly one" says `maxItems: 1`.
    data[key] = els.map((el) => typeValue(elementText(el) ?? ""));
    sources.set(key, { kind: "element-text", els });
    const first = els[0];
    const pointer = `/${escapePointerSegment(key)}`;
    // The caret goes on the first occurrence: it is where a reader looks, and
    // where a write that replaces the set begins.
    if (first?.lineNumber != null) lineMap.set(pointer, first.lineNumber);
    if (first?.columnNumber != null) colMap.set(pointer, first.columnNumber);
  }

  // DITA keeps document metadata in <prolog>/<topicmeta>, not on the root
  // element. Reading it is not optional once `fill` can write it: a value the
  // writer puts in an <othermeta> that the reader cannot see leaves the field
  // missing, so `validate` fails again and the next run rewrites it forever.
  const dita = ditaShape(body, root, filePath);
  if (dita) {
    // The typed elements first. They are namespaced by their container, so they
    // cannot collide with the flat `<othermeta>` names below — which is what
    // lets a topic carry the same fact in both channels and have both checked,
    // rather than one quietly overwriting the other.
    const liftContainer = liftRoot(root, dita);
    if (liftContainer) {
      for (const [key, { els, spec }] of ditaLiftedElements(liftContainer)) {
        const values = els
          .map((el) =>
            spec.attr ? el.getAttribute(spec.attr) : elementText(el),
          )
          .filter((v): v is string => v != null)
          .map(typeValue);
        if (values.length === 0) continue;
        data[key] = spec.repeatable ? values : values[0];
        sources.set(key, { kind: "element-text", els });
        const first = els[0];
        const pointer = `/${escapePointerSegment(key)}`;
        if (first?.lineNumber != null) lineMap.set(pointer, first.lineNumber);
        if (first?.columnNumber != null) colMap.set(pointer, first.columnNumber);
      }
    }

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
