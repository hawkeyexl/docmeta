# 0020 — element metadata, and the DITA schema it unblocks

- **Status:** Implemented
- **Supersedes:** [0018](0018-write-support-shipped-for-all-three.md), whose model of DITA metadata was "the `<othermeta>` channel, and that is where a write goes"
- **Serves:** Sara · S1 · Maya · M1, M4
- **Touches:** `src/extractors/{element-key,element-write,xml-read,xml-write,dita,dita-write,html-read,html-write}.ts`, `src/core/{config,resolve-schema}.ts`, `src/commands/*`, `src/schemas/dita/1.3.json`, `reference/{element-metadata,dita-schema,formats,configuration}.mdx`

## What changed

0018 shipped write support for DITA and, in doing so, fixed docmeta's model of
what DITA metadata *is*: `<othermeta name= content=>`, read and written in the
same place. That model was right about the channel it described and wrong about
being the whole picture.

A DITA topic can carry a full, correct `<prolog>` — `<author>`, `<critdates>`,
`<audience>`, `<permissions>` — and docmeta reported it as having no metadata at
all. The elements OASIS actually defines for the job were invisible. The same
blind spot ran wider than DITA: an XML article with `<title>` as an element had
nothing to validate, and an HTML page's `<title>` reached exactly one key.

So the gap the schema sweep hit when it skipped DITA was never a missing schema.
**It was a missing extraction surface**, and a schema over fields the extractor
never produces validates nothing.

## The rule: the containing element is the namespace

A value held in an element is keyed `<immediate parent>.<element name>`.

```
<article><byline>Ada</byline>              ->  article.byline
<prolog><author>Ada</author>               ->  prolog.author
<critdates><created date="2026-01-15"/>    ->  critdates.created
<head><title>Docs</title>                  ->  head.title
```

Stated as a general convention for structured formats rather than a DITA
special case, because the next structured extraction should follow it and
writing it down once is cheaper than deriving it twice.

Three properties made it the right rule rather than one of several:

1. **Nothing moves.** Root attributes, `<meta>`, `<othermeta>` and HTML's
   `<title>` keep the names they have always had, so no existing document
   changes meaning and no existing schema changes verdict.
2. **Both channels are validated.** A topic carrying `<audience type="x"/>` and
   `<othermeta name="audience" content="y"/>` yields two keys, disagreeing.
   Neither wins. Any precedence rule discards one, and the discarded one is
   exactly the one nobody is checking.
3. **Each key names its own write target.** `prolog.author` writes
   `<prolog><author>`; `author` writes the othermeta. 0018's rule — *a write
   updates the location the effective value was read from* — then holds by
   construction rather than by care.

### Dots in keys, slashes in paths

An XML element name may legally contain a dot, so a dotted *path* is
unparseable: `a.b.c` could be `<a.b><c>`, `<a><b.c>` or `<a><b><c>`. The
ambiguity never reaches a key, because nothing parses a key back into a path.
It only reaches `elements:` config, which must parse — hence `/` there.

Not a new convention. docmeta already printed it: JSON Pointer separates
structure with slashes and tolerates a dot inside one segment, which is why
`/ms.date` has worked since `microsoft:learn:1.0` shipped.

## What the convention will not do

The convention lifts values, not structure: an element with element children is
a container, and whitespace-only text is indentation. That is what keeps a
document body out of the key set without a hardcoded ignore list.

Generic XML lifts **lists, always**, because XML states no cardinality and a
type that changed with document content could not be written against. Where a
content model does state it — HTML's single `<title>`, DITA's `author*` versus
`source?` — the key follows the model.

`elements:` config reaches what the convention deliberately misses, with `@attr`
for values held in attributes. It *extends* rather than overrides, so naming a
path cannot retype a key the content model already typed exactly.

## The write boundary

Two cases, and the difference is the whole safety argument:

- **Updating an element that exists** replaces a span. It changes content, not
  shape, so it cannot change whether the document is valid — and therefore works
  in dialects docmeta knows nothing about.
- **Creating an element that is missing** needs to know where the element is
  legal. Done only for DITA, whose content model can answer.

Adding or removing a repeated element is refused outright. A key backed by N
elements receiving M values is unambiguous only when they match; a `fill` that
quietly dropped an `<author>` is worse than one that declines.

## Stress test

**1. The generic XML writer would have written `article.title` as a root
attribute.** It never consulted `sources`, and a dot is a legal XML NameChar, so
nothing structural stopped it — while the reader kept taking that key from the
element. Exactly 0018's loop, introduced by the read half of this change and
caught before the write half existed. Now: element sources branch first, and
creating an attribute whose first segment matches the root's own name is
refused. The guard is narrow deliberately — only *this* root's name can collide,
so `dc.title` and `ms.date` stay writable, and an existing test asserting that
is what forced the narrowing.

**2. Two keys backed by one element broke every `<title>` write.** `title` and
`head.title` read the same text, so writing either moves the other, and
`applyHtml`'s verification held the co-derived key to its *old* value and refused.
Found by the existing HTML write tests going red. The verification now exempts
keys sourced from an element the write touched — not a weakening, since the
written key is still checked strictly and anything from an untouched element is
still held exactly.

**3. Multi-field DITA `fill` died with an internal error.** Adding
`critdates.created`, `prolog.source` and `metadata.audience` to a topic with only
an `<author>` resolves to three containers that all land at the end of
`<prolog>` — one insertion point, three edits, and `spliceAll` refuses
overlapping edits. Grouping by container was not enough; blocks are grouped by
*anchor*. **Found by dumping the bytes, not by a test** — every test passed. The
same dump caught the indent being a level short, because the anchor is
`</prolog>`, which sits a level out from the children it closes over. This is
the entry that most justifies the plan's instruction to assert byte output
rather than "it did not throw".

**4. `docmeta get article.title` returned empty, not an error.** Dot-notation
split it into `article` → `title` and gave up. Tolerable while dotted keys were
an oddity; not once they are the majority of keys in a structured document. Now
falls back to the literal key, with descent still winning wherever it resolves.
This overrode a test that asserted the pointer form was the *only* spelling —
a deliberate rule, retired deliberately.

**5. `<topicmeta>` was assumed to mirror `<prolog>`, and does not.** It holds
`audience`, `category`, `prodinfo`, `othermeta` and `resourceid` as **direct
children**. Checked against the OASIS content-model appendix before coding, on
the plan's explicit instruction not to assume. The naming rule absorbs it
without a special case: `topicmeta.audience` in a map, `metadata.audience` in a
topic, each naming where the value is.

## Not breaking

Considered as `feat!:` and rejected. Nothing that worked before works
differently: keys do not move, schemas name existing keys, every `get` spelling
that resolved still resolves. Only new keys appear. The one way to notice is a
schema using `additionalProperties: false` over XML or HTML — and that schema
asserted the document had nothing else in it, which was untrue all along;
docmeta simply could not see the elements. Fixing under-reporting is not a
contract break, and a major bump on a published package for a contrived case is
a real cost paid for nothing.

## What is deferred, and why

`<copyright>` nests `copyrholder`/`copyryear @year` — two levels, two shapes.
`<keywords>` holds `<indexterm>`/`<keyword>` children rather than text, so it is
not a value the element rule can lift at all. The `<prodinfo>` tail is long and
rarely carries document metadata. All three are reachable through an `elements:`
path; none is described by `oasis:dita-metadata:1.3`, and the schema says so.

DTD validation of written output is **not** covered in CI, because no DITA
validator is available there. Stated here rather than implied, so nobody reads
the idempotence and round-trip tests as proving more than they do.
