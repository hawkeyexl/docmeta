# 0014 — An empty input set is not success

- **Status:** Implemented (#73)
- **Serves:** Every persona; this is the highest-severity item in the set
- **Relates to:** [0004](0004-config-upward-discovery.md) (same false-green class), [0001](0001-validation-baseline.md) (a ratchet makes this worse)
- **Touches:** `src/cli.ts`, `src/commands/{validate,get,fill}.ts`

> Not in the original gap review. This surfaced while stress-testing 0004.

## Problem

**docmeta exits `0` when it validates nothing at all.** The documented contract
says exit `0` means "all files passed (or nothing failed)", and the
implementation takes the parenthetical literally: zero files is zero failures.

Every one of these is a green build that checked nothing. Verified against the
built CLI at 3.4.0:

```console
$ docmeta validate "docs/**/*.nomatch"
0 files checked, 0 passed, 0 failed, 0 errors
exit=0

$ docmeta validate no-such-dir/
0 files checked, 0 passed, 0 failed, 0 errors
exit=0

$ docmeta validate docs/typo.md          # explicitly named, does not exist
0 files checked, 0 passed, 0 failed, 0 errors
exit=0
```

The third is the sharpest. The user **named one specific file**, that file does
not exist, and docmeta reports success. There is no reading of "all files
passed" under which that is right.

It also reaches through config. From 0004's sandbox, a `paths:` glob that
resolves against the wrong base:

```console
$ docmeta validate -c ../c2.yaml
0 files checked, 0 passed, 0 failed, 0 errors
exit=0
```

### And it swallows typo'd subcommands

`validate` is registered with `{ isDefault: true }`, so an unrecognized first
token is not an error. It is treated as a **path**:

```console
$ docmeta valdiate docs/
✓ docs/a.md
1 file checked, 1 passed, 0 failed, 0 errors
exit=0
```

`valdiate` was silently absorbed as a path that matched nothing, and the run
"succeeded". A bare `docmeta valdiate` matches nothing at all and also exits 0.
The same swallowing applies to `docmeta shcemas`, `docmeta fil`, and any other
misspelling.

### Why this is worse than it looks

The failure mode is *permanent and invisible*. A repo restructure moves `docs/`
to `content/`, the CI glob stops matching, and the metadata gate reports success
forever. Nobody investigates a green check. The gate's entire value is that it is
load-bearing, and this makes it silently non-load-bearing.

[0001](0001-validation-baseline.md) makes it strictly worse. Once a baseline
establishes "0 findings" as the expected steady state, a glob that stopped
matching is indistinguishable from a successfully completed ratchet.

## Proposal

### 1. Zero resolved files is an error

If the input set resolves to zero files (and stdin was not used), exit `2` with a
`DocmetaError`:

```
docmeta: No files matched. Patterns tried: "docs/**/*.nomatch".
Nothing was validated, so this is an error rather than a pass.
```

Exit `2`, not `1`. Nothing was validated, so no verdict was produced, which is
precisely the documented meaning of `2`. This matches `eslint`'s default
(`--no-error-on-unmatched-pattern` opts out) and `pytest`'s exit 5.

### 2. A named file that does not exist is an error, always

Distinct from "a glob matched nothing". `resolveTargets` currently `stat`s each
input and silently drops it when the `stat` fails, falling through to glob
expansion. An input containing no glob metacharacters is an explicit
name and must be reported:

```
docmeta: File not found: "docs/typo.md".
```

This fires even when other inputs did match, so `docmeta validate good.md
typo.md` is an error rather than a partial success. Use `picomatch.scan()` to
decide "is this a pattern or a literal name" rather than hand-rolling the test.

### 3. `--allow-empty` opts out

One flag covers both cases above, for the genuine uses. One is a shared CI
template that runs docmeta on repos that may legitimately have no docs yet. The
other is a pre-commit hook whose file list can be empty. In config it is
`allowEmpty: true`.

### 4. Unknown subcommands stop being paths

Keep `validate` as the default command, but reject a first positional that looks
like a misspelled subcommand. Concretely, take a first token that contains no
path separator, no glob metacharacter, no `.`-extension, and is not `-`. If its
edit distance to a known command name is ≤ 2, fail with a suggestion:

```
docmeta: Unknown command "valdiate". Did you mean "validate"?
```

The narrow guard matters. `docmeta docs` must keep working as `docmeta validate
docs`, and `docs` is not within edit distance 2 of any command name. Commander's
`showSuggestionAfterError` does not help here, because with a default command
there is no parse error to hang a suggestion on.

## Stress test

### 1. Does this break the documented `get` contract? (yes, deliberately, and narrowly)

`reference/output-and-exit-codes.mdx` says `get` "never" exits 1. It says nothing
about 2, and `get` already exits 2 on operational errors (unknown `--format`, no
inputs). "No files matched" is the same class. The documented table needs a note,
not a redefinition: *absent field* stays unset-and-successful; *absent file* is an
error. Those are different things and conflating them is the current bug.

### 2. Empty stdin must stay valid

`echo "" | docmeta validate - --as markdown` resolves zero *files* but one input.
The check must be "zero resolved files **and** no stdin", or piping an empty
document starts failing. Verified the current code path: `usingStdin` is tracked
separately from `files`, so the condition is expressible without restructuring.

### 3. `--allow-empty` as the default instead (rejected)

Safer for existing users, worthless as a fix: the dangerous configuration stays
the default and only the diligent opt in. The people harmed by silent-green are
exactly the people who will not add a flag they have never heard of. Breaking
change, pre-1.0, documented in the changelog.

### 4. Exit 1 instead of exit 2 (rejected)

Tempting because CI treats both as failure. Wrong because the codes mean
different things to *humans* and to `--format json` consumers. `1` sends someone
looking for a bad document, and `2` sends them to look at their invocation. A
mismatched glob is an invocation problem.

### 5. Interaction with `--exclude` (a real edge, resolved)

`docmeta validate "docs/**/*.md" --exclude "docs/**"` legitimately resolves to
zero files, and the user asked for that. Still an error under this proposal.
Considered special-casing "excluded everything" as benign; rejected, because a
too-broad exclude silently disabling the gate is the same defect wearing a
different hat. `--allow-empty` is the answer, and the error message should
mention that excludes were applied.

### 6. Interaction with `--ext`, which is the same shape

`--ext .rst` against a Markdown-only tree resolves to zero. Same verdict, same
remedy. The message should name the extension filter, because "no files matched"
is baffling when the glob obviously matches files on disk.

### 7. Edit-distance suggestions producing false positives (bounded by the guard)

`docmeta get` / `docmeta fill` / `docmeta schemas` are 3–7 characters, so
distance ≤ 2 has real collision potential with short real paths, such as
`docmeta git` or a directory named `fil`. The guard requires *all* of: no
separator, no glob char, no extension, not `-`. A real directory named `fil` in
cwd would still trip it. So the check should run **after** a `stat`, and only
fire when the token does not exist on disk. That makes a false positive
impossible, because if it exists, it is a path.

### 8. Replacing edit distance with a known-commands allowlist (considered and declined)

Review suggested dropping Levenshtein, since there are only four short command
names. It would instead fire whenever the first token has no separator, no glob
character, no extension, and is not one of the four. It would emit a generic
"did you mean validate/get/fill/schemas?".

Declined, on precision rather than cost. That predicate is true of **every**
mistyped path that happens to be a bare word. So `docmeta myproject`, a real
directory renamed last week, would answer "did you mean
validate/get/fill/schemas?". That is both wrong and less informative than `File
not found: "myproject"`. Edit distance is the only thing separating "this is
plausibly a misspelled command" from "this is some other mistake", and that
distinction *is* the feature. The cost being avoided is four comparisons of ≤
7-character strings, once per invocation, on a token that has already failed a
`stat`.

Implementation made the trade sharper. Once the missing-literal rule in item 2 is
in place, the typo'd subcommand **already** exits 2 with the right code:

```console
$ docmeta valdiate docs/
exit=2
docmeta: File not found: "valdiate".
```

So the suggestion is purely a message upgrade on an already-correct failure.
That raises the bar for precision rather than lowering it. A targeted `Unknown
command "valdiate". Did you mean "validate"?` earns its keep. A scattershot
four-way suggestion attached to every mistyped directory name is strictly worse
than the plain not-found message it would replace.

### 9. Monorepo template runs, the legitimate case, handled

A shared workflow running `docmeta validate "docs/**/*.md"` across 40 repos where
6 have no `docs/` would newly fail in 6. That is the one genuine cost, and
`allowEmpty: true` in those repos' configs (or the flag in the template) is the
intended answer. Worth calling out in the CI recipes page, since template authors
are the population most likely to be surprised.

## Implementation sketch

1. In `test/load-files.test.ts`, `resolveTargets` reports a literal input that
   does not exist, and distinguishes literal from pattern via `picomatch.scan()`.
2. In `test/commands.test.ts`, zero resolved files throws `DocmetaError`,
   stdin-only does not, and `allowEmpty` suppresses.
3. In `test/cli.integration.test.ts`, the three reproductions above exit 2, the
   `paths:`-from-config case exits 2, and `--allow-empty` returns them to 0.
4. In `test/cli.integration.test.ts`, `docmeta valdiate docs/` exits 2 with a
   suggestion, `docmeta docs/` still validates `docs/`, and a real directory
   named `fil` is treated as a path.
5. Apply to all three of `validate`, `get`, and `fill`. The shared input model is
   a stated working agreement, so the check belongs next to it, not in one
   command.

Then `reference/output-and-exit-codes.mdx` (the `get` row and a new "no files
matched" row), `reference/cli.mdx` for `--allow-empty`, and a note in the CI
recipes page for template authors.
