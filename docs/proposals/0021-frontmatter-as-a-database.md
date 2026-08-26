# 0021 — the corpus is a database: `docmeta query`

- **Status:** Proposed
- **Serves:** Devin · D1, D3 · Maya · M2
- **Touches:** `src/commands/query.ts`, `src/reporters/query.ts`, `src/cli.ts`, `src/index.ts`, `reference/{cli,api}.mdx`, `test/fixtures/query/`
- **Relates to:** [0005](0005-command-parity.md) (the surface it must match), [0016](0016-flag-ownership.md) (the flag rules it must not break), [0010](0010-init-and-schema-inference.md) (`schemas infer` is the only existing cross-file scan), [0014](0014-empty-input-is-not-success.md) (what an empty input set means here)

## Problem

Every check docmeta can express ends at a file boundary. JSON Schema is
single-document by design: a schema can say *this* file's `author` is a
non-empty string, and cannot say the string names an author that exists. The
rules docs teams actually enforce by hand in review are mostly **corpus** rules:

- every `author:` must exist in `authors/`;
- no two pages share a `slug:`;
- every `related:` entry names a real page;
- nothing published has `last_reviewed:` older than a quarter.

None of these is expressible in any schema docmeta could resolve, because each
one is a **join**, and validation sees one document at a time.

The reading side has the same ceiling. `get` walks many files but answers
per-file — a flat list, no filter, no aggregation. `schemas infer` aggregates
across the corpus but deliberately discards the file→value table as it counts
(`src/commands/schemas.ts` keeps capped samples, not rows). "Which pages are
drafts, by tag, sorted?" is a question the metadata already answers and no
command can ask.

## Prior art, and the gap

Querying frontmatter as data is a proven want, not a speculative one:

- [Obsidian Dataview](https://github.com/blacksmithgu/obsidian-dataview) (and
  its successor Datacore) — a data index and query language over frontmatter,
  with enormous adoption. Editor-bound; nothing for CI.
