# 0031 — the input-format gap: notebooks and Markdoc in, standalone data files out

- **Status:** Proposed
- **Serves:** Maya · M1, M4 · Sara · S1, S2
- **Depends on:** [0020](0020-element-metadata.md) (the parent-is-the-namespace
  naming rule, and the both-channels-are-validated rule that forbids a precedence
  tiebreak), [0018](0018-write-support-shipped-for-all-three.md) (a write updates
  the location the effective value was read from — load-bearing the moment a
  format has two channels), [0014](0014-empty-input-is-not-success.md) (the guard
  that turns an unreadable corpus into an error instead of a green run)
- **Relates to:** [0007](0007-html-xml-write-support.md) (the "permanently" this
  proposal is careful not to repeat), [0019](0019-no-docmeta-init.md) (the shape
  of a rejection), [0009](0009-publish-builtin-schemas.md) (docmeta publishes a
  MyST schema, which is where this gap becomes self-inflicted)
- **Touches (planned):** new `src/extractors/{markdoc,notebook,notebook-write}.ts`,
  `src/extractors/index.ts`, `reference/{formats,platform-schemas}.mdx`,
  `CONTRIBUTING.md`, `test/{extractors,notebook-write,cli.integration}.test.ts`
- **Verdict:** implement `.mdoc` and `.ipynb`. **Reject** standalone `.json`/`.yaml`,
  LaTeX, Typst, Confluence storage format and `.txt`. Defer Org-mode.

## Problem

`src/extractors/index.ts` registers six extractors covering eleven extensions.
Everything else is invisible, and the ways it is invisible differ enough that
they are not one bug.

### 1. docmeta ships a schema for content it cannot read

`myst:frontmatter:1.10` is the largest built-in — 41 fields, published at a
stable URL, documented on the site's platform-schemas page, and typing
`kernelspec`, `execute` and `binder`, which are the fields a *notebook* carries.
MyST and Jupyter Book corpora are substantially `.ipynb`. docmeta cannot open one:

```console
$ docmeta validate notebook.ipynb
docmeta: Unsupported file type ".ipynb" for "notebook.ipynb". Supported: .md,
.markdown, .mdx, .adoc, .asciidoc, .rst, .xml, .dita, .ditamap, .html, .htm.
Use --as to override.
# exit 2
```

That is the honest half. The transcript that matters is what happens when the
operator takes the error message's own advice:

```console
$ docmeta validate notebook.ipynb --as markdown -s myst:frontmatter:1.10
✓ notebook.ipynb

1 file checked, 1 passed, 0 failed, 0 errors
# exit 0
```

Green, against the MyST schema, on a notebook whose metadata was never read. The
fixture carries `"title": "Fitting a curve"`, an `authors` list and a
`kernelspec` in its top-level `metadata`, and the markdown extractor found no
fenced block, so `data` is `{}` and a schema that requires nothing passes it.
`query` says the same thing without the ambiguity:

```console
$ docmeta query "SELECT * FROM docs" . --as markdown --ext .ipynb
_path           _format   _present  _data
notebook.ipynb  markdown  0         {}
1 row
```

`_present 0`, `_data {}`. The false green is not a schema bug and not a
resolution bug — the row is empty because nothing read the file.

Point docmeta at the directory instead and [0014](0014-empty-input-is-not-success.md)
does its job, which is the one piece of good news here:

```console
$ docmeta validate .
docmeta: No files matched. Patterns tried: ".".
Nothing was validated, so this is an error rather than a pass.
Pass --allow-empty (or set allowEmpty: true) if matching nothing is expected.
# exit 2
```

The sandbox held four documents. A MyST source tree looks empty to docmeta.

### 2. Markdoc is reachable, and only by disabling format detection

`.mdoc` is Markdown with `{% %}` tags, and its metadata is an ordinary leading
`---` block:

