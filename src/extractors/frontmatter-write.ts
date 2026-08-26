/**
 * Front matter write-back, the inverse of `extractFrontmatter`.
 *
 * The whole design rests on one idea: splice only the characters *between* the
 * fences. `locateFrontmatter` gives offsets into the original content, so the
 * BOM, both fences, the entire document body, and the file's final-newline state
 * survive byte for byte by construction rather than by careful reassembly.
 *
 * Per flavor the merge differs, because the fidelity hazards differ:
 *
 *  - YAML re-emits the block through the `yaml` Document API, which preserves
 *    comments, key order, and scalar styles. Setting a *raw JS scalar* (not a
 *    Node) is deliberate: `YAMLMap.add` then mutates the existing node's value
 *    in place, keeping its comments and quoting.
 *  - TOML splices one key's line span at a time. Re-emitting the block through
 *    `smol-toml` would delete every comment and silently rewrite untouched
 *    values (`2026-06-25T10:00:00Z` becomes `2026-06-25T10:00:00.000Z`), which
 *    is exactly the corruption this module exists to prevent.
 *  - JSON re-emits wholesale: it has no comments to lose, and a spread keeps key
 *    order, so a surgical splice would buy nothing.
 *
 * Every merge is verified by re-parsing the result and comparing it against the
 * expected data before anything is returned, so a serializer bug becomes a
 * refusal rather than a damaged document.
 */
import { parseDocument, isMap, isCollection } from "yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  DocmetaError,
  type ApplyOptions,
  type FrontmatterFlavor,
  type MetadataPatch,
} from "../types.js";
import {
  hasFrontmatterFence,
  locateFrontmatter,
  frontmatterInnerText,
} from "./frontmatter.js";
import { dropUndefined, deepEqual } from "./patch-util.js";

const FENCE: Record<FrontmatterFlavor, string> = {
  yaml: "---",
  toml: "+++",
  json: ";;;",
};

/**
 * Merge `patch` into the document's leading metadata block and return the new
 * content. Pure: no IO, no mutation, and the input string itself is returned
 * when the patch is a no-op.
 */
export function applyFrontmatter(
  content: string,
  patch: MetadataPatch,
  options: ApplyOptions = {},
): string {
  const loc = locateFrontmatter(content);

  // Structural checks run before the empty-patch shortcut, so an empty patch
  // is a usable pre-flight probe for "can this document be written at all?".
  // `fill` uses it to avoid paying for inference on a file it could never
  // write. Returning the content unchanged here would report a false all-clear.
  if (!loc && hasFrontmatterFence(content)) {
    // An opening fence with no closing fence is not front matter, so the
    // locator returns null — but prepending a fresh block above a stray `---`
    // would produce two overlapping fences and corrupt the file. Refuse.
    throw new DocmetaError(
      "Unterminated front matter fence: the opening fence has no matching close. Add a closing fence before filling metadata.",
    );
  }

  const clean = dropUndefined(patch);
  // A key both set and deleted would be ambiguous; the set wins, matching the
  // rule that `patch` is applied and `deletions` removes what remains.
  const deletions = (options.deletions ?? []).filter(
    (k) => !Object.prototype.hasOwnProperty.call(clean, k),
  );
  if (Object.keys(clean).length === 0 && deletions.length === 0) return content;

  // No block: nothing to delete from, so deletions are no-ops by contract —
  // only a set may create a block. Without this guard a delete-only call on a
  // block-less document would insert a bare `---\n---\n`.
  if (!loc) {
    if (Object.keys(clean).length === 0) return content;
    return createBlock(content, clean, options.newBlockFlavor ?? "yaml");
  }

  const inner = frontmatterInnerText(content, loc);
  const merged = mergeBlock(loc.flavor, inner, clean, deletions);
  verify(loc.flavor, inner, merged, clean, deletions);

  /* c8 ignore next 3 -- defensive: every serializer above emits LF only. */
  if (merged.includes("\r")) {
    throw new DocmetaError("Internal error: serialized front matter contains CR.");
  }
  const emitted = loc.eol === "\r\n" ? merged.replace(/\n/g, "\r\n") : merged;

  return (
    content.slice(0, loc.innerStart) +
    (emitted === "" ? "" : emitted + loc.eol) +
    content.slice(loc.innerEnd)
  );
}

