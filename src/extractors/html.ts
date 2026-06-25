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
 * malformed markup, so extraction never throws. Per-node line numbers give a
 * JSON-Pointer -> source-line map for annotations.
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

function lineForFactory(
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
    const map = new Map<string, number>();
    // The document node has no location; anchor the root pointer at line 1.
    map.set("", 1);

    const setKey = (key: string, value: unknown, line: number | undefined): void => {
      data[key] = value;
      if (line != null) map.set(`/${escapePointerSegment(key)}`, line);
    };

    const visit = (node: ChildNode): void => {
      if (defaultTreeAdapter.isElementNode(node)) {
        const line = node.sourceCodeLocation?.startLine;
        if (node.tagName === "title") {
          // The first <title> wins; later ones (e.g. in SVG) are ignored.
          if (data.title === undefined) {
            const first = node.childNodes[0];
            const text =
              first && defaultTreeAdapter.isTextNode(first) ? first.value : "";
            setKey("title", text, line);
          }
        } else if (node.tagName === "meta") {
          const key = attrValue(node, "name") ?? attrValue(node, "property");
          const value = attrValue(node, "content");
          if (key != null && value != null) {
            setKey(key, typeValue(value), line);
          }
        }
      }
      if (defaultTreeAdapter.isElementNode(node)) {
        for (const child of node.childNodes) visit(child);
      }
    };

    for (const child of doc.childNodes) visit(child);

    const present = Object.keys(data).length > 0;
    return { data, present, format: "html", lineFor: lineForFactory(map) };
  },
};
