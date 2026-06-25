/**
 * XML metadata extractor.
 *
 * Reads metadata from the document's root-element attributes, e.g.
 * `<document type="concept" version="2">` yields `{ type: "concept", version: 2 }`.
 * Attribute values are parsed as YAML scalars so `"2"` -> number and `"true"` ->
 * boolean, consistent with the AsciiDoc header extractor. Namespace declarations
 * (`xmlns`, `xmlns:*`) are dropped as transport noise. Per-node line numbers from
 * the parser give a JSON-Pointer -> source-line map for precise annotations.
 *
 * Malformed XML is surfaced as a thrown error; the command layer records it as a
 * per-file failure so the rest of the run continues (mirroring frontmatter).
 */
import { DOMParser } from "@xmldom/xmldom";
import { parse as parseYamlScalar } from "yaml";
import type { ExtractedMetadata, MetadataExtractor } from "../types.js";

function escapePointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Parse a raw attribute value as a YAML scalar, falling back to the string. */
function typeValue(raw: string): unknown {
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
    if (map.has(pointer)) return map.get(pointer);
    // Walk up to the nearest recorded ancestor (e.g. a nested Ajv pointer).
    let p = pointer;
    while (p.length > 0) {
      const idx = p.lastIndexOf("/");
      if (idx < 0) break;
      p = p.slice(0, idx);
      if (map.has(p)) return map.get(p);
    }
    return map.get("");
  };
}

export const xmlExtractor: MetadataExtractor = {
  name: "xml",
  extensions: [".xml"],
  implemented: true,
  extract(content): ExtractedMetadata {
    // A BOM stays part of line 1; it doesn't shift line numbers.
    const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

    const errors: string[] = [];
    const doc = new DOMParser({
      onError: (level, msg) => {
        if (level === "error" || level === "fatalError") errors.push(msg);
      },
    }).parseFromString(body, "text/xml");

    if (errors.length > 0) {
      throw new Error(`Invalid XML: ${errors[0] ?? "parse error"}`);
    }

    const root = doc.documentElement;
    if (!root) {
      return { data: {}, present: false, format: "xml", lineFor: () => undefined };
    }

    const data: Record<string, unknown> = {};
    const map = new Map<string, number>();
    const rootLine = root.lineNumber ?? 1;
    map.set("", rootLine);

    const attrs = root.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs.item(i);
      if (!attr) continue;
      const name = attr.name;
      // Namespace declarations describe the document, not its metadata.
      if (name === "xmlns" || name.startsWith("xmlns:")) continue;
      data[name] = typeValue(attr.value);
      map.set(`/${escapePointerSegment(name)}`, attr.lineNumber ?? rootLine);
    }

    const present = Object.keys(data).length > 0;
    return { data, present, format: "xml", lineFor: lineForFactory(map) };
  },
};