```console
$ docmeta validate page.mdoc
docmeta: Unsupported file type ".mdoc" for "page.mdoc". […] Use --as to override.
# exit 2

$ docmeta get title,description page.mdoc --as markdown -f json
[
  {
    "file": "page.mdoc",
    "present": true,
    "values": {
      "title": "Payments quickstart",
      "description": "Take your first payment"
    }
  }
]
```

The existing extractor reads it perfectly. So the gap is registration, not
extraction — which makes the workaround look free until the corpus is mixed.
`--ext` *replaces* the walk's extension set and `--as` forces one extractor onto
everything it finds:

```console
$ docmeta query "SELECT * FROM docs" . --ext .mdoc,.html --as markdown
_path        _format   _present  _data                                       …
legacy.html  markdown  0         {}                                          …
page.mdoc    markdown  1         {"title":"Payments quickstart", …}          …
2 rows
```

`legacy.html` has a `<title>` and a `<meta name="type">` that docmeta reads
natively every other day of the week. Forced through the markdown extractor it
reports `_present 0`. There is no flag combination that validates a `.mdoc` and
a `.html` correctly in one run.

### 3. A standalone data file has no reader at all, and no workaround

```console
$ docmeta get title,type sidecar.yaml --as markdown -f json
[ { "file": "sidecar.yaml", "present": false, "values": {} } ]

$ docmeta get title,type dashed.yaml --as markdown -f json
[ { "file": "dashed.yaml", "present": false, "values": {} } ]
```

The second file opens with a `---` line — a YAML document-start marker, which
looks like a front matter fence and is not one, because nothing closes it. Both
report `present: false`. Unlike Markdoc there is no flag that reaches this
content. Whether that matters is § *What is rejected, and why* below.

### 4. The rest

```console
$ docmeta validate page.mdoc sidecar.yaml notes.org
docmeta: Unsupported file type ".org" for "notes.org". […] Use --as to override.
# exit 2
```

One unsupported extension aborts the whole run before any supported sibling is
read. That is correct — a silently skipped input is 0014's failure — and it is
worth seeing, because it is what an incremental "we'll add formats later" policy
costs an operator today.

## Verdict after stress testing

| Format | Verdict | Reason |
|---|---|---|
| `.ipynb` | **Implement**, read then write | docmeta already publishes a schema for this content. Two real metadata channels; both readable; positions and write offsets measured available (§ stress test 1). |
| `.mdoc` | **Implement** | Reuses `extractFrontmatter`/`applyFrontmatter` unchanged. The only thing missing is a name and an extension. |
| `.json` / `.yaml` standalone | **Reject** | A file that *is* metadata has no extraction step, so docmeta's distinguishing layer does nothing and a generic JSON Schema validator does the job better. Reopening condition named below. |
| `.org` | **Defer** | A real, parseable header channel (`#+TITLE:`), structurally the same as the RST/AsciiDoc native fallbacks. No demand signal, and no MyST-style self-inflicted inconsistency to force it. |
| `.tex` | **Reject** | The value of `\title{}` is a macro expansion, not a string. A read that resolves it is a TeX interpreter; a read that does not is lossy in exactly the way `CONTRIBUTING.md` forbids. |
| `.typ` | **Reject** | Same argument — `#set document(title: …)` takes an arbitrary Typst expression — with none of LaTeX's installed base to weigh against it. |
| Confluence storage format | **Reject** | The metadata is not in the file. Labels and page properties live in Confluence's API, not the stored XHTML, so no extractor reading a file on disk can be correct. |
| `.txt` | **Reject** | No metadata channel exists to read. Registering it makes every `.txt` in a walk a document with `present: false`. |

## Proposal: `.mdoc`

A `markdoc` extractor delegating to the shared frontmatter reader and writer,
exactly as `mdx.ts` does today — a dozen lines, no new mechanism, `apply`
included so it is writable from the first commit.

