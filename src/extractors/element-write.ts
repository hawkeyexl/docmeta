/**
 * Writing back to element-derived metadata, shared by the plain-XML and DITA
 * writers.
 *
 * Both cases here **replace a span that already exists**, which is what makes
 * them safe in a dialect docmeta knows nothing about: swapping the text between
 * `<title>` and `</title>`, or the value inside an attribute's quotes, cannot
 * change whether the document is valid. Creating an element that is *not* there
 * is a different problem — it needs to know where the element is legal — and
 * lives with the content model that can answer that.
 *
 * The count rule is the other half. A key backed by N elements receiving M
 * values is only unambiguous when M equals N: each value replaces one element,
 * in document order. Fewer values would mean deleting elements and more would
 * mean creating them, and both change the document's shape rather than its
 * content. Those are refused by name rather than guessed at, because a `fill`
 * that quietly dropped an `<author>` is worse than one that declines.
 */
import { DocmetaError } from "../types.js";
import type { XmlElement, XmlSource } from "./xml-read.js";
import {
  attrValueSpan,
  closeTagStart,
  offsetAt,
  startTagEnd,
} from "./xml-locate.js";

/** One character-range replacement in the source. */
export interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Escape text destined for element content.
 *
 * `&` and `<` are mandatory. `>` is escaped too — not required by XML except
 * after `]]`, but linters flag it and the attribute path already escapes it, so
 * matching keeps one rule rather than two.
 */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The values a write should distribute across the elements backing a key.
 *
 * A scalar key is one value; a list key is its items. Anything else — a list
 * whose length no longer matches, or an object where text was read — is refused
 * here rather than partially applied.
 */
export function valuesFor(
  key: string,
  value: unknown,
  count: number,
): unknown[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length !== count) {
    throw new DocmetaError(
      `Refusing to write "${key}": the document has ${count} element${
        count === 1 ? "" : "s"
      } for it and ${values.length} value${
        values.length === 1 ? "" : "s"
      } was given. docmeta updates elements in place; adding or removing one ` +
        "changes the document's shape, which it will not do on your behalf.",
    );
  }
  return values;
}

/** Replace the text between an element's start and end tags. */
export function elementTextEdit(
  content: string,
  starts: number[],
  el: XmlElement,
  key: string,
  emitted: string,
): Edit {
  const from = elementOffset(starts, el, key);
  const open = startTagEnd(content, from);
  if (open === undefined) {
    throw new DocmetaError(
      `Refusing to write "${key}": the <${el.nodeName}> start tag could not be located.`,
    );
  }
  if (open.selfClosing) {
    // `<title/>` has no text span to replace. Turning it into `<title>x</title>`
    // is a shape change, and the count rule above says those are the author's
    // to make.
    throw new DocmetaError(
      `Refusing to write "${key}": <${el.nodeName}> is self-closing, so it has no text to replace.`,
    );
  }
  const close = closeTagStart(content, open.end, el.nodeName);
  if (close === undefined) {
    throw new DocmetaError(
      `Refusing to write "${key}": <${el.nodeName}> has no closing tag.`,
    );
  }
  return { start: open.end, end: close, text: escapeText(emitted) };
}

/** Replace the value inside an element attribute's quotes. */
export function elementAttrEdit(
  content: string,
  starts: number[],
  el: XmlElement,
  attrName: string,
  key: string,
  emitted: string,
  escape: (value: string, quote: string) => string,
): Edit {
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs.item(i);
    if (!attr || attr.name !== attrName) continue;
    /* c8 ignore next -- xmldom always reports a position for an attribute it parsed. */
    if (attr.lineNumber == null || attr.columnNumber == null) break;
    const span = attrValueSpan(
      content,
      offsetAt(starts, attr.lineNumber, attr.columnNumber),
    );
    if (span === undefined) break;
    return {
      start: span.start,
      end: span.end,
      text: escape(emitted, span.quote),
    };
  }
  throw new DocmetaError(
    `Refusing to write "${key}": the "${attrName}" attribute on <${el.nodeName}> could not be located precisely.`,
  );
}

function elementOffset(
  starts: number[],
  el: XmlElement,
  key: string,
): number {
  /* c8 ignore next 5 -- xmldom reports a position for every element it parsed. */
  if (el.lineNumber == null || el.columnNumber == null) {
    throw new DocmetaError(
      `Refusing to write "${key}": <${el.nodeName}> has no recorded position.`,
    );
  }
  return offsetAt(starts, el.lineNumber, el.columnNumber);
}

/**
 * Edits for a key whose value lives in elements rather than a root attribute.
 *
 * One edit per element, in document order, after `valuesFor` has confirmed the
 * counts line up.
 */
export function elementEdits(
  content: string,
  starts: number[],
  source: Exclude<XmlSource, { kind: "attr" }>,
  key: string,
  value: unknown,
  emit: (key: string, value: unknown) => string,
  escape: (value: string, quote: string) => string,
): Edit[] {
  if (source.kind === "othermeta") {
    return [
      elementAttrEdit(
        content,
        starts,
        source.el,
        "content",
        key,
        emit(key, value),
        escape,
      ),
    ];
  }
  const values = valuesFor(key, value, source.els.length);
  return source.els.map((el, i) =>
    source.kind === "element-attr"
      ? elementAttrEdit(
          content,
          starts,
          el,
          source.name,
          key,
          emit(key, values[i]),
          escape,
        )
      : elementTextEdit(content, starts, el, key, emit(key, values[i])),
  );
}
