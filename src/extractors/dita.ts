/**
 * What docmeta knows about DITA, shared by the reader and the writer.
 *
 * DITA is XML, but its document metadata does not live where the generic XML
 * reader looks. A topic keeps it in
 * `<prolog><metadata><othermeta name="…" content="…"/></metadata></prolog>`;
 * a map keeps it in `<topicmeta>`. The root element's attributes are mostly
 * structural — `id`, `xml:lang`, `class`, `DITAArchVersion` — and, crucially,
 * the DTD declares which of them are allowed. Adding one it does not declare
 * produces a topic that fails validation in the user's own toolchain, which is
 * why the metadata channel and not the root element is the place to write.
 */
import type { XmlElement } from "./xml-read.js";

/** Which flavour of DITA a document is, and where its metadata belongs. */
export interface DitaShape {
  kind: "topic" | "map";
  /** The element that directly contains `<othermeta>`. */
  container: "metadata" | "topicmeta";
  /**
   * Elements that must precede the metadata container in the content model. A
   * new container is inserted after the last of these, which in practice means
   * "before the first child that is not one of them".
   */
  preamble: Set<string>;
}

const TOPIC_ROOTS = new Set([
  "topic",
  "concept",
  "task",
  "reference",
  "glossentry",
  "glossgroup",
]);

const MAP_ROOTS = new Set(["map", "bookmap", "subjectscheme"]);

/** Every root element name that suggests DITA, for the extension-backed signal. */
export const DITA_ROOTS = new Set([...TOPIC_ROOTS, ...MAP_ROOTS]);

/**
 * Whether this document is DITA, and if so what shape.
 *
 * Positive signals only, in descending order of confidence. A root element
 * merely *named* `map` or `task` is far too weak on its own — those are ordinary
 * names in hand-rolled XML — so the name counts only when the file extension
 * agrees.
 */
export function ditaShape(
  content: string,
  root: XmlElement,
  filePath: string | undefined,
): DitaShape | undefined {
  const name = root.nodeName.toLowerCase();
  const cls = root.getAttribute("class") ?? "";

  const byDoctype = hasDitaDoctype(content);
  // DITA-OT output carries the specialization ancestry in @class.
  const byClass = /^\s*[-+]\s+(topic|map)\//.test(cls);
  const byArch = root.getAttribute("DITAArchVersion") != null;
  const lower = filePath?.toLowerCase() ?? "";
  const byExtension =
    (lower.endsWith(".dita") || lower.endsWith(".ditamap")) &&
    DITA_ROOTS.has(name);

  if (!byDoctype && !byClass && !byArch && !byExtension) return undefined;

  // `@class` is the most precise statement of which model applies; the root
  // name and the extension are the fallbacks, in that order.
  const isMap =
    /^\s*[-+]\s+map\//.test(cls) ||
    MAP_ROOTS.has(name) ||
    lower.endsWith(".ditamap");

  return isMap
    ? { kind: "map", container: "topicmeta", preamble: new Set(["title"]) }
    : {
        kind: "topic",
        container: "metadata",
        preamble: new Set([
          "title",
          "titlealts",
          "shortdesc",
          "abstract",
          "prolog",
        ]),
      };
}

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
 * be taken for plain XML and written as such — a root attribute its DTD does
 * not declare, which is the one outcome this whole module exists to avoid.
 */
function hasDitaDoctype(content: string): boolean {
  const masked = content.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  const doctype = doctypeText(masked);
  if (doctype === undefined) return false;

  // A DITA public identifier is unambiguous on its own.
  if (/\/\/DTD DITA/i.test(doctype)) return true;

  // A SYSTEM-only declaration has no public identifier to match, and DITA
  // written against a local DTD copy looks exactly like that. Two weak signals
  // are required together, because either alone is ordinary in hand-rolled XML:
  // the declared root element has to be a DITA type, *and* the system
  // identifier has to name a DITA DTD.
  const declared = /<!DOCTYPE\s+([A-Za-z_][\w.-]*)/.exec(doctype)?.[1];
  if (declared === undefined || !DITA_ROOTS.has(declared.toLowerCase())) {
    return false;
  }
  return /\b(?:concept|task|reference|topic|map|bookmap|glossentry|glossgroup|ditabase|subjectscheme)\.dtd\b/i.test(
    doctype,
  );
}

/**
 * The whole `<!DOCTYPE …>` declaration, internal subset included.
 *
 * Scanning rather than matching `[^>]*`: an internal subset is full of `>` —
 * `<!ENTITY nbsp "&#160;">` is why most DITA files have one at all — and a
 * pattern that stopped at the first would read only part of the declaration.
 * Quotes and `[ … ]` nesting are tracked so the `>` that ends the declaration is
 * the one actually found.
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
 * One element docmeta lifts out of DITA's typed metadata, and how.
 *
 * `repeatable` is not a guess. It is read straight off the OASIS content model:
 * `author*` is a list, `source?` is a scalar. Generic XML defaults everything to
 * a list because it has no such statement to consult; DITA does, so its keys are
 * typed exactly and a schema can say `format: date` on a scalar rather than
 * reaching through a one-item array.
 */
export interface DitaLift {
  /** Attribute carrying the value. Absent means the element's text. */
  attr?: string;
  /** Whether the content model permits more than one. */
  repeatable: boolean;
}

