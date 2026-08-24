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
import {
  readXml,
  isMetadataAttribute,
  type XmlElement,
} from "./xml-read.js";
import { elementEdits } from "./element-write.js";
import { ditaEdits } from "./dita-write.js";
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
    before = readXml(original, options.filePath, { elements: options.elements });
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

  const clean = dropUndefined(patch);
  if (Object.keys(clean).length === 0) return original;

  // DITA keeps its metadata in <prolog>/<topicmeta>, and its DTD declares which
  // root attributes a topic may carry — so the generic root-attribute write
  // below would produce a document the user's own toolchain rejects.
  if (before.dita) {
    const next = spliceAll(
      content,
      ditaEdits(content, before, before.dita, clean, emitScalar, escapeAttr),
    );
    verify(next, before.data, clean, options);
    return bom ? original.slice(0, 1) + next : next;
  }

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
    // Element-derived keys first. Without this the key falls through to the
    // attribute branch below and `article.title` is written as a *root
    // attribute* — a legal XML Name, so nothing would stop it — while the
    // reader keeps taking that key from the element. Proposal 0018 calls that
    // asymmetry a loop.
    const source = before.sources.get(key);
    if (source && source.kind !== "attr") {
      edits.push(
        ...elementEdits(content, starts, source, key, value, emitScalar, escapeAttr),
      );
      continue;
    }

    const emitted = emitScalar(key, value);
    const quoteOffset = quoteOffsets.get(key);
    if (quoteOffset === undefined) {
      // The key becomes an attribute *name*, which — unlike a value — cannot be
      // escaped into safety. A key that is not a legal XML Name would produce a
      // document that no longer parses, and the failure would surface from the
      // parser rather than from here.
      assertWritableName(key);
      assertNoElementCollision(key, root);
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
  verify(next, before.data, clean, options);
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

/**
 * Refuse to *create* an attribute whose name collides with an element-derived
 * key on this document.
 *
 * A dot is legal in an XML Name, so nothing in `assertWritableName` stops
 * `article.title` becoming a root attribute on `<article>`. It must not: the
 * convention lifts the root's children as `<root>.<child>`, so the moment the
 * document grows an `<article><title>`, the reader takes that key from the
 * element and the attribute written here goes silently unread — one key meaning
 * two places depending on what the document happens to contain.
 *
 * Narrow on purpose. Only a first segment matching *this* root's name can
 * collide, so `dc.title` and `ms.date` stay writable, as they have always been.
 */
function assertNoElementCollision(key: string, root: XmlElement): void {
  const [head, ...rest] = key.split(".");
  if (rest.length === 0 || head !== root.nodeName.toLowerCase()) return;
  throw new DocmetaError(
    `Refusing to create "${key}" as an attribute of <${root.nodeName}>: that name is how docmeta reads <${root.nodeName}><${rest.join(".")}>, so an attribute here would go unread as soon as the element exists. Add the element to the document and docmeta will update it in place.`,
  );
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
  options: ApplyOptions,
): void {
  const expected = { ...before, ...patch };
  // Same path as the original read: a `.dita` file re-read as plain XML would
  // not see the <othermeta> just written, and the check would fail for the
  // wrong reason.
  //
  // The re-parse is guarded because it is the one place a writer bug shows up
  // as a *parse* failure rather than a mismatch, and `apply`'s contract is that
  // a document it cannot rewrite safely raises `DocmetaError` — not whatever
  // the parser happened to throw.
  let actual;
  try {
    // Re-read with the *same* options the write used. Without the config
    // element paths this cannot see a key an `elements:` path produced, so it
    // would find the key missing and refuse every write to one.
    actual = readXml(next, options.filePath, {
      elements: options.elements,
    }).data;
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
