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
    if (map.has(pointer)) return map.get(pointer);
    // A YAML-typed value can be an array/object, so Ajv may report nested
    // pointers like "/tags/0". Walk up to the nearest recorded ancestor.
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

/**
 * Detect a leading section title — a text line underlined with punctuation,
 * optionally also overlined — after any blank lines. The title is collected as
 * page metadata; `next` is the index where docinfo field-list parsing resumes.
 */
interface TitleInfo {
  /** Title text, when a leading section title is present. */
  title?: string;
  /** 1-based source line of the title text. */
  line?: number;
  /** Index of the first line after the title (and its adornment lines). */
  next: number;
}

function parseTitle(lines: string[]): TitleInfo {
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  if (i >= lines.length) return { next: i };

  const first = lines[i] ?? "";
  // A field line starts the docinfo block, not a title.
  if (FIELD.test(first)) return { next: i };

  // Over- and under-lined: adornment / title text / adornment.
  const overTitle = lines[i + 1] ?? "";
  if (
    ADORN.test(first) &&
    overTitle.trim() !== "" &&
    !FIELD.test(overTitle) &&
    ADORN.test(lines[i + 2] ?? "")
  ) {
    return { title: overTitle.trim(), line: i + 2, next: i + 3 };
  }

  // Underlined: title text / adornment.
  if (!ADORN.test(first) && ADORN.test(lines[i + 1] ?? "")) {
    return { title: first.trim(), line: i + 1, next: i + 2 };
  }

  return { next: i };
}

/**
 * Parse the native reStructuredText page metadata: a leading section title
 * (collected as `title`) followed by the docinfo field list. An explicit
 * `:title:` field takes precedence over the heading.
 */
function extractDocinfo(content: string): ExtractedMetadata {
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = body.split(/\r?\n/);

  const data: Record<string, unknown> = {};
  const map = new Map<string, number>();
  // First source line of the metadata block (title or, failing that, a field).
  let blockStart = -1;

  const titleInfo = parseTitle(lines);
  if (titleInfo.title != null && titleInfo.line != null) {
    data.title = titleInfo.title;
    map.set("/title", titleInfo.line);
    blockStart = titleInfo.line;
  }

  // Skip blank lines between the title and the field list.
  let i = titleInfo.next;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;

  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // The field list ends at the first blank or non-field line.
    if (line.trim() === "") break;
    const field = FIELD.exec(line);
    if (!field || field[1] == null) break;

    const name = field[1].trim();
    const value = field[2] === undefined ? true : typeValue(field[2]);
    if (blockStart === -1) blockStart = i + 1;
    data[name] = value;
    map.set(`/${escapePointerSegment(name)}`, i + 1);
  }

  const present = blockStart !== -1;
  // Root pointer maps to the block start. When no metadata is present we record
  // nothing, so `lineFor` reports unknown rather than misleadingly annotating
  // missing-metadata errors at line 1.
  if (present) map.set("", blockStart);

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
