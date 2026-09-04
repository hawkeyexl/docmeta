# 0030: `-s/--schema` on `query`: naming the contract DDL evolves

- **Status:** Implemented (#139)
- **Serves:** Sara · S1, S3 · Maya · M2, M3
- **Depends on:** [0024](0024-standard-sql-vocabulary.md) (the DDL planner, its
  single-set rule, and the `--schema <ref>` its design text sketched and never shipped)
- **Relates to:** [0016](0016-flag-ownership.md), where `-s` means "which
  schemas govern" on every command that takes it. Also
  [0027](0027-named-collections.md), the named-groups spelling of the split-set
  remedy this flag becomes the third of. Also [0029](0029-query-for-scripts.md),
  whose export-only refusal rule is applied here, and
  [0025](0025-query-dry-run-polarity.md), where nothing here changes the write
  polarity
- **Touches (planned):** `src/commands/query.ts`, `src/cli.ts`, `reference/cli.mdx`,
  `schemas/versioning.mdx`, `test/{query-ddl,cli.integration}.test.ts`

## Problem

0024 made DDL evolve the corpus's resolved schema set, and made ambiguity
refuse. Both refusals are right. Both leave Sara one step short of the statement
she meant:

```sh
$ docmeta query "ALTER TABLE docs ADD COLUMN reviewed TEXT" docs/
docmeta: The resolved set names 2 local schema files (./schemas/house.json,
./schemas/extra.json) — DDL cannot tell which one to evolve. Scope the run to an
override group that names one, or set the files' `$schema` to the schema to evolve.
# exit 2
```

```sh
$ docmeta query "ALTER TABLE docs ADD COLUMN reviewed TEXT" docs/   # split corpus
docmeta: DDL needs the corpus to resolve to one schema set, and this run's is split
("docs/two.md" resolves differently). Scope the run to one override group.
# exit 2
```

The remedies work, but they are indirect for the common one-off evolution.
Scoping to an override group means knowing which group's file glob covers the
files. It also means reshaping the *input set* to say something about the
*schema*. Setting in-file `$schema` means editing documents to steer one
statement. Sara knows exactly which contract she is evolving,
`./schemas/house.json`, and has nowhere to say so. 0024's own design text
sketched the answer: for ADD it is the set's single local-file schema, or
`--schema <ref>` names one. The implementation shipped without it. A test even
pins that the refusal names no phantom `--schema` flag, precisely because it did
not exist yet.

## Design

### `-s/--schema <ref>`, repeatable: the set the run's DDL evolves

```sh
docmeta query -s ./schemas/house.json \
  "ALTER TABLE docs ADD COLUMN reviewed TEXT NOT NULL DEFAULT 'pending'" docs/
```

When `-s` is given, the DDL planner skips the per-file resolution walk entirely.
The run's schema set **is** the deduped `-s` refs, with source `cli`. That is
the same CLI-precedence rule `validate` and `fill` give the flag. Everything
downstream is unchanged, with the same member loading, the same guards, the same
mutation modes:

- **ADD** still needs a single local-file member in the set. It still refuses
  when any member already declares the property, because its constraints would
  be clobbered.
- **DROP/RENAME** still need a sole declarer. The shared-ownership refusal of
  0024 § stress test 14 is **not** bypassable by `-s`. Name a set whose members
  both constrain the key, and the statement refuses exactly as before. `-s`
  picks the contract; it never overrides what the contract says about ownership.
- **A builtin forks**, a **URL ref refuses** with "vendor it first", and the
  **trust boundary** holds. The refs load through the same `classifyRef` and
  member-loading machinery as a resolved set. So a ref outside the repository
  refuses as a write target. 0024 § stress test 13 has the rule: writes go
  through the same machinery as reads, `trustRoot` included. `-s` must not
  become the parallel path that rule exists to prevent.

### `-s` is the third remedy for the split corpus

A set named on the command line is unanimous by construction, because there is
no per-file walk to disagree with itself. So the split-set refusal gains the
direct remedy alongside the two indirect ones. It does so in both spellings, the
plain one and 0027's named-groups variant: *"…or pass `-s <schema>` to name the
contract directly."* The ADD-ambiguity refusal (several local files in one set)
names it too, retiring the phantom-flag pin.

### A run whose statement evolves no schema refuses, before any write applies

`-s` speaks only to the DDL planner. A `SELECT` under `-s`, or an `UPDATE`,
would leave the flag silently meaning nothing. 0029's export-only `--param` fix
established the rule: such a flag refuses, at exit 2, naming its meaning. The
refusal says "produced no schema-evolving effects", not "ran no DDL". A
`CREATE INDEX` into a `--db` export is DDL, just none the planner maps to a
schema. Two placements, both load-bearing:

- **Export-only runs** (`--db` with no SQL) refuse at the CLI gate beside `--param`'s,
  before any file is read.
- **Statements** refuse **after effect classification and before
  `applyChanges`**. DDL is judged by its effects rather than its syntax. So the
  run cannot know "no DDL happened" until the statement has run against the
  disposable projection. But it must know before a byte lands. A DML statement
  under `-s` must **not** write files and then error. That applies-then-refuses
  trap was a live review finding on `-f csv`, and 0029's dispatch forces the dry
  run for the same reason. The refusal here sits on the plan side of the same
  all-or-nothing line.

### Collections are untouched

On `validate`, `-s` reshapes the corpus contract. That is why a scoped
`validate` run disqualifies checks (0026): the flag changes what the corpus
*is*. On `query`, `-s` deliberately does not. Collection views (0027) keep
following the config's resolution; a statement reading `FROM "handbook"` under
`-s` sees the same membership as without it. The flag names the contract DDL
evolves, and nothing more, which is what keeps it safe to add to a statement
that also reads.

### 0016 parity

`-s` keeps its cross-command meaning, "which schemas govern this run", narrowed
to the one surface `query` consults schemas on at all: DDL. `validate` judges
files against the set, `fill` proposes against it, `query` evolves it. Same
flag, same precedence rank (CLI over `$schema` over config), applied to each
command's own verb.

## Options

**A. Full-parity resolution override, like `validate`'s `cliSchemas`.**
Rejected: on `query`, resolution feeds two consumers, the DDL planner and the
0027 collection views. A parity override would silently empty every configured
collection mid-query. The views are built from what each override group won, and
a CLI set wins everything. On a plain read it would mean nothing visible at all.
The half that has meaning is the DDL half; the flag is scoped to it.

**B. Accepted-but-inert, like `--offline`.** Rejected: `--offline` is inert on
`query` because there is genuinely nothing to suppress, since no code path
fetches. An inert `-s` would mask a real semantic difference with `validate`'s
`-s` and leave the user believing they had scoped something. Where the flag has
no meaning, it refuses; where it has one, it acts.

**C. An in-statement spelling**, such as a qualified table name
(`ALTER TABLE house.docs …`) or a comment directive. Rejected twice over.
Non-standard vocabulary is exactly what 0024 exists to remove. And
comments-as-directives would break the scanners' comments-are-skipped contract.
The SET, CHECK and paren scans all skip comments by design, and a comment that
*means* something would fork that rule.

**D. Status quo.** Rejected. The remedies are real but indirect. Override
scoping reshapes the input set to say something about the schema, and in-file
`$schema` edits documents to steer one statement. The common one-off evolution
deserves the direct spelling 0024 sketched.

## Stress test

**1. The DML trap is why the refusal's placement is specified, not just its
text.** First shape considered: refuse "no DDL" wherever it is noticed. But
effects are judged after execution, and `applyChanges` runs right after
judgment. A careless placement refuses *after* the UPDATE landed in the files.
That is the exact applies-then-errors trap the `-f csv` review found, whose fix
forces the dry run before dispatch. The refusal here is pinned after
`columnDiffOps` and before any plan or apply, and the test asserts both halves:
exit 2 *and* the file bytes unchanged. Review then held the message itself to
the same standard. "Nothing was applied" is false under `--db`, because the
export target is created before the statement runs, and holds whatever the
statement did. So the refusal names that residue when a target exists. And "ran
no DDL" is false for planner-invisible DDL, since a `CREATE INDEX` into the
export is legal and *is* DDL. So the wording is "produced no schema-evolving
effects". Both wordings are pinned by test.

**2. Stress 14 stands: `-s` names the contract, not the outcome.**
`-s a.json -s b.json` where both constrain `title`, then `DROP COLUMN title`,
still gives "constrained by 2 schemas … evolve them separately". The unanimity
`-s` buys is about *which set*, not about ownership inside it. A bypass here
would recreate the corpus-fails-after-a-successful-write bug that stress test
found.

**3. One machinery, verified at the three edges, and the fork must stay
resolvable.** `-s` refs flow through the same loader as resolved sets. A URL ref
refuses with "vendor it first". A builtin id forks, with the config repoint and
`$schema` repoints riding the same write. A path outside the repository refuses
at the write-target boundary. No `-s`-only branch touches trust, classification,
or loading. The first implementation got the fork's repoint wrong, and review
caught it as the worst finding in the set. The repoint matched whole-set
equality, which a cli-named set can never satisfy against a config whose set is
by definition different. So `-s google:okf:0.1` over a config carrying
`[house.json, google:okf:0.1]` exited 0 with a fork on disk. The config was
untouched, and `validate` still resolved the un-evolved builtin. One rule fixes
it. A cli-named fork repoints by **builtin identity**. Every config `schemas:`
or override entry that names the builtin is repointed to the fork. So is every
loaded file's `$schema`. Either spelling counts, raw id or published URL. And
when *nothing* names it, with no entry and no `$schema`, the fork would be an
orphan nothing ever resolves. So the statement refuses with "add the schema to
the config (or the files' `$schema`) first", instead of reporting a success that
changed no contract.

**4. The export-only gate is the CLI's, mirroring `--param`.**
`docmeta query -s x --db out.db docs/` runs no statement, so nothing can
classify. The refusal lives beside `--param`'s export-only gate, before any file
is read. Same rule, same seam.

**5. The split fixture proceeds under `-s`, and the refusal without it names the
flag.** The 0024 split test's own fixture, an override sending one file to a
different set, runs green with `-s ./schemas/house.json`, evolving exactly that
file. And the refusal message without `-s` now carries the third remedy, in both
the plain and the named-groups spellings. The phantom-flag pin ("the ADD refusal
must not name `--schema`") inverts: the flag exists now, so the refusal must
name it.

## Not breaking

This is additive. It is a new flag on one command, and every existing invocation
behaves byte-identically. The two refusal messages that change are refusals, at
exit 2 before and after, with one more remedy named. Ships as `feat(query):`, a
minor release, with the demo video the house rule requires.
