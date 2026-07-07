/**
 * Shared front matter extractor, used by the Markdown, MDX, AsciiDoc, and
 * reStructuredText formats. Three fenced flavors are supported, matching Vale
 * (the `adrg/frontmatter` convention):
 *
 *  - YAML — fenced by `--- … ---` (or `...` close).
 *  - TOML — fenced by `+++ … +++`.
 *  - JSON — fenced by `;;; … ;;;`, with a JSON object inside.
 *
 * Every flavor is the same-shape fenced block (open fence on line 1, content
 * from line 2, matching close fence), so we split them uniformly and only the
 * inner parse differs. YAML and JSON are parsed with the `yaml` AST + a
 * LineCounter to recover a JSON-Pointer -> source-line map (JSON is a strict
 * subset of YAML, so the same walk gives per-key and per-array-item lines for
 * free). TOML is parsed with `smol-toml` for native typing, with a best-effort
 * top-level-key line scan.
 */
import { parseDocument, LineCounter, isMap, isSeq, isScalar } from "yaml";
import { parse as parseToml } from "smol-toml";
import type { ExtractedMetadata } from "../types.js";

type Flavor = "yaml" | "toml" | "json";

/** Any recognized opening fence, for the adoc/rst delegation gate. */
const OPEN_FENCE = /^(?:---|\+\+\+|;;;)\r?\n/;

interface Fence {
  open: RegExp;
  flavor: Flavor;
  isClose(line: string): boolean;
}

const FENCES: Fence[] = [
  { open: /^---\r?\n/, flavor: "yaml", isClose: (l) => l === "---" || l === "..." },
  { open: /^\+\+\+\r?\n/, flavor: "toml", isClose: (l) => l === "+++" },
  { open: /^;;;\r?\n/, flavor: "json", isClose: (l) => l === ";;;" },
];

interface Block {
  /** Raw content between the fences (no leading/trailing newline). */
  raw: string;
  /** Which flavor the opening fence selected. */
  flavor: Flavor;
  /** 1-based file line of the first content line (always 2). */
  firstContentLine: number;
}

/** Strip a leading BOM; it stays part of line 1 and doesn't shift line numbers. */
function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/** True when the content opens with a recognized front matter fence. */
export function hasFrontmatterFence(content: string): boolean {
  return OPEN_FENCE.test(stripBom(content));
}

/** Locate the leading fenced front matter block, if any. */
function splitFrontmatter(content: string): Block | null {
  const body = stripBom(content);
  const fence = FENCES.find((f) => f.open.test(body));
  if (!fence) return null;

  const lines = body.split(/\r?\n/);
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (fence.isClose(lines[i] ?? "")) {
      close = i;
      break;
    }
  }
  if (close === -1) return null;

  return {
    raw: lines.slice(1, close).join("\n"),
    flavor: fence.flavor,
    firstContentLine: 2,
  };
}

