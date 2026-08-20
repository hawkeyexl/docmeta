/**
 * HTML metadata extractor.
 *
 * Reads document metadata from `<meta>` tags and `<title>`:
 *  - `<title>…</title>` -> `title` (the text content, kept verbatim).
 *  - `<meta name="X" content="Y">` (or `property="X"` for OpenGraph-style tags)
 *    -> `X: Y`. `content` values are parsed as YAML scalars so `"2"` -> number
 *    and `"true"` -> boolean, consistent with the AsciiDoc/XML extractors.
 *
 * Tags with neither `name` nor `property` (e.g. `charset`, `http-equiv`) carry no
 * document metadata and are skipped. Duplicate keys: last tag wins; the first
 * `<title>` wins. The parser (parse5) decodes HTML entities and recovers from
 * malformed markup, so extraction never throws. Per-node — and per-attribute —
 * positions give JSON-Pointer -> source-line and -> source-column maps for
 * annotations. Both are 1-based, as parse5 reports them.
 */
import { parse, defaultTreeAdapter, type DefaultTreeAdapterMap } from "parse5";
import { parse as parseYamlScalar } from "yaml";
import type { ExtractedMetadata, MetadataExtractor } from "../types.js";

type ChildNode = DefaultTreeAdapterMap["childNode"];
type Element = DefaultTreeAdapterMap["element"];

function escapePointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Parse a raw value as a YAML scalar, falling back to the string. */
function typeValue(raw: string): unknown {
  // Empty meta content (`content=""`) is the empty string, not the YAML `null`
  // that parsing "" would yield.
  if (raw === "") return "";
  try {
    return parseYamlScalar(raw);
  } catch {
    return raw;
  }
}

/**
 * Build a pointer -> position lookup over one map. Position-agnostic, so the
 * line map and the column map share exactly one resolution rule (exact hit,
 * then ancestor walk, then the document root) and cannot drift into answering
 * from different nodes.
 */
function positionForFactory(
  map: Map<string, number>,
): (pointer: string) => number | undefined {
  return (pointer: string) => {
    // A bare top-level key (e.g. "type") maps to its "/type" JSON pointer.
    const start =
      pointer !== "" && !pointer.startsWith("/")
        ? `/${escapePointerSegment(pointer)}`
        : pointer;
    if (map.has(start)) return map.get(start);
    // Walk up to the nearest recorded ancestor (e.g. a nested Ajv pointer).
    let p = start;
    while (p.length > 0) {
      const idx = p.lastIndexOf("/");
      if (idx < 0) break;
      p = p.slice(0, idx);
      if (map.has(p)) return map.get(p);
    }
    return map.get("");
  };
}

function attrValue(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

export const htmlExtractor: MetadataExtractor = {
  name: "html",
  extensions: [".html", ".htm"],
  implemented: true,
  extract(content): ExtractedMetadata {
    const doc = parse(content, { sourceCodeLocationInfo: true });

    const data: Record<string, unknown> = {};
    const lineMap = new Map<string, number>();
    const colMap = new Map<string, number>();
    // The document node has no location; anchor the root pointer at 1:1.
    lineMap.set("", 1);
    colMap.set("", 1);

    const setKey = (
      key: string,
      value: unknown,
      line: number | undefined,
      col: number | undefined,
    ): void => {
      data[key] = value;
      const pointer = `/${escapePointerSegment(key)}`;
      if (line != null) lineMap.set(pointer, line);
      if (col != null) colMap.set(pointer, col);
    };

    const visit = (node: ChildNode): void => {
      if (defaultTreeAdapter.isElementNode(node)) {
        const location = node.sourceCodeLocation;
        const line = location?.startLine;
        if (node.tagName === "title") {
          // The first <title> wins; later ones (e.g. in SVG) are ignored.
          if (data.title === undefined) {
            const first = node.childNodes[0];
            const text =
              first && defaultTreeAdapter.isTextNode(first) ? first.value : "";
            setKey("title", text, line, location?.startCol);
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
            setKey(key, typeValue(value), line, col);
          }
        }
        // Same guard, same node, nothing between that could change the answer:
        // recursion belongs inside the one check rather than behind a second.
        for (const child of node.childNodes) visit(child);
      }
    };

    for (const child of doc.childNodes) visit(child);

    const present = Object.keys(data).length > 0;
    return {
      data,
      present,
      format: "html",
      lineFor: positionForFactory(lineMap),
      colFor: positionForFactory(colMap),
    };
  },
};
