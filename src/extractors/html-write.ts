/**
 * HTML write-back, the inverse of `readHtml`.
 *
 * Same idea as `frontmatter-write.ts`: never re-serialize, only splice. parse5's
 * serializer would materialize implied `<html>`/`<head>`/`<body>`, re-encode
 * entities, drop the original attribute quoting and rewrite the doctype — a
 * hand-authored page would come back reformatted and `fill` would produce a diff
 * touching every line. Instead every edit is a character range taken from
 * parse5's `sourceCodeLocation`, so everything outside the ranges survives by
 * construction rather than by careful reassembly.
 *
 * Where a value goes is decided by `readHtml`'s `sources` map, not by a rule of
 * this module's own. `fill` rewrites values that are present but *invalid*, not
 * just missing ones, so "new values go in a fresh <meta>" would leave the stale
 * tag the reader actually honors sitting right beside the correction — green
 * report, wrong page. A write lands on whatever the read took its value from.
 *
 * Values are emitted as YAML scalars because that is how they are read back
 * (`typeValue`). The string "2" therefore emits with its quotes and survives the
 * round trip; a value needing more than one line cannot fit in an attribute at
 * all and is refused rather than truncated.
 */
import { stringify as stringifyYaml } from "yaml";
import {
  DocmetaError,
  type ApplyOptions,
  type MetadataPatch,
} from "../types.js";
import { dropUndefined, deepEqual } from "./patch-util.js";
import { readHtml, type Element, type HtmlRead } from "./html-read.js";
import { escapeText, valuesFor } from "./element-write.js";

/** One character-range replacement in the source. */
interface Edit {
  start: number;
  end: number;
  text: string;
}

export function applyHtml(
  original: string,
  patch: MetadataPatch,
  options: ApplyOptions = {},
): string {
  // `readHtml` strips a leading BOM before parsing — see there for why parse5
  // makes that necessary — so every position it reports is relative to the text
  // it hands back. Splice against that same text and restore the BOM as a
  // prefix, which leaves no offset arithmetic to get wrong.
  const before = readHtml(original, { elements: options.elements });
  const content = before.body;

  // Structural checks run before the empty-patch shortcut, so an empty patch is
  // a usable pre-flight probe for "can this document be written at all?".
  // `fill` uses it to skip paying for inference on a file it could never write.
  const headStart = before.head?.sourceCodeLocation?.startTag;
  if (before.head === undefined || headStart == null) {
    throw new DocmetaError(
      "This HTML document has no <head> element; docmeta fill writes metadata into <head>. Add one, or set the field manually.",
    );
  }

  const clean = dropUndefined(patch);
  if (Object.keys(clean).length === 0) return original;

  const edits: Edit[] = [];
  const inserts: string[] = [];
  /** Elements this write touches, so `verify` knows which keys move with them. */
  const moved = new Set<Element>();
  for (const [key, value] of Object.entries(clean)) {
    const source = before.sources.get(key);
    // Emitted per branch rather than up front. A list-valued key is emitted one
    // item at a time below; emitting the whole array here would serialize it as
    // a YAML block and refuse it as "needs more than one line" — a write that
    // is perfectly expressible as one value per element.
    if (source === undefined) {
      const name = escapeAttr(key, DQ);
      inserts.push(
        "<meta name=" + DQ + name + DQ + " content=" + DQ +
          escapeAttr(emitScalar(key, value), DQ) + DQ + ">",
      );
    } else if (source.kind === "meta") {
      edits.push(metaEdit(content, source.el, key, emitScalar(key, value)));
      moved.add(source.el);
    } else if (source.kind === "title") {
      edits.push(elementTextEdit(source.el, key, emitScalar(key, value)));
      moved.add(source.el);
    } else {
      // An element-derived key — `head.title`, or a config `@attr` path.
      // Written where it was read, exactly as the XML side does: both replace
      // a span that already exists, which changes content and not shape and so
      // cannot make the document invalid.
      const values = valuesFor(key, value, source.els.length);
      source.els.forEach((el, i) => {
        const one = emitScalar(key, values[i]);
        edits.push(
          source.kind === "element-attr"
            ? elementAttrEdit(content, el, source.name, key, one)
            : elementTextEdit(el, key, one),
        );
        moved.add(el);
      });
    }
  }

  if (inserts.length > 0) {
    edits.push(insertEdit(content, before.head, headStart.endOffset, inserts));
  }

  const next = spliceAll(content, edits);
  verify(next, before, clean, moved, options);
  // `content === original` is the BOM test: `readHtml` returns `body` with any
  // leading BOM removed, so the two are the same value exactly when there was
  // none to remove. When there was, it is the single character at `original[0]`,
  // put back in front of the spliced text.
  return content === original ? next : original.slice(0, 1) + next;
}