/**
 * The typed metadata elements docmeta reads, keyed by the element that contains
 * them — which is also the namespace their key takes.
 *
 * A container appearing as a key here is descended into, so `<prolog>` reaches
 * `<critdates>`, `<metadata>` and `<prodinfo>` without any of them being named
 * as a special case in the walker.
 *
 * `topicmeta` repeats most of `prolog` rather than deferring to it because the
 * two models genuinely differ: `<topicmeta>` holds `audience`, `category`,
 * `prodinfo`, `othermeta` and `resourceid` as **direct children**, where a topic
 * nests them inside `<prolog><metadata>`. Verified against the OASIS
 * content-model appendix rather than assumed — the same fact reads as
 * `topicmeta.audience` in a map and `metadata.audience` in a topic, and both are
 * correct, because each key names where the value actually is.
 *
 * Deliberately absent, each for a reason: `<copyright>` nests
 * `copyrholder`/`copyryear @year`, two levels and two shapes; `<keywords>`
 * contains `<indexterm>`/`<keyword>` children rather than text; and the
 * `<prodinfo>` tail (`vrmlist`, `brand`, `component`, `featnum`, `platform`,
 * `prognum`, `series`) is long and rarely carries document metadata.
 */
export const DITA_LIFTS: Readonly<
  Record<string, Readonly<Record<string, DitaLift>>>
> = {
  prolog: {
    author: { repeatable: true },
    source: { repeatable: false },
    publisher: { repeatable: false },
    permissions: { attr: "entitlement", repeatable: false },
    resourceid: { attr: "id", repeatable: true },
  },
  topicmeta: {
    author: { repeatable: true },
    source: { repeatable: false },
    publisher: { repeatable: false },
    permissions: { attr: "entitlement", repeatable: false },
    resourceid: { attr: "id", repeatable: true },
    audience: { attr: "type", repeatable: true },
    category: { repeatable: true },
  },
  critdates: {
    created: { attr: "date", repeatable: false },
    revised: { attr: "modified", repeatable: true },
  },
  metadata: {
    audience: { attr: "type", repeatable: true },
    category: { repeatable: true },
  },
  prodinfo: {
    prodname: { repeatable: false },
  },
};

/**
 * The ordered content models, for placing an element that does not exist yet.
 *
 * A DITA container is a *sequence*, not a set: `<critdates>` after `<metadata>`
 * is invalid even though both are allowed, so a writer creating an element has
 * to know what may precede it. `shape.preamble` answers that question for one
 * position — where a whole new `<prolog>` goes — and this answers it for every
 * position inside one.
 *
 * Names not listed for a container are unknown to docmeta and sort last, which
 * keeps a specialization docmeta has never seen from being inserted in the
 * middle of a model it does not understand.
 */
export const DITA_CONTENT_MODEL: Readonly<Record<string, readonly string[]>> = {
  prolog: [
    "author",
    "source",
    "publisher",
    "copyright",
    "critdates",
    "permissions",
    "metadata",
    "resourceid",
    "data",
  ],
  topicmeta: [
    "navtitle",
    "linktext",
    "searchtitle",
    "shortdesc",
    "author",
    "source",
    "publisher",
    "copyright",
    "critdates",
    "permissions",
    "metadata",
    "audience",
    "category",
    "keywords",
    "exportanchors",
    "prodinfo",
    "othermeta",
    "resourceid",
    "ux-window",
    "data",
  ],
  critdates: ["created", "revised"],
  metadata: [
    "audience",
    "category",
    "keywords",
    "prodinfo",
    "othermeta",
    "data",
  ],
  prodinfo: [
    "prodname",
    "vrmlist",
    "brand",
    "series",
    "platform",
    "prognum",
    "featnum",
    "component",
  ],
};

/**
 * The element a document's typed metadata hangs off: `<prolog>` in a topic,
 * `<topicmeta>` in a map. Undefined when the document has neither.
 *
 * Distinct from {@link metadataContainers}, which finds the element holding
 * `<othermeta>` — one level deeper in a topic.
 */
export function liftRoot(
  root: XmlElement,
  shape: DitaShape,
): XmlElement | undefined {
  const { prolog, container } = metadataContainers(root, shape);
  return shape.kind === "map" ? container : prolog;
}

/** Direct child elements of `el`, optionally filtered by name. */
export function childElements(el: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const child = n as unknown as XmlElement;
    if (name === undefined || child.nodeName.toLowerCase() === name) {
      out.push(child);
    }
  }
  return out;
}

/**
 * The element that directly holds `<othermeta>`, if the document already has
 * one, along with the `<prolog>` that would hold it for a topic.
 *
 * Both are reported because the writer needs to know which one is missing: a
 * topic with a `<prolog>` but no `<metadata>` needs only the inner element
 * created, while one with neither needs the whole block.
 */
export function metadataContainers(
  root: XmlElement,
  shape: DitaShape,
): { prolog: XmlElement | undefined; container: XmlElement | undefined } {
  if (shape.kind === "map") {
    return { prolog: undefined, container: childElements(root, "topicmeta")[0] };
  }
  const prolog = childElements(root, "prolog")[0];
  return {
    prolog,
    container: prolog ? childElements(prolog, "metadata")[0] : undefined,
  };
}

/** The `<othermeta>` entries inside a metadata container, in document order. */
export function otherMetaEntries(
  container: XmlElement,
): { key: string; value: string; el: XmlElement }[] {
  const out: { key: string; value: string; el: XmlElement }[] = [];
  for (const el of childElements(container, "othermeta")) {
    const key = el.getAttribute("name");
    const value = el.getAttribute("content");
    if (key != null && key !== "" && value != null) out.push({ key, value, el });
  }
  return out;
}