/**
 * Remove the fenced front matter block entirely — fences included, plus the
 * single blank separator line that conventionally follows the close. This is
 * not the same as deleting every key, which leaves an empty block behind
 * (`_present` still 1). A document with no located block returns unchanged.
 */
export function stripFrontmatter(content: string): string {
  const loc = locateFrontmatter(content);
  if (!loc) return content;
  const bom = content.slice(0, loc.openStart);
  let rest = content.slice(loc.closeEnd);
  if (rest.startsWith(loc.eol)) rest = rest.slice(loc.eol.length);
  return bom + rest;
}

/**
 * Write-back for formats that *also* have a native metadata syntax (rst
 * docinfo, AsciiDoc document headers). Those native reads are lossy — values
 * are coerced through a YAML scalar parse, and an rst `title` is synthesized
 * from the section heading — so they are not round-trippable. Nor can a fenced
 * block simply be created: a bare `---` is a transition in reStructuredText and
 * an open-block delimiter in AsciiDoc, so inventing one would silently change
 * how the document renders. Write only into a block that already exists.
 */
export function applyFencedOnly(
  content: string,
  patch: MetadataPatch,
  options: ApplyOptions | undefined,
  format: string,
): string {
  // Checked before the empty-patch shortcut so this doubles as a writability
  // probe — see the note in applyFrontmatter.
  if (locateFrontmatter(content) === null) {
    if (hasFrontmatterFence(content)) {
      throw new DocmetaError(
        "Unterminated front matter fence: the opening fence has no matching close. Add a closing fence before filling metadata.",
      );
    }
    throw new DocmetaError(
      `This ${format} document has no fenced front matter block; docmeta can only write fenced front matter for ${format}. Add a fenced block, or set the field manually.`,
    );
  }
  if (
    Object.keys(dropUndefined(patch)).length === 0 &&
    (options?.deletions ?? []).length === 0
  ) {
    return content;
  }
  return applyFrontmatter(content, patch, options);
}
// ---------------------------------------------------------------------------
// Block creation
// ---------------------------------------------------------------------------

function createBlock(
  content: string,
  patch: MetadataPatch,
  flavor: FrontmatterFlavor,
): string {
  const bom = content.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const rest = bom === "" ? content : content.slice(1);
  // Take the document's *first* terminator, not any CRLF anywhere in it \u2014 a
  // stray CRLF inside a pasted code block must not make an otherwise
  // LF-normalized file gain a CRLF front matter block.
  const eol = /\r\n|\n/.exec(rest)?.[0] === "\r\n" ? "\r\n" : "\n";
  const fence = FENCE[flavor];

  const body = mergeBlock(flavor, "", patch);
  verify(flavor, "", body, patch);

  const block = [fence, ...body.split("\n"), fence].join(eol) + eol;
  // One blank line between the block and the document, unless the document is
  // empty or already starts with one.
  const gap = rest === "" || rest.startsWith("\n") || rest.startsWith("\r\n") ? "" : eol;
  return bom + block + gap + rest;
}

// ---------------------------------------------------------------------------
// Per-flavor merge
// ---------------------------------------------------------------------------

function mergeBlock(
  flavor: FrontmatterFlavor,
  inner: string,
  patch: MetadataPatch,
  deletions: readonly string[] = [],
): string {
  switch (flavor) {
    case "yaml":
      return mergeYaml(inner, patch, deletions);
    case "toml":
      return mergeToml(inner, patch, deletions);
    case "json":
      return mergeJson(inner, patch, deletions);
  }
}

