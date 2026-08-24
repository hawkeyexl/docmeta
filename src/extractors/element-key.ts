/**
 * The naming rule for element-derived metadata, shared by every structured
 * format.
 *
 * **The containing element is the namespace.** A value that lives in an element
 * rather than in an attribute is keyed `<immediate parent>.<element name>`:
 *
 *   <prolog><author>Ada</author>   ->  prolog.author
 *   <head><title>Docs</title>      ->  head.title
 *   <article><byline>Ada</byline>  ->  article.byline
 *
 * Existing flat keys do not move. Root attributes, `<meta>`, `<othermeta>` and
 * HTML's `<title>` keep the names they have always had, so a document can carry
 * the same fact in two channels and **both are validated** — neither wins, and
 * neither is silently discarded.
 *
 * The separator is a dot in the key and a slash in an `elements:` config path,
 * and the asymmetry is deliberate. XML element names may legally contain dots
 * (`.` is a NameChar, just not a NameStartChar), so a dotted *path* cannot be
 * parsed: `a.b.c` could be `<a.b><c>`, `<a><b.c>` or `<a><b><c>`. That never
 * reaches the key, because nothing parses a key back into a path — a schema
 * names the exact string. It only reaches config, which must parse, and `/`
 * cannot appear in an element name.
 *
 * This is not a new convention. docmeta already prints exactly it: JSON Pointer
 * separates structure with slashes and tolerates a dot inside one segment,
 * which is why `/ms.date` has worked since `microsoft:learn:1.0` shipped.
 */

import { DocmetaError } from "../types.js";

/** The metadata key an element contributes, given its parent's name. */
export function liftKey(parentName: string, elementName: string): string {
  return `${parentName.toLowerCase()}.${elementName.toLowerCase()}`;
}

/** One `elements:` entry, parsed. */
export interface ElementPath {
  /** Element names from the document root down, lowercased. At least two. */
  segments: string[];
  /** Attribute carrying the value. Absent means the element's text. */
  attr?: string;
  /** The key this path contributes, derived by {@link liftKey}. */
  key: string;
}

/**
 * Parse an `elements:` path — a slash-separated child path from the document
 * root, optionally ending in `@attribute`.
 *
 *   article/byline/author   ->  key `byline.author`, from element text
 *   html/head/link@href     ->  key `head.link`,     from the href attribute
 *
 * A deliberate subset of XPath's child axis. Naming the subset sets the
 * expectation that predicates, axes and functions are not coming, rather than
 * leaving someone to try `article/byline[1]` and file a bug.
 *
 * Two segments are the minimum because the key needs a parent to be the
 * namespace. A bare `title` names an element with no container, so there is no
 * key to derive — that is a config error, not an empty result, since silently
 * ignoring it would leave someone waiting for a check that never runs.
 */
export function parseElementPath(path: string): ElementPath {
  const at = path.indexOf("@");
  const attr = at === -1 ? undefined : path.slice(at + 1).trim();
  const body = at === -1 ? path : path.slice(0, at);
  const segments = body
    .split("/")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");

  if (segments.length < 2) {
    throw new DocmetaError(
      `Invalid elements path "${path}": it needs at least two segments, ` +
        "because the key is named after the element's parent " +
        '(so "article/title" gives `article.title`).',
    );
  }
  if (at !== -1 && attr === "") {
    throw new DocmetaError(
      `Invalid elements path "${path}": "@" must be followed by an attribute name.`,
    );
  }

  const parent = segments[segments.length - 2] ?? "";
  const name = segments[segments.length - 1] ?? "";
  return { segments, ...(attr ? { attr } : {}), key: liftKey(parent, name) };
}
