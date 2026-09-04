# 0021: the corpus is a database: `docmeta query`

- **Status:** Implemented (#120)
- **Serves:** Devin · D1, D3 · Maya · M2
- **Touches:** `src/commands/query.ts`, `src/reporters/query.ts`, `src/cli.ts`, `src/index.ts`, `reference/{cli,api}.mdx`, `test/fixtures/query/`
- **Relates to:** [0005](0005-command-parity.md), the surface it must match.
  [0016](0016-flag-ownership.md), the flag rules it must not break.
  [0010](0010-init-and-schema-inference.md), where `schemas infer` is the only
  existing cross-file scan. [0014](0014-empty-input-is-not-success.md), for what
  an empty input set means here

## Problem

Every check docmeta can express ends at a file boundary. JSON Schema is
single-document by design. A schema can say *this* file's `author` is a
non-empty string, and cannot say the string names an author that exists. The
rules docs teams actually enforce by hand in review are mostly **corpus** rules:

- every `author:` must exist in `authors/`;
- no two pages share a `slug:`;
- every `related:` entry names a real page;
- nothing published has `last_reviewed:` older than a quarter.

None of these is expressible in any schema docmeta could resolve, because each
one is a **join**, and validation sees one document at a time.

The reading side has the same ceiling. `get` walks many files but answers
per-file, as a flat list, with no filter and no aggregation. `schemas infer`
aggregates across the corpus, but deliberately discards the file-to-value table
as it counts. `src/commands/schemas.ts` keeps capped samples, not rows. "Which
pages are drafts, by tag, sorted?" is a question the metadata already answers,
and no command can ask.

## Prior art, and the gap

Querying frontmatter as data is a proven want, not a speculative one:

- [Obsidian Dataview](https://github.com/blacksmithgu/obsidian-dataview), and
  its successor Datacore. A data index and query language over frontmatter, with
  enormous adoption. Editor-bound, with nothing for CI.
- [MarkdownDB](https://markdowndb.com/), a markdown → SQLite index with a JS
  API.
- [mdquery](https://github.com/eristoddle/mdquery), in Python. Markdown →
  SQLite, with SQL joins over files, links and tags tables.
- [frontmatter-mcp](https://github.com/kzmshx/frontmatter-mcp), which serves
  DuckDB SQL over frontmatter through MCP.
- DuckDB's community
  [`markdown`](https://duckdb.org/community_extensions/extensions/markdown) and
  [`yaml`](https://duckdb.org/community_extensions/extensions/yaml) extensions.
  `SELECT title FROM read_yaml_frontmatter('posts/*.md')` works in the `duckdb`
  shell today.

Every one of them is markdown-only, none validates anything, and none is built
to gate a CI run. docmeta already owns the three pieces they lack. Those are
extractors for six formats behind one metadata shape, the input and config
surface 0005 standardized, and an exit-code contract CI trusts. The gap is
exactly docmeta-shaped.

## The boundary with dockg

dockg, a sibling project, derives a deterministic RDF graph from documentation,
covering frontmatter, headings and links, and governs it with SHACL. Its `query`
today is a single triple-pattern match, and its querying **is expected to
grow**. This proposal is written to survive that. The division is by data model,
not by feature gap.

dockg's own ADR 01008, "graph as index, not corpus", commits it to a curated
vocabulary. That is known page keys plus its validated `kg:` block, with
arbitrary frontmatter keys deliberately ignored. A mature dockg query still
could not answer "which pages have `sidebar_position` > 5", because those keys
never enter the graph. So:

- **`docmeta query` is the lossless, syntactic layer**: every top-level key as
  written, across all six formats, zero setup.
- **dockg is the normalized, semantic layer**: concepts, relationships,
  provenance, over markdown/MDX it has built a graph from.

As a rule of thumb, a question that names a *key* is docmeta's. One that names a
*concept or relationship* is dockg's.

Two consequences are binding on this design:

1. **No body-derived data, ever.** MarkdownDB and mdquery grow links and
   sections tables, and `docmeta query` must not. Document structure and
   cross-document relationships are dockg's side of the line. Metadata-only
   extraction is also what docmeta *is*.
2. **The referential-integrity overlap is owned, not hidden.** A team that
   models authors as `kg:` concepts can enforce their existence with SHACL via
   `dockg check`. `docmeta query --check` covers everyone else, meaning
   arbitrary keys, non-markdown formats, and repos with no graph adoption.

dockg already depends on docmeta (`extractFrontmatter`, `runValidate`), so
"docmeta turns files into metadata; dockg turns metadata into meaning" is the
established layering, not a new claim.

## Options

**A. Grow `get` with `--where` and `--sort` flags.** No joins, so the four
Problem rules stay inexpressible. A filter mini-language also grows one flag at
a time until it is a bad query language. Dataview's DQL hitting its ceiling hard
enough to force the Datacore rewrite is the cautionary tale. Rejected.

**B. A sibling project consuming docmeta as a library.** It would re-import
docmeta for extraction and config, as dockg does. It would re-implement the 0005
surface to feel consistent. And it would still lack the standing to gate CI the
way the tool already wired into CI can. That is a second npm package and docs
site for one command's worth of code. A future full dockg query makes the third
tool's territory smaller still. Rejected.

**C. `docmeta query`, running SQL over an in-memory SQLite database built per
run from extracted metadata.** Node ≥ 24 is already the engines floor, so
`node:sqlite` makes the entire engine **zero new dependencies**. `--check` turns
any join into a CI gate. That folds the feature into docmeta's mission, which is
cross-file validation, rather than away from it. **Recommended.**

**D. Export-only**, as `docmeta export --to sqlite`, queried with `sqlite3`,
`duckdb` or Datasette. Composable, but the referential-integrity gate then lives
outside the exit-code contract. The common case, "run this one query in CI",
also grows a two-tool pipeline. With `node:sqlite`, a `--db <path>` flag on
`query` gets all of D's interop nearly free later. Recorded as a fast-follow,
not the primary UX.

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

- SQL and path disambiguation reuses `looksLikePath`. `docmeta query docs/`,
  with the SQL forgotten, is refused with the remedy in the message. `--query`
  is the unambiguous spelling, and `-` is never SQL. Those are the same three
  rules `resolveGetInputs` already enforces for fields.
- `--offline` is accepted and has no effect, exactly as on `get`, and for the
  same reason. No schema is ever resolved, so there is no network dependency to
  suppress. Parity keeps the flag set uniform across commands.
- Exit codes are `0` for ran, which under `--check` means ran and returned no
  rows; `1` only from `--check` with rows; and `2` for operational. That last
  one includes bad SQL, since a query that cannot be prepared is a usage error,
  not a finding.
- There is no `--quiet`. `get` uses it to hide files and `validate` to hide
  passes, and a query result has no analogous noise to hide. Omitting a parity
  flag that would mean nothing follows 0016's corollary: a flag means what its
  command says, and here it would say nothing.

### The table

One table, `docs`. One row per input file (stdin included). Four system
columns, prefixed so they cannot collide with ordinary frontmatter:

| column | value |
|---|---|
| `_path` | the file's path as docmeta already prints it, with posix separators, relative and sorted, and identical on Windows and Linux |
| `_format` | extractor name (`markdown`, `xml`, …) |
| `_present` | `1` if the file has a metadata block or surface, else `0`, so `WHERE _present = 0` lists the files validation would report as missing metadata |
| `_data` | the full extracted metadata as JSON text, for `json_extract`/`->>` reach into anything not lifted to a column |

Data columns are the union of **top-level keys** across the corpus. That is the
same scan boundary `schemas infer` chose, for the same reason: nesting explodes
unboundedly, and the long tail lives in `_data`. Keys become quoted identifiers
verbatim, so `"sidebar position"` is a legal column. Values keep the type the
metadata had. Strings and numbers bind as themselves, booleans as `1` or `0`,
and arrays and objects as JSON text. SQLite's built-in `json_each` and `->>`
then query that directly. Columns are declared without type affinity, so SQLite
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

`pretty` renders an aligned table plus a row count, and under `--check` a ✓/✗
verdict line. `json` is the bare array of row objects, mirroring `get`'s bare
array. The exit code, not the envelope, carries the verdict.

### What the MVP deliberately does not do

- **No schema resolution.** Like `get` and `schemas infer`, the command is
  schemaless and offline, and reads what is there. Schema-informed column types
  are a refinement, not a prerequisite. See the roadmap.
- **No persistence.** The database is rebuilt in memory every run. The measured
  cost (below) is milliseconds at docs-corpus scale, and a cache would buy that
  back at the price of an invalidation story.
- **No body-derived data**, per the dockg treaty above.
- **No new config keys, no `--db`, no CSV.** Fast-follows, once the shape holds.

### Roadmap beyond the MVP

- **P2, typed collections.** An optional `name:` on config `overrides[]` turns
  each override group into a table, or view, of its own, typed from its resolved
  schemas. That gives `FROM docs JOIN authors` instead of the `GLOB` self-join.
- **P3, checks as first-class findings.** A convention over result columns
  (`path`, `line`, `message`) rendered through the existing reporters, so a
  `--check` violation can be a `::error` annotation or a SARIF result.
  `db.function()` can expose `lineFor` to SQL. Then named `checks:` in config,
  run by `validate` alongside the schemas.
- **Fast-follows.** `-f csv`, and `--db <path>` to materialize the database for
  `sqlite3`, `duckdb` or Datasette. That absorbs option D.

## Stress test

**1. JS booleans do not bind, and the spike caught the loader's first bug before
it existed.** `node:sqlite` on 24.11, with SQLite 3.50.4, throws
`Provided value cannot be bound` for `true`. So `draft: true` coerces to `1` or
`0` at insert, by rule, and the rule is documented. Write `WHERE draft = 1`, not
`WHERE draft = true`. SQLite accepts `true` as a literal for `1`, so both
spellings work anyway.

**2. Node 24 prints an `ExperimentalWarning` for `node:sqlite` on first use.**
Verified live. On the engines floor, every `docmeta query` would open with a
scare line in stderr. The module is therefore imported dynamically inside the
command, with a targeted `process.emitWarning` filter around the import. The
filter is narrow, restored immediately, and drops only the SQLite experimental
warning. A static import would be worse than the warning, because it would print
for `validate` runs that never touch SQL. Revisit and delete when the module
reaches Stable.

**3. User SQL runs under `PRAGMA query_only = 1`.** Verified: writes fail with
`attempt to write a readonly database`. The build phase writes, then flips the
pragma before the user's statement is prepared. Belt and braces: `prepare()`
compiles a single statement, so `SELECT 1; DROP TABLE docs` never reaches the
`DROP` either.

**4. A frontmatter key named `_path` must not shadow the system column.** The
four system names are reserved. Such a key is not lifted to a column, and stays
reachable as `_data ->> '$._path'`. Other `_`-prefixed keys lift normally,
because the reservation is four names rather than a namespace grab. Adding a
fifth system column later is therefore a breaking change to acknowledge, which
is the cost of keeping today's rule narrow.

**5. Key names SQL identifiers cannot hold.** Doubling internal quotes makes any
key a legal quoted identifier, except the empty string, which YAML allows as
`"": x`. That one stays in `_data` only. Element-derived keys with dots, such as
`prolog.author` from 0020, are ordinary quoted columns, written
`SELECT "prolog.author"`. They have no pointer semantics to collide with,
because SQL never parses identifiers as paths.

**6. Is rebuilding per run too slow to be a database?** Measured, not guessed.
2,020 rows insert in 4.2 ms, the referential-integrity `LEFT JOIN … GLOB` over
them answers in 1.0 ms, and the `json_each` census in 1.0 ms. The pipeline's
cost stays where it already was, in reading and extracting files. `validate`
pays that same cost today without anyone calling it slow.

**7. Do `GLOB 'authors/*'` patterns survive Windows?** Yes, by an invariant
docmeta already maintains. `resolveTargetSet` returns posix-style, cwd-relative,
sorted paths on every platform. So `_path` never contains a backslash, and path
predicates are portable verbatim.

**8. `--check` returning zero rows, against 0014's "empty is not success".** Not
in tension, and worth stating. Zero **files** is still the operational error
0014 made it, because `assertNonEmpty` runs before any SQL. Zero **rows** from a
successfully prepared query over a non-empty corpus is the passing state. That
is the whole point of a check.

**9. What if dockg grows real querying?** Expected, and designed for. The
boundary section is written against that future. Binding consequence 1, no
body-derived tables ever, is the concrete rule that keeps the two tools from
growing into each other. If dockg one day queries arbitrary frontmatter keys, it
will have reversed its own ADR 01008. That is the signal to renegotiate, and
this file is the record of what was agreed and why.

**10. The unit suite proved the engine, and only the built binary caught the
bundler.** All fifteen core tests passed while every CLI integration test failed
with `Cannot find package 'sqlite'`. tsup strips `node:` prefixes by default,
through `removeNodeProtocol`, an old-Node compat shim. `node:sqlite` is a
prefix-only builtin, so the strip manufactures an import of a package that does
not exist. Raw esbuild output was verbatim-correct, and that was the repro that
located the layer. Fixed in `tsup.config.ts` with `removeNodeProtocol: false`,
since engines ≥ 24 need no strip. It is pinned by the integration suite, which
is the only place it can be seen. The same tests also pin that the
ExperimentalWarning filter actually works through the built binary.

**11. Why SQL and not a friendlier DSL (GROQ, JMESPath, a `--where` grammar)?**
Because the ask is joins, and every DSL that starts friendlier than SQL grows
toward it under join pressure (Dataview → Datacore). SQL is the one query
language a Devin already knows, LLMs write reliably, and docmeta does not have
to design, version, or teach. The engine being in Node's standard library
settled the remaining cost argument.

## Not breaking

A new subcommand and nothing else. No existing command changes shape, no flag
moves, and no output format changes. It ships as `feat(query):`, which is a
minor release, with the demo video the house rule requires of features.