- [MarkdownDB](https://markdowndb.com/) — markdown → SQLite index with a JS API.
- [mdquery](https://github.com/eristoddle/mdquery) — Python, markdown → SQLite,
  SQL with joins over files/links/tags tables.
- [frontmatter-mcp](https://github.com/kzmshx/frontmatter-mcp) — DuckDB SQL over
  frontmatter, served over MCP.
- DuckDB's community [`markdown`](https://duckdb.org/community_extensions/extensions/markdown)
  and [`yaml`](https://duckdb.org/community_extensions/extensions/yaml)
  extensions — `SELECT title FROM read_yaml_frontmatter('posts/*.md')` works in
  the `duckdb` shell today.

Every one of them is markdown-only, none validates anything, and none is built
to gate a CI run. docmeta already owns the three pieces they lack: extractors
for six formats behind one metadata shape, the input/config surface 0005
standardized, and an exit-code contract CI trusts. The gap is exactly
docmeta-shaped.

## The boundary with dockg

dockg (sibling project) derives a deterministic RDF graph from documentation —
frontmatter, headings, links — and governs it with SHACL. Its `query` today is a
single triple-pattern match, and its querying **is expected to grow**. This
proposal is written to survive that: the division is by data model, not by
feature gap.

dockg's own ADR 01008 ("graph as index, not corpus") commits it to a curated
vocabulary: known page keys plus its validated `kg:` block, with arbitrary
frontmatter keys deliberately ignored. A mature dockg query still could not
answer "which pages have `sidebar_position` > 5" — those keys never enter the
graph. So:

- **`docmeta query` is the lossless, syntactic layer**: every top-level key as
  written, across all six formats, zero setup.
- **dockg is the normalized, semantic layer**: concepts, relationships,
  provenance, over markdown/MDX it has built a graph from.

Rule of thumb: a question that names a *key* is docmeta's; one that names a
*concept or relationship* is dockg's.

Two consequences are binding on this design:

1. **No body-derived data, ever.** MarkdownDB and mdquery grow links/sections
   tables; `docmeta query` must not. Document structure and cross-document
   relationships are dockg's side of the line — and extraction of metadata-only
   is also what docmeta *is*.
2. **The referential-integrity overlap is owned, not hidden.** A team that
   models authors as `kg:` concepts can enforce their existence with SHACL via
   `dockg check`. `docmeta query --check` covers everyone else: arbitrary keys,
   non-markdown formats, repos with no graph adoption.

dockg already depends on docmeta (`extractFrontmatter`, `runValidate`), so
"docmeta turns files into metadata; dockg turns metadata into meaning" is the
established layering, not a new claim.

## Options

**A. Grow `get` with `--where`/`--sort` flags.** No joins, so the four Problem
rules stay inexpressible — and a filter mini-language grows one flag at a time
until it is a bad query language. Dataview's DQL hitting its ceiling hard enough
to force the Datacore rewrite is the cautionary tale. Rejected.

**B. A sibling project consuming docmeta as a library.** It would re-import
docmeta for extraction and config (as dockg does), re-implement the 0005 surface
to feel consistent, and still lack the standing to gate CI the way the tool
already wired into CI can. A second npm package and docs site for one command's
worth of code. A future full dockg query makes the third tool's territory
smaller still. Rejected.

**C. `docmeta query`: SQL over an in-memory SQLite database built per run from
extracted metadata.** Node ≥ 24 is already the engines floor, so `node:sqlite`
makes the entire engine **zero new dependencies**. `--check` turns any join into
a CI gate, which folds the feature into docmeta's mission — cross-file
validation — rather than away from it. **Recommended.**

**D. Export-only** (`docmeta export --to sqlite`), query with `sqlite3` /
`duckdb` / Datasette. Composable, but the referential-integrity gate then lives
outside the exit-code contract, and the common case ("run this one query in CI")
grows a two-tool pipeline. With `node:sqlite`, a `--db <path>` flag on `query`
gets all of D's interop nearly free later — recorded as a fast-follow, not the
primary UX.

## Design

### CLI

Full 0005 parity with `get`, whose `[fields]`-then-`[paths...]` shape this
mirrors exactly:

```
docmeta query [sql] [paths...]        # or: --query <sql>, and every positional is a path
  --check                             # any row returned ⇒ findings ⇒ exit 1
  --as <format>  --ext <list>  --exclude <glob>
  -c/--config <path>  --no-config
  -f/--format <pretty|json>           # default pretty
  --allow-empty  --no-gitignore  --offline
  -                                   # stdin as one more input; requires --as
```

- SQL/path disambiguation reuses `looksLikePath`: `docmeta query docs/` (SQL
  forgotten) is refused with the remedy in the message, `--query` is the
  unambiguous spelling, and `-` is never SQL — the same three rules
  `resolveGetInputs` already enforces for fields.
- `--offline` is accepted and has no effect, exactly as on `get`, and for the
  same reason: no schema is ever resolved, so there is no network dependency to
  suppress. Parity keeps the flag set uniform across commands.
- Exit codes: `0` ran (with `--check`: ran and returned no rows), `1` only from
  `--check` with rows, `2` operational — bad SQL included, since a query that
  cannot be prepared is a usage error, not a finding.
- No `--quiet`: `get` uses it to hide files, `validate` to hide passes; a query
  result has no analogous noise to hide. Omitting a parity flag that would mean
  nothing follows 0016's corollary — a flag means what its command says, and
  here it would say nothing.

### The table

One table, `docs`. One row per input file (stdin included). Four system
columns, prefixed so they cannot collide with ordinary frontmatter:

| column | value |
|---|---|
| `_path` | the file's path as docmeta already prints it: posix separators, relative, sorted — identical on Windows and Linux |
| `_format` | extractor name (`markdown`, `xml`, …) |
| `_present` | `1` if the file has a metadata block/surface, else `0` — so `WHERE _present = 0` lists the files validation would report as missing metadata |
| `_data` | the full extracted metadata as JSON text, for `json_extract`/`->>` reach into anything not lifted to a column |

Data columns are the union of **top-level keys** across the corpus — the same
scan boundary `schemas infer` chose, for the same reason: nesting explodes
unboundedly, and the long tail lives in `_data`. Keys become quoted identifiers
verbatim (`"sidebar position"` is a legal column), values keep the type the
metadata had: strings and numbers bind as themselves, booleans as `1`/`0`,
arrays and objects as JSON text — which SQLite's built-in `json_each` and `->>`
then query directly. Columns are declared without type affinity, so SQLite
stores exactly what was bound and never coerces.

### What it looks like

```sql
-- every author: must name a page in authors/ — the join no schema can express
docmeta query --check "
  SELECT d._path, d.author FROM docs d
  LEFT JOIN docs a ON a._path GLOB 'authors/*' AND a.slug = d.author
  WHERE d.author IS NOT NULL AND a._path IS NULL" docs/ authors/

-- no two pages share a slug
docmeta query --check "
  SELECT slug, count(*) n, group_concat(_path, ', ') files
  FROM docs WHERE slug IS NOT NULL GROUP BY slug HAVING n > 1" docs/

-- tag census, from array-valued frontmatter
docmeta query "
  SELECT t.value tag, count(*) n FROM docs, json_each(docs.tags) t
  GROUP BY tag ORDER BY n DESC" docs/

-- what has gone stale
docmeta query --check "
  SELECT _path, last_reviewed FROM docs
  WHERE date(last_reviewed) < date('now', '-90 days')" docs/
```

`pretty` renders an aligned table plus a row count (with `--check`, a ✓/✗
verdict line); `json` is the bare array of row objects, mirroring `get`'s bare
array — the exit code, not the envelope, carries the verdict.

### What the MVP deliberately does not do

- **No schema resolution.** Like `get` and `schemas infer`, the command is
  schemaless and offline; it reads what is there. Schema-informed column types
  are a refinement, not a prerequisite — see the roadmap.
- **No persistence.** The database is rebuilt in memory every run. The measured
  cost (below) is milliseconds at docs-corpus scale, and a cache would buy that
  back at the price of an invalidation story.
- **No body-derived data** — the dockg treaty above.
- **No new config keys, no `--db`, no CSV.** Fast-follows, once the shape holds.

### Roadmap beyond the MVP

- **P2 — typed collections.** An optional `name:` on config `overrides[]` turns
  each override group into a table (or view) of its own, typed from its resolved
  schemas — `FROM docs JOIN authors` instead of the `GLOB` self-join.
- **P3 — checks as first-class findings.** A convention over result columns
  (`path`, `line`, `message`) rendered through the existing reporters, so a
  `--check` violation can be a `::error` annotation or a SARIF result;
  `db.function()` can expose `lineFor` to SQL. Then named `checks:` in config,
  run by `validate` alongside the schemas.
- **Fast-follows:** `-f csv`; `--db <path>` to materialize the database for
  `sqlite3`/`duckdb`/Datasette (option D, absorbed).

## Stress test

**1. JS booleans do not bind — the spike caught the loader's first bug before
it existed.** `node:sqlite` (24.11, SQLite 3.50.4) throws `Provided value
cannot be bound` for `true`. So `draft: true` coerces to `1`/`0` at insert, by
rule, and the rule is documented — `WHERE draft = 1`, not `WHERE draft = true`
(SQLite accepts `true` as a literal for `1`, so both spellings work anyway).

**2. Node 24 prints an `ExperimentalWarning` for `node:sqlite` on first use.**
Verified live; on the engines floor, every `docmeta query` would open with a
scare line in stderr. The module is therefore imported dynamically inside the
command with a targeted `process.emitWarning` filter around the import —
narrow, restored immediately, dropping only the SQLite experimental warning.
Static import would be worse than the warning: it would print for `validate`
runs that never touch SQL. Revisit and delete when the module reaches Stable.

**3. User SQL runs under `PRAGMA query_only = 1`.** Verified: writes fail with
`attempt to write a readonly database`. The build phase writes, then flips the
pragma before the user's statement is prepared. Belt and braces: `prepare()`
compiles a single statement, so `SELECT 1; DROP TABLE docs` never reaches the
`DROP` either.

**4. A frontmatter key named `_path` must not shadow the system column.** The
four system names are reserved: such a key is not lifted to a column and stays
reachable as `_data ->> '$._path'`. Other `_`-prefixed keys lift normally — the
reservation is four names, not a namespace grab. Adding a fifth system column
later is therefore a breaking change to acknowledge, which is the cost of
keeping today's rule narrow.

**5. Key names SQL identifiers cannot hold.** Doubling internal quotes makes
any key a legal quoted identifier except the empty string (YAML allows `"": x`),
which stays in `_data` only. Element-derived keys with dots (`prolog.author`,
0020) are ordinary quoted columns — `SELECT "prolog.author"` — with no pointer
semantics to collide with, because SQL never parses identifiers as paths.

**6. Is rebuilding per run too slow to be a database?** Measured, not guessed:
2,020 rows insert in 4.2 ms; the referential-integrity `LEFT JOIN … GLOB` over
them answers in 1.0 ms; the `json_each` census in 1.0 ms. The pipeline's cost
stays where it already was — reading and extracting files — and `validate`
pays that same cost today without anyone calling it slow.

**7. Do `GLOB 'authors/*'` patterns survive Windows?** Yes, by an invariant
docmeta already maintains: `resolveTargetSet` returns posix-style
cwd-relative sorted paths on every platform, so `_path` never contains a
backslash and path predicates are portable verbatim.

**8. `--check` returning zero rows vs. 0014's "empty is not success".** Not in
tension, and worth stating: zero **files** is still the operational error 0014
made it (`assertNonEmpty` runs before any SQL); zero **rows** from a
successfully prepared query over a non-empty corpus is the passing state —
it is the whole point of a check.

**9. What if dockg grows real querying?** Expected, and designed for — the
boundary section is written against that future, and binding consequence 1 (no
body-derived tables, ever) is the concrete rule that keeps the two tools from
growing into each other. If dockg one day queries arbitrary frontmatter keys,
it will have reversed its own ADR 01008; that is the signal to renegotiate,
and this file is the record of what was agreed and why.

**10. Why SQL and not a friendlier DSL (GROQ, JMESPath, a `--where` grammar)?**
Because the ask is joins, and every DSL that starts friendlier than SQL grows
toward it under join pressure (Dataview → Datacore). SQL is the one query
language a Devin already knows, LLMs write reliably, and docmeta does not have
to design, version, or teach. The engine being in Node's standard library
settled the remaining cost argument.

## Not breaking

A new subcommand and nothing else: no existing command changes shape, no flag
moves, no output format changes. Ships as `feat(query):` — a minor release —
with the demo video the house rule requires of features.
