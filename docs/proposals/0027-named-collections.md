# 0027 — named collections: override groups as views

- **Status:** Proposed
- **Serves:** Devin · D4 · Maya · M2
- **Depends on:** [0021](0021-frontmatter-as-a-database.md) (this is its roadmap item P2,
  re-scoped — see Options D), [0024](0024-standard-sql-vocabulary.md) (whose "scope the
  run to one override group" remedy gets a name to scope to)
- **Relates to:** [0016](0016-flag-ownership.md) (config key ownership),
  [0026](0026-corpus-checks-are-findings.md) (named checks read a lot better over named
  collections)
- **Touches (planned):** `src/core/config.ts`, `src/core/resolve-schema.ts`,
  `src/commands/query.ts`, `reference/{cli,configuration}.mdx`, `ci/query-gates.mdx`,
  `test/*`

## Problem

The flagship corpus rule — every `author:` names a real page in `authors/` — is written
today as a self-join against a path glob, 0021's own worked example:

```sql
SELECT d._path, d.author FROM docs d
LEFT JOIN docs a ON a._path GLOB 'authors/*' AND a.slug = d.author
WHERE d.author IS NOT NULL AND a._path IS NULL
```

The `GLOB 'authors/*'` is noise with two real costs. It duplicates knowledge the config
already holds — the repo that models authors this way almost certainly has an
`overrides:` entry mapping `authors/**` to an author schema — and the two spellings drift
independently: move the directory, update the config, and every check quietly matches
nothing. And 0024's DDL refusal tells a user to "scope the run to one override group"
when the corpus resolves to more than one schema set, but override groups have no names
to scope by; the remedy is real and unspellable.

0021's roadmap named this P2: "an optional `name:` on config `overrides[]` turns each
override group into a table (or view) of its own, typed from its resolved schemas —
`FROM docs JOIN authors` instead of the `GLOB` self-join."

## Design

```yaml
overrides:
  - name: authors
    files: "authors/**"
    schemas: [./schemas/author.json]
```

```sql
SELECT d._path, d.author FROM docs d
LEFT JOIN authors a ON a.slug = d.author
WHERE d.author IS NOT NULL AND a._path IS NULL
```

### The config key

`name:` becomes an optional override key. Refused at parse time: a duplicate name, the
name `docs`, a name that is empty or blank after trimming (a whitespace-only name would
otherwise become a legal quoted view `" "`), a name starting `sqlite_` (SQLite reserves
the prefix for internal objects and refuses such a `CREATE VIEW` outright, quoting
notwithstanding — refusing at parse time keeps that failure out of every later read), and
a `name:` on an entry with no `schemas:` — such an entry never wins schema resolution
(the resolver skips schema-less overrides), so its view would be empty by construction;
refusing follows the config's existing "this entry reads as configured and is not" idiom.
Any other string is legal: view names are quoted identifiers, the same rule 0021 stress 5
set for metadata-key columns.

### Membership: the group a file is validated as

A file belongs to the view of the override that **won its schema resolution** —
first-match-wins, so views are disjoint, and `FROM authors` means exactly "the files the
author schema judges." This needs one small additive change: `resolveSchemaSetWithSource`
today tells callers *that* an override won (`source: "override"`) but not which; it grows
the matched entry's identity.

Each view is built from the computed member list —

```sql
CREATE VIEW "authors" AS SELECT * FROM docs WHERE _path IN ('authors/ada.md', …)
```

— never by translating the config glob into SQL. The config's glob engine (picomatch:
`**`, braces, negation) and SQLite's `GLOB` are different languages; membership is
decided once, in the code that already decides it, and the view records the verdict.

### What the 0024 refusal gains

