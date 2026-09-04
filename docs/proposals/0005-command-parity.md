# 0005: Command parity: flags first, positional fallbacks kept

- **Status:** Implemented
- **Serves:** Every persona; enforces the project's own working agreement
- **Touches:** `src/cli.ts`, `src/reporters/{index,fill,get}.ts`. As built, the
  command cores were *not* touched; see [correction
  3](#correction-3-quiet-is-a-reporter-concern-not-a-core-one)
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
| Unknown-flag errors exit **1**, contract says **2**. Fixed separately in #84, see [§ 4](#4-usage-errors-exit-2) | `validate --nope x.md` → `error: unknown option '--nope'`, exit 1 |

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

The last probe line is the residual ambiguity. With no flag, `get docs/a.md`
still reads the path as a field. See stress test 2, where it gets a targeted
error rather than a silent misread.

### 2. `-q/--quiet` on `get` and `fill`

Same semantics as `validate`: in `pretty` output, hide the passing/uninteresting
rows. On `get`, suppress files where every requested field is unset. On `fill`,
suppress files with no proposals. No effect on `json`.

### 3. `--format github` on `fill`

`fill` already exits 1 in CI when a required property could not be filled
confidently. So it already participates in the gate, with no way to say *where*.
`github` emits one `::error` per required-but-unfilled property, at the file's
frontmatter line. Optional skips stay silent, matching the exit-code rule.

`fill` does **not** gain `sarif`/`junit`. See [0003 § stress test
8](0003-sarif-and-junit-reporters.md).

### 4. Usage errors exit 2

**Shipped in #84**, ahead of the rest of this proposal, which landed in #86.
Recorded here because the item is described as open above and this is the only
part of 0005 that did not ship with the others.

Call `program.exitOverride()` and route commander's `CommanderError` through the
existing `fail()` helper, mapping parse/usage failures to exit 2. Commander's
own `exitCode` for help (`0`) and version (`0`) must be preserved. Those are
successful invocations, not errors.

As built, the `CommanderError` is **not** routed through `fail()`.
`Command.error()` has already printed the message, so `fail()` would prefix it a
second time. `main()` branches on `err.exitCode` rather than a list of code
strings, because there are three success codes and not two. `docmeta help get`
raises `commander.help` alongside `commander.helpDisplayed` and
`commander.version`.

## Stress test

### 1. Does `[fields]` becoming optional break the drift checker? (yes, by design)

`scripts/check-cli-reference.mjs` explicitly compares required-vs-optional arity
and fails with *"`fields` is required (`<arg>`) in code but documented as optional
(`[arg]`)"*. So `reference/cli.mdx` must change `<fields>` to `[fields]` in the
same commit. This is the check working correctly; noted so it is not mistaken for
a regression mid-implementation.

### 2. `get` with neither flag nor a plausible field needs its own error

The probe confirms `get docs/a.md` still binds the path to `fields`. Since
`[fields]` is now optional, the handler can detect the likely mistake. If
`--fields` is absent and the sole positional contains a path separator or ends
in a supported extension, fail with the actual problem:

```
docmeta: "docs/a.md" looks like a path, not a field list.
Pass fields first (docmeta get title docs/a.md) or use --fields.
```

This is strictly better than today's misleading "No files to read", and it is
only reachable because the positional became optional. A field genuinely named
like a path is not expressible in frontmatter as a top-level key. So the
heuristic has no false positives worth worrying about, and `--fields` is the
unambiguous escape.

### 3. `--fields` **and** a leading field-looking positional, which is ambiguous and must not be guessed

In `docmeta get --fields title type docs/a.md`, is `type` a second field or a
path? Under the rule it is a **path**, so the run then errors with "File not
found: type" once [0014](0014-empty-input-is-not-success.md) lands. Merging
positionals into the field list when they are not paths was considered, and
rejected as unpredictable. One rule, stated once: with `--fields`, positionals
are paths.

### 4. Should `--fields` be repeatable? (no)

`--exclude` and `--schema` use `collect` and repeat. `--fields` takes a
comma-separated list on `fill` today, and `get`'s positional is comma-separated.
Making it repeatable *as well* is harmless but adds a third spelling of one idea.
Keep comma-separated to match `--ext` and `fill --fields`. Noted because the
inconsistency with `--schema` is real and a future reader will ask.

### 5. `exitOverride()` blast radius, the risk in this proposal

`exitOverride` makes commander **throw** instead of exiting, for every terminating
condition including `--help` and `--version`. Get it wrong and `docmeta --help`
exits 2 or prints a stack trace. The handler must switch on
`CommanderError.code`: `commander.helpDisplayed` / `commander.version` → exit 0
silently; everything else → exit 2 via `fail()`. This needs its own integration
tests for `--help`, `-V`, and each subcommand's `--help`, because a regression
here is both severe and easy to miss.

### 6. `--quiet` on `get`, and whether "uninteresting" is the right filter

`validate --quiet` hides *passing* files, an unambiguous notion. For `get` the
analogue is "no requested field is set", which is a judgment call. A file where
`title` is set and `owner` is unset is partially interesting. The decision is to
hide only when **every** requested field is unset. A file with any value present
still prints, with `(unset)` for the missing ones, so `--quiet` never hides a
value.

### 7. `--quiet` on `fill --dry-run`, verified non-conflicting

`--dry-run` already limits output to proposals. `--quiet` additionally drops
files with zero proposals. Composable, no interaction.

### 8. `fill -f github` when writing (not `--dry-run`), allowed and useful

Annotations describe what could *not* be filled, which is exactly what a CI run
that also writes wants to report. No reason to couple the format to `--dry-run`.

### 9. stdin plus `-f github` on `fill`, a genuine output collision

With `-`, `fill` writes the filled document to **stdout** and the report to
stderr. `::error` workflow commands are only interpreted on stdout, so `cat p.md
| docmeta fill - --as markdown -f github` produces annotations on stderr where
GitHub ignores them. The options are to silently degrade, to error out, or to
document it. The decision is to **error out** with a `DocmetaError`. `-f github`
with stdin input is a request that cannot be honored. A silent no-op annotation
is the kind of false-green this proposal set exists to eliminate.

### 10. Should `validate` gain `--fields` for symmetry? (no)

Validation is defined by the schema set, not by a field subset. A `--fields`
filter would mean "validate part of the contract", which contradicts the schema
set being all-or-nothing. Parity applies to *input and output affordances*, not
to semantics one command has and another cannot.

## Implementation sketch

1. In `test/cli.integration.test.ts`, the seven probe cases above, as a table.
2. In `test/cli.integration.test.ts`, `get docs/a.md` yields the
   path-looks-like-a-field error, not "No files to read".
3. In `test/cli.integration.test.ts`, `--help`, `-V`, and `<cmd> --help` still
   exit 0 after `exitOverride()`, `--nope` exits 2, and `get` with no args exits
   2.
4. In `test/commands.test.ts`, `runGet` / `runFill` honor `quiet`.
5. In `test/reporters.test.ts`, `renderFill("github", …)` emits `::error` only
   for required-and-unfilled.
6. In `test/cli.integration.test.ts`, `fill - --as markdown -f github` exits 2.
7. In `reference/cli.mdx`, `[fields]`, `--fields`, `--quiet` on two commands,
   and `github` in `fill`'s format list. Then `npm run build && npm run
   docs:check-cli` must pass. It is the gate for this proposal.

## Corrections found while implementing

Five things above are wrong. They are left in place rather than edited away, so
the record shows what the design said and what the code had to do instead. The
implementation follows the corrections.

### Correction 1. The four-line sketch in § 1 is wrong

```ts
const fields = options.fields ?? fieldsArg;
const paths  = options.fields ? [fieldsArg, ...pathsArg].filter(Boolean) : pathsArg;
```

With **neither** the flag nor the positional, `options.fields ?? fieldsArg` is
`undefined`, and `String(undefined).split(",")` is `["undefined"]`. That is a
field list of length one. `runGet`'s `fields.length === 0` guard therefore never
fires. So a bare `docmeta get` in a repo with config `paths:` prints
`undefined=(unset)` per file and exits **0**. That is a successful-looking
extraction of a field nobody named. The CLI has to detect the missing list
itself, and raise a `DocmetaError` before calling `runGet`.

`.filter(Boolean)` is wrong too, for a smaller reason: it silently drops an
empty-string path. The fold is keyed on `fieldsArg !== undefined` instead.

### Correction 2. Stress test 2 scopes the guard too narrowly

It says the guard fires when "the **sole** positional" looks like a path. Then
`docmeta get docs/a.md docs/b.md` has two positionals, the guard never fires,
and the user gets `docs/b.md: docs/a.md=(unset)`. That is the original bug, at
exit 0. The guard fires on the field-list argument **regardless of how many
paths follow**.

The heuristic is also wider than "a path separator or a supported extension". It
reuses the shape already proven in `suggestCommand`: exists on disk, is a glob,
ends in a supported extension, or contains a separator. The `existsSync` leg is
what catches a bare directory name (`docmeta get docs`), which has neither a dot
nor a slash. Two negative tests come first, because a false positive would
reject a legal field list. A **comma** makes it a list, and a **leading `/`** is
a JSON Pointer. `docmeta get /author/email page.md` is documented usage that a
bare separator test would refuse.

### Correction 3. Quiet is a reporter concern, not a core one

Implementation sketch item 4 says "`runGet` / `runFill` honor `quiet`". That is
wrong for this codebase. `validate` already treats quiet as a **reporter**
option, as `ReportOptions.quiet`, consumed in `renderPretty`. `GetOptions` and
`FillOptions` are public API, and a programmatic caller handed a silently
filtered `GetFileResult[]` cannot tell a filtered run from an empty one.

So the cores are untouched, and `get` gained the reporter it never had. That is
`src/reporters/get.ts`, exporting `renderGet(results, fields, { color, quiet })`
plus `stringifyValue`. It was the last command rendering inline in `src/cli.ts`.

### Correction 4. Stress test 7's rule for `fill --quiet` is a no-op

"`--quiet` additionally drops files with zero proposals" describes something
`renderFillPretty` already does. It skips `result.fields.length === 0` outright.
The only files left to drop are those with nothing **written**, which is exactly
the set that carries a `requiredSkipped`, the thing that makes `fill` exit 1.
Under the proposal's rule, `fill --quiet` would hide the reason for its own
failure.

As implemented, the rule hides a file only when it has **no written fields, no
required skip, and no error**.

### Correction 5. Annotations cannot be placed at the frontmatter line

§ 3 says `github` emits one `::error` "at the file's frontmatter line".
`FillFileResult` and `FilledField` carry **no location**, unlike
`ValidationResult.errors[].line`. A fill report is about a property that is
*missing* from the document. Threading `locateFrontmatter` through would be a
public-API shape change for a line number that points at the block rather than
at anything wrong in it.

So the annotation is `::error file=…::<message>` with **no `line=`**, and GitHub
anchors it to line 1. The reference page says so.

### Two things the proposal did not anticipate

- **`fill -f github` made two doc-detective steps stale**, not one.
  `reference/cli.mdx` asserted `fill … -f github` exits 2.
  `ci/exit-codes-and-annotations.mdx` asserted `docmeta get` reports "missing
  required argument", which stops being true the moment `[fields]` is optional.
  Both were replaced with steps that exercise the new behavior.
- **Any doc step or test that *runs* `fill` needs `--provider mock --dry-run
  --no-cache`.** The stale `-f github` step above stopped failing at the format
  check. It then ran a real fill against `test/fixtures/valid.md`, and wrote
  `action: understand` into the committed fixture. That made two unrelated
  provider tests fail, since a fully-filled fixture has no candidates left to
  propose.
