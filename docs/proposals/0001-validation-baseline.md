# 0001 — Validation baseline (the ratchet)

- **Status:** Implemented
- **Serves:** Maya · M2 "Tighten the standard without breaking the build"
- **Depends on:** The `FieldError` extension below (shared with [0003](0003-sarif-and-junit-reporters.md)); path resolution from [0004](0004-config-upward-discovery.md)
- **Touches:** `src/core/validator.ts`, `src/commands/validate.ts`, `src/cli.ts`, `src/core/config.ts`, new `src/core/baseline.ts`

## Problem

M2 is a named CUJ with a documented journey and **no tool support**. Today
[`set-up/new-required-field.mdx`](../src/content/docs/set-up/new-required-field.mdx)
implements the ratchet as four stages of hand-editing `overrides:` globs:

1. add the field as optional-but-validated,
2. find the docs missing it (`docmeta get`, by hand),
3. enforce it on new areas via a hand-maintained glob,
4. promote it to `required` once the glob covers everything.

Stage 3 is the expensive one: the user maintains, by hand, a glob list that
encodes "which parts of the repo have been cleaned up so far". That list is a
worse version of a data structure the tool could own. It goes stale silently, it
cannot express file-level granularity without becoming enormous, and nothing
verifies that a path in the "clean" list is actually clean.

Every comparable tool ships this: ESLint (`--max-warnings` plus suppressions
files), Stylelint, Vale, `tsc --strict` staged per-directory, RuboCop's
`.rubocop_todo.yml`, Psalm's baseline XML. The shape that fits docmeta is
RuboCop's: **record today's violations, fail only on new ones.**

## Prerequisite: `FieldError` needs a machine identity

`toFieldError` in `src/core/validator.ts` keeps Ajv's prose and throws away
everything machine-stable:

```ts
return { schema, instancePath, message, ...(line != null ? { line } : {}) };
```

`e.keyword`, `e.schemaPath`, and `e.params` are all discarded. Verified against
the built CLI at 3.4.0 — two violations that differ **only** by keyword are
indistinguishable once you remove the prose:

```console
$ docmeta validate p.md -s ./s.json -f json    # slug "A1"; minLength 5 + pattern ^[a-z]+$
{"schema":"./s.json","instancePath":"/slug","message":"must NOT have fewer than 5 characters","keyword":"(ABSENT)"}
{"schema":"./s.json","instancePath":"/slug","message":"must match pattern \"^[a-z]+$\"","keyword":"(ABSENT)"}
```

So add to `FieldError`:

```ts
/** Ajv keyword that failed (e.g. "required", "format", "pattern"). */
keyword: string;
/** The discriminator within that keyword, when one exists: the missing
 *  property, the additional property, the format name. */
subject?: string;
```

Both are additive. `keyword` is required-on-write, but every existing consumer
ignores unknown fields and the JSON reporter simply gains two keys. This is the
same change [0003](0003-sarif-and-junit-reporters.md) needs for a SARIF
`ruleId`.

**As implemented, `col` was deliberately left alone** — it stays declared and
never populated, and [0013](0013-cleanup-dead-code-and-exit-codes.md) still owns
the decision about it. Scoping `col` into this change was considered and
rejected with the user, to keep the baseline work tight; the sentence above
about closing 0013's complaint therefore does *not* apply.

## Proposal

### Surface

```
docmeta validate [paths...]
  --baseline [path]         compare against a baseline; fail only on new findings
  --write-baseline [path]   record current findings and exit 0
```

`--baseline` defaults to `.docmeta-baseline.json` when the value is omitted, so
the common case is a bare `--baseline`. **As implemented, a bare
`--write-baseline` instead resolves to the configured `baseline:` path, falling
back to `.docmeta-baseline.json` only when there is none.** The symmetric
version of this — both flags defaulting to the literal path — was rejected during
implementation: a repo that configured `baseline:` elsewhere would then record
into a second file nothing ever reads, so the ratchet would silently do nothing.
Read and write have to name the same file. Config equivalent:

```yaml
baseline: .docmeta-baseline.json   # implies --baseline on every run
```