Its own extractor rather than a third extension on `markdown` so that `--as
markdoc` exists, `docmeta schemas` names it, and a future Markdoc-specific read
(`{% partial %}` front matter, say) has a file to live in. That is the precedent
`mdx.ts` set and there is no reason to break it for the second case.

One limitation must be documented rather than discovered: **Markdoc's `---` fence
is format-agnostic and docmeta's fence *is* the format signal.** Markdoc's own
documentation says it has no opinion about what goes between the dashes — YAML,
TOML, JSON, GraphQL — because it hands the raw string to the application.
docmeta reads `---` as YAML, `+++` as TOML, `;;;` as JSON. A Markdoc file with
TOML between dashes therefore fails, loudly (§ stress test 7). Loud is the right
outcome and it still belongs on the formats page.

## Proposal: `.ipynb`

### Two channels, and neither of them wins

A notebook carries page metadata in two places, and both are documented by
mystmd:

- the notebook's **top-level `metadata` object** — where Jupyter's own property
  inspector writes, and where `kernelspec` and `language_info` always live;
- the **first cell, when it is a markdown cell holding only a `---` YAML block**
  — which is where MyST's page frontmatter goes for a notebook.

[0020](0020-element-metadata.md)'s second property settles what to do with that:
a document carrying the same fact in two channels yields two keys, both
validated, neither discarded. Any precedence rule silently drops one, and the
dropped one is the one nobody is checking.

So:

| Notebook location | Key |
|---|---|
| first-cell `---` block, `title:` | `title` |
| `metadata.title` | `metadata.title` |
| `metadata.kernelspec` | `metadata.kernelspec` |
| `metadata.language_info.version` | `metadata.language_info` (nested value; Ajv descends) |

The flat spelling for the first-cell block is what makes `myst:frontmatter:1.10`
start working on notebooks with **no schema change at all** — that block is MyST
page frontmatter and it has always been keyed flat.

The namespaced spelling for the notebook-native channel follows 0020's rule
verbatim (the containing thing is the namespace; the containing thing here is
`metadata`), and it carries a consequence worth stating plainly rather than
discovering: `myst:frontmatter:1.10`'s flat `kernelspec` does **not** reach
`metadata.kernelspec`. That is correct — the schema describes a Markdown page's
frontmatter — and it is the gap a `jupyter:nbformat:4.5` built-in over the
`metadata.*` keys would fill. That is Sara's work and a separate proposal; this
one only has to not make it impossible.

### Per-cell metadata is body, not document metadata

A code cell's `metadata.tags` (`hide-input`, `skip-execution`) is a rendering
directive for that cell. 0020 already drew this line for structured formats —
"the convention lifts values, not structure" is what keeps a document body out of
the key set — and cell metadata is body. It is also unnameable: positionally
(`cells.3.metadata.tags`) it moves when a cell is inserted, and collapsed
(`metadata.tags`) it collides with the document channel. Out of scope, with the
reason recorded so the next person does not re-derive it.

Not *impossible* — 0007's lesson is exactly about the difference. `elements:`
config is the existing escape hatch for reaching what a convention deliberately
misses, and it would need a JSON Pointer spelling to point into a notebook. If a
user ever needs cell tags validated, that is where it goes.

### Reading it: `JSON.parse` for the value, `yaml` for the positions

Measured before proposing, against the sandbox notebook:

```
metadata range: [ 278, 499, 499 ]
title key range: [ 282, 289, 289 ]  value range: [ 291, 308, 308 ]
slice at title value: "\"Fitting a curve\""
title value linePos: {"line":17,"col":12}
```

`yaml`'s `parseDocument` — already a direct dependency — parses `.ipynb` with
zero errors and reports byte-exact ranges for every node, and `LineCounter`
converts one to line/column. So `lineFor` and `colFor` are both available, which
makes notebooks the third format after `html` and `xml` to implement the optional
column half of `ExtractedMetadata`.

It must not be the *parser*, though. See stress test 1.

