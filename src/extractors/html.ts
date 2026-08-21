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
 *
 * The read itself lives in `html-read.ts`, shared with `html-write.ts` so that a
 * write lands wherever the read took its value from. See that module for why
 * the two must not each carry their own copy of the precedence rule.
 */
import { readHtml } from "./html-read.js";
import { applyHtml } from "./html-write.js";
import { positionForFactory } from "./pointer.js";
import type { ExtractedMetadata, MetadataExtractor } from "../types.js";

export const htmlExtractor: MetadataExtractor = {
  name: "html",
  extensions: [".html", ".htm"],
  implemented: true,
  extract(content): ExtractedMetadata {
    const { data, lineMap, colMap } = readHtml(content);
    return {
      data,
      present: Object.keys(data).length > 0,
      format: "html",
      lineFor: positionForFactory(lineMap),
      colFor: positionForFactory(colMap),
    };
  },
  apply: applyHtml,
};