const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);

/** Replace the value span of an existing `<meta>`'s `content` attribute. */
function metaEdit(
  content: string,
  el: Element,
  key: string,
  emitted: string,
): Edit {
  return elementAttrEdit(content, el, "content", key, emitted);
}

/** Replace the value span of a named attribute on any element. */
function elementAttrEdit(
  content: string,
  el: Element,
  attrName: string,
  key: string,
  emitted: string,
): Edit {
  const attrs = el.sourceCodeLocation?.attrs;
  const attrLocation =
    attrs && Object.prototype.hasOwnProperty.call(attrs, attrName)
      ? attrs[attrName]
      : undefined;
  if (attrLocation == null) {
    throw new DocmetaError(
      `Refusing to write "${key}": <${el.tagName}> has no locatable "${attrName}" attribute.`,
    );
  }
  const span = attrValueSpan(
    content,
    attrLocation.startOffset,
    attrLocation.endOffset,
  );
  if (span === undefined) {
    throw new DocmetaError(
      `Refusing to write "${key}": its "${attrName}" attribute could not be located precisely.`,
    );
  }
  const value = escapeAttr(emitted, span.quote);
  return {
    start: span.start,
    end: span.end,
    text: span.wrap ? span.quote + value + span.quote : value,
  };
}

/**
 * Replace the text span of an element — `<title>`, or any `<head>` child a
 * lifted key was read from.
 *
 * `<title>` is RCDATA, so markup is not parsed inside it, but an unescaped "<"
 * still ends the element for some consumers. `escapeText` escapes ">" too,
 * which RCDATA does not require but linters and stricter parsers flag, and
 * which the attribute path already does.
 */
function elementTextEdit(el: Element, key: string, emitted: string): Edit {
  const location = el.sourceCodeLocation;
  const open = location?.startTag;
  const close = location?.endTag;
  if (open == null || close == null) {
    throw new DocmetaError(
      `Refusing to write "${key}": the <${el.tagName}> element is not explicitly closed.`,
    );
  }
  return {
    start: open.endOffset,
    end: close.startOffset,
    text: escapeText(emitted),
  };
}

/**
 * Insert new `<meta>` tags immediately after `<head>`'s start tag, indented to
 * match whatever is already inside it.
 */
function insertEdit(
  content: string,
  head: Element,
  at: number,
  tags: string[],
): Edit {
  const { eol, indent } = headStyle(content, head, at);
  const text = tags.map((t) => `${eol}${indent}${t}`).join("");
  return { start: at, end: at, text };
}

/**
 * The line ending and indentation to use inside `<head>`, taken from its first
 * existing child so an inserted tag looks like the ones around it.
 */
function headStyle(
  content: string,
  head: Element,
  at: number,
): { eol: string; indent: string } {
  for (const child of head.childNodes) {
    const start = child.sourceCodeLocation?.startOffset;
    if (start == null || start < at) continue;
    const lineStart = content.lastIndexOf("\n", start - 1) + 1;
    const between = content.slice(lineStart, start);
    // Only whitespace counts as indentation; a tag sharing a line with other
    // content tells us nothing about how the file is laid out.
    if (/^[ \t]*$/.test(between)) {
      return {
        eol: crlfAt(content, lineStart) ? "\r\n" : "\n",
        indent: between,
      };
    }
  }
  // Reached only for an empty `<head></head>`, where there is no child to copy
  // the style from. Look only at the text above the insertion point: a document
  // that mixes endings — an LF head in a generator's CRLF body — would
  // otherwise take its head's line ending from the body below it.
  const above = content.slice(0, at);
  return { eol: above.includes("\r\n") ? "\r\n" : "\n", indent: "  " };
}

