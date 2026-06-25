/**
 * Markdown frontmatter extractor. Splits the leading YAML frontmatter block
 * ourselves (deterministic offsets) and parses it with the `yaml` AST + a
 * LineCounter to recover a JSON-Pointer -> source-line map for annotations.
 */
import { parseDocument, LineCounter, isMap, isSeq, isScalar } from "yaml";
import type { ExtractedMetadata, MetadataExtractor } from "../types.js";

const OPENING = /^---\r?\n/;

interface Block {
  /** Raw YAML between the delimiters (no leading/trailing newline). */
  raw: string;
  /** 1-based file line of the first YAML content line. */
  firstYamlLine: number;
}

/** Locate the leading `--- ... ---` frontmatter block, if any. */
function splitFrontmatter(content: string): Block | null {
  // A BOM stays part of line 1; it doesn't shift line numbers.
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (!OPENING.test(body)) return null;

  const lines = body.split(/\r?\n/);
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...") {
      close = i;
      break;
    }
  }
  if (close === -1) return null;

  return { raw: lines.slice(1, close).join("\n"), firstYamlLine: 2 };
}

function escapePointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Build a JSON-Pointer -> 1-based file line map from a parsed YAML block. */
function buildLineMap(
  doc: ReturnType<typeof parseDocument>,
  lc: LineCounter,
  prefixLines: number,
): Map<string, number> {
  const map = new Map<string, number>();
  // Root pointer maps to the opening `---` line (block start).
  map.set("", 1);

  const lineAt = (offset: number | undefined): number | undefined =>
    offset == null ? undefined : lc.linePos(offset).line + prefixLines;

  const walk = (node: unknown, pointer: string): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = isScalar(pair.key)
          ? String(pair.key.value)
          : String(pair.key);
        const ptr = `${pointer}/${escapePointerSegment(key)}`;
        const line = lineAt(
          (pair.key as { range?: [number, number, number] })?.range?.[0],
        );
        if (line != null) map.set(ptr, line);
        if (pair.value) walk(pair.value, ptr);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        const ptr = `${pointer}/${i}`;
        const line = lineAt(
          (item as { range?: [number, number, number] })?.range?.[0],
        );
        if (line != null) map.set(ptr, line);
        walk(item, ptr);
      });
    }
  };

  if (doc.contents) walk(doc.contents, "");
  return map;
}

function lineForFactory(
  map: Map<string, number>,
): (pointer: string) => number | undefined {
  return (pointer: string) => {
    if (map.has(pointer)) return map.get(pointer);
    // Walk up to the nearest recorded ancestor.
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

/** Core frontmatter extraction shared by the markdown and mdx extractors. */
export function extractFrontmatter(
  content: string,
  format: string,
): ExtractedMetadata {
  const block = splitFrontmatter(content);
  if (!block) {
    return { data: {}, present: false, format, lineFor: () => undefined };
  }

  const lc = new LineCounter();
  const doc = parseDocument(block.raw, { lineCounter: lc });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    // Surface as a thrown error; the command layer records it as a per-file
    // failure so the rest of the run continues.
    throw new Error(`Invalid YAML frontmatter: ${e?.message ?? "parse error"}`);
  }

  const js = doc.toJS({ maxAliasCount: 100 }) as unknown;
  const data =
    js && typeof js === "object" && !Array.isArray(js)
      ? (js as Record<string, unknown>)
      : {};

  const map = buildLineMap(doc, lc, block.firstYamlLine - 1);
  return { data, present: true, format, lineFor: lineForFactory(map) };
}

export const markdownExtractor: MetadataExtractor = {
  name: "markdown",
  extensions: [".md", ".markdown"],
  implemented: true,
  extract: (content) => extractFrontmatter(content, "markdown"),
};
