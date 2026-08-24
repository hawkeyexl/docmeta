/**
 * DITA write-back.
 *
 * The proposal that introduced write support called a `<prolog>` writer "a
 * separate project" and left DITA read-only permanently. This is that project.
 * The reason it is not simply "XML, but deeper" is the content model: DITA
 * declares which attributes a topic may carry, so the generic XML writer's move
 * — add an attribute to the root element — produces a topic the user's own
 * toolchain rejects. Metadata has a designated home instead:
 * `<prolog><metadata><othermeta/></metadata></prolog>` for topics,
 * `<topicmeta>` for maps.
 *
 * Which of those a given key uses is not this module's decision. `fill` corrects
 * values that are present but *invalid*, not only missing ones, so a rule like
 * "new values go in an othermeta" would add a correction beside the stale root
 * attribute a DITA processor actually reads — docmeta reporting green over a
 * topic that still says the wrong thing. So:
 *
 *   1. read from a root attribute  -> update that attribute's value span
 *   2. read from an <othermeta>    -> update its `content` span
 *   3. absent from both            -> insert an <othermeta>, creating
 *                                     <metadata> and <prolog> only as needed
 *
 * Cases 1 and 2 replace spans that already exist and so cannot change whether
 * the document is valid. Only case 3 adds structure, and it adds it where the
 * DTD already allows it.
 */
import {
  DocmetaError,
  type MetadataPatch,
} from "../types.js";
import {
  childAnchor,
  childElements,
  ditaContainerParent,
  findContainer,
  liftRoot,
  metadataContainers,
  DITA_CONTENT_MODEL,
  DITA_LIFTS,
  type DitaLift,
  type DitaShape,
} from "./dita.js";
import { elementEdits, escapeText } from "./element-write.js";
import type { XmlElement, XmlRead } from "./xml-read.js";
import {
  lineStarts,
  offsetAt,
  attrValueSpan,
  startTagEnd,
  closeTagStart,
} from "./xml-locate.js";

export interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Build the edits that set `patch` on a DITA document. The caller splices and
 * verifies, so this stays a pure description of what should change.
 */
export function ditaEdits(
  content: string,
  read: XmlRead,
  shape: DitaShape,
  patch: MetadataPatch,
  emit: (key: string, value: unknown) => string,
  escape: (value: string, quote: string) => string,
): Edit[] {
  const root = read.root;
  /* c8 ignore next 3 -- the caller has already refused a rootless document. */
  if (!root) {
    throw new DocmetaError("This DITA document has no root element.");
  }

  const starts = lineStarts(content);
  const edits: Edit[] = [];
  const fresh: { key: string; value: string }[] = [];
  const freshElements: FreshElement[] = [];

  for (const [key, raw] of Object.entries(patch)) {
    const source = read.sources.get(key);
    // Emitted per branch rather than up front. A list-valued key — `author*` in
    // the content model — is emitted one item at a time by `elementEdits`;
    // emitting the whole array here would serialize it as a YAML block, hit the
    // "needs more than one line" guard, and refuse a write that is perfectly
    // expressible as two `<author>` elements.
    if (source?.kind === "attr") {
      edits.push(
        attributeEdit(content, starts, root, source.name, emit(key, raw), escape),
      );
    } else if (source?.kind === "othermeta") {
      edits.push(
        otherMetaEdit(content, starts, source.el, key, emit(key, raw), escape),
      );
    } else if (
      source?.kind === "element-text" ||
      source?.kind === "element-attr"
    ) {
      // A typed prolog element — <author>, <created date=…>. Written where it
      // was read, which for DITA also means written where the DTD already
      // allows it: the element exists, so only its value changes.
      edits.push(...elementEdits(content, starts, source, key, raw, emit, escape));
    } else {
      // A key naming a typed element docmeta knows — `prolog.author` — is
      // created as that element. Anything else keeps the othermeta channel,
      // which is where a key with no place in the content model belongs.
      const dot = key.indexOf(".");
      const container = dot === -1 ? "" : key.slice(0, dot);
      const element = dot === -1 ? "" : key.slice(dot + 1);
      const spec = DITA_LIFTS[container]?.[element];
      if (spec) {
        freshElements.push({ key, container, element, spec, value: raw });
      } else {
        fresh.push({ key, value: emit(key, raw) });
      }
    }
  }

  if (fresh.length > 0) {
    edits.push(insertEdit(content, starts, root, shape, fresh, escape));
  }
  if (freshElements.length > 0) {
    edits.push(
      ...newElementEdits(
        content,
        starts,
        root,
        shape,
        freshElements,
        emit,
        escape,
      ),
    );
  }
  return edits;
}

