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

/** The metadata key an element contributes, given its parent's name. */
export function liftKey(parentName: string, elementName: string): string {
  return `${parentName.toLowerCase()}.${elementName.toLowerCase()}`;
}
