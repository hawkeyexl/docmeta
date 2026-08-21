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

export type Element = DefaultTreeAdapterMap["element"];

/** Where a key's winning value came from. */
export type HtmlSource =
  | { kind: "meta"; el: Element }
  | { kind: "title"; el: Element };

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

/** Read metadata, positions, and per-key provenance from HTML source. */
export function readHtml(source: string): HtmlRead {
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

  return { data, body, lineMap, colMap, sources, head };
}