/** A typed element the document does not have yet. */
interface FreshElement {
  key: string;
  container: string;
  element: string;
  spec: DitaLift;
  value: unknown;
}

/**
 * Create typed elements the document is missing, in content-model order.
 *
 * This is the one place in the DITA writer that adds structure rather than
 * replacing a span, so it is the one place that can produce a topic the user's
 * DTD rejects. Three things keep it honest:
 *
 * - **Position comes from the content model, not from convenience.** A DITA
 *   container is a sequence, so `<critdates>` after `<metadata>` is invalid even
 *   though both are allowed. `childAnchor` finds the first existing child that
 *   must follow the new one, and the element goes immediately before it.
 * - **Missing ancestors are created together.** Adding `critdates.created` to a
 *   topic with no `<critdates>` emits the whole nest at the position
 *   `<critdates>` itself belongs in.
 * - **Blocks are grouped by anchor, not by container.** Two containers can
 *   resolve to one insertion point, and two edits at one offset overlap —
 *   which `spliceAll` refuses, turning a legitimate multi-field `fill` into an
 *   internal error.
 */
function newElementEdits(
  content: string,
  starts: number[],
  root: XmlElement,
  shape: DitaShape,
  items: FreshElement[],
  emit: (key: string, value: unknown) => string,
  escape: (value: string, quote: string) => string,
): Edit[] {
  const eol = content.includes(CRLF) ? CRLF : LF;
  const liftRootEl = liftRoot(root, shape);

  /** `<author>Ada</author>` or `<created date="…"/>`, one per value. */
  const tagsFor = (item: FreshElement): string[] => {
    const values = Array.isArray(item.value) ? item.value : [item.value];
    return values.map((v) => {
      const emitted = emit(item.key, v);
      return item.spec.attr
        ? `<${item.element} ${item.spec.attr}="${escape(emitted, DQ)}"/>`
        : `<${item.element}>${escapeText(emitted)}</${item.element}>`;
    });
  };

  const byContainer = new Map<string, FreshElement[]>();
  for (const item of items) {
    const group = byContainer.get(item.container);
    if (group) group.push(item);
    else byContainer.set(item.container, [item]);
  }

  // One placement per container, then merged by anchor. Two containers can
  // resolve to the *same* insertion point — adding `critdates.created` and
  // `metadata.audience` to a topic that has neither puts both at the end of
  // `<prolog>` — and two edits at one offset overlap, which `spliceAll`
  // refuses outright. Grouping by container alone is not enough.
  const placements: Placement[] = [];
  for (const [containerName, group] of byContainer) {
    const missing: string[] = [];
    let name: string | undefined = containerName;
    let host: XmlElement | undefined;
    while (name !== undefined) {
      const found = liftRootEl ? findContainer(liftRootEl, name) : undefined;
      if (found) {
        host = found;
        break;
      }
      missing.unshift(name);
      name = ditaContainerParent(shape, name);
    }

    const tags = group.flatMap(tagsFor);
    const outermost = missing[0] ?? group[0]?.element ?? "";

    if (host) {
      const hostName = host.nodeName.toLowerCase();
      const before = childAnchor(host, hostName, outermost);
      const at = before
        ? offsetAt(starts, before.lineNumber ?? 1, before.columnNumber ?? 1)
        : closeOf(content, starts, host, host.nodeName);
      placements.push({
        at,
        base: "",
        missing,
        tags,
        order: modelIndex(hostName, outermost),
        atClose: before === undefined,
      });
    } else {
      placements.push({
        at: newContainerAnchor(content, starts, root, shape),
        base: siblingIndent(content, starts, root),
        missing,
        tags,
        order: modelIndex("", outermost),
        atClose: false,
      });
    }
  }

  const byAnchor = new Map<number, Placement[]>();
  for (const p of placements) {
    const group = byAnchor.get(p.at);
    if (group) group.push(p);
    else byAnchor.set(p.at, [p]);
  }

  const edits: Edit[] = [];
  for (const [at, group] of byAnchor) {
    const base = group.find((p) => p.base !== "")?.base ?? "";
    const anchor = anchorBefore(content, at, base || "  ");
    const lines: string[] = [];
    // Content-model order among themselves, so two created siblings do not
    // land in an order the DTD rejects.
    for (const p of [...group].sort((a, b) => a.order - b.order)) {
      const indent = base || anchor.indent + (p.atClose ? "  " : "");
      if (p.missing.length === 0) {
        for (const tag of p.tags) lines.push(indent + tag);
        continue;
      }
      p.missing.forEach((n, depth) => {
        lines.push(indent + "  ".repeat(depth) + `<${n}>`);
      });
      for (const tag of p.tags) {
        lines.push(indent + "  ".repeat(p.missing.length) + tag);
      }
      [...p.missing].reverse().forEach((n, i) => {
        lines.push(indent + "  ".repeat(p.missing.length - 1 - i) + `</${n}>`);
      });
    }
    edits.push({
      start: anchor.start,
      end: anchor.end,
      text: (anchor.lead ? eol : "") + lines.join(eol) + eol + anchor.indent,
    });
  }
  return edits;
}

