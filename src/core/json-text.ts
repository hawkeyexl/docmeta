/**
 * Concessions that belong to **parsing** decoded text, and to nothing else.
 *
 * Its own module so the rule below has one statement rather than three, and so
 * the constraint that makes it subtle is written down once, next to the code it
 * constrains.
 */

/**
 * Drop a leading byte-order mark.
 *
 * `EF BB BF` at the head of a UTF-8 file decodes to U+FEFF, and Node's
 * `JSON.parse` rejects it — while almost every other tool accepts it. Windows
 * editors write it routinely: PowerShell 5.1's `Set-Content -Encoding utf8`,
 * Notepad, older VS Code configurations. The result was a schema file that
 * every other JSON tool read happily failing as
 * `is not valid JSON: unexpected token at line 1 column 1`, which reads as an
 * empty or corrupt file and points the operator nowhere near the cause.
 *
 * **Apply this to the decoded string that is about to be parsed, never to the
 * bytes.** An integrity pin is taken over exactly what is on disk or exactly
 * what a server sent, BOM included, and `schemas vendor` writes those same
 * bytes to the vendored copy. Stripping anywhere upstream of the hash would
 * make every pinned BOM'd schema fail its own pin, and would make the vendored
 * file differ from the source it claims to be a copy of. Parsing is the only
 * step that cares.
 *
 * Only U+FEFF, and only leading: a BOM anywhere else is real content, and
 * UTF-16/UTF-32 marks are a different problem — those files are not valid UTF-8
 * at all, and reporting them as bad JSON is honest.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
