/**
 * reStructuredText metadata extractor.
 *
 * Two metadata styles are accepted:
 *  1. A leading YAML frontmatter block (`--- … ---`), as some static-site
 *     generators (e.g. MyST) use. This delegates to the shared
 *     `extractFrontmatter` so the values are typed and the line map comes for
 *     free.
 *  2. The native reStructuredText docinfo field list: the run of `:name: value`
 *     entries at the top of the document, optionally preceded by a section
 *     title (which we skip — only page-level metadata is extracted, not
 *     headings). Field values are parsed as YAML scalars so `2` -> number,
 *     `[a, b]` -> array, etc., consistent with frontmatter typing.
 */
import { parse as parseYamlScalar } from "yaml";
import type { ExtractedMetadata, MetadataExtractor } from "../types.js";
import { extractFrontmatter } from "./markdown.js";

const OPENING = /^---\r?\n/;
// `:name:` or `:name: value` — a docinfo field (value optional). The name may
// contain spaces but not a colon; the value (if any) may.
const FIELD = /^:([^:]+):(?:\s+(.*\S))?\s*$/;
// A section-title adornment: a line of two or more identical punctuation chars.
const ADORN = /^([=\-~:.'"*+#_^<>])\1+$/;

function escapePointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Parse a raw field value as a YAML scalar, falling back to the string. */
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
    // A bare top-level key (e.g. "type") maps to its "/type" JSON pointer.
    const start =
      pointer !== "" && !pointer.startsWith("/")
        ? `/${escapePointerSegment(pointer)}`
        : pointer;
    if (map.has(start)) return map.get(start);
    // A YAML-typed value can be an array/object, so Ajv may report nested
    // pointers like "/tags/0". Walk up to the nearest recorded ancestor.
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

/**
 * Advance past leading blank lines and an optional section title (with or
 * without an overline) so the docinfo field list that follows can be parsed.
 * Returns the index of the first line that is not blank/title adornment.
 */
function skipToDocinfo(lines: string[]): number {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    // A field line marks the start of the docinfo block.
    if (FIELD.test(line)) break;
    const next = lines[i + 1] ?? "";
    // Over+underlined title: adornment / text / adornment.
    if (
      ADORN.test(line) &&
      next.trim() !== "" &&
      ADORN.test(lines[i + 2] ?? "")
    ) {
      i += 3;
      continue;
    }
    // Underlined title: text / adornment.
    if (ADORN.test(next)) {
      i += 2;
      continue;
    }
    // Plain body text before any field list — there is no docinfo.
    break;
  }
  return i;
}

/** Parse the native reStructuredText docinfo field list. */
function extractDocinfo(content: string): ExtractedMetadata {
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = body.split(/\r?\n/);

  const data: Record<string, unknown> = {};
  const map = new Map<string, number>();
  let firstFieldLine = -1;

  const start = skipToDocinfo(lines);
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // The field list ends at the first blank or non-field line.
    if (line.trim() === "") break;
    const field = FIELD.exec(line);
    if (!field || field[1] == null) break;

    const name = field[1].trim();
    const value = field[2] === undefined ? true : typeValue(field[2]);
    if (firstFieldLine === -1) firstFieldLine = i + 1;
    data[name] = value;
    map.set(`/${escapePointerSegment(name)}`, i + 1);
  }

  const present = firstFieldLine !== -1;
  // Root pointer maps to the first field line (block start). When no field list
  // is present we record nothing, so `lineFor` reports unknown rather than
  // misleadingly annotating missing-metadata errors at line 1.
  if (present) map.set("", firstFieldLine);

  return {
    data,
    present,
    format: "rst",
    lineFor: lineForFactory(map),
  };
}

export const rstExtractor: MetadataExtractor = {
  name: "rst",
  extensions: [".rst"],
  implemented: true,
  extract(content) {
    const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    if (OPENING.test(body)) {
      // Delegate only when a complete frontmatter block is actually present;
      // a stray opening `---` with no closing delimiter should not shadow a
      // native docinfo field list that follows.
      const fm = extractFrontmatter(content, "rst");
      if (fm.present) return fm;
    }
    return extractDocinfo(content);
  },
};
