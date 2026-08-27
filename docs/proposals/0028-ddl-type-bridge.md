# 0028 — the DDL type bridge: formats as column types, enums as CHECK IN

- **Status:** Proposed
- **Serves:** Sara · S1, S3 · Maya · M2, M3
- **Depends on:** [0024](0024-standard-sql-vocabulary.md) (extends its deliberately thin
  type mapping; its "enums, formats, and CHECK constraints are future work" line is this
  proposal), [0021](0021-frontmatter-as-a-database.md)
- **Relates to:** [0023](0023-metadata-vocabularies.md) (the vocabulary schemas lean on
  `enum` and `format` — this is how a corpus would evolve one through DDL),
  [0022](0022-sql-write-back.md) (whose no-SQL-parsing rule gains its second recorded
  exception here)
- **Touches (planned):** `src/commands/query.ts` (`mapDeclaredType`, `snapshotColumns`,
  `assertDefaultsMatchDeclaredTypes`, `columnDiffOps`, `mutateSchemaObject`),
  `src/reporters/query.ts`, `reference/cli.mdx`, `test/query-ddl.test.ts`

## Problem

0024 made `ALTER TABLE docs ADD COLUMN reviewed TEXT NOT NULL DEFAULT 'pending'` do the
whole job — the schema gains a required property, every file is backfilled, `validate` is
green on both sides of the change. But its type mapping stopped at affinity: TEXT →
`string`, INTEGER → `integer`, REAL → `number`. The constraints schema authors actually
reach for first — **`enum`** ("one of these values") and **`format`** (`date`,
`date-time`, `uri`, …) — cannot be spelled, so evolving them is back to hand-editing the
schema and hand-migrating the files, the two-commit gap S3's journey exists to close.
0024 recorded the gap explicitly rather than smuggling in a design; this is the design.

## Design

Both halves use spellings SQL already owns — 0024's thesis, continued:

```sql
-- schema gains  reviewed_on: { type: string, format: date }, required;
-- every file is backfilled with the default
ALTER TABLE docs ADD COLUMN reviewed_on DATE NOT NULL DEFAULT '2026-08-26'

-- schema gains  status: { type: string, enum: [draft, review, final] }
ALTER TABLE docs ADD COLUMN status TEXT CHECK (status IN ('draft','review','final'))
```

### Formats ride the declared column type

SQLite accepts any word as a column type and reports it back verbatim through
`PRAGMA table_info` — quoted names dequoted (verified: `DATE` → `DATE`, `"date-time"` →
`date-time`, `URI` → `URI`). So the mapping rule is: a declared type that
case-insensitively equals a JSON Schema format name — `date`, `date-time`, `time`,
`duration`, `email`, `idn-email`, `uri`, `uri-reference`, `uuid`, `hostname`, `ipv4`,
`ipv6`, `regex`, `json-pointer` — maps to `{ type: "string", format: <name> }`.
Hyphenated names are written as quoted types: `ADD COLUMN updated "date-time"`.

Two deliberate edges:

- **A closed alias pair**: `DATETIME` and `TIMESTAMP` → `format: date-time`. They are what
  SQLite users habitually type, and both would otherwise map to nothing. The list is
  closed at two; everything else is strict equality, and the preview always prints the
  property the schema will gain, so a near-miss (`ADD COLUMN due DUE-DATE`) is visible as
  "unconstrained" before anything is written.
- **Ordering is load-bearing** (stress test 3): the format match runs **before** the
  existing affinity regexes, or `/INT/` eats `json-POINTER`.

### Enums are `CHECK (col IN (…))`

Detection is the delicate part. 0024 detects DDL by diffing `PRAGMA table_info` before
and after the statement — and table_info does **not** expose CHECK constraints (verified;
it reports name/type/notnull/default only). The constraint exists in exactly one place:
`sqlite_master`, the catalog of stored `CREATE TABLE` text, where `ADD COLUMN` appends
the new column's definition **verbatim to text docmeta itself authored** (verified — the
stored SQL is the original `CREATE TABLE docs (…)` plus the appended defs, character for
character).

So the run snapshots the catalog text alongside the column snapshot, and consults it
**only when the effect diff shows a column add**. The appended suffix is then parsed
against a deliberately tiny grammar: `CHECK (<the-new-column> IN (<string-or-number
literals>))`, yielding `enum: [...]` merged with the declared type's mapping. Any other
CHECK — expressions, other columns, `AND` — refuses, naming the supported shape and the
hand-edit alternative. DROP and RENAME rewrite the stored text mid-string and never
consult it.

### The DEFAULT guard extends to formats and enums

0024 stress 14 established the invariant: one statement must not produce a corpus that
fails the schema it just gained. Two findings against this design, one free and one not:

- **Enums come free from the engine.** SQLite itself refuses an ADD whose DEFAULT
  violates its own CHECK — verified with and without NOT NULL
  (`ADD COLUMN sev TEXT DEFAULT 'bogus' CHECK (sev IN ('low','high'))` →
  `CHECK constraint failed`).