The split-set DDL refusal can finally say something actionable. Today it ends "Scope the
run to one override group" with no way to name one; with named overrides it lists the
groups it found — `the run spans authors (authors/**) and docs (docs/**); re-run over one
group's files` — turning the remedy from a concept into a copy-pastable next step. That
message change is this proposal's whole delivery on the 0024 gap: scoping itself stays
what it is today (run over that group's paths). A `--collection <name>` input flag that
scopes a run by name is the natural follow-up, recorded here rather than designed here —
it is an input-surface change that 0005's parity rules say every command would then need
to answer for.

### Labeling, never a gate

Plain reads resolve no schemas today — that is 0021's founding rule — and resolution can
*throw* for a single file (a document `$schema:` URL the trust settings refuse). Building
views must not turn a working `SELECT 1` into exit 2. So the resolution walk runs only
when the config has named overrides at all, and a per-file refusal demotes to "member of
no view" — the file stays a `docs` row, every existing query is untouched.

### What a view is not

Writing through a view refuses — SQLite's own error, which docmeta catches and completes
with the remedy: `cannot modify authors because it is a view; write through docs:
UPDATE docs … WHERE _path IN (SELECT _path FROM "authors")`. The write-back machinery is
untouched: effect judgment snapshots the `docs` table, and views live outside it.

## Options

**A. Materialized tables per group.** Rejected: copied rows are a second source of truth,
and a second *writable* surface for the effect gate to police. Views keep one table
authoritative and are read-only by construction.

**B. Views over a SQL translation of the glob.** Rejected: picomatch and SQLite `GLOB`
agree on the easy cases and diverge on `**`, braces, and dot-handling — exactly the cases
a docs repo hits. A view over the computed member list is exact by construction.

**C. Membership by raw glob match (every override whose glob matches).** Rejected:
overlapping globs would put one file in two collections while only one schema set judges
it, and "the group this file is validated as" is the meaning that makes `FROM authors`
trustworthy in a check. Resolution-winner keeps views disjoint and consistent with
`validate`.

**D. The "typed" half of P2 — view columns typed from the group's resolved schemas.**
Rejected, and this proposal is the record: typing requires resolving and loading schemas
inside every read, importing the trust and network machinery into a command whose design
rule is "no schema resolution; schemaless and offline" (0021), and column affinity would
silently change what existing comparisons match. The name and the join ergonomics are the
value P2 was reaching for; the typing was cost wearing a feature's clothes.

## Stress test

**1. A file's own `$schema:` takes it out of the view — stated, not discovered later.**
Resolution precedence puts a document's `$schema` above overrides, so a file inside
`authors/**` that names its own schema — *even the identical one* — resolves as
`document`, not `override`, and exits the view. That is the design meaning ("the group
this file is validated as"), and it will still surprise someone; the implementation emits
a stderr notice when a glob-matching file is excluded this way, naming the file and why.

**2. Trust settings move membership.** With `schemaTrust.documentRefs: none`, the
document's `$schema` is ignored, the override wins the file back, and the view grows.
Membership tracking resolution means membership tracks *everything* resolution honors.
Recorded as a consequence of the design rule, with stress test 1's notice as the
observability.

**3. A trust refusal must not abort a SELECT.** `assertDocumentRefAllowed` throws for a
file whose `$schema` URL the config refuses; `validate` reports that as a per-file
finding, but a query is not a validation. Verified the failure shape in design review:
without the demotion rule, one contributed file would turn every `SELECT 1` over the
corpus into exit 2. Demoted to "member of no view"; the file's row is unaffected.

**4. The IN-list scales past any real corpus.** A view's member list is literal paths.
SQLite's default SQL-length ceiling is ~1 GB; a 10,000-file corpus of long-ish paths is
under a megabyte of view definition. One line records the ceiling; no mitigation needed.

**5. Views ride into `--db`, and that is already covered.** `CREATE VIEW` rows live in
`sqlite_master`, so a `--db` export carries the collections — which is a feature (open the
export in Datasette, the groups are there) and already inside the export's contract: 0021
declared the file a regenerable artifact statements may add objects to.

**6. The effect gate never sees them.** Verified live (`node:sqlite`, Node 24.11.0):
views appear in `sqlite_master` as `type: view`, `SELECT` through them works,
`UPDATE` through them fails with `cannot modify <name> because it is a view`, and
`PRAGMA table_info(docs)` / `SELECT * FROM docs` — the two snapshots effect judgment
diffs — are byte-identical before and after `CREATE VIEW`.

## Not breaking

Additive: an optional config key and some `CREATE VIEW` statements in a per-run in-memory
database. A corpus with no named overrides builds byte-identical SQL surface to today.
Ships as `feat(query):`, a minor release, demo video per the house rule. A config using
`name:` requires a docmeta at or above this feature everywhere the config is read — the
standard new-key caveat, same as 0026's.
