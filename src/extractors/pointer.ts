/**
 * JSON Pointer helpers shared by every extractor.
 *
 * These lived in `frontmatter.ts` and were imported from there by `asciidoc`
 * and `rst`, while `html` and `xml` each carried a byte-identical private copy
 * — three implementations of two functions, and nothing keeping them in step.
 * Adding the column map made that concrete: the same fix would have had to be
 * applied in three places, and a reader had no way to tell which copy was
 * canonical.
 *
 * A pointer is not a frontmatter concept, so this is their home rather than
 * that one.
 */

/**
 * Escape one JSON Pointer segment, per RFC 6901.
 *
 * `~` first, or the `/` replacement's `~1` would be re-escaped to `~01`.
 */
export function escapePointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Build a pointer -> position lookup over one map.
 *
 * Position-agnostic on purpose: a line map and a column map share exactly one
 * resolution rule, so they cannot drift into answering from different nodes and
 * pair a line from one place with a column from another.
 *
 * Three steps, in order: a bare top-level key is normalized to its pointer, an
 * exact hit wins, and otherwise it walks up to the nearest recorded ancestor —
 * Ajv reports nested pointers like `/tags/0` for a value the extractor recorded
 * only at `/tags`. The document root is the last resort.
 */
export function positionForFactory(
  map: Map<string, number>,
): (pointer: string) => number | undefined {
  return (pointer: string) => {
    // A bare top-level key (e.g. "type") maps to its "/type" JSON pointer.
    const start =
      pointer !== "" && !pointer.startsWith("/")
        ? `/${escapePointerSegment(pointer)}`
        : pointer;
    if (map.has(start)) return map.get(start);
    let p = start;
    while (p.length > 0) {
      const idx = p.lastIndexOf("/");
      if (idx < 0) break;
      p = p.slice(0, idx);
      if (map.has(p)) return map.get(p);
    }
    return map.get("");
  };
}
