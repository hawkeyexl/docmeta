# 0024 — standard SQL vocabulary: DML edits the files, DDL edits the schema

- **Status:** Proposed
- **Serves:** Maya · M2, M3 · Sara · S1, S3 · Devin · D3
- **Depends on:** [0021](0021-frontmatter-as-a-database.md), [0022](0022-sql-write-back.md) — stacked on their PRs; nothing here has released.
- **Relates to:** [0023](0023-metadata-vocabularies.md) (in design on its own branch — "vocabulary" there means the house schema families; the DDL below is how a corpus would one day *evolve* such a schema), [0010](0010-init-and-schema-inference.md) (`schemas infer` births a schema; this proposal grows one)
- **Touches (planned):** `src/commands/query.ts`, `src/extractors/frontmatter-write.ts`, `src/core/{config,schema-registry}.ts` (read-mostly), `src/reporters/query.ts`, `reference/cli.mdx`, `test/*`

## Problem

The write surface that 0022 built uses vocabulary nobody else speaks. `drop_key()` is a
docmeta invention; `DELETE` and `INSERT` are refused; `ALTER TABLE` edits *data*, which is
not what ALTER means anywhere else. And the model's most valuable consequence is still
unrealized: schema evolution and corpus migration are two hand-synchronized changes. Sara
ships a stricter schema, then someone migrates the files, and CI is red for exactly the gap
between those commits — S3's whole journey is managing that gap.

SQL already has the vocabulary for both halves, and the mapping is exact once stated:

**DML edits the rows — the files. DDL edits the table definition — the schema.**

## The vocabulary

| Statement | Kind | Meaning |
|---|---|---|
| `SELECT …` | read | rows out |
| `UPDATE docs SET k = v` | DML | set a key; a corpus-new key widens the table (0022) |
| `UPDATE docs SET k = NULL` | DML | **remove the key** from matching files; absent is a no-op |
| `UPDATE docs SET k = explicit_null()` | DML | write a literal `k: null` — the rare case |
| `UPDATE docs SET _path = '…'` | DML | move/rename the file, body byte-preserved |
| `INSERT INTO docs (_path, …) VALUES (…)` | DML | create a file: that frontmatter, an empty body |
| `DELETE FROM docs WHERE …` | DML | strip the frontmatter block; the file and body survive |
| `ALTER TABLE docs ADD COLUMN k TYPE [NOT NULL] [DEFAULT v]` | DDL | the schema gains property `k` (required if NOT NULL); a DEFAULT backfills the files |
| `ALTER TABLE docs DROP COLUMN k` | DDL | the schema loses `k`; the key is removed from the files |
| `ALTER TABLE docs RENAME COLUMN a TO b` | DDL | the schema property is renamed; the key is renamed in every file |
| `DROP TABLE`, `ATTACH`, `VACUUM`, multi-statement | — | refused, with messages naming why |

Everything rides the architecture 0022 fixed: preview by default, `--write` to apply,
`--check` as the drift gate, effects judged rather than syntax parsed, two-phase
all-or-nothing application, typed restoration. No new flags.

The statement this proposal exists for — M2's ratchet, whole:

```sh
docmeta query --write "ALTER TABLE docs
  ADD COLUMN reviewed TEXT NOT NULL DEFAULT 'pending'" docs/
```

One preview shows the schema gaining a required `reviewed` (and, for a builtin, the fork and
the reference moves) above the per-file backfill; one `--write` applies all of it; `validate`
is green on both sides of the change.

## DDL → schema

**Detection stays effect-judged.** The run snapshots `PRAGMA table_info(docs)` alongside the
row snapshot. A column that appears, disappears, or pairs (per-row value equality, the same
pairing DML renames use) is a DDL effect — carrying the declared type, `notnull`, and
`dflt_value`, so nothing parses the ALTER.

**Which schema mutates.** The run's files must resolve to **one** schema set; a corpus whose
overrides split it refuses, naming the split (scope the run to one group). The target is the
schema in the set that *declares* the key (DROP, RENAME); for ADD it is the set's single
local-file schema, or `--schema <ref>` names one; remaining ambiguity refuses.

