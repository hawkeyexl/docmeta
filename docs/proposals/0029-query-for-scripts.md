# 0029: query for scripts: CSV out, bound parameters in

- **Status:** Implemented (#133)
- **Serves:** Devin · D3, D4
- **Depends on:** [0021](0021-frontmatter-as-a-database.md) (whose roadmap records
  `-f csv` as a fast-follow; the `--db` half of that line already shipped)
- **Relates to:** [0005](0005-command-parity.md) and
  [0016](0016-flag-ownership.md), where format lists are per-command surface,
  and `fill` set the precedent with its own list. Also
  [0026](0026-corpus-checks-are-findings.md), which grows the same
  `QUERY_FORMATS` list with the `--check`-gated findings formats; the combined
  surface is specified below. Also [0025](0025-query-dry-run-polarity.md), where
  nothing here changes the write polarity
- **Touches (planned):** `src/commands/query.ts`, `src/reporters/query.ts`, `src/cli.ts`,
  `src/index.ts`, `reference/cli.mdx`, `test/{query,cli.integration}.test.ts`

## Problem

Two gaps for the person driving `query` from a script rather than a terminal.

**The spreadsheet hop is manual.** "Which pages are stale, by team" ends in a
spreadsheet, and query speaks only `pretty` (for eyes) and `json` (for
programs). The `--db` export covers the heavyweight case, which is opening the
whole corpus in a SQLite UI. But the common one is a single result table into
Sheets or a pandas one-liner, and today that is a `jq` incantation away.

**Values reach the SQL by string-splicing.** Any script that feeds a runtime value into
a query builds the statement by concatenation:

```sh
docmeta query "SELECT _path FROM docs WHERE author = '$AUTHOR'" docs/
```

One apostrophe in the value breaks the statement. This is the injection-shaped
pattern SQL solved decades ago, with bound parameters. The engine underneath,
`node:sqlite`, already supports them. Verified: named parameters bind from a
plain object, with or without the `$` prefix on keys.

```sh
# this proposal
docmeta query -f csv "SELECT _path, title, last_reviewed FROM docs" docs/ > stale.csv
docmeta query --param author="O'Brien" \
  "SELECT _path FROM docs WHERE author = \$author" docs/
```

## Design

### `-f csv`, result rows only

`query` gets its own format list as a new `QUERY_FORMATS` const, following
`FILL_FORMATS`' precedent that a format list belongs to the command whose output it
describes. This proposal contributes `csv`; sibling proposal
[0026](0026-corpus-checks-are-findings.md) contributes the findings formats
(`github | sarif | junit`, legal only under `--check` with a `path` column). The full surface once both land is **one six-value list with per-value gates,
stated once**. `pretty | json | csv` are unconditional, and the findings three
are `--check`-gated. Whichever proposal is implemented second merges into that
one const and its error text, rather than forking a branch in the CLI dispatch.
`-f csv --check` is legal: a check's rows are still rows, the exit code carries
the verdict, and the zero-row header-only output *is* the passing gate.
`COMMON_FORMATS` stays two, and `get` and `schemas` are untouched. Query comes
first because its result is the one that is already a table. `get` growing csv
is a natural follow-up when someone wants it, not a tagalong here.

The dialect, chosen once and documented:

- a header row always, so a zero-row result is the header alone, which is the
  answer a script can distinguish from an error;
- LF line endings. That is a deliberate divergence from RFC 4180, which
  specifies CRLF. LF is the right default for scripts and CI. The divergence is
  named in the reference. A consumer that insists on CRLF, such as Excel
  double-clicking a `.csv` on Windows, then knows to re-terminate. RFC 4180
  quoting still applies: a field is quoted when it contains a comma, quote or
  newline, and quotes double;
- SQL `NULL` → empty field;
- arrays and objects stay the JSON text the projection already holds, which is
  the same encoding `json` output and the `--db` export use.

`-f csv` describes **result rows**. A run that produced *changes*, meaning a
mutating statement's preview or application, refuses with exit 2 naming `pretty`
and `json`. Changes are heterogeneous per-file diffs, eight kinds since 0024,
and not a table. The refusal lives in the CLI's format dispatch, where the
format is known and the existing error path already means exit 2. The reporter
stays presentation-only, per its own module contract. The `--db`-export-only run
(no SQL) prints its summary as today under `pretty` and `json`, and refuses
`csv` the same way, because there are no rows to shape.

### Named parameters, string-by-default

- **CLI:** Repeatable `--param name=value` binds `value` as a **string**;
  `--param name:=value` parses `value` as JSON for typed binds (numbers,
  booleans, arrays, null), which is the httpie and jq convention. Split on the
  first `=` or `:=`; everything after is the value, so values containing `=`
  need no escaping.
- **API:** `QueryOptions.params?: Record<string, unknown>`. Values pass through
  the same `bindValue` the projection loader uses. So booleans become `1` or
  `0`, and arrays and objects become JSON text. A bound parameter then compares
  against a stored cell under exactly the encoding the cell got.
- **SQL.** Standard named parameters, spelled `$name`, `:name` or `@name`,
  usable anywhere a value goes: SELECTs, `--check` gates, UPDATEs. The engine
  change is one call site, where `stmt.all()` grows the bound object. That is
  why parameters work uniformly across read, gate and write, with no per-path
  code.
- Anonymous `?` placeholders stay CLI-unsupported: the order CLI flags appear in is not
  a contract anyone should be encouraged to rely on.

### The false-green guard

Verified on `node:sqlite` (Node 24.11.0), the two failure directions are asymmetric:

- an **extra** parameter throws, with `Unknown named parameter 'x'`, so the typo
  guard exists in the engine;
- a parameter the SQL **references with nothing bound is silently NULL**.
  `WHERE status = $status` with the `--param` forgotten matches nothing, and
  returns zero rows. And a zero-row `--check` is a **passing CI gate**.

docmeta closes the second direction itself. The statement is scanned for
parameter tokens outside string literals, using the quote-aware scanner that
already exists for single-statement enforcement. A referenced-but-unbound
parameter then refuses with exit 2, naming it.

## Options

**A. CSV renders changes too.** Rejected. Eight change kinds share no column
set, so the CSV would be a union of mostly-empty columns. That is a shape nobody
can load without reading docmeta's source. `json` already carries changes
structurally.

**B. JSON-first parameter parsing (`--param n=5` binds the number 5).** Rejected
by a probe-informed footgun. The projection's columns deliberately have no type
affinity, so a bound number `2026` never equals a stored string `"2026"`.
`--param title=2026` would then silently match nothing. And quoting your way
back to a string, as `--param 'title="2026"'`, is shell-quoting hell on two
platforms. Strings are the default because metadata is mostly strings; `:=`
makes numbers deliberate.

**C. Add csv to `COMMON_FORMATS` (so `get` and `schemas` grow it too).**
Rejected for this proposal. `schemas`' output is not a table. `get`'s is, but
nobody has asked. And 0016's rule is that a flag value means what its command
says, which per-command lists keep true. Recorded so `get -f csv` is a follow-up
with a home, not a parity debt.

**D. A `--tsv` twin.** Rejected: two dialects to document and drift; every consumer that
wanted TSV accepts CSV.

## Stress test

**1. The unbound-parameter probe is the reason the guard exists.** Live probe:
`db.prepare("SELECT _path FROM docs WHERE draft = $d").all({})` does not throw.
`$d` binds NULL and the result is empty. In a `--check` gate that is a green
light from a typo. The same probe confirms the opposite direction throws
(`Unknown named parameter`), so docmeta adds only the missing half.

**2. `--param title=2026` binds the string.** Pinned by test: with a corpus whose
`title: "2026"` is a YAML string, the string-default rule matches it and `:=` binds the
number that does not. The footgun from Options B, nailed down as behavior.

**3. Splitting on the first separator, `:=` checked before `=`.**
`--param msg=a=b` binds `a=b`. The typed-string spelling needs its shell quoting
stated exactly, because review caught the trap. Written bare, `--param v:="5"`
has its double quotes eaten by the shell. The program then receives `v:=5` and
binds the **number**, which is the precise inversion this mechanism exists to
prevent. The reference therefore teaches `--param 'v:="5"'`, with outer single
quotes protecting the JSON string literal. That binds the string `5`, which is
how you spell "a string that looks like a number, typed deliberately". The
pinning test asserts both spellings: quoted binds the string, and unquoted binds
the number.

**4. A zero-row CSV is the header alone.** Distinguishable from empty output (an
operational failure printed nothing to stdout) and cheap for a script to test. Pinned in
the integration suite against the built binary.

**5. CSV quoting round-trips through a real consumer.** The unit test writes a
corpus whose titles contain commas, quotes and a newline. It then asserts the
emitted bytes parse back to the same cells under an RFC 4180 reader. That proves
the escaping rather than string-matching it.

**6. The reference and the format-list string move in the same PR.** The CLI
reference is machine-compared against the real commander surface, by
`npm run docs:check-cli`. And the shared helper that renders "pretty or json"
renders longer lists with commas. Both are named here so the implementation PR
treats them as expected fallout, not surprises.

## Not breaking

This is additive. It is a new format value and a new repeatable flag, and every
existing invocation behaves byte-identically. Ships as `feat(query):`, a minor
release, demo video per the house rule.
