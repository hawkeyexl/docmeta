/**
 * XML write-back, the inverse of the root-attribute read in `xml-read.ts`.
 *
 * Same discipline as `frontmatter-write.ts` and `html-write.ts`: splice, never
 * re-serialize. `XMLSerializer` would normalize the DOCTYPE's spelling, rewrite
 * single-quoted attributes as double-quoted, re-encode `>` inside values, and —
 * worst for the DITA-adjacent files this extractor also reads — turn an
 * unresolvable `&nbsp;` into `&amp;nbsp;`, because the parser keeps such a
 * reference only as literal text. `xml-read.ts` goes out of its way to keep
 * those files readable; re-serializing would corrupt them on the way back out.
 *
 * The ranges come from `xml-locate.ts`, because xmldom reports positions and not
 * offsets. See that module for why the line index has to recognise six break
 * forms rather than one.
 *
 * Metadata lives in the root element's attributes, so that is where a write
 * goes. There is only the one channel, so "write back to where the value was
 * read from" holds by construction here — unlike DITA, which keeps metadata in
 * `<prolog>` and is refused below until it has a writer of its own.
 */
import { stringify as stringifyYaml } from "yaml";
import {
  DocmetaError,
  type ApplyOptions,
  type MetadataPatch,
} from "../types.js";
import { dropUndefined, deepEqual } from "./patch-util.js";
import { readXml, isMetadataAttribute, type XmlElement } from "./xml-read.js";
import {
  lineStarts,
  offsetAt,
  attrValueSpan,
  afterElementName,
} from "./xml-locate.js";

interface Edit {
  start: number;
  end: number;
  text: string;
}

const DQ = String.fromCharCode(34);
const BOM_CODE = 0xfeff;

export function applyXml(
  original: string,
  patch: MetadataPatch,
  options: ApplyOptions = {},
): string {
  // `readXml` strips a BOM before parsing, so every position it reports is
  // relative to the stripped text. Splice against the same text and put the BOM
  // back afterwards — a prefix, so there is no offset arithmetic to get wrong.
  const bom = original.charCodeAt(0) === BOM_CODE;

  let before;
  try {
    before = readXml(original);
  } catch (err) {
    // A document the reader rejects has no trustworthy positions, so there is
    // nothing safe to splice.
    throw new DocmetaError(
      `Refusing to write metadata: ${(err as Error).message}`,
    );
  }

  const content = before.body;
  const root = before.root;
  if (root === undefined) {
    throw new DocmetaError(
      "This XML document has no root element, so there is nowhere to write metadata.",
    );
  }

  // Structural checks run before the empty-patch shortcut, so an empty patch is
  // a usable pre-flight probe for "can this document be written at all?".
  // `fill` uses it to skip paying for inference on a file it could never write.
  if (isDita(content, root, options.filePath)) {
    throw new DocmetaError(
      "This looks like DITA, whose metadata belongs in a <prolog> element. Adding it to the root element would produce a topic its DTD rejects, so docmeta will not write it.",
    );
  }

  const clean = dropUndefined(patch);
  if (Object.keys(clean).length === 0) return original;

  const starts = lineStarts(content);
  const quoteOffsets = new Map<string, number>();
  const attrs = root.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs.item(i);
    if (!attr || !isMetadataAttribute(attr.name)) continue;
    if (attr.lineNumber == null || attr.columnNumber == null) continue;
    // An attribute's reported column is the opening quote of its value.
    quoteOffsets.set(
      attr.name,
      offsetAt(starts, attr.lineNumber, attr.columnNumber),
    );
  }

  const edits: Edit[] = [];
  const inserts: string[] = [];
  for (const [key, value] of Object.entries(clean)) {
    const emitted = emitScalar(key, value);
    const quoteOffset = quoteOffsets.get(key);
    if (quoteOffset === undefined) {
      // The key becomes an attribute *name*, which — unlike a value — cannot be
      // escaped into safety. A key that is not a legal XML Name would produce a
      // document that no longer parses, and the failure would surface from the
      // parser rather than from here.
      assertWritableName(key);
      inserts.push(`${key}="${escapeAttr(emitted, DQ)}"`);
      continue;
    }
    const span = attrValueSpan(content, quoteOffset);
    if (span === undefined) {
      throw new DocmetaError(
        `Refusing to write "${key}": its attribute value could not be located precisely.`,
      );
    }
    edits.push({
      start: span.start,
      end: span.end,
      text: escapeAttr(emitted, span.quote),
    });
  }

  if (inserts.length > 0) {
    const at = rootNameEnd(content, starts, root);
    edits.push({ start: at, end: at, text: ` ${inserts.join(" ")}` });
  }

  const next = spliceAll(content, edits);
  verify(next, before.data, clean);
  return bom ? original.slice(0, 1) + next : next;
}