**Two mutation modes, decided by `classifyRef`:**

- **A builtin forks.** Built-in schemas are immutable — the manifest pins their bytes and
  `schemas:check` enforces it — so `ALTER` over `google:okf:0.1` writes a local copy
  (default `./schemas/okf-0.1.local.json`, `$id` suffixed `+local`, collision refuses) and
  **repoints the references**: the config entry through the comment-preserving YAML Document
  API, any in-file `$schema` through the ordinary metadata writer. One writer pass — a file
  whose `$schema` moves is already a file edit.
- **A local file is edited in place.** It is the author's hand-maintained schema. The edit
  touches `properties` and `required` only, re-emitted with the file's own indent (the
  `mergeJson` discipline), dialect preserved. There are no references to update, and git is
  the review surface. Version and `$id` discipline stay the author's; the preview names the
  file so a bump is a conscious follow-up, and S3's semver guidance — additive is minor,
  required/drop/rename is major — is cited, not enforced.
- **A URL ref refuses**: "vendor it first." `docmeta schemas vendor` exists for exactly
  this, and a vendored copy is a local file the mode above handles. Integrity pins on a
  config entry are recomputed when their target changes.

**Type mapping** is deliberately thin: TEXT → `string`, INTEGER → `integer`, REAL →
`number`, an untyped column adds an unconstrained property. Enums, formats, and `CHECK`
constraints are future work, recorded rather than smuggled in.

## DML → files

**`SET k = NULL` removes the key.** This revises 0022, which chose explicit null — 0022's
own text carries the pointer. The frontmatter reading wins: to a docs engineer, "set it to
nothing" means "it is not set," and the corpus reads back the way the statement left it
(`WHERE k IS NULL` now matches). The literal `k: null` keeps a spelling — `explicit_null()`,
the same per-run sentinel mechanics `drop_key()` used. `drop_key()` itself is removed
outright: nothing has released, and a softened alias is a permanent second surface
(`CLAUDE.md § parallel behaviors`).

**`DELETE FROM docs WHERE …` strips the block.** Removed rows become `cleared` changes; a
new writer primitive `stripFrontmatter(content)` removes the fences and inner text by
`locateFrontmatter` offsets — deleting every key would leave an empty `---`/`---` shell,
which is not the same thing. Fence-family formats only; element formats refuse; matching a
`_present = 0` file is a no-op. A WHERE-less DELETE is allowed: the preview lists every
file, which is the same gate every other bulk edit stands behind.

**`INSERT` creates files.** Added rows become `created` changes. `_path` is required and
validated — relative, no `..`, under the run's base, not already on disk — and no other
system column may be set. Content is `applyFrontmatter("", patch)`: the existing
`createBlock` path, default YAML flavor, empty body. AsciiDoc and RST refuse (their writer
refuses to invent fenced blocks — a bare `---` means something else in both), as do the
element formats.

**`SET _path` renames.** Rows whose *only* change is `_path` pair old→new; the file moves
with `fs.rename`, so the body is untouched by construction. Mixing a rename with cell edits
in one statement refuses — do them separately, each previewable. The extension may not
change (a rename must not change which extractor owns the file), and a target that exists
refuses.

**Rename pairing is correctness, not presentation.** A renamed column's created side has no
type history, so an array value would restore from its projection as a JSON *string*. The
pairing pre-pass — a per-file delete of `a` and create of `b` whose SQL values match
`bindValue(original)` — carries the original file value verbatim, no SQL round-trip. The
same pre-pass serves `ALTER RENAME COLUMN` and any UPDATE that moves a value across columns.

`QueryChange` grows matching variants — `cleared` (with the removed data), `created` (with
the new data), `renamed` (file), `renamedFrom` (key), and a `schema` change describing the
edit or fork and any reference moves — each specified for `json` and `pretty` output.

## Options

