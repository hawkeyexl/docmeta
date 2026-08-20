# 0010 — `docmeta init` and `docmeta schemas infer`

- **Status:** Proposed
- **Serves:** Maya · M1 (the on-ramp), Sara · S1 (the missing first step)
- **Relates to:** [0001](0001-validation-baseline.md) (infer → baseline → ratchet is the retrofit path), [0014](0014-empty-input-is-not-success.md)
- **Touches:** new `src/commands/init.ts`, new `src/commands/infer.ts`, `src/cli.ts`

## Problem

M1 is the anchor CUJ, and its first concrete step is writing YAML by hand from
`examples/docmeta.config.yaml`. The user must already know which directories hold
docs, which extensions are in play, and which schema to name — before docmeta has
told them anything about their own repo.

S1 has the mirror gap. Sara's job is to encode an existing standard as JSON Schema,
and docmeta can already read every frontmatter key in her docset, but offers no way
to see them. The natural first question — *what metadata do we actually have
today?* — is answerable only by scripting `docmeta get` against a field list she
does not yet know.

`fill` solves the inverse problem (documents missing fields the schema wants). The
missing half is: schema missing the fields the documents have.

## Proposal

### 1. `docmeta init`

```
docmeta init [--force] [--paths <glob>] [--schema <ref>] [--yes]
```

Detects and writes a `docmeta.config.yaml`:

- **paths** — scan for directories containing files with supported extensions,
  preferring conventional names (`docs/`, `content/`, `documentation/`, `src/content/`).
- **exclude** — anything `.gitignore` already ignores is skipped by
  [0006](0006-gitignore-aware-discovery.md), so `exclude:` starts empty rather than
  restating it.
- **schemas** — default to the built-in default set, and print what that means.
- Writes a **commented** config, closer to `examples/docmeta.config.yaml` than to a
  minimal dump, so the file teaches the options it did not choose.

Then it runs validation once and prints the result, so `init` ends with the user
seeing their actual state rather than a file they must now figure out how to use.

### 2. `docmeta schemas infer`

```
docmeta schemas infer [paths...] [--out <path>] [--min-coverage <pct>] [-f pretty|json]
```

Purely **statistical and offline** — no inference provider, no network, no LLM.
Reads every target's metadata and reports:

```
1,204 files scanned

key            coverage   types            sample
title            99.8%    string           "Getting started"
description      87.1%    string           "How to install…"
type             61.4%    string (7 enum)  guide | reference | how-to | …
owner            12.0%    string           "docs-team"
lastReviewed      3.2%    string (date)    "2026-04-01"

Wrote schema draft to ./docmeta.schema.json (0 required — see below)
```

And emits a schema draft where **nothing is `required`**, with observed types and,
where a key has few distinct values, a commented candidate `enum`.

## Stress test

### 1. Inference ratifies the mess — the central objection, and it shapes the output

If 61% of files have `type`, what should the schema say? Marking it `required`
breaks 39% of the repo on the next run. Marking it optional encodes "type is
optional" as the house standard, which is the opposite of adopting a standard.
Either way, inferring *from* current state and calling the result a *standard* is a
category error — the tool would be laundering the status quo into policy.

Resolution: `infer` never emits `required`, and its primary output is the
**coverage report**, not the schema. The schema is a starting file the human then
edits. The coverage column is what makes the decision possible: 99.8% means
"require it now", 61% means "require it behind a
[baseline](0001-validation-baseline.md)", 3% means "this is one team's convention,
not a standard".

This is why the report is the product and the draft schema is the by-product. A
`--require-above <pct>` flag was considered and **rejected**: it makes the
laundering one flag away, and the number would be chosen by whoever wants a green
build.

### 2. Should `infer` use the LLM? — no, and the contrast is the point

`fill` sends document content to a provider. `infer` reads only metadata keys that
are already structured, and its job is counting. Making it deterministic and
offline means it can run in CI, needs no credentials, has no cost, and produces
byte-identical output for identical input — none of which is true of `fill`.

Keeping it out of the inference path also keeps [0012](0012-fill-cost-and-privacy.md)'s
story simple: exactly one subcommand talks to a model, and it is the one named after
what it does.

### 3. Type inference from YAML scalars is lossier than it looks

Extractors already coerce via `parseYamlScalar`, so `version: 2` arrives as a
number and `2026-04-01` may arrive as a string or a Date depending on the flavor.
A key that is `string` in 900 files and `number` in 4 (because someone wrote
`title: 2024`) would infer as `["string","number"]`, which is technically right and
useless as a standard.

