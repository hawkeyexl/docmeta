# 0005 — Command parity: flags first, positional fallbacks kept

- **Status:** Proposed
- **Serves:** every persona; enforces the project's own working agreement
- **Touches:** `src/cli.ts`, `src/commands/{get,fill}.ts`, `src/reporters/fill.ts`
- **Constraint:** `npm run docs:check-cli` compares documented args/options/defaults *and* required-vs-optional arity against `buildProgram()`. Every change here needs a matching `reference/cli.mdx` edit.

## Problem

CLAUDE.md and `CONTRIBUTING.md § Keeping commands consistent` both state the rule:
shared flags use the same names and semantics, and per-command input conventions
are forbidden. The shipped CLI breaks it in four places. All verified against the
built CLI at 3.4.0:

| Gap | Evidence |
|---|---|
| `get` takes fields **positionally**; `fill` takes `--fields` | `get <fields> [paths...]` vs `fill --fields <list>` in `src/cli.ts` |
| `--quiet` only on `validate` | `get title docs/a.md --quiet` → `error: unknown option '--quiet'` (exit 1) |
| `--format github` only on `validate` | `fill docs/a.md -f github --dry-run` → `Unknown --format "github". Use pretty or json.` (exit 2) |
| Unknown-flag errors exit **1**, contract says **2** | `validate --nope x.md` → `error: unknown option '--nope'`, exit 1 |

The `--fields` divergence is the one CLAUDE.md calls out by name, and it has a
user-visible cost today. Because `<fields>` is a *required* positional, a user who
forgets it gets their path eaten:

```console
$ docmeta get docs/a.md
docmeta: No files to read. Pass paths/globs, or add `paths:` to docmeta.config.yaml.
exit=2
```

`docs/a.md` was bound to `<fields>`, leaving zero paths. The error blames the
missing paths and never mentions that the given path was consumed as a field name.

The exit-code gap is separate and worse in CI: a typo'd flag returns 1, which
`reference/output-and-exit-codes.mdx` defines as "one or more files failed
validation". A pipeline distinguishing "docs are bad" from "the command is wrong"
gets the wrong answer.

## Proposal

Per the instruction to prefer flags with backwards-compatible fallbacks.

### 1. `--fields` on `get`, positional kept as a fallback

Declare `get [fields] [paths...]` (note: `[fields]` becomes **optional**) and add
`--fields <list>`. Resolution rule:

> If `--fields` is present, **every** positional is a path. Otherwise the first
> positional is the field list, exactly as today.

Verified against the repo's commander (v15) with a prototype:

```
docmeta get title docs/a.md                    -> {"fields":"title","paths":["docs/a.md"]}
docmeta get title,type docs/ more/             -> {"fields":"title,type","paths":["docs/","more/"]}
docmeta get --fields title docs/a.md           -> {"fields":"title","paths":["docs/a.md"]}
docmeta get --fields title docs/a.md b.md      -> {"fields":"title","paths":["docs/a.md","b.md"]}
docmeta get --fields title                     -> {"fields":"title","paths":[]}
docmeta get --fields=title docs/a.md           -> {"fields":"title","paths":["docs/a.md"]}
docmeta get docs/a.md                          -> {"fields":"docs/a.md","paths":[]}
```

Every legacy invocation is unchanged, and the flag form correctly reclassifies
the first positional as a path. The implementation is four lines in the action
handler:

```ts
const fields = options.fields ?? fieldsArg;
const paths  = options.fields ? [fieldsArg, ...pathsArg].filter(Boolean) : pathsArg;
```

The last probe line is the residual ambiguity: with no flag, `get docs/a.md` still reads
the path as a field. See stress test 2 — it gets a targeted error, not a silent
misread.

### 2. `-q/--quiet` on `get` and `fill`

Same semantics as `validate`: in `pretty` output, hide the passing/uninteresting
rows. On `get`, suppress files where every requested field is unset. On `fill`,
suppress files with no proposals. No effect on `json`.

### 3. `--format github` on `fill`

`fill` already exits 1 in CI when a required property could not be filled
confidently, so it already participates in the gate — with no way to say *where*.
`github` emits one `::error` per required-but-unfilled property, at the file's
frontmatter line. Optional skips stay silent, matching the exit-code rule.

`fill` does **not** gain `sarif`/`junit` — see
[0003 § stress test 8](0003-sarif-and-junit-reporters.md).

### 4. Usage errors exit 2

Call `program.exitOverride()` and route commander's `CommanderError` through the
existing `fail()` helper, mapping parse/usage failures to exit 2. Commander's own
`exitCode` for help (`0`) and version (`0`) must be preserved — those are
successful invocations, not errors.

## Stress test

### 1. Does `[fields]` becoming optional break the drift checker? — yes, by design

