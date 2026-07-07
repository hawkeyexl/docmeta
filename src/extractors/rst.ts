/**
 * reStructuredText metadata extractor.
 *
 * Two metadata styles are accepted:
 *  1. A leading fenced frontmatter block (YAML `--- … ---`, TOML `+++ … +++`,
 *     or JSON `;;; … ;;;`), as some static-site generators (e.g. MyST) use.
 *     This delegates to the shared `extractFrontmatter` so the values are typed
 *     and the line map comes for free.
 *  2. The native reStructuredText docinfo field list: the run of `:name: value`
 *     entries at the top of the document, optionally preceded by a section
 *     title (which we skip — only page-level metadata is extracted, not
 *     headings). Field values are parsed as YAML scalars so `2` -> number,
 *     `[a, b]` -> array, etc., consistent with frontmatter typing.
 */
import { parse as parseYamlScalar } from "yaml";
import type { ExtractedMetadata, MetadataExtractor } from "../types.js";
import {
  extractFrontmatter,
  hasFrontmatterFence,
  escapePointerSegment,
  lineForFactory,
} from "./frontmatter.js";

// `:name:` or `:name: value` — a docinfo field (value optional). The name may
// contain spaces but not a colon; the value (if any) may.
const FIELD = /^:([^:]+):(?:\s+(.*\S))?\s*$/;
// A section-title adornment: a line of two or more identical punctuation chars.
const ADORN = /^([=\-~:.'"*+#_^<>])\1+$/;

/** Parse a raw field value as a YAML scalar, falling back to the string. */
function typeValue(raw: string): unknown {
  try {
    return parseYamlScalar(raw);
  } catch {
    return raw;
  }
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

/** A run of identical title-adornment punctuation, or null for any other line. */
function adornment(line: string): { char: string; length: number } | null {
  const m = ADORN.exec(line);
  return m && m[1] != null ? { char: m[1], length: line.length } : null;
}

function parseTitle(lines: string[]): TitleInfo {
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  if (i >= lines.length) return { next: i };

  const first = lines[i] ?? "";
  // A field line starts the docinfo block, not a title.
  if (FIELD.test(first)) return { next: i };

  const over = adornment(first);
  if (over) {
    // Over- and under-lined: adornment / title text / matching adornment. RST
    // requires the over- and underline to use the same character and length,
    // and to be at least as long as the title text.
    const text = lines[i + 1] ?? "";
    const under = adornment(lines[i + 2] ?? "");
    if (
      text.trim() !== "" &&
      !FIELD.test(text) &&
      under != null &&
      under.char === over.char &&
      under.length === over.length &&
      over.length >= text.trim().length
    ) {
      return { title: text.trim(), line: i + 2, next: i + 3 };
    }
    // A lone adornment that isn't a valid overlined title — not metadata.
    return { next: i };
  }

  // Underlined: title text / adornment at least as long as the title.
  const under = adornment(lines[i + 1] ?? "");
  if (under != null && under.length >= first.trim().length) {
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
    if (hasFrontmatterFence(content)) {
      // Delegate only when a complete frontmatter block is actually present.
      const fm = extractFrontmatter(content, "rst");
      if (fm.present) return fm;
      // A stray opening fence with no closing delimiter is not frontmatter, and
      // it must not shadow a native docinfo field list that follows. Blank the
      // fence line (keeping its newline so source lines stay aligned) before
      // reading the native metadata — otherwise docinfo parsing would stop on
      // the fence line.
      const nl = content.indexOf("\n");
      if (nl !== -1) return extractDocinfo(content.slice(nl));
    }
    return extractDocinfo(content);
  },
};