function crlfAt(content: string, lineStart: number): boolean {
  return lineStart >= 2 && content.slice(lineStart - 2, lineStart) === "\r\n";
}

/**
 * Find the value span inside an attribute's `name="value"` range, and the quote
 * character in use, so the original quoting style survives the write.
 */
function attrValueSpan(
  content: string,
  start: number,
  end: number,
): { start: number; end: number; quote: string; wrap: boolean } | undefined {
  const eq = content.indexOf("=", start);
  if (eq === -1 || eq >= end) return undefined;
  let i = eq + 1;
  while (i < end && /\s/.test(content[i] ?? "")) i++;
  // Nothing but whitespace after the `=`. parse5 should never report an
  // attribute that way, but falling through would return a zero-width span at
  // `end`, and the write would *insert* beside the attribute rather than
  // replace its value. `verify` would catch it; refusing here says which
  // attribute could not be located instead of reporting a mismatch later.
  if (i >= end) return undefined;
  const quote = content[i];
  if (quote === DQ || quote === SQ) {
    const close = content.indexOf(quote, i + 1);
    if (close === -1 || close > end) return undefined;
    return { start: i + 1, end: close, quote, wrap: false };
  }
  // Unquoted value: it runs to the end of the attribute's range, and the
  // replacement has to supply its own quotes — `wrap`. Leaving it bare would
  // hold only while the new value had no spaces: `content=hello world`
  // tokenizes as `content="hello"` plus a boolean `world` attribute, which the
  // verify step then rejects with its generic message instead of the write
  // simply working.
  return { start: i, end, quote: DQ, wrap: true };
}

/** Emit a value the way the reader will parse it back: as a YAML scalar. */
function emitScalar(key: string, value: unknown): string {
  const text = stringifyYaml(value).replace(/\n$/, "");
  if (text.includes("\n")) {
    throw new DocmetaError(
      `Refusing to write "${key}": the value needs more than one line, which an HTML attribute cannot hold. Set it manually.`,
    );
  }
  return text;
}

function escapeAttr(value: string, quote: string): string {
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return quote === SQ
    ? escaped.replace(/'/g, "&#39;")
    : escaped.replace(/"/g, "&quot;");
}

/** Apply every edit back-to-front, so earlier offsets stay valid. */
function spliceAll(content: string, edits: Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = content;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of ordered) {
    /* c8 ignore next 5 -- defensive: sources are distinct tags by construction. */
    if (edit.end > lastStart) {
      throw new DocmetaError(
        "Internal error: overlapping edits while writing HTML metadata.",
      );
    }
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    lastStart = edit.start;
  }
  return out;
}

/**
 * Re-read the written document and confirm it says exactly what it should. This
 * is the difference between a bug here being a refusal and a bug here being a
 * corrupted page.
 *
 * `moved` names the elements this write edited. Since element-derived metadata
 * arrived, one element can back **two** keys — `<title>` is read as both the
 * flat `title` and as `head.title` — so writing one of them necessarily moves
 * the other. Holding the co-derived key to its *old* value would fail every
 * `<title>` write, which is exactly what it did before this argument existed.
 *
 * The invariant is not weakened by exempting them. A co-derived key reads from
 * the same text as the key that was written, and that key is still checked
 * strictly: if the element had not been updated, the written key would mismatch
 * and this would still throw. Everything sourced from an element the write did
 * not touch is still held to its old value exactly.
 */
function verify(
  next: string,
  before: HtmlRead,
  patch: MetadataPatch,
  moved: Set<Element>,
  options: ApplyOptions,
): void {
  // Re-read with the *same* options the write used, or a key an `elements:`
  // path produced is invisible here and every write to one is refused.
  const actual = readHtml(next, { elements: options.elements }).data;
  const expected: Record<string, unknown> = { ...before.data, ...patch };
  for (const [key, source] of before.sources) {
    if (key in patch) continue;
    const els =
      source.kind === "element-text" || source.kind === "element-attr"
        ? source.els
        : [source.el];
    if (els.some((el: Element) => moved.has(el))) expected[key] = actual[key];
  }
  if (!deepEqual(actual, expected)) {
    throw new DocmetaError(
      "Refusing to write HTML metadata: the rewritten document did not read back as expected.",
    );
  }
}