### Writing it: a splice, never a re-serialization

The same discipline 0007 established for HTML and 0018 carried to XML. Measured
on the same fixture, splicing a new title into `metadata.title`'s value range:

```
prefix identical: true
suffix identical: true
still valid JSON: true
nbformat preserved: 4 5
cells untouched: true
```

Outputs, execution counts, cell ids, the 1-space indent nbformat writes, and the
trailing newline all survive because nothing outside the value span is rewritten.
This matters more for notebooks than for any other format: a notebook diff that
touches every cell because a serializer normalized it is unreviewable, and
re-emitting outputs risks corrupting base64 image payloads.

The first-cell channel is the harder half, because the YAML block lives inside a
JSON string array (`"source": ["---\n", "title: x\n", "---\n"]`). The write is
two nested splices: join the array, run `applyFrontmatter` on the joined text —
the same comment-preserving, self-verifying writer every other format uses — then
re-serialize that one array and splice it at the array's own byte range. Inserting
a key changes the array's length, so this is the one place where formatting is
chosen rather than preserved, and it is where the byte-level assertion 0020's
stress test 3 insists on has to be aimed.

Recommended as **two landings, read first**, so the naming rule is fixed and
tested before a writer aims at it. Not as "read-only for now": there is no
objection here of the kind 0007 raised and 0018 answered, only sequencing.

## What is rejected, and why

### Standalone `.json` and `.yaml`

docmeta's pipeline is *load → extract → resolve → validate → report*, and its
distinguishing layer is extraction: pulling a metadata block out of a document
that is mostly not metadata. A standalone data file has no such block. The whole
file is the value, extraction is `JSON.parse`, and what is left is JSON Schema
validation of a JSON file — which `check-jsonschema` and `ajv-cli` already do,
with better error rendering for deep instance paths and no notion of a "document"
to get in the way. docmeta would be a worse one of those.

The discovery hazard makes it worse rather than being the whole objection.
Registering `.json`/`.yaml` on an extractor puts them in `supportedExtensions()`,
which drives every directory walk. In *this* repository:

```console
$ git ls-files "*.json" "*.yaml" "*.yml" | wc -l
124
$ git ls-files "docs/src/content/docs/*" | wc -l
47
```

124 tracked JSON/YAML files, none of them documents, against 47 published pages —
so docmeta's own corpus would become 72% CI workflows, issue templates, and
`docmeta.config.yaml` validating itself against the default document schema.

That hazard *is* avoidable: register the extractors with an empty `extensions`
array so they are reachable by `--as json` / `--as yaml` and never by a walk. The
registry already supports it — `byName` gets the entry, `byExtension` gets
nothing, `supportedExtensions()` flatMaps to nothing. It is a real design and it
is not the reason to say no; the reason to say no is the paragraph above it.

**What would reopen it**, in 0019's shape: not a request to validate a data file
— that has a better tool. A request to bring data files into `docmeta query`, so
a corpus check can join a page's `product` against a `products.yaml` the docs are
generated from. That is a cross-file rule and there is no other tool for it. It is
also squarely on the boundary [0021](0021-frontmatter-as-a-database.md) drew, so
it would be a query proposal, not a format one.

### LaTeX and Typst

`\title{\ProductName{} User Guide}` has no value until `\ProductName` is
expanded, and it may be defined in an included preamble, redefined mid-document,
or supplied by a document class. Typst is the same shape with better syntax:
`#set document(title: ...)` takes an arbitrary expression. A reader that returns
the raw source text reports `\ProductName{} User Guide` as the title, which is
wrong in a way that passes a `minLength` check and fails a human. `CONTRIBUTING.md`
already governs this: a format whose read is lossy should stay read-only rather
than guess — and here the read is lossy enough that read-only is still wrong.

Stated as a property of the format, not of anyone's effort, precisely because
0007 taught the difference. What would change it is a real TeX/Typst evaluator in
the toolchain, not more care.

