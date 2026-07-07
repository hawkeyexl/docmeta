/**
 * AsciiDoc metadata extractor.
 *
 * Two metadata styles are accepted:
 *  1. A leading fenced frontmatter block (YAML `--- … ---`, TOML `+++ … +++`,
 *     or JSON `;;; … ;;;`), as some static-site generators use. This delegates
 *     to the shared `extractFrontmatter` so the values are typed and the line
 *     map comes for free.
 *  2. The native AsciiDoc document header: the `= Title` line plus `:key: value`
 *     attribute entries, running from the first line until the first blank line.
 *     Attribute values are parsed as YAML scalars so `2` -> number, `true` ->
 *     boolean, etc., consistent with frontmatter typing.
 */
import { parse as parseYamlScalar } from "yaml";
import type { ExtractedMetadata, MetadataExtractor } from "../types.js";
import {
  extractFrontmatter,
  hasFrontmatterFence,
  escapePointerSegment,
  lineForFactory,
} from "./frontmatter.js";

const TITLE = /^=\s+(.+?)\s*$/;
// `:!name:` or `:name!:` — an unset attribute.
const UNSET = /^:(?:!([^:\s]+)|([^:\s]+)!):\s*$/;
// `:name:` or `:name: value` — a set attribute (value optional).
const SET = /^:([^:\s!][^:\s]*):(?:\s+(.*\S))?\s*$/;

/** Parse a raw attribute value as a YAML scalar, falling back to the string. */
function typeValue(raw: string): unknown {
  try {
    return parseYamlScalar(raw);
  } catch {
    return raw;
  }
}

/** Parse the native AsciiDoc document header (title + attribute entries). */
function extractHeader(content: string): ExtractedMetadata {
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = body.split(/\r?\n/);

  const data: Record<string, unknown> = {};
  const map = new Map<string, number>();
  map.set("", 1);

  const setKey = (key: string, value: unknown, line: number): void => {
    data[key] = value;
    map.set(`/${escapePointerSegment(key)}`, line);
  };

  for (const [i, line] of lines.entries()) {
    // The header ends at the first blank line.
    if (line.trim() === "") break;

    if (i === 0) {
      const title = TITLE.exec(line);
      if (title?.[1] != null) {
        setKey("title", title[1], i + 1);
        continue;
      }
    }

    const unset = UNSET.exec(line);
    if (unset) {
      const name = unset[1] ?? unset[2];
      if (name != null) setKey(name, false, i + 1);
      continue;
    }

    const set = SET.exec(line);
    if (set?.[1] != null) {
      const value = set[2] === undefined ? true : typeValue(set[2]);
      setKey(set[1], value, i + 1);
      continue;
    }
    // Non-attribute header lines (e.g. author/revision) are ignored.
  }

  const present = Object.keys(data).length > 0;
  return {
    data,
    present,
    format: "asciidoc",
    lineFor: lineForFactory(map),
  };
}

export const asciidocExtractor: MetadataExtractor = {
  name: "asciidoc",
  extensions: [".adoc", ".asciidoc"],
  implemented: true,
  extract(content) {
    if (hasFrontmatterFence(content)) {
      // Delegate only when a complete frontmatter block is actually present;
      // a stray opening fence with no closing delimiter should not shadow a
      // native AsciiDoc header that follows.
      const fm = extractFrontmatter(content, "asciidoc");
      if (fm.present) return fm;
      // Note: unlike rst, we do NOT slice the stray fence line off here.
      // `extractHeader` already ignores the fence line in place and keeps every
      // `:name: value` attribute on its true source line. Slicing would either
      // break the blank-line-terminated header scan (a blanked line 1 ends it)
      // or shift every attribute line by one. The document title is not
      // recovered in this case — which is correct: an AsciiDoc `= Title` is only
      // the document title on the very first line, so a stray fence above it
      // disqualifies it as a title.
    }
    return extractHeader(content);
  },
};
