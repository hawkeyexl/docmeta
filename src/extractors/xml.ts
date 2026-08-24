/**
 * XML metadata extractor.
 *
 * Also handles DITA topics (`.dita`) and maps (`.ditamap`), which are XML.
 *
 * Reads metadata from the document's root-element attributes, e.g.
 * `<document type="concept" version="2">` yields `{ type: "concept", version: 2 }`.
 * Attribute values are parsed as YAML scalars so `"2"` -> number and `"true"` ->
 * boolean, consistent with the AsciiDoc header extractor. Namespace declarations
 * (`xmlns`, `xmlns:*`) are dropped as transport noise. Per-node line and column
 * numbers from the parser give JSON-Pointer -> source-line and -> source-column
 * maps for precise annotations. Both are 1-based.
 *
 * Malformed XML is surfaced as a thrown error; the command layer records it as a
 * per-file failure so the rest of the run continues (mirroring frontmatter).
 *
 * The read itself lives in `xml-read.ts`, shared with `xml-write.ts` so that a
 * write lands on the attribute the read took its value from.
 */
import { readXml, toExtracted } from "./xml-read.js";
import { applyXml } from "./xml-write.js";
import type { ExtractedMetadata, MetadataExtractor } from "../types.js";

export const xmlExtractor: MetadataExtractor = {
  name: "xml",
  // DITA topics and maps are XML, and their metadata lives on the root element
  // (`id`, `type`, `xml:lang`, …), so they need no extractor of their own.
  extensions: [".xml", ".dita", ".ditamap"],
  implemented: true,
  extract(content, filePath, options): ExtractedMetadata {
    return toExtracted(readXml(content, filePath, options));
  },
  apply: applyXml,
};