A CLI `--baseline` with no config key works; a config key with no flag works;
`--no-baseline` suppresses a configured one for a single run (needed for "show me
everything" locally, and to answer "how far from clean are we?").

### Baseline file

```json
{
  "version": 1,
  "generatedWith": "3.4.0",
  "entries": {
    "docs/api/legacy.md": ["a1b2c3d4e5f60718", "9f8e7d6c5b4a3210"],
    "docs/guides/old.md": ["1122334455667788"]
  }
}
```

Path-keyed, with a sorted array of violation fingerprints. Sorted keys and
sorted fingerprints so the file is diff-stable and merge-conflict-legible.

### Fingerprint

```
sha256(schemaRef + NUL + instancePath + NUL + keyword + NUL + (subject ?? "")).slice(0, 16)
```

Deliberately **excludes**:

- **the line number** — otherwise every content edit invalidates the baseline,
- **the message prose** — otherwise an Ajv upgrade invalidates every entry,
- **the file path** — it is already the key, so it is not repeated in the hash.

16 hex chars (64 bits) is the collision budget. Within a single file's entry
list the realistic population is tens of violations, so 64 bits is overwhelming
headroom, and a collision's consequence is one forgiven violation, not
corruption.

### Semantics

For each file, a finding is **new** if its fingerprint is not in that file's
baseline array. Exit `1` if any file has a new finding, `0` otherwise.

Stale entries — fingerprints in the baseline that no longer occur — are
**reported but never fatal**:

```
✓ docs/api/legacy.md  (2 baselined)

1 file checked, 1 passed, 0 failed, 0 errors
3 baselined findings, 1 no longer occurs — run --write-baseline to prune
```

## Stress test

### 1. Count-based baseline instead of fingerprints — rejected

`--max-failures N` is far cheaper to build. It is also unsound: fix one
violation, introduce another, and the count is unchanged, so the build stays
green while a regression lands. The failure is silent and routine — any PR that
touches two files — not exotic. Fingerprints are the minimum viable design.

Keeping `--max-failures` as a *coarse extra* was also rejected: two competing
ratchets invite the cheaper, broken one to be used.

### 2. Message prose in the fingerprint — rejected, and it is load-bearing

Tried first because it needs no `FieldError` change. Ajv's messages are generated
prose (`"must NOT have fewer than 5 characters"`). Any Ajv minor that rewords a
message invalidates every affected entry in every consuming repo simultaneously,
presenting as "docmeta 3.5 broke our build". `keyword` + `subject` is
version-stable in a way prose is not — which is exactly why the prerequisite
above is not optional.

### 3. Line number in the fingerprint — rejected

Adding a line to frontmatter shifts `line` for every subsequent violation, so a
pure reordering of frontmatter keys would present every existing violation as
new. The baseline must survive content edits or it is not a ratchet.

### 4. Same `(schema, instancePath)`, different keyword — the collision that forced the design

Reproduced above: `minLength` and `pattern` on the same property both fire at
`/slug` under the same schema. `(schema, instancePath)` alone forgives both when
only one was baselined. Including `keyword` distinguishes them. `subject` is then
needed for the same reason one level down: two `required` violations at the root
differ only by *which* property is missing.

### 5. File rename breaks the build — accepted cost, made visible

A rename moves findings to a path with no baseline entry, so every violation in
the renamed file reads as new. Alternatives considered:

- **Content-hash keying** — survives renames, breaks on every edit. Strictly worse.
- **Path-independent global fingerprint set** — survives renames, but then moving
  a bad file into a clean directory carries its forgiveness with it, and a
  violation deleted in one file is forgiven in another. Unsound.

Decision: stay path-keyed and make recovery one command (`--write-baseline`). The
stale-entry line in the summary is what makes a rename diagnosable rather than
mysterious — without it the user sees "new findings" with no hint that the fix is
a re-record.

### 6. Baseline as permanent amnesty — mitigated, not solved

Nothing forces the baseline to shrink. A repo can baseline everything and never
improve. Considered and deferred: a `baselineMaxAge`, or a CI-visible count
trend. Both need history that docmeta does not have. The stale-entry report plus
the count in the summary (`3 baselined findings`) is the honest minimum: it keeps
the debt visible on every run instead of hiding it.

### 7. Schema ref string is part of the identity — documented sharp edge

Switching a schema reference from `google:okf:0.1` to a URL serving the same
schema changes every fingerprint. This is *correct* — it is a different contract
as far as docmeta can tell — but it is surprising. It must be called out on the
reference page, with `--write-baseline` as the remedy.

**Found during implementation, and fixed rather than documented:** the same
property makes the fingerprint depend on the *working directory*, because
0004's `rebaseConfigSchemaRefs` rewrites a config's local file refs to absolute
paths whenever the config directory is not `cwd`. A repo with
`schemas: ["./schemas/doc.json"]` therefore produced one fingerprint set from
the repo root and a different, machine-specific one from `docs/` — CI green
while a developer in a subdirectory saw the entire baselined backlog as new.
`src/core/baseline.ts` now canonicalizes a **local file** ref to its path
relative to the config directory (posix separators) before hashing; built-in ids
and URLs pass through untouched. Only the fingerprint input is canonicalized —
reports and schema loading still use the ref exactly as written.

### 8. `--write-baseline` shrinkage is invisible — fixed by reporting it

The read path reports stale entries, but the *write* path was silent. A developer
who fixes half the backlog and re-records gets a smaller baseline with no
indication that anything was dropped — and in a CI log
`Baseline written.` and `Baseline written. (12 entries pruned)` are
indistinguishable. Worse, an accidental `--write-baseline` on a run that resolved
fewer files than intended (a narrowed glob, or an `--exclude` typo) silently
*forgives* everything it did not see.

So `--write-baseline` must report the delta in both directions:

```
Baseline written to .docmeta-baseline.json
  14 findings recorded (+2 new, -12 no longer occur)
```

The `-12` is the number that makes an over-broad re-record visible. This is the
same philosophy as the stale-entry line on the read path, applied to the side that
actually mutates the file.

### 9. Baseline present, repo clean — verified benign

Every entry is stale, the run exits 0, and all entries are reported prunable.
That is the natural end state of a completed ratchet: the user deletes the file
and drops the flag.

### 10. Interaction with 0004 (config discovery) — genuine coupling

A relative `baseline:` path must resolve **relative to the config file**, not
`cwd`. Resolving against `cwd` reintroduces the class of bug 0004 fixes: run from
a subdirectory, silently find no baseline, and every violation reads as new
(noisy rather than silent — the safe direction, but still wrong). 0004 should
land first, or this must carry its own config-relative resolution.

### 11. Interaction with `fill` — verified benign

`fill` removes violations, so it only ever produces stale entries. No interaction
beyond the prune prompt.

### 12. Interaction with 0014 (empty input) — the ratchet must not mask it

A baseline makes "0 findings" the expected steady state, which makes
[0014](0014-empty-input-is-not-success.md)'s silent-pass-on-zero-files strictly
more dangerous: a glob that stops matching looks identical to a clean ratchet.
0014 should land before or with this.

### 13. Determinism — verified

Baseline correctness needs deterministic output. Three consecutive runs produced
a byte-identical `errors` array (`sha256` prefix `f1a3aabdcbbb06dc` each time),
and `resolveTargets` sorts its output, so file order is stable independent of
glob expansion order.

## Rejected alternative: per-schema severity

The other obvious shape is `severity: warn` on a schema in config, so a new
required field can warn before it fails.

Rejected as the *first* move, on cost-to-the-user grounds rather than
implementation cost. Severity asks the user to maintain **two schemas** (lenient
and strict) or a severity map, and keep them in sync — the same
hand-maintained-parallel-structure problem the current four-stage journey already
has. A baseline asks the user to maintain **nothing**; the tool records the state.

Severity remains a reasonable follow-on for the different job of "this field is
advisory forever", which a baseline cannot express. Out of scope here.

## Implementation sketch

Red/green order:

1. `test/validator.test.ts` — `FieldError` carries `keyword`; `subject` set for
   `required`, `additionalProperties`, and `format`.
2. `test/baseline.test.ts` — fingerprint stability: the same violation across a
   line shift hashes identically; the keyword pair above hashes differently.
3. `test/baseline.test.ts` — parse/serialize round-trip; reject `version != 1`
   with a `DocmetaError` naming the remedy.
4. `test/commands.test.ts` — `runValidate` with a baseline: new finding fails,
   baselined finding passes, stale entry reported and non-fatal.
5. `test/cli.integration.test.ts` — `--baseline` / `--write-baseline` /
   `--no-baseline`, and the omitted-value defaults.
6. Fixtures: `test/fixtures/baseline/` with `two-violations.md`, `baseline.json`,
   and `baseline-stale.json`.

Then update `reference/cli.mdx` (`npm run docs:check-cli` enforces this — new
flags and their omitted-value defaults must be documented), the M2 page (which
shrinks substantially), and `reference/output-and-exit-codes.mdx`.