### Confluence storage format

Assessed and rejected on a fact rather than a difficulty: Confluence page
metadata — labels, page properties, the content status — is held by Confluence,
not by the storage-format XHTML. A `page-properties` macro in the body is an HTML
table rendered into a report, not a metadata block. There is nothing in the file
for an extractor to be correct about. A Confluence integration would be an API
client, which is a different product.

### `.txt`

No metadata channel exists. Registering it adds every `.txt` in a walk as a
document with `present: false`, which under a permissive schema is a green row
that means nothing — the same false green § Problem 1 opens with, manufactured
deliberately.

### Org-mode: deferred, not rejected

`#+TITLE:`, `#+AUTHOR:`, `#+DATE:` are a genuine, unambiguous, line-oriented
header channel, structurally identical to the RST docinfo and AsciiDoc attribute
readers docmeta already ships, and writable by line splice. There is no technical
objection. There is also no demand: the repository has one open issue and it is
about SARIF severity, and unlike notebooks there is no built-in schema making a
promise docmeta cannot keep. Deferred on that basis alone, so that if an Org user
turns up the answer is "nobody asked yet", not "we decided against it".

## Stress test

### 1. The position parser would have accepted six notebooks Jupyter rejects

`yaml`'s `parseDocument` is the obvious reader for `.ipynb` — it gives the value
*and* the offsets in one pass. Measured what else it gives:

```
probe "{a: 1}"        yamlErrors=0  JSON.parse=false
probe "{\"a\": 1,}"   yamlErrors=0  JSON.parse=false
probe "{\"a\": 01}"   yamlErrors=0  JSON.parse=false
probe "{\"a\": .5}"   yamlErrors=0  JSON.parse=false
probe "{'a': 1}"      yamlErrors=0  JSON.parse=false
probe "# c\n{\"a\":1}" yamlErrors=0 JSON.parse=false
```

YAML 1.2 is a strict superset of JSON, so a notebook with a trailing comma, a
leading-zero integer or single-quoted keys parses clean and docmeta reports it
green — while Jupyter cannot open the file at all. A false green whose polarity
is the reverse of the one this proposal exists to fix, and worse, because it
would have been introduced by the fix.

**Changed as a result:** `JSON.parse` is the authoritative reader and the gate; a
failure there is a per-file parse error, the same as malformed YAML frontmatter.
`parseDocument` runs afterward for positions only, and its output is never the
source of a value. A single reader was the design until this was measured.

### 2. `fenced` is one boolean and a notebook has two channels

`ExtractedMetadata.fenced` is per-extraction, and `query.ts` uses it to decide
whether `DELETE FROM docs` may strip a block:

```ts
if (extracted.fenced !== true) {
  throw new DocmetaError(
    `"${file}": the ${name} format has no front matter block to strip.`,
  );
}
```

A notebook whose first cell holds a `---` block would answer `fenced: true` — and
deleting that cell would leave every `metadata.*` key standing. A DELETE that
silently leaves keys behind is worse than one that refuses.

**Changed as a result:** notebooks report `fenced: false` unconditionally, so
DELETE refuses, and the refusal message is already correct. This is the one place
where `ExtractedMetadata` genuinely strains: a two-channel format can only answer
a single-channel question conservatively. It is a strain, not a break —
element-backed XML already leaves `fenced` unset for the same reason — and
widening it to a per-channel answer would change an exported interface for a
capability nothing has asked for.

### 3. Flattening `metadata` would have discarded a title silently

The first design lifted notebook `metadata` to top-level keys, so
`myst:frontmatter:1.10` would type `kernelspec` and `authors` directly. A
notebook with page frontmatter in cell 0 *and* a `title` in `metadata` then has
two `title`s and one key. Whichever the merge favours, the other is discarded —
and it is the discarded one that nobody is checking. 0020 rejected exactly this
for DITA's `<audience>` against `<othermeta name="audience">`.

