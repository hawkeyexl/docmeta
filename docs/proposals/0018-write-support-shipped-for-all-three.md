# 0018 — write support shipped for HTML, XML **and** DITA

- **Status:** Superseded by [0020](0020-element-metadata.md)
- **Supersedes:** [0007](0007-html-xml-write-support.md), whose verdict was "implement HTML; keep XML and DITA read-only, permanently"
- **Serves:** Maya · M1, M4 · Theo · T1
- **Touches:** `src/extractors/{html,xml,dita}*`, `reference/formats.mdx`, `CONTRIBUTING.md`

## What changed

0007 concluded that `fill` should gain HTML write support, and that XML and DITA
must stay read-only, DITA **permanently**. All three shipped.

Both objections behind that verdict were real. Neither was permanent.

### "xmldom gives no offsets, so XML cannot be spliced"

True as stated. `Node` carries `lineNumber` and `columnNumber` and nothing else:
no `startOffset`, no end position, no start-tag end. The SAX layer computes an
attribute offset and discards it converting to line/column.

The span is reconstructible anyway, because **an attribute's reported column
lands exactly on the opening quote of its value**. The span runs to the next
matching quote, and the quote character itself says which style to preserve.
Measured against `test/fixtures/topic.dita` before any code was written,
covering DOCTYPE, wrapped attributes, LF and CRLF.

What 0007 could not have known is where the difficulty actually sat. It was not
in finding the value. It was in the line index. xmldom measures positions
against a copy of the source with line endings normalized. It folds CR LF, lone
CR, NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR to LF before counting. An index
recognising only LF drifts the moment a document uses any of the others. The
symptom is not a wrong answer but a splice at the wrong offset, which is a
corrupted file.

### "writing root attributes produces DTD-invalid DITA"

Also true, and this one is not answerable by being careful. It is answerable
only by writing somewhere else. DITA has a designated place for document
metadata: `<prolog><metadata><othermeta/></metadata></prolog>` for topics,
`<topicmeta>` for maps. 0007 named that as "a separate project" and stopped.

It was a project, and it carried a consequence 0007 did not have to face: the
**read** model had to move with it. A value written into an `<othermeta>` the
reader cannot see leaves the field missing. So `validate` fails again, and the
next `fill` proposes it again, forever. Write where you read is not a nicety
there; asymmetry is a loop.

## The rule 0007 did not have

`fill` rewrites values that are present but **invalid**, not only missing ones.
That is the ordinary retrofit case, not an edge one. So "new values go in an
`<othermeta>`" would have added a correction beside the stale root attribute a
DITA processor actually honors. The result is a green report over a topic that
still says the wrong thing.

> **A write updates the location the effective value was read from.** Only a key
> absent from every channel chooses a location, and then it goes to the format's
> designated one.

This is not DITA-specific, and the HTML half of 0007 got it wrong for the same
reason. 0007 says "`title` maps to `<title>`". Measurement says otherwise. A
`<meta name="title">` beats `<title>` in **either** document order, so writing
to `<title>` would have landed somewhere the reader ignores. The existing
comment says "the first `<title>` wins". That means *among several `<title>`
elements*, and reads like the opposite.

Cases that update an existing span cannot change whether a document is valid,
because the attribute is already there. Only insertion adds structure, and only
where the content model already allows it. The rule and the DTD-safety argument
turn out to be the same argument.

## What 0007 got right

The HTML mechanism, exactly as written: splice, never re-serialize. parse5
already reports byte-exact locations, and `html.ts` already requested them for
its annotation columns. Re-serializing would have reflowed entities, attribute
quoting, void elements and the doctype across every file. That discipline
carried to XML and DITA unchanged. It is why an unresolvable `&nbsp;` survives a
write, even though the XML reader goes out of its way to accept it.

## Consequences

- `validate` reads six formats and `fill` writes all six.
- **"Permanently" was a judgment about effort, not a fact about the format.**
  0007's two objections were the honest state of the evidence when it was
  written. What changed was that someone measured the parser rather than reading
  its type definitions. That is the useful thing to take from this pair, and the
  reason 0007 is left exactly as written rather than corrected.
- `CONTRIBUTING.md`'s write-support guidance now carries the
  write-back-to-source rule. `html-read.ts` and `xml-read.ts` each export the
  precedence their writer aims at, so the two cannot drift.
