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

  const byDoctype = /<!DOCTYPE[^>]*\/\/DTD DITA/i.test(
    content.slice(0, doctypeLimit(content)),
  );
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

/** A DOCTYPE can only precede the root element, so stop at the tag that opens it. */
function doctypeLimit(content: string): number {
  const match = /<[A-Za-z_]/.exec(content);
  return match ? match.index : content.length;
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
