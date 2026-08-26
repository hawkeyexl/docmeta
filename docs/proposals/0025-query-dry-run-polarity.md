# 0025 — query writes by default, `--dry-run` previews

- **Status:** Implemented
- **Serves:** Devin · D4 · Maya · M2
- **Supersedes:** the polarity decision of [0022](0022-sql-write-back.md) § "The shape: preview by default, `--write` to apply". Everything else in 0022 — effect judgment, typed restoration, two-phase all-or-nothing, `--check` as the drift gate — stands unchanged.
- **Relates to:** [0016](0016-flag-ownership.md) (one meaning per flag name across commands), [0024](0024-standard-sql-vocabulary.md) (the vocabulary this surface carries)
- **Touches:** `src/cli.ts`, `src/commands/query.ts`, `src/reporters/query.ts`, `scripts/query-ui.mjs`, `reference/cli.mdx`, the three query journey pages, `test/{query,query-ddl,cli.integration}.test.ts`

## Problem

docmeta shipped two write-capable commands with opposite polarities. `fill`
applies by default and offers `--dry-run`; `query` previewed by default and
offered `--write`. Same concept, two spellings — exactly the per-command
convention drift the parallel-behaviors agreement exists to prevent. A user
who learned "add `--dry-run` to see what would happen" on one command found
that spelling unknown on the other, and the safe-looking bare `query
"UPDATE …"` was the *odd one out*, not the rule.

0022 chose preview-by-default deliberately, arguing `fill`'s values had each
passed a confidence gate while a SQL statement can touch every file
unreviewed. That argument was real, and it lost to a stronger one: **one
convention beats two rationales.** The maintainer's call, 2026-08-26.

## Decision

- `--write` is gone. A mutating statement **applies by default**, matching
  `fill`.
- `--dry-run` previews: the exact per-file diff, nothing touched. Same flag
  name, same meaning, both commands.
- `--check` **implies** `--dry-run`. A check judges and sets the exit code;
  it never mutates. Every `query --check` drift gate in CI is therefore a
  read-only step by construction, before and after this change.
- The programmatic surface mirrors the CLI: `QueryOptions.write` is replaced
  by `QueryOptions.dryRun`, matching `FillOptions.dryRun`.
- No alias softens the rename, per the house rule.

## Release note

Shipped as a `fix:` (patch) at the maintainer's explicit direction,
2026-08-26 — recorded here because the mechanical reading of the change (a
flag removed, a default inverted, days after `--write` shipped in 4.3.0)
would ordinarily spell a major. The judgment: the surface was days old, the
correction is to the convention the project already promised, and `--check`
pipelines — the documented CI integration — behave identically before and
after.

## Stress test

**1. The 4.3.x preview habit inverts.** A user who ran bare `query "UPDATE …"`
to look before leaping now applies on the first run. Named, not hidden: the
reference and every journey page teach `--dry-run` first, and the applied
run's output is the same diff with `✓ … written` in place of the hint — the
information arrives either way, after the fact instead of before. This is
the cost the parity decision paid; 0022's polarity section remains the record
of the argument for the other side.

**2. `--check` had to imply the dry run.** Without the implication,
`query --check "UPDATE …"` — the documented drift-gate recipe — would have
started *writing* under the flipped default, turning every such CI step into
a mutation. The implication keeps "check never mutates" a rule a reader can
hold, and keeps the gate a one-flag spelling.

**3. The reporter's hint had to move, not vanish.** "dry run; pass `--write`
to apply" became "dry run; run again without `--dry-run` to apply" — the
verdict line still names the way out of the mode it reports.