**Changed as a result:** the namespaced `metadata.*` spelling above, and the
honest consequence recorded with it — the shipped MyST schema reaches the
first-cell channel and not the native one.

### 4. Per-cell metadata has no name that survives an edit

`cells.3.metadata.tags` is positional, so inserting a cell renames every key
below it and a baseline fingerprint or a `--check` rule breaks on an edit that
changed nothing. Collapsing to `metadata.tags` collides with the document
channel. There is no third option that is both stable and unambiguous.

**Changed as a result:** cell metadata is out of scope, on the principle that it
is body rather than document metadata — which is the reason that survives, where
"we couldn't name it" would just be an invitation to try harder.

### 5. Registering `.json`/`.yaml` would have swallowed the repository

Measured above: 124 tracked JSON/YAML files against 47 documents, including
`docmeta.config.yaml`, which a walk would hand to the validator to check against
the default document schema.

**Changed as a result:** the design moved from "register the extensions" to
"register the extractors with an empty `extensions` array, reachable by `--as`
only" — and then the format was rejected outright for the stronger reason in
§ *What is rejected*. Worth recording because the mitigation is sound and will be
the right shape if the query-side reopening condition is ever met.

The mitigation also surfaced a display defect that would ship with it:
`listFormats()` feeds `docmeta schemas`, which joins `extensions` with `", "`, so
an extension-less format prints as `json ()`. Whatever lands with an empty
extension list has to give that column a word.

### 6. The `--ext`/`--as` workaround does not survive a mixed corpus

`--ext .mdoc --as markdown` reads Markdoc correctly, which nearly made `.mdoc` a
documentation fix rather than a code change. Then:

```console
$ docmeta query "SELECT * FROM docs" . --ext .mdoc,.html --as markdown
legacy.html  markdown  0  {}
page.mdoc    markdown  1  {"title":"Payments quickstart", …}
```

`--as` is per-run, not per-file, so making Markdoc readable makes every other
format unreadable in the same run. A real Markdoc docset with a single legacy
`.html` page has no working invocation.

**Changed as a result:** nothing in the design — but this is the evidence that
moved `.mdoc` from "already possible, skip it" to "implement", and without it the
recommendation would have been wrong.

### 7. Markdoc's fence carries no flavor, and docmeta's fence is the flavor

Markdoc permits TOML or JSON between `---` markers. docmeta reads `---` as YAML.
Tested with a TOML body between dashes:

```console
$ docmeta validate toml-in-dashes.md
✗ toml-in-dashes.md
    (root)  Invalid YAML frontmatter: root must be an object  [(parse)]

1 file checked, 0 passed, 1 failed, 1 error
# exit 1
```

Loud, per-file, attributed to `(parse)`, run continues. That is the right
behaviour and it needs no change — only a line on the formats page.

**Found in passing, and out of scope:** the same file through `get` aborts the
whole run as an operational error.

```console
$ docmeta get title toml-in-dashes.md -f json
docmeta: Unexpected error: Invalid YAML frontmatter: root must be an object
# exit 2
```

Reproduced with ordinary malformed YAML too, so it is not Markdoc-specific: `get`
promotes a per-file parse failure to exit 2 with an "Unexpected error" prefix,
where `validate` reports it per file and carries on. That is a `CLAUDE.md §
Commands must have parallel behaviors` violation that predates this proposal.
Recorded here so the Markdoc landing is not read as having introduced it, and so
it is fixed as its own `fix(get):` change.

### 8. `.ipynb` is a container, and its formatting varies

nbformat writes 1-space indent; `nbstripout` and CI tools emit minified
notebooks; `git config core.autocrlf` gives Windows checkouts CRLF. Any of those
shifts every offset. Measured all three against the splice:

```
crlf parse errors: 0 []
crlf title slice: "\"Fitting a curve\""
minified title slice: "\"Fitting a curve\""
```