/** One block of new markup, and where it goes. */
interface Placement {
  at: number;
  base: string;
  missing: string[];
  tags: string[];
  order: number;
  /**
   * Whether the anchor is the container's closing tag rather than an existing
   * sibling. It changes the indent by one level: a sibling already sits where
   * the new block goes, but a closing tag sits a level out from the children it
   * closes over.
   */
  atClose: boolean;
}

/** Position of `name` in `container`'s content model; unknown sorts last. */
function modelIndex(container: string, name: string): number {
  const model = DITA_CONTENT_MODEL[container] ?? [];
  const at = model.indexOf(name);
  return at === -1 ? Number.MAX_SAFE_INTEGER : at;
}

/** Replace a root attribute's value span — case 1. */
function attributeEdit(
  content: string,
  starts: number[],
  root: XmlElement,
  name: string,
  emitted: string,
  escape: (value: string, quote: string) => string,
): Edit {
  const attrs = root.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs.item(i);
    if (!attr || attr.name !== name) continue;
    /* c8 ignore next -- xmldom always reports a position for an attribute it parsed. */
    if (attr.lineNumber == null || attr.columnNumber == null) break;
    const span = attrValueSpan(
      content,
      offsetAt(starts, attr.lineNumber, attr.columnNumber),
    );
    if (span === undefined) break;
    return { start: span.start, end: span.end, text: escape(emitted, span.quote) };
  }
  throw new DocmetaError(
    `Refusing to write "${name}": its attribute value could not be located precisely.`,
  );
}

/** Replace an existing `<othermeta>`'s `content` value span — case 2. */
function otherMetaEdit(
  content: string,
  starts: number[],
  el: XmlElement,
  key: string,
  emitted: string,
  escape: (value: string, quote: string) => string,
): Edit {
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs.item(i);
    if (!attr || attr.name !== "content") continue;
    /* c8 ignore next -- xmldom always reports a position for an attribute it parsed. */
    if (attr.lineNumber == null || attr.columnNumber == null) break;
    const span = attrValueSpan(
      content,
      offsetAt(starts, attr.lineNumber, attr.columnNumber),
    );
    if (span === undefined) break;
    return { start: span.start, end: span.end, text: escape(emitted, span.quote) };
  }
  throw new DocmetaError(
    `Refusing to write "${key}": its <othermeta> content attribute could not be located precisely.`,
  );
}

/**
 * Insert new `<othermeta>` entries, creating whatever containers are missing —
 * case 3.
 *
 * Each insertion replaces the whitespace run in front of an anchor rather than
 * inserting at the anchor itself. Inserting would leave that run stranded as a
 * blank line, and a `fill` that reformats the file around its own edit is the
 * thing the splice-only rule exists to prevent.
 */
function insertEdit(
  content: string,
  starts: number[],
  root: XmlElement,
  shape: DitaShape,
  fresh: { key: string; value: string }[],
  escape: (value: string, quote: string) => string,
): Edit {
  const { prolog, container } = metadataContainers(root, shape);
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const tag = (f: { key: string; value: string }): string =>
    `<othermeta name="${escape(f.key, DQ)}" content="${escape(f.value, DQ)}"/>`;
  const build = (a: Anchor, lines: string[]): Edit => ({
    start: a.start,
    end: a.end,
    text: (a.lead ? eol : "") + lines.join(eol) + eol + a.indent,
  });

  // The container exists: append inside it. `<othermeta>` sits late in the
  // metadata content model, so appending keeps the order the DTD expects.
  if (container) {
    const anchor = anchorBefore(
      content,
      closeOf(content, starts, container, container.nodeName),
    );
    return build(
      anchor,
      fresh.map((f) => anchor.indent + "  " + tag(f)),
    );
  }

  // A topic with a <prolog> but no <metadata>: create just the inner element.
  if (prolog) {
    const anchor = anchorBefore(
      content,
      closeOf(content, starts, prolog, prolog.nodeName),
    );
    const meta = anchor.indent + "  ";
    return build(anchor, [
      meta + "<metadata>",
      ...fresh.map((f) => meta + "  " + tag(f)),
      meta + "</metadata>",
    ]);
  }

  // Neither exists: create the whole block, in the position the content model
  // requires — after the title and friends, before the body.
  const at = newContainerAnchor(content, starts, root, shape);
  // Two different indents. `anchor.indent` is the anchor's own, restored after
  // the block so the element that follows keeps its position; `base` is where
  // the new block sits. They differ when the anchor is the root's closing tag,
  // which sits a level out from the children the block joins.
  const base = siblingIndent(content, starts, root);
  const anchor = anchorBefore(content, at, base);
  if (shape.kind === "map") {
    return build(anchor, [
      base + "<topicmeta>",
      ...fresh.map((f) => base + "  " + tag(f)),
      base + "</topicmeta>",
    ]);
  }
  return build(anchor, [
    base + "<prolog>",
    base + "  <metadata>",
    ...fresh.map((f) => base + "    " + tag(f)),
    base + "  </metadata>",
    base + "</prolog>",
  ]);
}

