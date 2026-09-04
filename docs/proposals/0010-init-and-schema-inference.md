# 0010: `docmeta init` and `docmeta schemas infer`

- **Status:** Partly shipped. `schemas infer` landed; `init` rejected by
  [0019](0019-no-docmeta-init.md)
- **Serves:** Maya · M1 (the on-ramp), Sara · S1 (the missing first step)
- **Relates to:** [0001](0001-validation-baseline.md) (infer → baseline → ratchet is the retrofit path), [0014](0014-empty-input-is-not-success.md)
- **Touches:** `src/commands/schemas.ts`, `src/reporters/infer.ts`, `src/cli.ts`

## What shipped

`docmeta schemas infer [paths...] [--out <path>] [--min-coverage <pct>]` lives in
`src/commands/schemas.ts` beside `getSchemasInfo` and `runVendorSchema`, with the
pretty renderer in `src/reporters/infer.ts`. Every stress test below stands, and
each is covered by a test:

- **Stress test 1.** The draft never emits `required`, at any coverage, under
  any input. `test/commands.test.ts` walks the whole draft object rather than
  substring-matching, so a nested `required` cannot slip past. No
  `--require-above` flag was added, and none should be.
- **Stress test 2.** Offline is asserted rather than assumed. The test replaces
  `globalThis.fetch` with one that records and rejects, and asserts nothing was
  attempted. `infer` resolves no schema, so a document naming a remote `$schema`
  still costs no request.
- **Stress test 3.** Dominant type, with the distribution reported as `string
  ×900, number ×4` and each outlier named by file and line via `lineFor`.
- **Stress test 4.** `enum` needs ≤ 20 distinct **and** ≤ 5% of files scanned.
  There are three tests. One proposes at 7 distinct in 140 files. One refuses at
  30 distinct in 30 files, which is the absolute half. One refuses at 7 distinct
  in 10 files, which is the ratio half.
- **Stress test 9.** Mostly paid by [0008](0008-remote-schema-durability.md)'s
  `schemas vendor`, which made `schemas` a real group and taught
  `scripts/check-cli-reference.mjs` to recurse. What `infer` paid is the shared
  input model, since it is the first path-taking command under the group. That
  covers `--ext`, `--exclude`, `--as`, `-c/--config`, `--no-config`,
  `-f/--format`, positional `[paths...]`, `-` for stdin, and the config `paths:`
  fallback.

Two things the proposal did not anticipate:

- **`runGet` was not reusable.** It is a projection: `values` is built by
  looping over `opts.fields`, and the full `extracted.data` is discarded. So the
  core calls `extractorForExtension(...).extract(...)` and reads `data` whole.
- **The `schemas` group swallowed `-f`.** commander binds an option declared on
  a parent wherever it appears in the argv. So `docmeta schemas infer -f json`
  set the *parent's* format, and the run answered in `pretty`, silently, at exit
  0. That is the same false green `schemas -f github` was fixed for. `formatFor`
     in `src/cli.ts` reads `getOptionValueSource` on both commands, and prefers
     whichever was typed. **`schemas vendor` still has the latent version of
     this**, where `-f` on a vendor run is accepted and ignored. It is harmless
     today because `vendor` has no format to choose, but it is worth closing
     when that changes.

Two deliberate limits, chosen rather than discovered:

- **Top-level keys only.** Coverage of `author` is the standard-level question;
  `author.name` is a schema-authoring detail settled while editing the draft.
- **`--min-coverage` defaults to 0.** A default that hid the long tail would hide
  exactly the "3% is one team's convention" signal the report exists to surface.

The `--out` draft also emits `minLength: 1` on a string key where no empty value
was ever observed. That is not in the proposal. It is what makes `--out` produce
the `schemas/permissive.json` that [the retrofit
page](../src/content/docs/set-up/retrofit.mdx) previously asked the reader to
hand-write. It gives format enforcement without demanding any field be filled
in. It is an observation rather than a policy. A docset that really contains
`title: ""` gets a bare `{"type": "string"}`.

## Why `init` was deferred

Not rejected, but deferred, and the case for it got weaker on inspection. What
it saves is typing a four-line `docmeta.config.yaml`.
[Retrofit](../src/content/docs/set-up/retrofit.mdx) and [the config
reference](../src/content/docs/reference/configuration.mdx) already hand the
reader that in full. What it costs is stress tests 5 through 8, all of which are
real:

- refusing to overwrite an existing config;
- warning about an **ancestor** config that
  [0004](0004-config-upward-discovery.md)'s upward walk would let a new one
  silently shadow;
