/**
 * The HTML read model, split out so that `html.ts` (which extracts) and
 * `html-write.ts` (which writes back) share one implementation of it.
 *
 * That sharing is the point, not tidiness. A write has to land in the same
 * place the read takes its value from; if the two disagree about which tag wins,
 * `fill` writes somewhere the reader ignores, the field stays invalid, and the
 * next run proposes it again. So precedence is decided exactly once, here, and
 * `sources` reports the winner so the writer can aim at it.
 */
import { parse, defaultTreeAdapter, type DefaultTreeAdapterMap } from "parse5";
import { parse as parseYamlScalar } from "yaml";
import { escapePointerSegment } from "./pointer.js";
import {
  liftKey,
  parseElementPath,
  type ElementPath,
} from "./element-key.js";
import type { ExtractOptions } from "../types.js";

export type Element = DefaultTreeAdapterMap["element"];

/** Where a key's winning value came from. */
export type HtmlSource =
  | { kind: "meta"; el: Element }
  | { kind: "title"; el: Element }
  /**
   * A value read from the text of a `<head>` child. `els` carries every
   * occurrence because the key may be a list — a write replaces the whole set,
   * and one element out of several is not a location a write can aim at.
   */
  | { kind: "element-text"; els: Element[] };

export interface HtmlRead {
  data: Record<string, unknown>;
  /** The text actually parsed — the source minus any leading BOM. */
  body: string;
  lineMap: Map<string, number>;
  colMap: Map<string, number>;
  /** The element each key's effective value was read from. */
  sources: Map<string, HtmlSource>;
  /** The `<head>` element, or undefined when the document has none. */
  head: Element | undefined;
}

/** Parse a raw value as a YAML scalar, falling back to the string. */
export function typeValue(raw: string): unknown {
  // Empty meta content (`content=""`) is the empty string, not the YAML `null`
  // that parsing "" would yield.
  if (raw === "") return "";
  try {
    return parseYamlScalar(raw);
  } catch {
    return raw;
  }
}