Rule: report the distribution with counts (`string ×900, number ×4`) and emit the
**dominant** type in the draft, with the outliers named in the report so they read
as data errors — which is what they are. A union in the draft would encode the typo
as policy, the same failure as stress test 1 one level down.

### 4. Enum candidates explode on free-text fields

`title` has ~1,204 distinct values; `type` has 7. Only propose an `enum` when
distinct values are few in absolute terms **and** small relative to file count.
Threshold: ≤ 20 distinct and ≤ 5% of files. Both conditions matter — a 30-file
repo where every `title` is unique would pass a ratio test alone and produce a
30-value `enum` for prose.

### 5. `init` overwriting an existing config — must refuse by default

Refuse when `docmeta.config.yaml` or `.yml` exists; require `--force`. And with
[0004](0004-config-upward-discovery.md)'s upward walk, `init` must also check
**ancestors** and warn: writing a new config in a subdirectory of a repo that
already has one silently shadows it (0004 § stress test 4), and the user who ran
`init` will not know that is what they did.

### 6. `init` writing a config that then errors — sequencing matters

If detection guesses a `paths:` glob that matches nothing,
[0014](0014-empty-input-is-not-success.md) makes the next run exit 2. That is
correct behavior and a terrible first experience. Hence the "run validation once
and print the result" step: `init` must not report success on a config it has not
demonstrated works. If the detected glob matches zero files, `init` should say so
and not write the file.

### 7. Interactive prompts — must not be the only path

An interactive `init` is friendlier and unusable in CI, containers, and agent
workflows. Requirements: `--yes` for full non-interactive operation, prompts only
when `process.stdin.isTTY`, and every prompt answerable by a flag. This mirrors the
existing colour discipline (`shouldColor` already keys on `isTTY`), so the codebase
has the precedent.

### 8. Which `paths:` to pick when several candidates exist — do not guess silently

A repo with `docs/`, `examples/`, and `website/content/` has three plausible
answers. Guessing one and writing it produces a config that quietly validates a
third of the repo. Print all candidates with file counts, and either prompt or
(with `--yes`) write **all** of them and say so. Over-inclusion is visible and
fixable; under-inclusion is the silent-gap failure this proposal set keeps finding.

### 9. Does `infer` belong under `schemas`? — yes, and it constrains the surface

`schemas` is currently a zero-argument lister with only `-f`. Adding
`schemas infer [paths...]` makes it a command group, which means `schemas` needs
the shared input model (`--ext`, `--exclude`, `--as`, `-c`) that
`CONTRIBUTING.md § Keeping commands consistent` requires of anything taking paths.
That is more surface than it first appears, and `docs:check-cli` will require every
bit of it to be documented. Worth it for the naming (`infer` is about schemas), but
it should be scoped as a subcommand from the start rather than retrofitted.

Note this also collides with [0008](0008-remote-schema-durability.md)'s proposed
`schemas pull`. Both want `schemas` to become a group; they should land in a
consistent order, and whichever is first pays the restructuring cost.

### 10. `init` and `infer` are two commands, not one — deliberately

A combined `init` that also infers a schema would produce, in one step, a config
plus a schema that ratifies the current state — stress test 1's failure, automated.
Keeping them separate means `init` gets you validating against a *published
standard*, and `infer` is the tool you reach for when you have decided to write
your own. The M1 retrofit path is then explicit and honest:
`init` → `infer` (look) → edit the schema → `--write-baseline` → ratchet.

## Implementation sketch

1. `test/init.test.ts` — detection picks conventional dirs; multiple candidates all
   reported; zero candidates writes nothing and errors.
2. `test/init.test.ts` — refuses an existing config; `--force` overwrites; warns on
   an ancestor config.
3. `test/init.test.ts` — `--yes` needs no TTY; output is deterministic.
4. `test/infer.test.ts` — coverage percentages against a fixture docset with known
   key distribution.
5. `test/infer.test.ts` — dominant-type selection with a 900/4 split; outliers
   named in the report; draft emits no `required` under any input.
6. `test/infer.test.ts` — enum proposed at 7 distinct values, not proposed at 30
   distinct in a 30-file set.
7. Fixtures: `test/fixtures/infer/` with ~8 files covering full, partial, and rare
   keys plus one type outlier.
8. Docs: a new `get-started` or `set-up` page for the retrofit path, plus
   `reference/cli.mdx` for both commands (`docs:check-cli` enforces the full
   flag surface, including the `schemas` group restructure).