`scripts/check-cli-reference.mjs` explicitly compares required-vs-optional arity
and fails with *"`fields` is required (`<arg>`) in code but documented as optional
(`[arg]`)"*. So `reference/cli.mdx` must change `<fields>` to `[fields]` in the
same commit. This is the check working correctly; noted so it is not mistaken for
a regression mid-implementation.

### 2. `get` with neither flag nor a plausible field — needs its own error

The probe confirms `get docs/a.md` still binds the path to `fields`. Since
`[fields]` is now optional, the handler can detect the likely mistake: if
`--fields` is absent and the sole positional contains a path separator or ends in
a supported extension, fail with the actual problem:

```
docmeta: "docs/a.md" looks like a path, not a field list.
Pass fields first (docmeta get title docs/a.md) or use --fields.
```

This is strictly better than today's misleading "No files to read", and it is only
reachable because the positional became optional. A field genuinely named like a
path is not expressible in frontmatter as a top-level key, so the heuristic has no
false positives worth worrying about — and `--fields` is the unambiguous escape.

### 3. `--fields` **and** a leading field-looking positional — ambiguous, must not guess

`docmeta get --fields title type docs/a.md` — is `type` a second field or a path?
Under the rule it is a **path**, so the run then errors with "File not found:
type" once [0014](0014-empty-input-is-not-success.md) lands. Considered merging
positionals into the field list when they are not paths; rejected as
unpredictable. One rule, stated once: with `--fields`, positionals are paths.

### 4. Should `--fields` be repeatable? — no

`--exclude` and `--schema` use `collect` and repeat. `--fields` takes a
comma-separated list on `fill` today, and `get`'s positional is comma-separated.
Making it repeatable *as well* is harmless but adds a third spelling of one idea.
Keep comma-separated to match `--ext` and `fill --fields`. Noted because the
inconsistency with `--schema` is real and a future reader will ask.

### 5. `exitOverride()` blast radius — the risk in this proposal

`exitOverride` makes commander **throw** instead of exiting, for every terminating
condition including `--help` and `--version`. Get it wrong and `docmeta --help`
exits 2 or prints a stack trace. The handler must switch on
`CommanderError.code`: `commander.helpDisplayed` / `commander.version` → exit 0
silently; everything else → exit 2 via `fail()`. This needs its own integration
tests for `--help`, `-V`, and each subcommand's `--help`, because a regression
here is both severe and easy to miss.

### 6. `--quiet` on `get` — is "uninteresting" the right filter?

`validate --quiet` hides *passing* files, an unambiguous notion. For `get` the
analogue is "no requested field is set", which is a judgment call: a file where
`title` is set and `owner` is unset is partially interesting. Decision: hide only
when **every** requested field is unset. A file with any value present still
prints, with `(unset)` for the missing ones — so `--quiet` never hides a value.

### 7. `--quiet` on `fill --dry-run` — verified non-conflicting

`--dry-run` already limits output to proposals. `--quiet` additionally drops
files with zero proposals. Composable, no interaction.

### 8. `fill -f github` when writing (not `--dry-run`) — allowed, and useful

Annotations describe what could *not* be filled, which is exactly what a CI run
that also writes wants to report. No reason to couple the format to `--dry-run`.

### 9. stdin plus `-f github` on `fill` — a genuine output collision

With `-`, `fill` writes the filled document to **stdout** and the report to
stderr. `::error` workflow commands are only interpreted on stdout, so
`cat p.md | docmeta fill - --as markdown -f github` produces annotations on
stderr where GitHub ignores them. Options: silently degrade, error out, or
document. Decision: **error out** with a `DocmetaError` — `-f github` with stdin
input is a request that cannot be honored, and a silent no-op annotation is the
kind of false-green this proposal set exists to eliminate.

### 10. Should `validate` gain `--fields` for symmetry? — no

Validation is defined by the schema set, not by a field subset; a `--fields`
filter would mean "validate part of the contract", which contradicts the schema
set being all-or-nothing. Parity applies to *input and output affordances*, not
to semantics one command has and another cannot.

## Implementation sketch

1. `test/cli.integration.test.ts` — the seven probe cases above, as a table.
2. `test/cli.integration.test.ts` — `get docs/a.md` yields the path-looks-like-a-field
   error, not "No files to read".
3. `test/cli.integration.test.ts` — `--help`, `-V`, and `<cmd> --help` still exit 0
   after `exitOverride()`; `--nope` exits 2; `get` with no args exits 2.
4. `test/commands.test.ts` — `runGet` / `runFill` honor `quiet`.
5. `test/reporters.test.ts` — `renderFill("github", …)` emits `::error` only for
   required-and-unfilled.
6. `test/cli.integration.test.ts` — `fill - --as markdown -f github` exits 2.
7. `reference/cli.mdx`: `[fields]`, `--fields`, `--quiet` on two commands,
   `github` in `fill`'s format list. Then `npm run build && npm run docs:check-cli`
   must pass — it is the gate for this proposal.