/** Where a new attribute goes: just past the root element's name. */
function rootNameEnd(
  content: string,
  starts: number[],
  root: XmlElement,
): number {
  const tagOffset = offsetAt(
    starts,
    root.lineNumber ?? 1,
    root.columnNumber ?? 1,
  );
  const at = afterElementName(content, tagOffset);
  if (at === undefined) {
    throw new DocmetaError(
      "Refusing to write XML metadata: the root element's start tag could not be located.",
    );
  }
  return at;
}

/**
 * Whether this document is DITA, which keeps its metadata somewhere else.
 *
 * Positive signals only. A root element merely *named* `map` or `task` is far
 * too weak on its own — those are ordinary names in hand-rolled XML — so the
 * name counts only when the file extension agrees.
 */
function isDita(
  content: string,
  root: XmlElement,
  filePath: string | undefined,
): boolean {
  if (hasDitaDoctype(content)) return true;
  // DITA-OT output carries the specialization ancestry in @class.
  if (/^\s*[-+]\s+(topic|map)\//.test(root.getAttribute("class") ?? "")) {
    return true;
  }
  if (root.getAttribute("DITAArchVersion") != null) return true;
  const lower = filePath?.toLowerCase() ?? "";
  return (
    (lower.endsWith(".dita") || lower.endsWith(".ditamap")) &&
    DITA_ROOTS.has(root.nodeName.toLowerCase())
  );
}

const DITA_ROOTS = new Set([
  "topic",
  "concept",
  "task",
  "reference",
  "glossentry",
  "glossgroup",
  "map",
  "bookmap",
  "subjectscheme",
]);

/**
 * Whether the document declares a DITA DTD.
 *
 * Comments are blanked first, at their original length so offsets still line up.
 * Two things go wrong otherwise, and both are silent: a comment containing a
 * tag-like `<word` ends the search window early — `<!-- covers <integration> -->`
 * ahead of the DOCTYPE hides it entirely — and a comment that merely *mentions*
 * a DITA DTD would announce one that isn't there.
 *
 * Missing the DOCTYPE is the dangerous direction. A hand-authored DITA topic
 * carries no `@class` or `@DITAArchVersion` to fall back on, so the file would
 * be taken for plain XML and given a root attribute its DTD does not declare.
 */
function hasDitaDoctype(content: string): boolean {
  const masked = content.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  const doctype = doctypeText(masked);
  if (doctype === undefined) return false;

  // A DITA public identifier is unambiguous on its own.
  if (/\/\/DTD DITA/i.test(doctype)) return true;

  // A SYSTEM-only declaration has no public identifier to match, and DITA files
  // written against a local DTD copy use exactly that form. Two weak signals
  // are required together, because either alone is ordinary in hand-rolled XML:
  // the declared root element has to be a DITA type, *and* the system
  // identifier has to name a DITA DTD.
  const root = /<!DOCTYPE\s+([A-Za-z_][\w.-]*)/.exec(doctype)?.[1];
  if (root === undefined || !DITA_ROOTS.has(root.toLowerCase())) return false;
  return /\b(?:concept|task|reference|topic|map|bookmap|glossentry|glossgroup|ditabase|subjectscheme)\.dtd\b/i.test(
    doctype,
  );
}