Ranges are byte offsets into the original string in every case, so no indent or
newline assumption is needed — the same reason 0018's XML splice survives CRLF,
reached the same way. A BOM still needs a test: `src/core/json-text.ts § stripBom`
exists because Windows editors write one and `JSON.parse` rejects it, and
stripping it before measuring offsets would shift every one of them by one. The
strip must happen at parse and never upstream of the offsets.

The related non-problem: Jupytext's `md:myst` notebooks are `.md` files with
ordinary front matter and are already covered. Only the JSON container is missing.

### 9. Confluence was assessed before it was rejected

The temptation is to treat storage format as "XHTML, so the HTML extractor nearly
works". It parses, and it yields nothing, because Confluence keeps labels and
page properties outside the stored body. Checked rather than assumed, on 0020's
instruction not to guess a content model — and the answer moved the verdict from
"defer, needs an XHTML dialect" to "reject, the data is not in the file".

## Implementation order

Impact-last on purpose: the cheapest change proves the registration path before
the expensive one needs it.

1. **`markdoc`** — `src/extractors/markdoc.ts` in `mdx.ts`'s shape, registered in
   `index.ts`. Red test first: `.mdoc` is rejected today, and a mixed
   `.mdoc`/`.html` walk gets both rows right afterwards. Fixture
   `test/fixtures/page.mdoc` with a `{% %}` tag in the body, so the test proves
   the tag survives a write rather than only that the fence parses.
   `reference/formats.mdx` gains the row and the flavor-agnostic-fence caveat.
2. **`notebook` read** — `JSON.parse` gate, `parseDocument` positions,
   `LineCounter` for `lineFor`/`colFor`, both channels keyed, `fenced: false`.
   Fixtures: a notebook with only `metadata`, one with only a first-cell block,
   one with both and a disagreeing `title` (the key test — two keys, two values,
   neither dropped), one CRLF, one BOM'd, one minified, and one that is valid
   YAML but invalid JSON, asserting the parse error.
3. **`notebook` write** — `metadata.*` splice first, first-cell splice second.
   Assert bytes, not "it did not throw": 0020's stress test 3 is the entry that
   earned that instruction and this is the same shape of edit. `test/fill.test.ts`
   loses its notebook refusal fixture and `docmeta schemas` flips notebook to
   `writable`.
4. **Docs** — `reference/formats.mdx` for both formats,
   `reference/platform-schemas.mdx` to say which MyST channel the schema reaches
   in a notebook and which it does not, `CONTRIBUTING.md § Write support is
   optional` for the notebook nested-splice case.

Steps 1 and 2 are `feat(extractors):` and therefore each ship a demo video per
`CLAUDE.md § Every new feature ships with a short demo video` — one is enough if
they land together, and the notebook one is the demo: a Jupyter Book directory
that validates as empty, then doesn't.

## Not breaking

No key moves, no existing document changes meaning, no schema changes verdict.
Two extensions that were errors become documents, and a directory walk that
skipped them stops skipping them — which can turn a passing run into a failing
one for a repo that had unreadable notebooks in scope. That is the same class as
0020's `additionalProperties: false` case: the run was passing because docmeta
could not see the files, and fixing under-reporting is not a contract break.
`feat:`, not `feat!:`.

## Consequences

- `validate` reads eight formats; `fill` and `query` write eight.
- `myst:frontmatter:1.10` reaches the corpus it was written for, without being
  edited.
- The `metadata.*` half of a notebook has no built-in schema. That is a named,
  scoped follow-on (`jupyter:nbformat:4.5`, Sara · S1), not a defect of this one.
- Four formats carry a written rejection, so the next sweep re-derives none of
  them; one carries a deferral with the reason stated as absence of demand rather
  than presence of an objection.
- The `get`-versus-`validate` parse-error asymmetry in stress test 7 is filed as
  its own fix and is not this proposal's to make.
