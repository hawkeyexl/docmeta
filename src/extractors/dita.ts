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
import { liftKey } from "./element-key.js";

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
  // Cheap exit before the expensive one. Masking allocates a same-length string
  // per comment match, and this runs once per file — including on DITA-OT
  // output, which is already identified by `@class` and rarely carries a
  // DOCTYPE at all. Sound in one direction only, which is the direction needed:
  // masking replaces text with spaces and never introduces any, so a document
  // whose raw bytes hold no `<!DOCTYPE` cannot have one after masking either.
  if (!content.includes("<!DOCTYPE")) return false;
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
  /**
   * Attributes that are each a value in their own right, rather than one
   * attribute being where the element's single value happens to sit.
   *
   * `<created date="…"/>` is the first case: the element means one thing and
   * `@date` is where it lives, so the key stays `critdates.created`. `<vrm
   * version="2" release="1" modification="0"/>` is the second: three separate
   * facts on one EMPTY element, and keying it `vrmlist.vrm` would have to pick
   * one and discard two.
   *
   * The naming rule does not change to accommodate it — it applies one level
   * down. For an attribute the containing thing is the *element*, so these are
   * `vrm.version`, `vrm.release`, `vrm.modification`.
   */
  attrKeys?: readonly string[];
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
  copyright: {
    copyryear: { attr: "year", repeatable: true },
    copyrholder: { repeatable: false },
  },
  keywords: {
    keyword: { repeatable: true },
    indexterm: { repeatable: true },
  },
  prodinfo: {
    prodname: { repeatable: false },
    brand: { repeatable: true },
    component: { repeatable: true },
    featnum: { repeatable: true },
    platform: { repeatable: true },
    prognum: { repeatable: true },
    series: { repeatable: true },
  },
  vrmlist: {
    vrm: {
      attrKeys: ["version", "release", "modification"],
      repeatable: true,
    },
  },
};

/**
 * Keys produced by {@link DitaLift.attrKeys} — `vrm.version` and friends.
 *
 * Derived rather than written out, so the two cannot disagree. The writer needs
 * it to tell such a key apart from an ordinary `container.element` one: they
 * look identical, and creating `vrm.version` would mean synthesising a
 * `<vrmlist><vrm/></vrmlist>` and folding three keys into one element, which is
 * not what the create path does.
 */
export const DITA_ATTR_KEYS: ReadonlySet<string> = new Set(
  Object.entries(DITA_LIFTS).flatMap(([, lifts]) =>
    Object.entries(lifts).flatMap(([element, spec]) =>
      (spec.attrKeys ?? []).map((attr) => liftKey(element, attr)),
    ),
  ),
);

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
  copyright: ["copyryear", "copyrholder"],
  // `(indexterm | keyword)*` — a repeatable *choice*, so any interleaving is
  // valid and the order here only decides where a created element lands.
  keywords: ["indexterm", "keyword"],
  vrmlist: ["vrm"],
  // `prodname, vrmlist?, (brand | component | featnum | platform | prognum |
  // series)*`. The tail is a choice group too, so its internal order is
  // likewise a placement preference rather than a rule.
  prodinfo: [
    "prodname",
    "vrmlist",
    "brand",
    "component",
    "featnum",
    "platform",
    "prognum",
    "series",
  ],
};

/**
 * The container an element of this name lives inside, or `undefined` when it
 * hangs directly off the root.
 *
 * A map is flatter than a topic. `<topicmeta>` holds `audience`, `category` and
 * `prodinfo` as direct children, where a topic nests the first two inside
 * `<prolog><metadata>` and `prodinfo` one deeper still. Encoding it here keeps
 * that asymmetry in the one file that already knows about it.
 */
export function ditaContainerParent(
  shape: DitaShape,
  name: string,
): string | undefined {
  if (name === "prolog" || name === "topicmeta") return undefined;
  // Two levels below the root are the same in both flavours: `<keywords>` and
  // `<prodinfo>` hang off `<metadata>`, and `<vrmlist>` off `<prodinfo>`. Only
  // the *top* level differs, which is what the fallthrough handles.
  if (name === "vrmlist") return "prodinfo";
  if (name === "keywords" || name === "prodinfo") {
    // A map may hold these directly under `<topicmeta>` or nest them in a
    // `<metadata>`; both are legal. Creating one goes to `<metadata>` in a
    // topic, where it is the only option, and directly under `<topicmeta>` in
    // a map, where it is the shorter of the two.
    return shape.kind === "map" ? "topicmeta" : "metadata";
  }
  return shape.kind === "map" ? "topicmeta" : "prolog";
}

/**
 * Where a new child goes inside a container, by content-model position.
 *
 * Returns the element it should be inserted *before*, or `undefined` for "at the
 * end", which the caller turns into an offset.
 *
 * Children the model does not list are skipped rather than used as anchors.
 * They are specializations docmeta has never seen, and inserting before one
 * would be a guess about a model it does not understand; going last is at least
 * a position the author can see and move.
 */
export function childAnchor(
  container: XmlElement,
  containerName: string,
  childName: string,
): XmlElement | undefined {
  const model = DITA_CONTENT_MODEL[containerName] ?? [];
  const target = model.indexOf(childName);
  if (target === -1) return undefined;
  for (const child of childElements(container)) {
    const at = model.indexOf(child.nodeName.toLowerCase());
    if (at === -1) continue;
    if (at > target) return child;
  }
  return undefined;
}

/** Find a metadata container by name, searching down from the lift root. */
export function findContainer(
  from: XmlElement,
  name: string,
): XmlElement | undefined {
  if (from.nodeName.toLowerCase() === name) return from;
  for (const child of childElements(from)) {
    const found = findContainer(child, name);
    if (found) return found;
  }
  return undefined;
}

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
