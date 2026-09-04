# 0026: corpus checks are findings

- **Status:** Implemented (#132)
- **Serves:** Devin · D4 · Maya · M2
- **Depends on:** [0021](0021-frontmatter-as-a-database.md) (the engine and the `--check`
  gate; this is its roadmap item P3), [0001](0001-validation-baseline.md) (the baseline
  these findings ride)
- **Relates to:** [0003](0003-sarif-and-junit-reporters.md) (the reporters these
  findings reach), [0014](0014-empty-input-is-not-success.md) (zero rows vs zero
  files), [0016](0016-flag-ownership.md) (`--no-checks` ownership),
  [0025](0025-query-dry-run-polarity.md) (`--check` never mutates, unchanged
  here)
- **Touches (planned):** `src/core/config.ts`, `src/core/checks.ts` (new),
  `src/commands/validate.ts`, `src/commands/query.ts`, `src/cli.ts`,
  `src/reporters/{index,junit,rule-id}.ts`, `reference/{cli,configuration}.mdx`,
  `ci/query-gates.mdx`, `test/*`

## Problem

0021 gave corpus rules an engine and an exit code, and stopped there. A cross-file rule
today is a raw SQL string pasted into a workflow file:

```yaml
- run: |
    npx docmeta query --check \
      "SELECT slug, count(*) n FROM docs GROUP BY slug HAVING n > 1" docs/
```

Four things are wrong with where that leaves Devin and Maya:

- **A violation is a row, not a finding.** The output is a result table. It
  names no line, renders as no `::error` annotation on the PR, and reaches no
  SARIF or JUnit consumer. Every channel `validate` findings already have
  (0003), corpus violations lack.
- **The rule lives in the wrong file.** Every other rule this repo enforces is
  named in `docmeta.config.yaml`. The corpus rules hide in `.github/workflows/`,
  YAML-escaped, and invisible to anyone reading the config to learn what the
  standard is.
- **`validate` is blind to them.** M2's journey is "one command, one green light";
  today it takes `validate` plus N `query --check` steps to know a corpus is clean.
- **No adoption path.** The baseline (0001) lets a team turn on a stricter schema without
  fixing 400 legacy files first. A new corpus rule gets no such ramp: it is red until the
  whole backlog is fixed, which in practice means it never turns on.

0021's roadmap named this P3 and sketched the shape. That is a convention over
result columns, `lineFor` exposed to SQL, then named `checks:` in config, run by
`validate` alongside the schemas. This proposal is that design, stress-tested.

## Design

### The config key

```yaml
# docmeta.config.yaml
checks:
  - name: unique-slugs
    query: >-
      SELECT _path AS path, 'slug' AS key, slug AS message
      FROM docs WHERE slug IN
        (SELECT slug FROM docs GROUP BY slug HAVING count(*) > 1)
```

A top-level `checks:` list of `{ name, query }` mappings, parsed in
`parseConfig` beside the other keys. It has the same shape discipline
`overrides:` has. That is an array guard, a per-entry mapping guard, and unknown
keys rejected before field checks. An entry with a missing `name` or `query` is
refused by index.

`name` is constrained at parse time to `[a-z0-9][a-z0-9._-]*`, not ending
`.json`. That is not taste. It is the builtin-id segment grammar (`BUILTIN_ID`,
`src/core/schema-registry.ts:207`), and stress test 1 is why it must hold.

### Rows are findings, by the column convention

A check's SELECT says where each violation lives by naming its columns:

| column | | meaning |
|---|---|---|
| `path` | required | the file the finding attaches to, which must be a file the run loaded |
| `line` | optional | 1-based source line; `lineFor(path, key)` computes it (below) |
| `key` | optional | the metadata field at fault; becomes the finding's `instancePath` and part of its baseline identity |
| `message` | optional | the prose; synthesized as `col=value` pairs from any remaining columns when absent |

Every container in the findings pipeline is per-file, as `ValidationResult`. So
an aggregate rule reports by emitting one row per offending file. The
`unique-slugs` check above is the worked example. The aggregate lives in the
subquery, and the outer SELECT fans it back out to files.

A new module (`src/core/checks.ts`) maps each row to a `FieldError`: `schema` =
`check:<name>`, `keyword` = `"check"`, `instancePath` = `/<key>` when given,
`line` and `message` from the row. On the `validate` path that one mapping buys
every downstream surface with **no reporter changes**. Pretty prints `(line N)`,
and `github` emits `file=` and `line=` params. SARIF takes `line` into
`region.startLine`, and JUnit and JSON serialize what is there. (The `query`
path is not free. It needs the three additions stress test 6 names.) The rule id
renders as `check:<name>/check` through the existing `ruleIdFor`. The trailing
`/check` is not a typo. It is `ruleIdFor`'s standard `schema/keyword`
composition, and the keyword is `"check"` because no Ajv keyword produced the
finding.

### `lineFor(path, key)`

It is registered as a SQL function on the run's database, through the same
`db.function` mechanism that already registers `explicit_null()`. It adds
`deterministic: true`, which `explicit_null()` itself does not set. The option
is probe-verified to work, and the precedent is the mechanism rather than the
flags. The machinery exists end to end. Every extractor already must map a
metadata key to its source line, through `ExtractedMetadata.lineFor`, resolved
by `positionForFactory`, where a bare key becomes `/key` with a nearest-ancestor
fallback. And the command already holds every file's extraction in its `entries`
array. The function is a map lookup, with `NULL` for an unknown path or a key
the extractor cannot place.

### Where they run

`validate` runs the checks **after its per-file loop and before
`settleBaseline`**. The findings merge into the per-file results, so:

- `summary.failed` counts them and drives exit 1 with no exit-code changes;
- the baseline sees them **automatically**. That is the adoption story this
  proposal exists for. Turn a check on, `--write-baseline` the existing debt,
  then ratchet down. the same ramp schemas get.

`validate` will keep the per-file extractions for the run, as `query` already
does, instead of dropping each after validation. 0021 measured that holding a
docs corpus in memory is not the cost that matters.

`query --check` keeps working exactly as shipped, and gains the findings
formats. `-f
github|sarif|junit` become legal on `query`, accepted **only with `--check`**,
and only when the result carries the `path` column. Otherwise it exits 2, naming
the convention. (0029 grows the same per-command format list with `csv`. The
combined six-value surface and its gates are recorded there, and whichever
proposal is implemented second merges into the one list.) Three mechanical
additions make that honest rather than free, per stress test 6. `QueryRun` grows
the optional path-normalization `frame` that SARIF and JUnit need. The CLI
synthesizes the `RunSummary` that `render()` takes. And the JUnit reporter's
hardcoded `classname="docmeta.validate"` becomes a parameter.

### Scoped runs skip checks

A corpus rule computed over half a corpus reports wrong answers. "Dangling
author" because `authors/` was not loaded. Named checks therefore run only when
the resolved file set **is** the config-resolved corpus. That is the rule, and
it is an invariant rather than a flag list. Any CLI reshaping of the input set
disqualifies the run. Today that means positional paths, stdin, `--ext`,
`--exclude` and `--no-gitignore`. Excludes narrow the walk and `--no-gitignore`
widens it, per stress test 3. A future file-set flag disqualifies by failing the
invariant, not by being remembered onto a list. A scoped run prints one stderr
notice, `corpus checks skipped: run is scoped`, and `--no-checks` opts out
explicitly, mirroring `--no-baseline`.

## Options

**A. Status quo, where gates stay in workflow files.** Rejected, because the
four problems above are the shape of the debt, and every one of them is a thing
`validate` findings already have.

**B. A new `docmeta check` command.** Rejected: validation is `validate`'s job, and M2's
whole point is one command with one exit code. A third gate command fragments the surface
0005 unified, and everything it would do is a subset of D.

**C. Findings formats on `query --check` only, no config key.** Rejected as the
whole answer. The rules would stay in workflow YAML and `validate` would stay
blind. That forfeits the baseline ramp, which is the piece that makes a new rule
adoptable at all. Kept as a *component* of D: the row→finding mapping is one
module either entry point calls.

**D. Named `checks:` in config, run by `validate`; `query --check` reuses the mapping.**
Recommended.

## Stress test

**1. A check's name is baseline identity, so its grammar is enforced, not hoped
for.** The finding's `schema` field carries `check:<name>`, and the baseline
canonicalizes that field through `classifyRef` before fingerprinting.
`check:unique-slugs` matches `BUILTIN_ID`, which is `seg(:seg)+` over
`[a-z0-9._-]`, with no separators and not ending `.json`
(`src/core/schema-registry.ts:207-220`), and passes through untouched. But
`check:my rules`, `check:a/b`, or `check:slugs.json` classify as **file paths**,
and get resolved cwd-relative. That is a fingerprint that changes with the
directory you run from, which is the exact bug `canonicalSchemaRef` exists to
prevent. Hence the parse-time name grammar, and an implementation test pinning
`classifyRef("check:" + name).kind === "builtin"` for every accepted name. The
namespace is reserved from the other side too. The built-in registry refuses to
ever publish a real builtin id whose first segment is `check`, and a test holds
that. Otherwise a future schema id could collide with check identity inside
baseline fingerprints, while both are legal.

**2. The baseline is a set, not a counter, and `key` is what keeps a ratchet
ratcheting.** `buildBaseline` dedupes fingerprints through a `Set` and
`applyBaseline` forgives every occurrence of a recorded print. Two findings in
one file that differ only in `message` share a fingerprint, because message is
deliberately excluded. They collapse to one entry, and any number of *future*
duplicates stay forgiven. A check that can fire more than once per file must
make the occurrences distinct through the `key` column (it feeds `instancePath`,
which is fingerprinted). The reference documents this beside the column table.
The synthesized-message fallback exists so a lazy check is still usable, not so
it is a good idea.

**3. "Unscoped" must mean more than "no positional paths."** First design said
checks run when inputs came from config `paths:`. Review caught the hole:
`validate --exclude 'drafts/**'` still takes the config-paths branch while
narrowing the walk. And a duplicate-slug check over a filtered corpus answers
wrongly. A second review pass caught the same hole in the other direction.
`--no-gitignore` *widens* the walk past the corpus, so a check could fire on a
gitignored draft and enter the baseline. The rule shipped is therefore the
invariant itself: the resolved file set equals the config-resolved corpus.
Today's disqualifiers are positional paths, stdin, `--ext`, `--exclude` and
`--no-gitignore`. Config-level `exclude:` and `respectGitignore:` do not
disqualify, they *define* the corpus; the CLI flags redefine the run.

**4. A row whose `path` is outside the run is exit 2, not a synthetic finding.**
Fabricating a `ValidationResult` for a file the run never validated would
corrupt the summary, with "N files" counting files never read. It would also
have to invent the result's required `format`. A check pointing outside the
corpus is a broken check. That is the same class as a check whose SQL does not
prepare, which is also exit 2 with the check named, not a finding.

**5. Line numbers cost nothing new.** Verified before designing: `FieldError` already
carries `line`/`col`, every extractor is contractually required to supply
`lineFor(pointer)`, and all five reporters already render a line when present. The only
new code is the SQL function shim. `db.function` with `deterministic: true` verified live
on `node:sqlite` (Node 24.11.0).

**6. `query -f sarif` is three named additions, not zero.** SARIF and JUnit need
the fingerprint frame (`{cwd, base, runBase}`) that `validate` builds and
`QueryRun` today does not carry. It is constructible from query's existing
`RunContext` (`cwd`, `base`, `configDir`). `render()` needs a `RunSummary`,
synthesized in the CLI. And JUnit's `classname` is hardcoded `docmeta.validate`;
query findings must not ship under validate's name. All three are additive.

**7. stdin never meets a check's baseline, by construction on both entry
points.** On `validate`, a stdin input disqualifies the run from named checks
entirely (the scoping rule above), so a baselined `<stdin>` check finding cannot
arise there. On `query --check`, `<stdin>` is a loaded row and a legal `path`
for a finding. And no baseline exists on that path, so such findings always
fire. Recorded so nobody writes the unreachable test (a stdin check finding
surviving `validate`'s baseline) or "fixes" the scoping rule to make it
reachable.

**8. Checks resolve no schemas, so `--offline` keeps meaning nothing here.** The
`check:<name>` ref is only ever string-compared, never loaded. `classifyRef`
uses it for identity, and `ruleIdFor` for display. No network dependency is
introduced into `validate`'s check phase or `query`.

## Not breaking

This is additive. It is a new config key, a new flag, and new formats on
`query`, with no change to any shipped behavior. So `feat:`, a minor release,
with the demo video the house rule requires. One caveat is stated rather than
hidden. docmeta rejects unknown config keys. So a shared `docmeta.config.yaml`
that adopts `checks:` requires every consumer of that config to run a docmeta at
or above this feature. That is true of every new config key; it bites here
because CI is exactly where old pinned versions live.