interface Anchor {
  start: number;
  end: number;
  indent: string;
  lead: boolean;
}

/**
 * The whitespace run in front of `at`, so new lines can replace it and put it
 * back — which is what keeps the anchor's own indentation intact.
 *
 * When `at` does not begin its line there is no run to reuse, so the caller
 * emits a leading newline and falls back to a supplied indent.
 */
function anchorBefore(content: string, at: number, fallback = "  "): Anchor {
  let i = at;
  while (i > 0 && (content[i - 1] === " " || content[i - 1] === "\t")) i--;
  if (i > 0 && content[i - 1] === "\n") {
    return { start: i, end: at, indent: content.slice(i, at), lead: false };
  }
  return { start: at, end: at, indent: fallback, lead: true };
}

/**
 * The indentation of the root's first child element, used when a new container
 * is anchored on the root's closing tag — which sits at the parent's indent and
 * so would put the block a level too far out.
 */
function siblingIndent(
  content: string,
  starts: number[],
  root: XmlElement,
): string {
  const first = childElements(root)[0];
  if (!first) return "  ";
  const at = offsetAt(starts, first.lineNumber ?? 1, first.columnNumber ?? 1);
  const lineStart = content.lastIndexOf("\n", at - 1) + 1;
  const between = content.slice(lineStart, at);
  return /^[ \t]*$/.test(between) ? between : "  ";
}

const DQ = String.fromCharCode(34);
const CRLF = String.fromCharCode(13, 10);
const LF = String.fromCharCode(10);

/**
 * The offset of a container's close tag, which is where new children go.
 *
 * `name` is the element's own `nodeName`, not the canonical lowercase one the
 * shape carries. The reader finds these containers by comparing lowercased
 * names, so it accepts a `<Metadata>`; searching for `</metadata>` here would
 * then refuse a document the reader had just read, with a message describing a
 * tag the file does not contain.
 */
function closeOf(
  content: string,
  starts: number[],
  el: XmlElement,
  name: string,
): number {
  const from = offsetAt(starts, el.lineNumber ?? 1, el.columnNumber ?? 1);
  const open = startTagEnd(content, from);
  if (open === undefined || open.selfClosing) {
    // `<metadata/>` has no inside to append to. Refusing beats rewriting the
    // tag, which would take this out of splice-only territory.
    throw new DocmetaError(
      `Refusing to write DITA metadata: <${name}> is self-closing, so there is nowhere to add an entry. Expand it to <${name}></${name}> and retry.`,
    );
  }
  const close = closeTagStart(content, open.end, name);
  if (close === undefined) {
    throw new DocmetaError(
      `Refusing to write DITA metadata: <${name}> has no closing tag.`,
    );
  }
  return close;
}

/**
 * Where a brand-new metadata container goes: immediately before the first child
 * that is not part of the preamble, or before the root's close tag when every
 * child is (a topic with a title and nothing else).
 */
function newContainerAnchor(
  content: string,
  starts: number[],
  root: XmlElement,
  shape: DitaShape,
): number {
  for (const child of childElements(root)) {
    if (shape.preamble.has(child.nodeName.toLowerCase())) continue;
    return offsetAt(starts, child.lineNumber ?? 1, child.columnNumber ?? 1);
  }
  const from = offsetAt(starts, root.lineNumber ?? 1, root.columnNumber ?? 1);
  const open = startTagEnd(content, from);
  const close =
    open === undefined
      ? undefined
      : closeTagStart(content, open.end, root.nodeName);
  if (close === undefined) {
    throw new DocmetaError(
      "Refusing to write DITA metadata: the root element's closing tag could not be located.",
    );
  }
  return close;
}