- **Formats do not.** `ADD COLUMN published DATE DEFAULT 'yesterday'` sails through the
  engine and through today's guard, which compares broad types only — and would backfill
  every file with a non-date while writing `format: date` into a schema ajv-formats
  enforces. `assertDefaultsMatchDeclaredTypes` therefore validates the backfill value
  against the mapped format before any plan exists.

### The read side stays untyped — closing 0021's dangling line

0021 deferred "schema-informed column types" for reads as "a refinement, not a
prerequisite." This proposal closes that line as **rejected**, for the same reasons 0027
rejects typed views: it would put schema resolution inside every read, against query's
schemaless/offline design rule, and new column affinity silently changes what existing
comparisons match. Declared types exist in this proposal only inside a DDL statement the
user is writing — where they are instructions, not inference.

## Options

**A. docmeta-invented spellings** (`ADD COLUMN status ENUM('draft','review')`, a
`format()` function). Rejected: 0024's entire argument was that SQL already has the
vocabulary; `CHECK (k IN (…))` *is* the standard enum spelling, and type names are the
natural carrier for formats.

**B. Parse the user's ALTER statement for the CHECK.** Rejected: 0022 fixed the
architecture as effect-judged, with refusal-by-name for ATTACH/VACUUM as "the one place
syntax is consulted." Reading the catalog's stored text is narrower than parsing user
input — the suffix is docmeta-authored text plus one appended column def — but it is
still a second consultation of syntax, and this proposal owns that in stress test 2
rather than pretending the diff is pure effect.

**C. Strict format list, no aliases.** Rejected by a hair: `DATETIME`/`TIMESTAMP` →
nothing is a trap for exactly the population this feature serves, and a closed two-alias
list costs one table row in the reference. The slope is guarded by being closed: `DATE`
is a format name, `DATETIME`/`TIMESTAMP` are the aliases, and nothing else maps.

**D. Keep refusing all CHECKs (status quo for enums).** Rejected: it is the recorded gap
this proposal exists to close, and the refusal already steers users toward hand-editing —
the two-commit ratchet gap 0024 shipped to eliminate.

## Stress test

**1. `PRAGMA table_info` cannot see a CHECK — verified before designing.** Probe on
`node:sqlite` (Node 24.11.0, the engines floor):
`ALTER TABLE docs ADD COLUMN status TEXT CHECK (status IN ('draft','review','final'))` is
accepted on a non-empty table and enforced on later writes
(`UPDATE … SET status='nope'` → `CHECK constraint failed`), while table_info reports
`{name: "status", type: "TEXT", notnull: 0, dflt: null}` — no constraint. The catalog
consult is not an implementation choice; it is the only channel.

**2. The catalog consult is the second syntax exception, and it is scoped to stay small.**
The stored `CREATE TABLE` text after an ADD is docmeta's own text plus the verbatim
appended def (verified) — a suffix delta, extractable without parsing the user's
statement. DROP and RENAME rewrite the stored text mid-string, which is why they never
consult it: widening the consult beyond adds is where this exception would grow into the
SQL parser 0022 refused. The grammar accepted from the suffix is one shape; everything
else refuses.

**3. Affinity regexes eat format names — ordering found in design.** The existing mapper
matches `/INT/i` before anything else, and `json-POINTER` contains `INT`: affinity-first
would map a `json-pointer` column to `integer`. (This is SQLite's own famous affinity
rule doing exactly what it documents.) The format match therefore runs first, and a test
pins `json-pointer` end to end.

**4. `DATE DEFAULT 'yesterday'` — the hole the review found.** Today's guard checks the
backfill's *broad type* against the declared type, so a string default satisfies a DATE
column, backfills every file, and writes a `format` the validator enforces — the corpus
failing the schema it just gained, 0024 stress 14's regression reborn one level up. The
guard validates the default against the mapped format (and, for enums, the engine already
refuses — see Design). A test pins both directions.

**5. RENAME must carry the whole property, not rebuild it.** The internal DDL op record
carries `{type, required}` only; a rename that *rebuilds* the schema property from the op
would strip an existing `enum`/`format`/`description` from a hand-written schema. 0024
already moves the property object for renames — the test added here pins that an enum
property survives `ALTER TABLE docs RENAME COLUMN status TO stage` intact, so the op
record's thinness can never become the property's.

**6. Quoted type names survive the whole path.** Verified at the engine (`"date-time"`
dequotes in table_info) and by reading the statement scanner (quoted tokens are skipped,
so the hyphen never splits a statement); the integration test runs the quoted spelling
through the built binary, which is where 0021 stress 10 taught that bundler-layer
surprises live.

**7. A numeric enum with an INTEGER declared type maps consistently.**
`ADD COLUMN priority INTEGER CHECK (priority IN (1,2,3))` →
`{ type: "integer", enum: [1, 2, 3] }`; the literals' JSON types must agree with the
declared type or the statement refuses — the same reconciliation rule as the DEFAULT
guard, applied to the enum members.

## Not breaking

Additive: every statement that works today maps exactly as it did — the new mappings
occupy declared-type spellings (`DATE`, `"date-time"`, …) that currently map to an
unconstrained property, and CHECKs that are refused wholesale today. A corpus author who
never types them sees no change. Ships as `feat(query):`, minor release, demo video per
the house rule.