- sequencing detection so it never writes a config that
  [0014](0014-empty-input-is-not-success.md) then makes exit 2;
- choosing among several plausible `paths:` candidates without guessing quietly.

That is four hazards, each with a failure mode measured in confused hours, for a
saving measured in seconds of typing. `schemas infer` was the half of this
proposal with the asymmetry the other way round. Nothing else in docmeta could
answer "what metadata do we actually have?". And the retrofit page had a
dangling forward reference to a coverage probe that did not exist.

If `init` is revisited, stress test 10 still holds. It must not also infer a
schema, or it produces a config plus a schema that ratifies the current state in
one step. That is stress test 1's failure, automated.

## Problem

M1 is the anchor CUJ, and its first concrete step is writing YAML by hand from
`examples/docmeta.config.yaml`. The user must already know which directories
hold docs, which extensions are in play, and which schema to name. All of that
comes before docmeta has told them anything about their own repo.

S1 has the mirror gap. Sara's job is to encode an existing standard as JSON
Schema. docmeta can already read every frontmatter key in her docset, but offers
no way to see them. Her natural first question is *what metadata do we actually
have today?*. It is answerable only by scripting `docmeta get` against a field
list she does not yet know.

`fill` solves the inverse problem (documents missing fields the schema wants). The
missing half is: schema missing the fields the documents have.

## Proposal

### 1. `docmeta init`

```
docmeta init [--force] [--paths <glob>] [--schema <ref>] [--yes]
```

Detects and writes a `docmeta.config.yaml`:

- **paths.** Scan for directories containing files with supported extensions,
  preferring conventional names such as `docs/`, `content/`, `documentation/`,
  and `src/content/`.
- **exclude.** Anything `.gitignore` already ignores is skipped by
  [0006](0006-gitignore-aware-discovery.md), so `exclude:` starts empty rather
  than restating it.
- **schemas.** Default to the built-in default set, and print what that means.
- Writes a **commented** config, closer to `examples/docmeta.config.yaml` than to a
  minimal dump, so the file teaches the options it did not choose.

Then it runs validation once and prints the result. So `init` ends with the user
seeing their actual state, rather than a file they must now figure out how to
use.

### 2. `docmeta schemas infer`

```
docmeta schemas infer [paths...] [--out <path>] [--min-coverage <pct>] [-f pretty|json]
```

Purely **statistical and offline**, with no inference provider, no network, and
no LLM. It reads every target's metadata and reports:

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

### 1. Inference ratifies the mess, the central objection, and it shapes the output

If 61% of files have `type`, what should the schema say? Marking it `required`
breaks 39% of the repo on the next run. Marking it optional encodes "type is
optional" as the house standard, which is the opposite of adopting a standard.
Either way, inferring *from* current state and calling the result a *standard*
is a category error. The tool would be laundering the status quo into policy.

The resolution is that `infer` never emits `required`, and its primary output is
the **coverage report**, not the schema. The schema is a starting file the human
then edits. The coverage column is what makes the decision possible. 99.8% means
"require it now". 61% means "require it behind a
[baseline](0001-validation-baseline.md)". 3% means "this is one team's
convention, not a standard".

This is why the report is the product and the draft schema is the by-product. A
`--require-above <pct>` flag was considered and **rejected**: it makes the
laundering one flag away, and the number would be chosen by whoever wants a green
build.

### 2. Should `infer` use the LLM? (no, and the contrast is the point)

`fill` sends document content to a provider. `infer` reads only metadata keys
that are already structured, and its job is counting. Making it deterministic
and offline means it can run in CI, needs no credentials, has no cost, and
produces byte-identical output for identical input. None of that is true of
`fill`.

Keeping it out of the inference path also keeps
[0012](0012-fill-cost-and-privacy.md)'s story simple. Exactly one subcommand
talks to a model, and it is the one named after what it does.

### 3. Type inference from YAML scalars is lossier than it looks

Extractors already coerce via `parseYamlScalar`, so `version: 2` arrives as a
number and `2026-04-01` may arrive as a string or a Date depending on the flavor.
A key that is `string` in 900 files and `number` in 4 (because someone wrote
`title: 2024`) would infer as `["string","number"]`, which is technically right and
useless as a standard.

The rule is to report the distribution with counts, as `string ×900, number ×4`,
and to emit the **dominant** type in the draft. The outliers are named in the
report so they read as data errors, which is what they are. A union in the draft
would encode the typo as policy, the same failure as stress test 1 one level
down.

### 4. Enum candidates explode on free-text fields