**A. `DELETE` deletes files.** The literal standard semantics — a row is a file. Rejected
by decision: the projection holds metadata only, so deleting a row would destroy body
content the statement never examined. Stripping the block is the metadata-scoped reading of
"delete this row from the metadata table."

**B. `DELETE` stays refused.** Rejected: standard vocabulary is the point, and a refusal
teaches the tool's one irregular verb.

**C. Copy-on-write for every schema edit.** Rejected on review: forced version copies of a
hand-maintained schema litter files nobody asked for and still need their references moved.
The author already has a change-review mechanism — git. Forking is reserved for the case
where it is *forced*: builtins, whose immutability is a repo invariant.

**D. `SET k = NULL` keeps writing explicit null.** Chosen at first, revised on review. The
SQL-native objection (real UPDATEs never remove columns) is answered in stress test 5.

## Stress test

**1. The array-rename corruption is what makes pairing mandatory.** Found in design:
`ALTER TABLE docs RENAME COLUMN tags TO topics` without pairing restores each file's array
through the projection — where it is JSON text — and, with no type history on the created
column, writes `topics: '["a","b"]'` as a string. The pre-pass carries the original value
and never round-trips it.

**2. `DROP TABLE` is the accident-shaped spelling and stays refused.** It is one keystroke
of intent away from `DELETE FROM docs`, but "delete the table definition" would mean
"delete the schema," and the destructive reading of an ambiguous statement is the wrong
default. The refusal message names `DELETE FROM docs WHERE …` for the strip and
`ALTER TABLE docs DROP COLUMN` for the schema side.

**3. A strip is not an empty block.** Deleting every key through the writer leaves
`---`/`---` with nothing between — `_present` still 1, `validate` still judging an empty
map. `stripFrontmatter` removes the fences too, and the following blank line, so the body
starts where the author wrote it.

**4. Builtin forks need a name that cannot collide with the real thing.** `okf-0.1.local.json`
beside the config, `$id` `google:okf:0.1+local` — `classifyRef` still reads the file ref as
a file, the `+local` suffix keeps the fork out of the published namespace, and an existing
file at the fork path refuses rather than overwrites.

**5. "SQL never removes a column with `SET NULL`" — true, and not the model here.** In SQL
the column exists for every row and NULL is a cell value. In a document corpus the key
either appears in a file or does not; the projection renders absence *as* NULL both ways
(0021). Reading the assignment as removal makes the corpus read back the way the statement
left it; `explicit_null()` keeps the literal spelling for the rare file that means `null`.

**6. An in-place edit reaches every consumer of a shared local schema.** Named, not hidden:
that is what hand-maintaining a shared schema means, with or without docmeta. The preview
names the schema file; S3's semver guidance is cited beside it; the diff lands in git where
schema changes are already reviewed.

**7. The `$schema` rewrite is itself a file edit — one writer pass.** A builtin fork
repoints in-file `$schema` keys; those files may *also* carry cell changes from the same
statement. Two passes over one file is a lost-update waiting to happen, so reference moves
merge into the same per-file patch the DML path builds.

**8. A mixed-schema corpus refuses rather than guesses.** Overrides can split a run's files
across schema sets; a DDL statement over the split cannot know which contract to evolve.
The refusal names the groups; scoping the run to one override's files is the remedy.

**9. WHERE-less DELETE is allowed, and that is consistent.** `SET k = NULL` with no WHERE
already touches every file, as does `ALTER DROP COLUMN`. The gate is the preview plus
`--write`, not a special case per statement — one rule a user can hold.

**10. INSERT's format limits are the writers' limits, stated.** Markdown and MDX create
blocks; AsciiDoc and RST refuse because a bare `---` is a transition or an open-block there
(the writer's existing refusal, surfaced); element formats have no block to create. The
refusal names the format and the reason.

## Not breaking

Every statement here lands before the stack releases, so the surface ships standard from
day one — including the removal of `drop_key()`, which no released version ever carried.
0022's NULL decision is revised by this proposal and its text points here; the reasoning
stays where it was written.