/**
 * The whole `<!DOCTYPE …>` declaration, internal subset included.
 *
 * Scanning rather than matching `[^>]*`: an internal subset is full of `>` —
 * `<!ENTITY nbsp "&#160;">` is the reason most DITA files have one at all — and
 * a pattern that stopped at the first one would read only part of the
 * declaration. Quotes and `[ … ]` nesting are tracked so the `>` that ends the
 * declaration is the one actually found.
 */
function doctypeText(masked: string): string | undefined {
  const start = masked.indexOf("<!DOCTYPE");
  if (start === -1) return undefined;
  let quote: string | undefined;
  let depth = 0;
  for (let i = start + "<!DOCTYPE".length; i < masked.length; i++) {
    const ch = masked[i];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ">" && depth === 0) return masked.slice(start, i + 1);
  }
  return undefined;
}

/**
 * Refuse a key that cannot be an XML attribute name.
 *
 * Values are escaped on the way in, so any value is writable; a *name* has no
 * such escape hatch. This covers the practical cases — a leading digit, a
 * space, a namespace prefix docmeta cannot declare, or an `xmlns:` that would
 * rewrite a namespace declaration — rather than the full XML Name production,
 * and errs toward refusing rather than emitting something the parser will
 * reject downstream.
 *
 * Deliberately stricter than XML itself: `xml:lang` is a perfectly legal name,
 * and its prefix is even predefined, but allowing colons in general would let
 * through prefixes with no binding in the document. Refusing something safe
 * costs a rename; allowing something unsafe costs a file that will not parse.
 * The message says which of the two reasons applied.
 */
function assertWritableName(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(key)) {
    throw new DocmetaError(
      `Refusing to write "${key}": it is not a valid XML attribute name, or uses a namespace prefix docmeta cannot declare. Writing it would produce a document that no longer parses. Rename the property, or set it manually.`,
    );
  }
}

/** Emit a value the way the reader will parse it back: as a YAML scalar. */
function emitScalar(key: string, value: unknown): string {
  const text = stringifyYaml(value).replace(/\n$/, "");
  if (text.includes("\n")) {
    throw new DocmetaError(
      `Refusing to write "${key}": the value needs more than one line, which an XML attribute cannot hold. Set it manually.`,
    );
  }
  return text;
}

function escapeAttr(value: string, quote: string): string {
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return quote === "'"
    ? escaped.replace(/'/g, "&apos;")
    : escaped.replace(/"/g, "&quot;");
}

/** Apply every edit back-to-front, so earlier offsets stay valid. */
function spliceAll(content: string, edits: Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = content;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of ordered) {
    /* c8 ignore next 5 -- defensive: attributes are distinct spans by construction. */
    if (edit.end > lastStart) {
      throw new DocmetaError(
        "Internal error: overlapping edits while writing XML metadata.",
      );
    }
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    lastStart = edit.start;
  }
  return out;
}

/**
 * Re-read the written document and confirm it says exactly what it should. A
 * bug above becomes a refusal rather than a corrupted file.
 */
function verify(
  next: string,
  before: Record<string, unknown>,
  patch: MetadataPatch,
): void {
  const expected = { ...before, ...patch };
  // The re-parse is guarded because it is the one place a writer bug shows up
  // as a *parse* failure rather than a mismatch, and `apply`'s contract is that
  // a document it cannot rewrite safely raises `DocmetaError` — not whatever
  // the parser happened to throw.
  let actual;
  try {
    actual = readXml(next).data;
  } catch (err) {
    throw new DocmetaError(
      `Refusing to write XML metadata: the rewritten document did not parse (${(err as Error).message}).`,
    );
  }
  if (!deepEqual(actual, expected)) {
    throw new DocmetaError(
      "Refusing to write XML metadata: the rewritten document did not read back as expected.",
    );
  }
}