`title` has ~1,204 distinct values, and `type` has 7. Only propose an `enum`
when distinct values are few in absolute terms **and** small relative to file
count. The threshold is ≤ 20 distinct and ≤ 5% of files. Both conditions matter.
A 30-file repo where every `title` is unique would pass a ratio test alone, and
produce a 30-value `enum` for prose.

### 5. `init` overwriting an existing config must refuse by default

Refuse when `docmeta.config.yaml` or `.yml` exists, and require `--force`. With
[0004](0004-config-upward-discovery.md)'s upward walk, `init` must also check
**ancestors** and warn. Writing a new config in a subdirectory of a repo that
already has one silently shadows it, per 0004 § stress test 4. The user who ran
`init` will not know that is what they did.

### 6. `init` writing a config that then errors, where sequencing matters

If detection guesses a `paths:` glob that matches nothing,
[0014](0014-empty-input-is-not-success.md) makes the next run exit 2. That is
correct behavior and a terrible first experience. Hence the "run validation once
and print the result" step: `init` must not report success on a config it has not
demonstrated works. If the detected glob matches zero files, `init` should say so
and not write the file.

### 7. Interactive prompts must not be the only path

An interactive `init` is friendlier and unusable in CI, containers, and agent
workflows. Requirements: `--yes` for full non-interactive operation, prompts only
when `process.stdin.isTTY`, and every prompt answerable by a flag. This mirrors the
existing colour discipline (`shouldColor` already keys on `isTTY`), so the codebase
has the precedent.

### 8. Which `paths:` to pick when several candidates exist, without guessing silently

A repo with `docs/`, `examples/`, and `website/content/` has three plausible
answers. Guessing one and writing it produces a config that quietly validates a
third of the repo. Print all candidates with file counts, and either prompt or
(with `--yes`) write **all** of them and say so. Over-inclusion is visible and
fixable; under-inclusion is the silent-gap failure this proposal set keeps finding.

### 9. Does `infer` belong under `schemas`? (yes, and it constrains the surface)

`schemas` is currently a zero-argument lister with only `-f`. Adding
`schemas infer [paths...]` makes it a command group, which means `schemas` needs
the shared input model (`--ext`, `--exclude`, `--as`, `-c`) that
`CONTRIBUTING.md § Keeping commands consistent` requires of anything taking paths.
That is more surface than it first appears, and `docs:check-cli` will require every
bit of it to be documented. Worth it for the naming (`infer` is about schemas), but
it should be scoped as a subcommand from the start rather than retrofitted.

Note this also collides with [0008](0008-remote-schema-durability.md)'s proposed
`schemas vendor`. Both want `schemas` to become a group; they should land in a
consistent order, and whichever is first pays the restructuring cost.

### 10. `init` and `infer` are two commands, not one, and deliberately so

A combined `init` that also infers a schema would produce, in one step, a config
plus a schema that ratifies the current state. That is stress test 1's failure,
automated. Keeping them separate means `init` gets you validating against a
*published standard*, and `infer` is the tool you reach for when you have
decided to write your own. The M1 retrofit path is then explicit and honest:
`init` → `infer` (look) → edit the schema → `--write-baseline` → ratchet.

## Implementation sketch

Steps 1–3 covered `init` and are deferred with it. What shipped for
`schemas infer`, and where it lives:

1. In `test/commands.test.ts`, coverage percentages against
   `test/fixtures/infer/`, with the core called directly and an explicit `cwd:`.
2. In `test/commands.test.ts`, dominant-type selection over a generated 900/4
   split, with outliers named by file and line. The draft emits no `required`
   under any input, asserted by walking the object.
3. In `test/commands.test.ts`, an enum proposed at 7 distinct in 140 files,
   refused at 30 distinct in 30 files, and refused at 7 distinct in 10 files.
4. In `test/commands.test.ts`, `--out` refuses to overwrite and refuses a
   gitignored target. In both cases **nothing is written**, and the gitignore
   case uses `makeTempRepo`.
5. In `test/commands.test.ts`, a `fetch` that records and rejects proves the run
   never touches the network.
6. In `test/cli.integration.test.ts`, the report end to end, `-f json` written
   *after* the subcommand, `--out` twice, plus the unknown-option and `--help`
   tables.
7. 7. For fixtures, `test/fixtures/infer/`, with eight files covering full,
   partial and rare keys. Also one type outlier on a key the default schemas do
   not constrain, and one file with no frontmatter at all.
8. For docs, `reference/cli.mdx` gained a `schemas infer` section.
   `set-up/retrofit.mdx` gained the coverage probe its own caution had already
   promised, which is the dangling forward reference this work existed to close.