export function attrValue(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

/**
 * `<head>` children that carry text but are not metadata.
 *
 * Both are text-bearing, so the generic rule would lift them, and neither says
 * anything about the document: lifting them would put a stylesheet and a line
 * of JavaScript into the key set of every page docmeta reads.
 */
const HEAD_NOT_METADATA = new Set(["script", "style"]);

/**
 * `<head>` children the HTML content model permits at most once, which are
 * therefore scalars rather than one-item lists.
 *
 * `<base>` is here for completeness; being void it carries no text and so never
 * reaches the convention at all. `<meta>`, `<link>` and the rest may repeat.
 */
const HEAD_SINGLETONS = new Set(["title", "base"]);

const elementName = (el: Element | undefined): string =>
  el ? el.tagName.toLowerCase() : "";

/**
 * The text a `<head>` child carries, or `undefined` when it carries none worth
 * lifting — an element child makes it a container, and whitespace-only text is
 * indentation rather than content.
 */
function headText(el: Element, allowEmpty = false): string | undefined {
  let text = "";
  for (const node of el.childNodes) {
    if (defaultTreeAdapter.isElementNode(node)) return undefined;
    if (defaultTreeAdapter.isTextNode(node)) text += node.value;
  }
  if (!allowEmpty && text.trim() === "") return undefined;
  return text.trim();
}

/**
 * The `<head>` children that are values, grouped by the key they contribute.
 *
 * Void elements — `<meta>`, `<link>`, `<base>` — hold their value in an
 * attribute and so produce nothing here. That is deliberate rather than an
 * omission: lifting `<link>` by `href` would collapse a canonical URL and three
 * stylesheets into one list and discard the `rel` that distinguished them. An
 * `elements:` path naming the attribute addresses them instead.
 */
function liftableHeadChildren(head: Element): Map<string, Element[]> {
  const out = new Map<string, Element[]>();
  for (const node of head.childNodes) {
    if (!defaultTreeAdapter.isElementNode(node)) continue;
    const name = node.tagName.toLowerCase();
    if (HEAD_NOT_METADATA.has(name)) continue;
    if (headText(node) === undefined) continue;
    const key = liftKey("head", name);
    const group = out.get(key);
    if (group) group.push(node);
    else out.set(key, [node]);
  }
  return out;
}


/** Every element a config path selects, walked down the child axis. */
function matchHtmlPath(
  doc: DefaultTreeAdapterMap["document"],
  segments: string[],
): Element[] {
  const childrenNamed = (
    nodes: readonly DefaultTreeAdapterMap["childNode"][],
    name: string,
  ): Element[] => {
    const out: Element[] = [];
    for (const n of nodes) {
      if (defaultTreeAdapter.isElementNode(n) && n.tagName.toLowerCase() === name) {
        out.push(n);
      }
    }
    return out;
  };

  let current = childrenNamed(doc.childNodes, segments[0] ?? "");
  for (const segment of segments.slice(1)) {
    const next: Element[] = [];
    for (const el of current) next.push(...childrenNamed(el.childNodes, segment));
    current = next;
  }
  return current;
}

/** Read metadata, positions, and per-key provenance from HTML source. */
export function readHtml(
  source: string,
  options?: ExtractOptions,
): HtmlRead {
  // A BOM is invisible in an editor, so letting the parser count it as a
  // character puts every caret on line 1 one column to the right of what the
  // reader sees. `xml-read.ts` has always stripped it for that reason.
  //
  // For HTML there is a second, sharper reason. The BOM is character data as
  // far as the HTML parser is concerned, and it lands *before* `<html>` — which
  // pushes parse5 into a mode where `<html>`, `<head>` and `<body>` are all
  // reported as implied, with no source locations, even when the document
  // spells them out. Everything downstream that needs to know where `<head>`
  // is would then be looking at a document that appears not to have one.
  //
  // Stripping is safe for line numbers: the BOM sits on line 1 and removing it
  // deletes no line. `body` is returned so a caller that splices — the writer —
  // measures against the same text these positions describe.
  const body = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const doc = parse(body, { sourceCodeLocationInfo: true });

  const data: Record<string, unknown> = {};
  const lineMap = new Map<string, number>();
  const colMap = new Map<string, number>();
  const sources = new Map<string, HtmlSource>();
  let head: Element | undefined;
  // The document node has no location; anchor the root pointer at 1:1.
  lineMap.set("", 1);
  colMap.set("", 1);

  const setKey = (
    key: string,
    value: unknown,
    source: HtmlSource,
    line: number | undefined,
    col: number | undefined,
  ): void => {
    data[key] = value;
    sources.set(key, source);
    const pointer = `/${escapePointerSegment(key)}`;
    if (line != null) lineMap.set(pointer, line);
    if (col != null) colMap.set(pointer, col);
  };

  const visit = (node: DefaultTreeAdapterMap["childNode"]): void => {
    if (defaultTreeAdapter.isElementNode(node)) {
      const location = node.sourceCodeLocation;
      const line = location?.startLine;
      if (node.tagName === "head" && head === undefined) {
        head = node;
      } else if (node.tagName === "title") {
        // The first <title> wins; later ones (e.g. in SVG) are ignored. A
        // <meta name="title"> still overwrites it, in either document order.
        if (data.title === undefined) {
          const first = node.childNodes[0];
          const text =
            first && defaultTreeAdapter.isTextNode(first) ? first.value : "";
          setKey("title", text, { kind: "title", el: node }, line, location?.startCol);
        }
      } else if (node.tagName === "meta") {
        const key = attrValue(node, "name") ?? attrValue(node, "property");
        const value = attrValue(node, "content");
        if (key != null && value != null) {
          // parse5 locates each attribute separately, so the caret can land
          // on `content=` — the thing that failed — rather than on `<meta`.
          //
          // Only when it is on the *same* line as the tag, though. `line`
          // stays the tag's opening line (changing that would move existing
          // annotations), so borrowing a column from an attribute wrapped
          // onto a later line would pair a real line with a column measured
          // somewhere else, and point at nothing.
          const attrLocation = location?.attrs?.["content"];
          const col =
            attrLocation != null && attrLocation.startLine === line
              ? attrLocation.startCol
              : location?.startCol;
          setKey(key, typeValue(value), { kind: "meta", el: node }, line, col);
        }
      }
      // Same guard, same node, nothing between that could change the answer:
      // recursion belongs inside the one check rather than behind a second.
      for (const child of node.childNodes) visit(child);
    }
  };

  for (const child of doc.childNodes) visit(child);

  // Element-derived metadata, lifted from `<head>` only. The body is prose, and
  // an SVG `<title>` down in it labels a graphic rather than the page — which is
  // also why this walks `head` directly instead of reusing the visitor above.
  if (head) {
    for (const [key, els] of liftableHeadChildren(head)) {
      const values = els.map((el) => typeValue(headText(el) ?? ""));
      // HTML has a content model, so where it fixes the cardinality the key
      // follows it. `<title>` is permitted once, so it is a scalar rather than
      // a one-item list; generic XML defaults to a list precisely because it
      // has no such statement to follow.
      const singleton = HEAD_SINGLETONS.has(elementName(els[0]));
      data[key] = singleton ? values[0] : values;
      sources.set(key, { kind: "element-text", els });
      const first = els[0];
      const location = first?.sourceCodeLocation;
      const pointer = `/${escapePointerSegment(key)}`;
      if (location?.startLine != null) lineMap.set(pointer, location.startLine);
      if (location?.startCol != null) colMap.set(pointer, location.startCol);
    }
  }

  // Config paths last, so a path naming a key the convention already filled is
  // a no-op rather than a silent retype.
  for (const raw of options?.elements ?? []) {
    const spec: ElementPath = parseElementPath(raw);
    if (data[spec.key] !== undefined) continue;
    const els = matchHtmlPath(doc, spec.segments);
    const values = els
      .map((el) => (spec.attr ? attrValue(el, spec.attr) : headText(el, true)))
      .filter((v): v is string => v != null)
      .map(typeValue);
    if (values.length === 0) continue;
    data[spec.key] = values;
    sources.set(spec.key, { kind: "element-text", els });
    const location = els[0]?.sourceCodeLocation;
    const pointer = `/${escapePointerSegment(spec.key)}`;
    if (location?.startLine != null) lineMap.set(pointer, location.startLine);
    if (location?.startCol != null) colMap.set(pointer, location.startCol);
  }

  return { data, body, lineMap, colMap, sources, head };
}
