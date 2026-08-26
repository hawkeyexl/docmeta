# 0022 — write-back: an UPDATE against the corpus edits the files

- **Status:** Implemented (#122)
- **Serves:** Maya · M2, M4 · Devin · D3
- **Depends on:** [0021](0021-frontmatter-as-a-database.md) — the `docs` table this writes through. Stacked on #120.
- **Relates to:** [0017](0017-fill-egress-and-bounds.md) (`fill` is the other writer, and the polarity argument below is against its shape), [0020](0020-element-metadata.md) (whose write boundary this inherits), [0016](0016-flag-ownership.md)
- **Touches (planned):** `src/commands/query.ts`, `src/reporters/query.ts`, `src/cli.ts`, `reference/cli.mdx`, `test/{query.test.ts,cli.integration.test.ts}`

## Problem

Bulk metadata edits are predicate-shaped — "stamp `last_reviewed` where it is
stale", "default `draft` where it is missing", "rename this tag everywhere" —
but every tool for them is imperative: a hand-rolled loop over files
([file-batcher](https://github.com/hilja/file-batcher),
[EditFrontMatter](https://karlredman.github.io/EditFrontMatter/), the
[recurring](https://johnwargo.com/posts/2023/batching-yaml-front-matter-updates/)
[forum-script](https://discourse.gohugo.io/t/how-to-edit-the-yaml-front-matter-of-multiple-markdown-files/40070)
genre), or `yq`/`sed` across a glob, which is format-blind and eats comments.
None of them can say *which* files, except by writing the filter yourself.

docmeta already owns both halves of the missing tool. 0021 gave it the
predicate half: SQL over every top-level key across six formats. And `fill`
has long owned the write half: every extractor's `apply(content, patch)`,
which splices only between the fences, preserves YAML comments, key order and
scalar quoting by mutating existing nodes in place, refuses TOML re-emission
precisely because it would rewrite untouched values, and **re-parses and
verifies every merge before returning it** — a serializer bug becomes a
refusal, not a damaged document (`src/extractors/frontmatter-write.ts`).

What is missing is the pipe between them. That pipe is one statement:

```sh
docmeta query "UPDATE docs SET last_reviewed = date('now')
               WHERE date(last_reviewed) < date('now', '-90 days')" docs/
```

## The shape: preview by default, `--write` to apply

Today that command exits 2: 0021 runs user SQL under `PRAGMA query_only`, so
an UPDATE is refused. This proposal makes it mean something instead:

- **Without `--write`**: the statement runs against the in-memory projection,
  and the report is the per-file, per-key diff it *would* make —
  `docs/a.md: last_reviewed: 2026-03-01 -> 2026-08-26` — plus a closing
  `dry run; pass --write to apply`. No file is touched. Exit 0.
- **With `--write`**: the same diff, applied in two phases — every file's new
  content is computed and verified in memory first, then flushed with
  `writeFileAtomic` — with the writer's own re-parse verification standing
  between the patch and the disk. In `--format json`, a preview or an applied
  edit is the bare array of change objects
  (`{ file, key, from?, to | deleted, written }`), mirroring a SELECT's bare
  row array; `from` is omitted for a key the file never had, which keeps
  "absent" distinguishable from an explicit null.
- **`--check` composes**: in preview, any pending change is a finding —
  exit 1. That turns a normalization statement into a drift gate: CI fails
  while any file does not match the rule, and `--write` is the remedy the
  failure message names.

This is the opposite polarity from `fill`, which writes by default and offers
`--dry-run`. The difference is argued, not accidental: every `fill` write has
passed a per-value confidence gate and a schema check before it lands, so the
machine has grounds to proceed. An UPDATE has no gate a machine can apply —
the human reading the preview **is** the gate, so applying must be the
explicit act. (Option A below records the rejected alternative.)

## Mechanics: gate at the diff, not the parser

The projection is disposable, which makes enforcement almost free. Write mode
lifts `query_only` for the user's (still single) statement, lets SQLite do
whatever the statement says *to the in-memory table*, and then diffs the
table against the pre-statement snapshot, keyed by `_path`:

- **The row set changed** — an INSERT or DELETE happened — the whole run is
  refused. Creating and deleting *files* is not a metadata edit, and since
  only the projection changed, refusing costs nothing.
- **A system column changed** (`_path`, `_format`, `_present`, `_data`) —
  refused the same way. Renaming files via SQL is not on offer.
- **Data columns changed on existing rows** — each changed cell becomes an
  entry in that file's `MetadataPatch`.

No SQL parsing, no authorizer (which `node:sqlite` does not expose anyway):
effects are judged, not syntax. A CTE-wrapped UPDATE, an UPSERT that only
updates, `UPDATE ... FROM` — all are fine or refused by what they *did*,
which is the only thing that matters.

## The type round-trip

The projection is lossy by design — SQLite stores booleans as `1`/`0` and
arrays/objects as JSON text — so writing a cell back must restore the type
the file had, or `draft: true` corrupts into `draft: 1`. The inverse map runs
per file and key, with a stated precedence:

1. **The file's own original type** for that key. The run still holds every
   file's extracted data (it built the table from it), so `draft` was a
   boolean *in this file* → `1` writes back as `true`; `tags` was an array →
   the new JSON text is parsed and written as an array.
2. **The column's dominant type across the corpus**, when the file had no
   value for the key (the `SET draft = 0 WHERE draft IS NULL` case): if
   `draft` is boolean in the files that have it, the new value is written as
   a boolean. Dominant is mechanical: the strict plurality by count of files
   carrying the key; a tie yields *no* dominant type, and precedence falls
   through to storage — a heterogeneous column never guesses.
3. **The SQL storage type as-is**, when neither exists.

Failures refuse rather than guess, naming the file and key: new JSON text
that does not parse, or parses to a different shape than the key had
(array → scalar), or a value outside the restored type's domain
(`SET draft = 2` where `draft` is boolean everywhere).

`SET x = NULL` writes an explicit `x: null`. It cannot *delete* the key:
`MetadataPatch` ignores `undefined` by contract (`src/types.ts`), so deletion
is not expressible through today's writer. Deferred, and the cost of lifting
it is named: a deletion channel on `apply()` — a contract change for every
extractor — not a query-side hack.

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

INSERTed or DELETEd rows; any system-column change; a type that cannot be
restored under the precedence above; JSON that does not parse back to the
key's shape; any merge the writer's own re-parse verification rejects; a
write that would touch `<stdin>` (there is no file behind it — and this
refusal deliberately aborts the **whole run**, path-backed rows included:
stdin in a write's input set means the corpus is mixed with something
unwritable, and silently skipping it would be a scope reduction nobody asked
for; the preview shows the stdin row, so the refusal is predictable); and —
0020's boundary, inherited — element-backed keys whose write support is
read-only in that format. Each refusal names the file and key, and a refusal
anywhere aborts the run before any file is written: a bulk edit that
half-applied is worse than one that declined.

One honest boundary on "all-or-nothing": it is a property of the *refusal
and verification* path, made real by the two-phase apply — every file's new
content exists in memory before the first byte lands. What remains is the
flush loop itself: `writeFileAtomic` is atomic per file, not across files,
so an OS-level kill mid-flush can leave a partial corpus. The remedy is
convergence, not a rollback machine: re-running the same statement in
preview shows exactly the remainder.

## The `fill` boundary

`fill` infers values nothing in the repo knows (a description, an audience),
per field, gated by confidence, priced in tokens. Write-back computes values
the repo already implies (dates, defaults, renames), in bulk, deterministically,
offline. They are complementary lanes into the same writer — and the difference is why
their polarities differ, per the argument above.

## Options

**A. Write by default, `--dry-run` to preview (`fill` parity).** Rejected on
blast radius: one statement can rewrite every file in the corpus, and unlike
`fill` there is no per-value gate between the statement and the disk. Parity
of flags matters (0005); parity of *danger* matters more.

**B. Preview by default, `--write` to apply.** Recommended, above.

**C. A separate `docmeta update` subcommand.** Rejected: it would duplicate
`query`'s entire input surface (0005 makes that expensive by design), split
one mental model across two commands, and still need every mechanism above.
The statement kind already says what the user means.

**D. Enforce scope by parsing the SQL.** Rejected: a parser strong enough to
judge arbitrary SQLite is a dependency and a maintenance surface; judging
effects on a disposable projection is exact, free, and cannot be fooled by a
statement shape nobody anticipated.

## Stress test

**1. `MetadataPatch` cannot express deletion — found by reading the contract,
not by assuming it.** `undefined` values are documented as *ignored*
(`src/types.ts`), so `SET x = NULL` must mean "explicit null", and key
removal is a deferral with its real cost named (an `apply()` contract change
across all six extractors), not a TODO.

**2. The writer already refuses corruption, so write-back inherits its floor.**
Every merge is re-parsed and compared before it is returned, TOML is spliced
per key precisely because re-emission rewrites untouched values, and YAML
edits mutate existing nodes to keep comments and quoting. The failure mode of
a write-back bug is a refusal naming the file — the same property 0020 §
"What checks the written output" relies on.

**3. The residual type ambiguity is real and recorded.** `SET draft = 1` on a
corpus where *no* file has ever had `draft` gives the inverse map nothing to
consult — precedence bottoms out at storage type and writes the number `1`.
SQLite stores the literal `true` as `1`, so the statement cannot even spell
the intent. No clean mitigation exists inside SQL's type system; the rule is
documented, deterministic, and fixable by the user in one preview read.

**4. A file can change between load and write.** The table was built from
content read at load time; the corpus can move underneath a long-running
preview-then-apply session. Before splicing, the file is re-read and the
touched keys' current values compared against the load-time snapshot — a
mismatch refuses that file by name ("the corpus moved") rather than applying
a patch computed against stale data.

**5. Element-backed keys make write-back reach XML and DITA — under 0020's
rules.** `SET "prolog.author" = 'Ada'` routes through the element writers:
updating an existing element is a span replacement and safe anywhere;
*creating* one needs a content model and exists only for DITA. The refusal
list above is where that boundary surfaces, per file, rather than being
re-litigated here.

**6. `--check` in write mode needed a meaning, and drift-gate fell out.** In
preview, pending changes are findings (exit 1), which makes
`query --check "UPDATE …"` a normalization ratchet CI can hold — the same
0/1/2 contract as everything else, no new flag. With `--write`, `--check`
is redundant and accepted (the applied changes were the findings; exit 0 on
success), matching `--allow-empty`'s tolerance for combinations that are
harmless rather than wrong.

**7. Why refusal aborts the whole run instead of skipping the bad file.** A
half-applied bulk edit leaves the corpus in a state no statement describes —
the exact condition the preview existed to prevent. All-or-nothing is the
only result a user can reason about, and the diff already told them what
"all" is. (`fill` skips per field instead — its writes are independent
proposals, not one statement's coherent effect. The difference is the
statement.)

**8. Effect-gating has a blind spot the implementation had to close: SQL that
writes *other* files.** `ATTACH DATABASE 'x.db'` creates `x.db` on disk, and
`VACUUM INTO` writes wherever it is pointed — neither touches the `docs` table
the gate watches. They are the two statements refused by *name* (before
preparation), the one place syntax is consulted; everything else stays
effect-judged. Found while implementing, not while designing — which is what
this section is for.

**9. A `_path` rewrite disguises itself as an add-and-remove.** The effect
diff keys rows by `_path`, so `UPDATE docs SET _path = 'renamed.md'` shows up
as one path missing and one appearing — the row-*set* refusal, with a message
about creating and deleting files that never mentions the column actually
touched. Caught by the system-column test expecting its own message: equal
row counts with a missing key now report the `_path` change by name. (A
pathological DELETE-plus-INSERT pair cannot exist — one statement — so the
disambiguation is sound.)

## The deferrals, and what reversing them found

Two limits this proposal set were reversed on request before it merged —
recorded here rather than rewritten above, on 0020's precedent.

**Corpus-new keys.** The design implied Create came free, and it did not: a
`SET` target must be a column, and columns are the union of keys files
*already have*. The fix is a tolerant scan of the statement's SET targets
that pre-widens the table with empty columns. It is safe by construction —
anything the scan misses fails exactly as before (`no such column`), and a
false positive is an all-NULL column no diff ever sees.

**Deletion.** The cost named above — a removal channel through `apply()` —
was paid: `ApplyOptions.deletions`, advisory by contract (a writer that
cannot remove a key ignores it; the caller re-extracts and refuses on a
survivor). One writer covers four formats, because AsciiDoc and RST route
their writes through the same fenced-front-matter path as markdown and MDX;
YAML deletes through the Document API, TOML as the degenerate case of its
line splice, JSON by omission — each still re-parse-verified. Element-backed
keys in HTML/XML refuse, caught by the read-back rather than a format list.
The SQL spelling is `drop_key()`, a per-run random sentinel no content can
collide with and nobody can type, which keeps deletion conditional
(`WHERE`, `CASE`) — and `ALTER TABLE docs DROP COLUMN` falls out of the
effect gate as corpus-wide removal for free, since a vanished column reads
as every file losing the key. `SET key = NULL` still writes an explicit
null; the two spellings now mean the two different things.

## Not breaking

`UPDATE` without `--write` changes from exit 2 (`SQL error: attempt to write
a readonly database`) to a dry-run report with exit 0 — an error becoming a
useful answer, which is the 0020 "fixing under-reporting" shape rather than a
contract break. Every SELECT behaves exactly as 0021 shipped it. Ships as
`feat(query):` with the house demo video.