function mergeYaml(
  inner: string,
  patch: MetadataPatch,
  deletions: readonly string[] = [],
): string {
  const doc = parseDocument(inner);
  if (doc.errors.length > 0) {
    throw new DocmetaError(
      `Cannot rewrite invalid YAML front matter: ${doc.errors[0]?.message ?? "parse error"}`,
    );
  }
  if (doc.contents != null && !isMap(doc.contents)) {
    throw new DocmetaError(
      "Cannot rewrite front matter: the root must be a mapping.",
    );
  }

  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === "object") {
      // Collections must be rebuilt, but carry the previous flow/block style so
      // `tags: [a, b]` doesn't silently become a block sequence.
      const prev = doc.get(key, true);
      const node = doc.createNode(value);
      if (isCollection(prev) && isCollection(node) && prev.flow) node.flow = true;
      doc.set(key, node);
    } else {
      // Raw scalar: takes YAMLMap.add's in-place branch, preserving the
      // existing node's comments and quoting style.
      doc.set(key, value);
    }
  }
  // Deleting through the Document API removes the key's node — and its own
  // comments with it — while every other node stays untouched.
  for (const key of deletions) doc.delete(key);
  // lineWidth: 0 disables folding. The default (80) would wrap long values onto
  // continuation lines, rewriting keys the patch never touched.
  return doc.toString({ lineWidth: 0 }).replace(/\n$/, "");
}

function mergeJson(
  inner: string,
  patch: MetadataPatch,
  deletions: readonly string[] = [],
): string {
  const parsed = parseJsonBlockText(inner);
  const indent = /^\{\s*\n([ \t]+)/.exec(inner)?.[1] ?? "  ";
  const merged = Object.fromEntries(
    Object.entries({ ...parsed, ...patch }).filter(
      ([key]) => !deletions.includes(key),
    ),
  );
  return JSON.stringify(merged, null, indent);
}

// ---------------------------------------------------------------------------
// TOML: surgical per-key line splicing
// ---------------------------------------------------------------------------

// A top-level key assignment, bare or simply quoted. Mirrors the reader's
// TOML_KEY so read and write agree on what "top-level" means.
const TOML_KEY = /^\s*(?:([A-Za-z0-9_-]+)|"([^"\\]*)"|'([^']*)')\s*=/;
const TOML_TABLE = /^\s*\[\[?\s*([A-Za-z0-9_-]+)/;

interface RootAssignment {
  key: string;
  /** Line index of the assignment's first line. */
  start: number;
  /** Line index just past its last line (values may span lines). */
  end: number;
}

/**
 * Index the root table's key assignments. Once a `[table]` header appears every
 * following assignment belongs to that table, not the root, so scanning stops
 * there — `rootEnd` is where new root keys must be inserted.
 */
function scanRootTable(lines: string[]): {
  assignments: RootAssignment[];
  rootEnd: number;
} {
  const assignments: RootAssignment[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (TOML_TABLE.test(line)) break;
    const m = TOML_KEY.exec(line);
    const key = m?.[1] ?? m?.[2] ?? m?.[3];
    if (key == null) continue;
    const end = assignmentEnd(lines, i);
    assignments.push({ key, start: i, end });
    i = end - 1;
  }
  return { assignments, rootEnd: i };
}

/**
 * Line index just past an assignment starting at `start`. A value continues
 * across lines while brackets/braces are unbalanced or a multi-line string is
 * open, so quotes and `#` comments must be tracked to avoid counting brackets
 * that sit inside them.
 */
function assignmentEnd(lines: string[], start: number): number {
  let depth = 0;
  let multi: string | null = null;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let j = 0;
    while (j < line.length) {
      if (multi != null) {
        if (line.startsWith(multi, j)) {
          multi = null;
          j += 3;
        } else j++;
        continue;
      }
      if (line.startsWith('"""', j) || line.startsWith("'''", j)) {
        multi = line.slice(j, j + 3);
        j += 3;
        continue;
      }
      const ch = line[j] ?? "";
      if (ch === '"' || ch === "'") {
        j = skipString(line, j, ch);
        continue;
      }
      if (ch === "#") break; // comment runs to end of line
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      j++;
    }
    if (multi == null && depth <= 0) return i + 1;
  }
  return i;
}

/** Index just past the string literal opening at `from`. */
function skipString(line: string, from: number, quote: string): number {
  let j = from + 1;
  while (j < line.length) {
    const c = line[j];
    if (quote === '"' && c === "\\") {
      j += 2;
      continue;
    }
    j++;
    if (c === quote) break;
  }
  return j;
}

/** Emit one `key = value` line, rejecting values TOML cannot express inline. */
function emitTomlLine(key: string, value: unknown): string {
  if (value === null) {
    throw new DocmetaError(
      `TOML has no null value; cannot set "${key}" in TOML front matter.`,
    );
  }
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  ) {
    throw new DocmetaError(
      `Cannot write the object value for "${key}" into TOML front matter.`,
    );
  }
  const line = stringifyToml({ [key]: value }).trimEnd();
  if (line.includes("\n") || line.startsWith("[")) {
    throw new DocmetaError(
      `Cannot write the value for "${key}" into TOML front matter.`,
    );
  }
  return line;
}

