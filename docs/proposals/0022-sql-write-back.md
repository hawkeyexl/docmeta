# 0022 — write-back: an UPDATE against the corpus edits the files

- **Status:** Implemented (#122)
- **Serves:** Maya · M2, M4 · Devin · D3
- **Depends on:** [0021](0021-frontmatter-as-a-database.md), the `docs` table
  this writes through. Stacked on #120.
- **Relates to:** [0017](0017-fill-egress-and-bounds.md) (`fill` is the other writer, and the polarity argument below is against its shape), [0020](0020-element-metadata.md) (whose write boundary this inherits), [0016](0016-flag-ownership.md)
- **Touches (planned):** `src/commands/query.ts`, `src/reporters/query.ts`, `src/cli.ts`, `reference/cli.mdx`, `test/{query.test.ts,cli.integration.test.ts}`

## Problem

Bulk metadata edits are predicate-shaped. Think "stamp `last_reviewed` where it
is stale", "default `draft` where it is missing", or "rename this tag
everywhere". But every tool for them is imperative. There is the hand-rolled
loop over files ([file-batcher](https://github.com/hilja/file-batcher),
[EditFrontMatter](https://karlredman.github.io/EditFrontMatter/), and the
[recurring](https://johnwargo.com/posts/2023/batching-yaml-front-matter-updates/)
[forum-script](https://discourse.gohugo.io/t/how-to-edit-the-yaml-front-matter-of-multiple-markdown-files/40070)
genre). Or there is `yq` and `sed` across a glob, which is format-blind and eats
comments. None of them can say *which* files, except by writing the filter
yourself.

docmeta already owns both halves of the missing tool. 0021 gave it the predicate
half, which is SQL over every top-level key across six formats. `fill` has long
owned the write half, in every extractor's `apply(content, patch)`. That splices
only between the fences. It preserves YAML comments, key order and scalar
quoting by mutating existing nodes in place. It refuses TOML re-emission
precisely because it would rewrite untouched values. And it **re-parses and
verifies every merge before returning it**, so a serializer bug becomes a
refusal rather than a damaged document (`src/extractors/frontmatter-write.ts`).

What is missing is the pipe between them. That pipe is one statement:

```sh
docmeta query "UPDATE docs SET last_reviewed = date('now')
               WHERE date(last_reviewed) < date('now', '-90 days')" docs/
```

## The shape, which previews by default and applies with `--write`

> Superseded on this one point by [0025](0025-query-dry-run-polarity.md). The
> polarity flipped to apply-by-default with `--dry-run`, for parity with
> `fill`. The argument below stands as written. It is the record of why the
> other polarity looked right, and 0025 records what outweighed it.

Today that command exits 2: 0021 runs user SQL under `PRAGMA query_only`, so
an UPDATE is refused. This proposal makes it mean something instead:

- **Without `--write`**, the statement runs against the in-memory projection.
  The report is the per-file, per-key diff it *would* make, such as `docs/a.md:
  last_reviewed: 2026-03-01 -> 2026-08-26`, plus a closing `dry run; pass
  --write to apply`. No file is touched. Exit 0.
- **With `--write`**, the same diff is applied in two phases. Every file's new
  content is computed and verified in memory first, then flushed with
  `writeFileAtomic`. The writer's own re-parse verification stands between the
  patch and the disk. In `--format json`, a preview or an applied edit is the
  bare array of change objects, as
  `{ file, key, from?, to | deleted, written }`, mirroring a SELECT's bare row
  array. `from` is omitted for a key the file never had, which keeps "absent"
  distinguishable from an explicit null.
- **`--check` composes.** In preview, any pending change is a finding, at exit
  1. That turns a normalization statement into a drift gate. CI fails while any
     file does not match the rule, and `--write` is the remedy the failure
     message names.

This is the opposite polarity from `fill`, which writes by default and offers
`--dry-run`. The difference is argued, not accidental. Every `fill` write has
passed a per-value confidence gate and a schema check before it lands, so the
machine has grounds to proceed. An UPDATE has no gate a machine can apply. The
human reading the preview **is** the gate, so applying must be the explicit act.
(Option A below records the rejected alternative.)

## Mechanics, gating at the diff rather than the parser

The projection is disposable, which makes enforcement almost free. Write mode
lifts `query_only` for the user's single statement. It lets SQLite do whatever
the statement says *to the in-memory table*, then diffs the table against the
pre-statement snapshot, keyed by `_path`:

- **The row set changed**, meaning an INSERT or DELETE happened. The whole run
  is refused. Creating and deleting *files* is not a metadata edit, and since
  only the projection changed, refusing costs nothing.
- **A system column changed**, one of `_path`, `_format`, `_present` or `_data`.
  Refused the same way. Renaming files via SQL is not on offer.
- **Data columns changed on existing rows.** Each changed cell becomes an entry
  in that file's `MetadataPatch`.

There is no SQL parsing, and no authorizer, which `node:sqlite` does not expose
anyway. Effects are judged, not syntax. A CTE-wrapped UPDATE, an UPSERT that
only updates, and `UPDATE ... FROM` are all fine, or refused, by what they
*did*. That is the only thing that matters.

## The type round-trip

The projection is lossy by design, because SQLite stores booleans as `1` or `0`,
and arrays and objects as JSON text. So writing a cell back must restore the
type the file had, or `draft: true` corrupts into `draft: 1`. The inverse map
runs per file and key, with a stated precedence:

1. **The file's own original type** for that key. The run still holds every
   file's extracted data, since it built the table from it. So if `draft` was a
   boolean *in this file*, `1` writes back as `true`. If `tags` was an array,
   the new JSON text is parsed and written as an array.
2. **The column's dominant type across the corpus**, when the file had no value
   for the key. That is the `SET draft = 0 WHERE draft IS NULL` case. If `draft`
   is boolean in the files that have it, the new value is written as a boolean.
   Dominant is mechanical, being the strict plurality by count of files carrying
   the key. A tie yields *no* dominant type, and precedence falls through to
   storage, so a heterogeneous column never guesses.
3. **The SQL storage type as-is**, when neither exists.

Failures refuse rather than guess, naming the file and key. That covers new JSON
text that does not parse, or parses to a different shape than the key had (array
→ scalar). It also covers a value outside the restored type's domain, as in `SET
draft = 2` where `draft` is boolean everywhere.

`SET x = NULL` writes an explicit `x: null`. It cannot *delete* the key.
`MetadataPatch` ignores `undefined` by contract, per `src/types.ts`, so deletion
is not expressible through today's writer. It is deferred, and the cost of
lifting it is named. That cost is a deletion channel on `apply()`, which is a
contract change for every extractor, not a query-side hack.

## Worked examples

```sh
# Stamp stale pages — preview shows the diff, --check makes it a drift gate
docmeta query --check "UPDATE docs SET last_reviewed = date('now')
  WHERE date(last_reviewed) < date('now', '-90 days')" docs/

# Default a missing flag, typed by the column's dominant type (boolean)
docmeta query --write "UPDATE docs SET draft = false WHERE draft IS NULL" docs/

# Rename a tag inside array values, edited as JSON, restored as YAML arrays
docmeta query --write "UPDATE docs SET tags = (
    SELECT json_group_array(CASE t.value WHEN 'guides' THEN 'guide' ELSE t.value END)
    FROM json_each(docs.tags) t)
  WHERE EXISTS (SELECT 1 FROM json_each(docs.tags) t WHERE t.value = 'guides')" docs/
```

## What write mode refuses, by name

INSERTed or DELETEd rows. Any system-column change. A type that cannot be
restored under the precedence above. JSON that does not parse back to the key's
shape. Any merge the writer's own re-parse verification rejects. A write that
would touch `<stdin>`, since there is no file behind it. That last refusal
deliberately aborts the **whole run**, path-backed rows included. Stdin in a
write's input set means the corpus is mixed with something unwritable. Silently
skipping it would be a scope reduction nobody asked for. The preview shows the
stdin row, so the refusal is predictable. Finally, inheriting 0020's boundary,
element-backed keys whose write support is read-only in that format. Each
refusal names the file and key. A refusal anywhere aborts the run before any
file is written, because a bulk edit that half-applied is worse than one that
declined.

There is one honest boundary on "all-or-nothing". It is a property of the
*refusal and verification* path, made real by the two-phase apply. Every file's
new content exists in memory before the first byte lands. What remains is the
flush loop itself. `writeFileAtomic` is atomic per file, not across files, so an
OS-level kill mid-flush can leave a partial corpus. The remedy is convergence,
not a rollback machine. Re-running the same statement in preview shows exactly
the remainder.

## The `fill` boundary

`fill` infers values nothing in the repo knows, such as a description or an
audience. It works per field, gated by confidence, and priced in tokens.
Write-back computes values the repo already implies, such as dates, defaults and
renames, in bulk, deterministically and offline. They are complementary lanes
into the same writer, and the difference is why their polarities differ, per the
argument above.

## Options

**A. Write by default, with `--dry-run` to preview, for `fill` parity.**
Rejected on blast radius. One statement can rewrite every file in the corpus,
and unlike `fill` there is no per-value gate between the statement and the disk.
Parity of flags matters, per 0005. Parity of *danger* matters more.

**B. Preview by default, `--write` to apply.** Recommended, above.

**C. A separate `docmeta update` subcommand.** Rejected. It would duplicate
`query`'s entire input surface, which 0005 makes expensive by design. It would
split one mental model across two commands, and still need every mechanism
above. The statement kind already says what the user means.

**D. Enforce scope by parsing the SQL.** Rejected. A parser strong enough to
judge arbitrary SQLite is a dependency and a maintenance surface. Judging
effects on a disposable projection is exact, free, and cannot be fooled by a
statement shape nobody anticipated.

## Stress test

**1. `MetadataPatch` cannot express deletion, found by reading the contract
rather than assuming it.** `undefined` values are documented as *ignored* in
`src/types.ts`. So `SET x = NULL` must mean "explicit null". Key removal is a
deferral with its real cost named, which is an `apply()` contract change across
all six extractors, rather than a TODO.

**2. The writer already refuses corruption, so write-back inherits its floor.**
Every merge is re-parsed and compared before it is returned. TOML is spliced per
key precisely because re-emission rewrites untouched values, and YAML edits
mutate existing nodes to keep comments and quoting. The failure mode of a
write-back bug is a refusal naming the file. That is the same property 0020 §
"What checks the written output" relies on.

**3. The residual type ambiguity is real and recorded.** `SET draft = 1` on a
corpus where *no* file has ever had `draft` gives the inverse map nothing to
consult. Precedence bottoms out at storage type, and writes the number `1`.
SQLite stores the literal `true` as `1`, so the statement cannot even spell the
intent. No clean mitigation exists inside SQL's type system. The rule is
documented, deterministic, and fixable by the user in one preview read.

**4. A file can change between load and write.** The table was built from
content read at load time, and the corpus can move underneath a long-running
preview-then-apply session. Before splicing, the file is re-read, and the
touched keys' current values are compared against the load-time snapshot. A
mismatch refuses that file by name, as "the corpus moved", rather than applying
a patch computed against stale data.

**5. Element-backed keys make write-back reach XML and DITA, under 0020's
rules.** `SET "prolog.author" = 'Ada'` routes through the element writers.
Updating an existing element is a span replacement, and safe anywhere.
*Creating* one needs a content model, and exists only for DITA. The refusal list
above is where that boundary surfaces, per file, rather than being re-litigated
here.

**6. `--check` in write mode needed a meaning, and drift-gate fell out.** In
preview, pending changes are findings at exit 1. That makes `query --check
"UPDATE …"` a normalization ratchet CI can hold, on the same 0/1/2 contract as
everything else, with no new flag. With `--write`, `--check` is redundant and
accepted, because the applied changes were the findings and success exits 0.
That matches `--allow-empty`'s tolerance for combinations that are harmless
rather than wrong.

**7. Why refusal aborts the whole run instead of skipping the bad file.** A
half-applied bulk edit leaves the corpus in a state no statement describes. That
is the exact condition the preview existed to prevent. All-or-nothing is the
only result a user can reason about, and the diff already told them what "all"
is. (`fill` skips per field instead, because its writes are independent
proposals rather than one statement's coherent effect. The difference is the
statement.)

**8. Effect-gating has a blind spot the implementation had to close, which is
SQL that writes *other* files.** `ATTACH DATABASE 'x.db'` creates `x.db` on
disk, and `VACUUM INTO` writes wherever it is pointed. Neither touches the
`docs` table the gate watches. They are the two statements refused by *name*,
before preparation, and the one place syntax is consulted. Everything else stays
effect-judged. Found while implementing rather than while designing, which is
what this section is for.

**9. A `_path` rewrite disguises itself as an add-and-remove.** The effect diff
keys rows by `_path`. So `UPDATE docs SET _path = 'renamed.md'` shows up as one
path missing and one appearing. That is the row-*set* refusal, with a message
about creating and deleting files that never mentions the column actually
touched. It was caught by the system-column test expecting its own message.
Equal row counts with a missing key now report the `_path` change by name. (A
pathological DELETE-plus-INSERT pair cannot exist, since there is one statement,
so the disambiguation is sound.)

## The deferrals, and what reversing them found

Two limits this proposal set were reversed on request before it merged. They are
recorded here rather than rewritten above, on 0020's precedent.

**Corpus-new keys.** The design implied Create came free, and it did not. A
`SET` target must be a column, and columns are the union of keys files *already
have*. The fix is a tolerant scan of the statement's SET targets that pre-widens
the table with empty columns. It is safe by construction. Anything the scan
misses fails exactly as before, with `no such column`, and a false positive is
an all-NULL column no diff ever sees.

**Deletion.** The cost named above was a removal channel through `apply()`, and
it was paid. `ApplyOptions.deletions` is advisory by contract. A writer that
cannot remove a key ignores it, and the caller re-extracts and refuses on a
survivor. One writer covers four formats, because AsciiDoc and RST route their
writes through the same fenced-front-matter path as markdown and MDX. YAML
deletes through the Document API, TOML as the degenerate case of its line
splice, and JSON by omission. Each is still re-parse-verified. Element-backed
keys in HTML and XML refuse, caught by the read-back rather than a format list.
The SQL spelling is `drop_key()`, a per-run random sentinel no content can
collide with and nobody can type. That keeps deletion conditional, through
`WHERE` and `CASE`. `ALTER TABLE docs DROP COLUMN` falls out of the effect gate
as corpus-wide removal for free, since a vanished column reads as every file
losing the key. `SET key = NULL` still writes an explicit null, so the two
spellings now mean the two different things. *(Revised once more by
[0024](0024-standard-sql-vocabulary.md) before release. The NULL assignment
became the removal spelling, `explicit_null()` took the literal, and
`drop_key()` was removed. The standard-vocabulary push moved the decision. The
reasoning above stays as written.)*

## Not breaking

`UPDATE` without `--write` changes from exit 2, with `SQL error: attempt to
write a readonly database`, to a dry-run report with exit 0. That is an error
becoming a useful answer, which is the 0020 "fixing under-reporting" shape
rather than a contract break. Every SELECT behaves exactly as 0021 shipped it.
Ships as `feat(query):` with the house demo video.
