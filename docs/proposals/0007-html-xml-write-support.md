# 0007 — `fill` write support for HTML, and why XML/DITA must stay read-only

- **Status:** Superseded by [0018](0018-write-support-shipped-for-all-three.md)
- **Serves:** Maya · M1 (the retrofit tail), Theo · T1
- **Touches:** `src/extractors/html.ts`, new `src/extractors/html-write.ts`, `CONTRIBUTING.md`
- **Verdict:** Implement HTML. Keep XML and DITA read-only, for a reason
  stronger than the current one.

## Problem

`fill` is the answer to "adopting a standard on an existing docset is not a
data-entry project". It stops at four of six supported formats. `apply` is
implemented on `markdown`, `mdx`, `asciidoc`, and `rst`. `html` and `xml` have
no `apply` at all. So `listFormats()` reports them read-only, and `fill` refuses
them. `test/fixtures/fill/unsupported.html` locks in that refusal.

DITA and HTML shops are exactly the population with the largest legacy docset
and the least appetite for hand-editing thousands of files. So the feature is
missing where it would pay the most.

This was a deliberate decision, not an oversight. `CONTRIBUTING.md § Write support
is optional` states the principle:

> Only implement it if the format can round-trip without disturbing the rest of
> the document. […] A format whose read is lossy should stay read-only rather than
> guess.

So the burden here is not "add `apply`". It is to show that a write can satisfy
that principle, or to accept the refusal and say so more precisely.

## Verdict after stress testing

| Format | Verdict | Reason |
|---|---|---|
| `.html` / `.htm` | **Implement** | A `<meta>` write is a byte-splice into `<head>`, the same shape as fenced frontmatter. Verified below. |
| `.xml` | **Stay read-only** | Writable in principle, but the read model (root attributes) makes the *target* ambiguous. |
| `.dita` / `.ditamap` | **Stay read-only, permanently** | Writing root attributes produces DTD-invalid DITA. Correct support needs a `<prolog>` writer, which is a separate project. |

## Proposal: HTML write support

### The mechanism is a splice, not a re-serialization

The naive approach is to parse with parse5, mutate the tree, and re-serialize.
That is exactly what the CONTRIBUTING principle forbids. parse5's serializer
normalizes. It materializes implied `<html>`/`<head>`/`<body>`, re-encodes
entities, drops the original attribute quoting style, and discards the doctype's
original spelling. A hand-authored file would come back reformatted, and `fill`
would produce a diff touching every line.

But parse5 already gives byte-exact source locations, because `html.ts` requests
`sourceCodeLocationInfo: true` for its `lineFor()` map. Verified:

```
--- parse5 offsets:
    {"tag":"head","start":23,"end":94,"startTagEnd":29}
    {"tag":"title","start":32,"end":49,"startTagEnd":39}
    {"tag":"meta","start":52,"end":86,"startTagEnd":86}
```

So the write is a text splice at a known offset, and the document outside the
insertion is untouched:

```
<!DOCTYPE html>
<html>
<head>
  <meta name="description" content="NEW">
  <title>Hi</title>
  <meta name="type" content="guide">
</head>
<body><p>x</p></body>
</html>
```

`html.slice(0, at) === spliced.slice(0, at)` → `true`. This is the same guarantee
`frontmatter-write.ts` provides, reached the same way, so it satisfies the stated
principle rather than bending it.

### Write rules

- **Update in place** when a `<meta name="X">` exists. Replace only the
  `content` attribute's value span, preserving quote style and the rest of the
  tag.
- **Insert** when it does not. Place it immediately after `<head>`'s start tag,
  indented to match the first existing child of `<head>`.
- **`title`** maps to `<title>`, replacing its text span only. `html.ts` reads it
  as metadata, so `fill` must be able to write it or the two disagree.
- **Refuse** rather than guess when `<head>` is implied rather than present (a
  fragment with no `<head>`). Throw `DocmetaError`, which the command layer already
  records as a per-file error while the run continues.
- **Re-parse to verify** before returning, as `CONTRIBUTING.md` requires.
  Extract from the spliced text and assert the patch round-trips. A serializer
  bug becomes a refusal, not a corrupted file.

## Stress test

### 1. `property=` vs `name=`, which must not create a duplicate

`html.ts` reads `name` **or** `property` (OpenGraph). If a document carries
`<meta property="og:description">` and `fill` inserts `<meta name="og:description">`,
the extractor's "last tag wins" rule means the new tag shadows the old, leaving
two contradictory tags. Rule: when updating, match on whichever attribute the
existing tag uses; only ever insert with `name`.

### 2. Duplicate `<meta name="X">` tags, where the last is updated, per the read model

The extractor documents "duplicate keys: last tag wins". A writer that updates
the *first* would produce a document whose read value is still the old one. That
is a silent no-op that `fill` would report as written. Update the last
occurrence so read and write agree. This is the kind of mismatch the mandatory
re-parse check catches.

### 3. `<title>` in SVG, a read bug that must be fixed *before* any write code

`html.ts` takes the **first** `<title>`, noting later ones "e.g. in SVG" are
ignored. An inline `<svg><title>` before the document `<title>` makes the first
`<title>` the SVG's. The reader has this bug today. A writer would then rewrite
the SVG's title, turning a mostly-harmless read quirk into content corruption.

Scope this explicitly rather than folding it into the write work, because **it
is a behavior change on its own**. The `title` extracted from an SVG-headed
document changes, which alters `validate` and `get` output for those documents
with no write feature involved. That means it needs:

