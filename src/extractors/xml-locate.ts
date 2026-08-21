/**
 * Turning xmldom's positions into character offsets.
 *
 * xmldom reports only where a node *starts*, as `lineNumber` and
 * `columnNumber` — there is no `startOffset`, no end position, and no marker for
 * the end of a start tag. (The SAX layer does compute an offset per attribute
 * and then discards it converting to line/column.) Splicing needs ranges, so
 * this module rebuilds them.
 *
 * The subtlety is which characters count as line breaks. xmldom measures against
 * `normalizeLineEndings(source)`, which folds CR LF, lone CR, NEL (U+0085), LINE
 * SEPARATOR (U+2028) and PARAGRAPH SEPARATOR (U+2029) all down to LF before
 * counting. An index that recognised only LF would drift the moment a document
 * used any of the others, and the symptom is not a wrong answer — it is a splice
 * at the wrong offset, which is a corrupted file. So the index below counts
 * exactly those six forms, and `xml-write.test.ts` pins each one.
 *
 * CR LF is two characters folding to one, which shortens the normalized string.
 * That is harmless here because reconstruction goes from (line, line-relative
 * column) against the *original*, so a length change earlier in the file cannot
 * shift anything.
 */

/** The six break forms xmldom folds to LF before counting lines. */
const LINE_BREAK = /\r\n|\r|\n|\u0085|\u2028|\u2029/g;

/** Character offsets at which each 1-based line begins. */
export function lineStarts(source: string): number[] {
  const starts = [0];
  LINE_BREAK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINE_BREAK.exec(source)) !== null) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

/**
 * The offset of a 1-based (line, column) pair. Out-of-range lines clamp to the
 * start of the document rather than returning NaN, so a caller that mis-reads a
 * position gets a refusal from the verify step rather than a silent splice at
 * an undefined index.
 */
export function offsetAt(starts: number[], line: number, column: number): number {
  const base = starts[line - 1];
  if (base === undefined) return 0;
  return base + column - 1;
}

/**
 * The span of a quoted attribute value, given the offset of its opening quote —
 * which is exactly what xmldom's `columnNumber` points at for an attribute.
 *
 * Returns the range *inside* the quotes and the quote character in use, so a
 * rewrite keeps the document's original quoting style.
 */
export function attrValueSpan(
  source: string,
  quoteOffset: number,
): { start: number; end: number; quote: string } | undefined {
  const quote = source[quoteOffset];
  if (quote !== '"' && quote !== "'") return undefined;
  const close = source.indexOf(quote, quoteOffset + 1);
  if (close === -1) return undefined;
  return { start: quoteOffset + 1, end: close, quote };
}

/**
 * The offset just past a start tag's element name, which is where a new
 * attribute can always be inserted.
 *
 * Inserting here rather than before the closing `>` is deliberate: finding that
 * `>` means scanning past attribute values that may themselves contain one,
 * while the name ends at the first whitespace, `/` or `>` and cannot be
 * mistaken. `tagOffset` is the offset of the `<`.
 */
export function afterElementName(
  source: string,
  tagOffset: number,
): number | undefined {
  if (source[tagOffset] !== "<") return undefined;
  let i = tagOffset + 1;
  while (i < source.length && !/[\s/>]/.test(source[i] ?? "")) i++;
  return i > tagOffset + 1 ? i : undefined;
}
