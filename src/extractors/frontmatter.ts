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
import { isoDateValue } from "./date-value.js";
import type { ExtractedMetadata, FrontmatterFlavor } from "../types.js";

type Flavor = FrontmatterFlavor;

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

/**
 * Character offsets bracketing the leading fenced block, measured against the
 * *original* content — BOM included, CRLF intact. Writing metadata back is a
 * surgical splice of `[innerStart, innerEnd)`, so everything outside that range
 * (the BOM, both fences, the whole body, the file's final-newline state) is
 * preserved byte for byte by construction rather than by careful reassembly.
 */
export interface FrontmatterLocation {
  /** Which flavor the opening fence selected. */
  flavor: Flavor;
  /** Offset of the opening fence's first char (1 when a BOM precedes it). */
  openStart: number;
  /** Offset just past the opening fence's terminator == start of inner text. */
  innerStart: number;
  /** Offset of the closing fence line's first char == end of inner text. */
  innerEnd: number;
  /** Offset just past the closing fence's terminator (or EOF). */
  closeEnd: number;
  /** Line terminator of the opening fence line — the block's EOL on re-emission. */
  eol: "\n" | "\r\n";
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

/**
 * Locate the leading fenced front matter block, if any. Returns null when there
 * is no opening fence *or* no matching closing fence — an unterminated fence is
 * not front matter (see the rst extractor, which relies on that distinction).
 */
export function locateFrontmatter(content: string): FrontmatterLocation | null {
  const bom = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  const body = bom === 1 ? content.slice(1) : content;
  const fence = FENCES.find((f) => f.open.test(body));
  if (!fence) return null;

  // The open regexes all require a terminator, so this newline always exists.
  const openNl = body.indexOf("\n");
  const eol = openNl > 0 && body.charCodeAt(openNl - 1) === 13 ? "\r\n" : "\n";
  const innerStart = openNl + 1;

  let cursor = innerStart;
  while (cursor <= body.length) {
    const nl = body.indexOf("\n", cursor);
    const hasNl = nl !== -1;
    const lineEnd = hasNl ? nl : body.length;
    const hadCr = lineEnd > cursor && body.charCodeAt(lineEnd - 1) === 13;
    const line = body.slice(cursor, hadCr ? lineEnd - 1 : lineEnd);
    if (fence.isClose(line)) {
      return {
        flavor: fence.flavor,
        openStart: bom,
        innerStart: innerStart + bom,
        innerEnd: cursor + bom,
        closeEnd: (hasNl ? lineEnd + 1 : lineEnd) + bom,
        eol,
        firstContentLine: 2,
      };
    }
    if (!hasNl) break;
    cursor = lineEnd + 1;
  }
  return null;
}

/**
 * The block's inner text, LF-normalized with the final terminator removed —
 * byte-identical to what the parsers have always received, which is what lets
 * `extractFrontmatter` sit on top of the locator with no behavior change.
 */
export function frontmatterInnerText(
  content: string,
  loc: FrontmatterLocation,
): string {
  return content
    .slice(loc.innerStart, loc.innerEnd)
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "");
}

// Re-exported so `asciidoc` and `rst` keep one import site while the
// implementations live with the other pointer helpers, where `html` and `xml`
// can share them instead of each keeping a copy.
export {
  escapePointerSegment,
  positionForFactory as lineForFactory,
} from "./pointer.js";
import { escapePointerSegment, positionForFactory } from "./pointer.js";

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
        // `| null` in the asserted type, not decoration: `yaml` types a
        // Pair's key as nullable, and asserting it away would make the `?.`
        // below read as dead code while the null it guards is still reachable.
        const line = lineAt(
          (pair.key as { range?: [number, number, number] } | null)?.range?.[0],
        );
        if (line != null) map.set(ptr, line);
        if (pair.value) walk(pair.value, ptr);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        const ptr = `${pointer}/${i}`;
        // `| null` for the same reason as the Pair key above.
        const line = lineAt(
          (item as { range?: [number, number, number] } | null)?.range?.[0],
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
      // A `[table]` / `[[array of tables]]` header: record it, then leave root
      // context — every following `key =` belongs to a table, not the root.
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
  return { data, present: true, format, lineFor: positionForFactory(map) };
}

function emptyBlock(format: string): ExtractedMetadata {
  // An empty fenced block is present with no data (parity with empty YAML).
  const map = new Map<string, number>([["", 1]]);
  return { data: {}, present: true, format, lineFor: positionForFactory(map) };
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
  return { data, present: true, format, lineFor: positionForFactory(map) };
}

/**
 * Replace TOML's native dates with the strings they were authored as.
 *
 * TOML is the only flavor with a real date type: `date = 2026-06-25` parses to
 * a `Date`, where the same line under a YAML or JSON fence yields a string. A
 * schema sees the parsed value, so without this a field typed `"string"` —
 * OKF's `timestamp`, Hugo's `date` and `lastmod` — rejects the *unquoted*
 * spelling, which is the idiomatic one, and accepts only the quoted one.
 *
 * The per-value spelling is `isoDateValue`, shared with `schemas infer` so the
 * two cannot disagree about what a `Date` looks like as JSON.
 *
 * Recursive, because a date can sit inside a `[table]` or an array.
 */
function withoutNativeDates(value: unknown): unknown {
  if (value instanceof Date) return isoDateValue(value);
  if (Array.isArray(value)) return value.map(withoutNativeDates);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, withoutNativeDates(v)]),
    );
  }
  return value;
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
  const data = rootObject(withoutNativeDates(parsed), "TOML");
  const map = buildTomlLineMap(raw, prefixLines);
  return { data, present: true, format, lineFor: positionForFactory(map) };
}

/** Core front matter extraction shared by the markdown, mdx, adoc, rst formats. */
export function extractFrontmatter(
  content: string,
  format: string,
): ExtractedMetadata {
  const loc = locateFrontmatter(content);
  if (!loc) {
    return { data: {}, present: false, format, lineFor: () => undefined };
  }

  const raw = frontmatterInnerText(content, loc);
  const prefixLines = loc.firstContentLine - 1;
  // `fenced` is stamped here, the one place that just located a complete
  // block — a per-extraction fact, not an extractor capability: RST and
  // AsciiDoc reach their native-header fallbacks through their own extract()
  // and never pass this point for those files.
  switch (loc.flavor) {
    case "yaml":
      return { ...parseYamlBlock(raw, prefixLines, format), fenced: true };
    case "json":
      return { ...parseJsonBlock(raw, prefixLines, format), fenced: true };
    case "toml":
      return { ...parseTomlBlock(raw, prefixLines, format), fenced: true };
  }
}