- its own red test and fixture, landed **before** any `apply` code exists
  (step 0 in the implementation sketch, not part of step 1);
- its own changelog entry as a `fix(extractors):` commit, since it changes
  existing output;
- its own decision on precedence. Prefer a `<title>` that is a descendant of
  `<head>`, and fall back to first-wins only when `<head>` has none.

Shipping it separately also means the write work starts from a reader whose
contract is already correct. That is the only way the mandatory re-parse
verification is meaningful.

### 4. Escaping the written value, which is required and not symmetric with reading

parse5 decodes entities on read, so a proposal string may contain `<`, `&`, or a
quote. Writing it raw into an attribute breaks the document. Escape `&`, `<`,
`>`, and the quote character actually in use. Test with a proposal containing
`"` and `&`. Note also that the value came from an LLM, so it is untrusted input
in the sense that matters. It will eventually contain something hostile to naive
escaping.

### 5. `content` spanning the value only, where offset precision is needed

parse5 gives per-attribute locations via `sourceCodeLocation.attrs`, which covers
the whole `content="…"` pair, not just the value. The splice must recompute the
value span inside that range. Cheap, but it is where an off-by-one lands, so it
needs a test with single quotes, double quotes, and an unquoted value.

### 6. CRLF and BOM must survive

Offsets are byte offsets into the original string, so CRLF is preserved
automatically for untouched regions. The *inserted* line must use the document's
prevailing newline, not `\n`. `xml.ts` already strips a BOM before parsing, and
parse5 does not, so a BOM shifts every offset by one. Test both.

### 7. Why not XML, when the read model is not a write model

`xml.ts` reads **root-element attributes only**. Writing therefore means adding
attributes to the root element. Mechanically this is tractable (`@xmldom/xmldom`
exposes `lineNumber`, and the start-tag's `>` is findable by scanning past quoted
values). Semantically it is a guess:

- A schema asking for `description` gets `<document description="…">`, when in
  most real XML vocabularies prose belongs in a child element, not an attribute.
- Generic XML has no convention for where document metadata lives. docmeta reads
  root attributes because that is the one place it can read *something* without
  a vocabulary. That is a reasonable read heuristic and an unreasonable write
  target.

Reading a heuristic location is harmless. Writing to it invents markup the
document's own vocabulary may not permit. Stays read-only.

### 8. Why not DITA, when writing produces invalid documents

This is the decisive case. DITA is DTD-constrained: `<topic>` permits a fixed
attribute set (`id`, `xml:lang`, `outputclass`, `props`, …). Document metadata
belongs in `<prolog>` (`<author>`, `<critdates>`, `<metadata><keywords>`) and
`<shortdesc>`, **not** in root attributes.

So `fill` writing `<topic description="A tour of the CLI">` yields a file that:

- fails DITA DTD/RELAX NG validation,
- is rejected by DITA-OT at build time,
- and *passes* docmeta afterwards, because docmeta reads root attributes.

That last point is the worst outcome available. docmeta would report success
while breaking the user's build. Real DITA support means a `<prolog>` writer
that knows the element order the DTD mandates. That is a much larger,
vocabulary-specific project, and a reasonable future proposal. It is not this
one.

### 9. Does the extension-level split fit the extractor model? (yes, and it is a wrinkle)

`xml.ts` registers `.xml`, `.dita`, `.ditamap` in one extractor, and writability
is per-extractor (`typeof extractor.apply === "function"`). Since both XML
verdicts are "read-only", nothing needs to split today. But if generic XML is
ever made writable, `.dita` must not inherit it. That means either a separate
DITA extractor, or making writability per-extension. Recording this now, because
the current one-extractor-many-extensions shape quietly assumes uniform
writability, and `listFormats()` reports it per format name.

### 10. Does this change `schemas` output? (yes, and it is the user-visible signal)

`docmeta schemas` prints `writable` / `read-only` per format from the presence
of `apply`. HTML flips to `writable`, and `xml` stays `read-only`. The
`reference/formats.mdx` table and its "Why some formats are read-only" section
must be updated, and improved. The current text says XML and HTML "do not
implement `apply` at all" without distinguishing *cannot* from *should not*.
After this proposal the reasons differ per format, and the docs should say so.

## Implementation sketch

0. **Ship the reader fix on its own** (stress test 3). `test/extractors.test.ts`
   with an SVG-headed fixture; prefer a `<title>` inside `<head>`. Separate
   `fix(extractors):` commit with a changelog note, merged before any write code
   is written.
1. In `test/html-write.test.ts`, updating an existing `<meta>` leaves bytes
   outside the value span identical.
2. In `test/html-write.test.ts`, a new `<meta>` is inserted after `<head>`,
   indentation matches the first child, and the prevailing newline is preserved
   (CRLF fixture, BOM fixture).
3. In `test/html-write.test.ts`, a `property=` tag is updated as `property` and
   never duplicated as `name`, and duplicate `name` tags update the last.
4. In `test/html-write.test.ts`, an escaping fixture with `"`, `'`, `&`, `<` in
   the value, plus unquoted and single-quoted existing attributes.
5. In `test/html-write.test.ts`, a fragment with no `<head>` throws
   `DocmetaError`.
6. In `test/fill.test.ts`, replace `test/fixtures/fill/unsupported.html` with a
   writable fixture, and add `unsupported.dita` asserting the refusal *and* its
   message.
7. In `CONTRIBUTING.md § Write support is optional`, update the XML/HTML
   sentence to the per-format reasoning above. It is currently the canonical
   statement of a decision this proposal changes for one format and hardens for
   two.