function mergeToml(
  inner: string,
  patch: MetadataPatch,
  deletions: readonly string[] = [],
): string {
  const lines = inner === "" ? [] : inner.split("\n");
  const { assignments, rootEnd } = scanRootTable(lines);
  const byKey = new Map(assignments.map((a) => [a.key, a]));

  // Replace in place, marking replaced spans; collect the rest for appending.
  const replaced = new Map<number, string>();
  const dropped = new Set<number>();
  const appended: string[] = [];

  for (const [key, value] of Object.entries(patch)) {
    const line = emitTomlLine(key, value);
    const hit = byKey.get(key);
    if (!hit) {
      appended.push(line);
      continue;
    }
    replaced.set(hit.start, line);
    for (let i = hit.start + 1; i < hit.end; i++) dropped.add(i);
  }

  // Deletion is the replacement's degenerate case: the whole span goes,
  // nothing comes back. The same splice discipline keeps comments and every
  // untouched line byte-identical.
  for (const key of deletions) {
    const hit = byKey.get(key);
    if (!hit) continue;
    for (let i = hit.start; i < hit.end; i++) dropped.add(i);
  }

  // New keys go at the end of the root table, above any blank lines that
  // separate it from the first `[table]` header.
  let insertAt = rootEnd;
  while (insertAt > 0 && (lines[insertAt - 1] ?? "").trim() === "") insertAt--;

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === insertAt) out.push(...appended);
    if (dropped.has(i)) continue;
    out.push(replaced.get(i) ?? lines[i] ?? "");
  }
  if (insertAt >= lines.length) out.push(...appended);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function parseJsonBlockText(text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DocmetaError(
      "Cannot rewrite front matter: the root must be an object.",
    );
  }
  return parsed as Record<string, unknown>;
}

/** Read a block back with its own flavor's parser, for the verification pass. */
function parseBlock(
  flavor: FrontmatterFlavor,
  text: string,
): Record<string, unknown> {
  switch (flavor) {
    case "json":
      return parseJsonBlockText(text);
    case "toml":
      return text.trim() === ""
        ? {}
        : parseToml(text);
    case "yaml": {
      const doc = parseDocument(text);
      if (doc.errors.length > 0) {
        throw new DocmetaError(
          `Cannot rewrite invalid YAML front matter: ${doc.errors[0]?.message ?? "parse error"}`,
        );
      }
      const js: unknown = doc.toJS({ maxAliasCount: 100 });
      if (js == null) return {};
      if (typeof js !== "object" || Array.isArray(js)) {
        throw new DocmetaError(
          "Cannot rewrite front matter: the root must be a mapping.",
        );
      }
      return js as Record<string, unknown>;
    }
  }
}

/**
 * Re-read the merged block and confirm it says exactly what it should. This is
 * the difference between a serializer bug being a refusal and a serializer bug
 * being a corrupted file.
 */
function verify(
  flavor: FrontmatterFlavor,
  inner: string,
  merged: string,
  patch: MetadataPatch,
  deletions: readonly string[] = [],
): void {
  const expected = Object.fromEntries(
    Object.entries({ ...parseBlock(flavor, inner), ...patch }).filter(
      ([key]) => !deletions.includes(key),
    ),
  );
  const actual = parseBlock(flavor, merged);
  if (!deepEqual(actual, expected)) {
    throw new DocmetaError(
      "Refusing to write front matter: the rewritten block did not read back as expected.",
    );
  }
}