export function escapePointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Build a JSON-Pointer -> 1-based file line map from a parsed YAML/JSON block. */
function buildLineMap(
  doc: ReturnType<typeof parseDocument>,
  lc: LineCounter,
  prefixLines: number,
): Map<string, number> {
  const map = new Map<string, number>();
  // Root pointer maps to the opening fence line (block start).
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

// A top-level TOML key assignment — bare (`key = …`) or simply quoted
// (`"my key" = …` / `'my-key' = …`) — or a `[table]` / `[[array of tables]]`
// header. Dotted keys and basic-quoted keys containing escape sequences are not
// matched (best-effort: they fall back to the block's opening line).
const TOML_KEY = /^\s*(?:([A-Za-z0-9_-]+)|"([^"\\]*)"|'([^']*)')\s*=/;
const TOML_TABLE = /^\s*\[\[?\s*([A-Za-z0-9_-]+)/;

/**
 * Best-effort TOML line map: `smol-toml` returns a plain object without
 * positions, so scan the raw block for top-level `key =` assignments and
 * `[table]` / `[[array of tables]]` headers. Only keys in the root-table context are
 * top-level pointers — once a table header appears, subsequent `key =` lines are
 * nested under it, so they are not recorded as top-level keys (that would
 * mis-attribute e.g. `[meta]\ntitle = …` to the root `/title`). Nested pointers
 * resolve to the nearest recorded ancestor via `lineForFactory`.
 */
function buildTomlLineMap(raw: string, prefixLines: number): Map<string, number> {
  const map = new Map<string, number>();
  map.set("", 1);
  // First occurrence wins; record a pointer only if not already seen.
  const record = (key: string, i: number): void => {
    const ptr = `/${escapePointerSegment(key)}`;
    if (!map.has(ptr)) map.set(ptr, i + 1 + prefixLines);
  };

  let inRootTable = true;
  raw.split("\n").forEach((line, i) => {
    const table = TOML_TABLE.exec(line);
    if (table?.[1] != null) {
      // A `[table]` / `[[array]]` header: record it, then leave root context —
      // every following `key =` belongs to a table, not the document root.
      record(table[1], i);
      inRootTable = false;
      return;
    }
    if (!inRootTable) return;
    const km = TOML_KEY.exec(line);
    // Group 1 = bare key, 2 = basic-quoted, 3 = literal-quoted.
    const key = km?.[1] ?? km?.[2] ?? km?.[3];
    if (key != null) record(key, i);
  });
  return map;
}

export function lineForFactory(
  map: Map<string, number>,
): (pointer: string) => number | undefined {
  return (pointer: string) => {
    // A bare top-level key (e.g. "type") maps to its "/type" JSON pointer.
    const start =
      pointer !== "" && !pointer.startsWith("/")
        ? `/${escapePointerSegment(pointer)}`
        : pointer;
    if (map.has(start)) return map.get(start);
    // A value can be an array/object, so Ajv may report nested pointers like
    // "/tags/0". Walk up to the nearest recorded ancestor.
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
 * Coerce a parsed document root to the metadata object shape. An empty document
 * (`null`/`undefined`) is treated as no metadata (`{}`). A scalar or array root
 * is malformed frontmatter — metadata is a key/value object — so it throws,
 * uniformly across flavors. `label` names the flavor for the error message.
 */
function rootObject(parsed: unknown, label: string): Record<string, unknown> {
  if (parsed == null) return {};
  if (typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new Error(`Invalid ${label} frontmatter: root must be an object`);
}

function parseYamlBlock(
  raw: string,
  prefixLines: number,
  format: string,
): ExtractedMetadata {
  const lc = new LineCounter();
  const doc = parseDocument(raw, { lineCounter: lc });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    // Surface as a thrown error; the command layer records it as a per-file
    // failure so the rest of the run continues.
    throw new Error(`Invalid YAML frontmatter: ${e?.message ?? "parse error"}`);
  }
  const data = rootObject(doc.toJS({ maxAliasCount: 100 }) as unknown, "YAML");
  const map = buildLineMap(doc, lc, prefixLines);
  return { data, present: true, format, lineFor: lineForFactory(map) };
}

function emptyBlock(format: string): ExtractedMetadata {
  // An empty fenced block is present with no data (parity with empty YAML).
  const map = new Map<string, number>([["", 1]]);
  return { data: {}, present: true, format, lineFor: lineForFactory(map) };
}

function parseJsonBlock(
  raw: string,
  prefixLines: number,
  format: string,
): ExtractedMetadata {
  if (raw.trim() === "") return emptyBlock(format);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Invalid JSON frontmatter: ${e instanceof Error ? e.message : "parse error"}`,
    );
  }
  // Thrown outside the try so its message isn't re-wrapped as a parse error.
  const data = rootObject(parsed, "JSON");
  // JSON is a strict subset of YAML: reuse the YAML AST purely for the line map.
  const lc = new LineCounter();
  const doc = parseDocument(raw, { lineCounter: lc });
  const map = buildLineMap(doc, lc, prefixLines);
  return { data, present: true, format, lineFor: lineForFactory(map) };
}

function parseTomlBlock(
  raw: string,
  prefixLines: number,
  format: string,
): ExtractedMetadata {
  if (raw.trim() === "") return emptyBlock(format);
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (e) {
    throw new Error(
      `Invalid TOML frontmatter: ${e instanceof Error ? e.message : "parse error"}`,
    );
  }
  // A valid TOML document is always a table, but stay uniform with the others.
  const data = rootObject(parsed, "TOML");
  const map = buildTomlLineMap(raw, prefixLines);
  return { data, present: true, format, lineFor: lineForFactory(map) };
}

/** Core front matter extraction shared by the markdown, mdx, adoc, rst formats. */
export function extractFrontmatter(
  content: string,
  format: string,
): ExtractedMetadata {
  const block = splitFrontmatter(content);
  if (!block) {
    return { data: {}, present: false, format, lineFor: () => undefined };
  }

  const prefixLines = block.firstContentLine - 1;
  switch (block.flavor) {
    case "yaml":
      return parseYamlBlock(block.raw, prefixLines, format);
    case "json":
      return parseJsonBlock(block.raw, prefixLines, format);
    case "toml":
      return parseTomlBlock(block.raw, prefixLines, format);
  }
}
