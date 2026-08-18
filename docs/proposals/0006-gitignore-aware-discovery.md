# 0006 — `.gitignore`-aware file discovery

- **Status:** Proposed
- **Serves:** every persona; removes hand-maintained `exclude:` boilerplate
- **Relates to:** [0014](0014-empty-input-is-not-success.md) (fewer files makes the empty case reachable), [0004](0004-config-upward-discovery.md) (both need the repo root)
- **Touches:** `src/core/load-files.ts`, `src/core/config.ts`, `src/cli.ts`

## Problem

`load-files.ts` hardcodes two ignores and nothing else:

```ts
const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];
```

Everything else a repo has already declared uninteresting gets validated.
Verified in a git repo with `build/` in `.gitignore`:

```console
$ git status --porcelain --ignored | grep build
!! build/

$ docmeta validate "**/*.md" -f json
files checked: 2
  build/generated.md      <-- gitignored
  docs/real.md
```

`node_modules` was correctly skipped, so the hardcoded list works — it is just
far too small. Any repo with a built site (`build/`, `.astro/`, `_site/`,
`.docusaurus/`), a vendored copy, or a local scratch directory validates
generated Markdown. The consequences are worse than noise:

- **Generated files fail differently.** A static-site build emits Markdown with
  transformed or stripped frontmatter, producing violations the user cannot fix
  in source.
- **Every user pays the same tax.** The remedy today is hand-maintaining
  `exclude:` to restate what `.gitignore` already says — two lists to keep in
  sync, in a project whose own working agreements are hostile to exactly that
  pattern.
- **This repo dogfoods around it.** The documented dogfood command targets
  `docs/src/content/docs/**` explicitly rather than the repo, and `docs/.gitignore`
  lists `dist`, `.astro`, `node_modules` — none of which docmeta itself honors.

## Proposal

Filter directory-walk and glob results through **git itself**, not a
reimplementation:

```
git check-ignore --stdin   <  (candidate paths, NUL- or newline-delimited)
```

One subprocess per run, after `fast-glob` enumeration and before the extension
filter. Ignored paths are dropped.

### Surface

On by default. Opt out per run or per repo:

```
docmeta validate --no-gitignore
```

```yaml
respectGitignore: false
```

### Explicitly named files always win

Gitignore filtering applies **only** to directory and glob expansion. An input
that names one file is never filtered:

```console
$ docmeta validate build/generated.md     # explicit -> still validated
```

This mirrors the existing behavior for the extension filter, where
`resolveTargets` adds `st.isFile()` inputs before `keepByExt` runs. The user who
types a path means it.

## Stress test

### 1. Hand-rolling gitignore semantics — rejected, and the probe shows why

The obvious dependency-free approach is translating `.gitignore` lines into
picomatch patterns (picomatch is already a dependency). The probe kills it.
Given a nested `docs/.gitignore` containing `tmp/` then `!keep.md`:

```console
$ printf 'build/generated.md\ndocs/tmp/x.md\ndocs/tmp/keep.md\n' | git check-ignore --stdin -v
.gitignore:1:build/       build/generated.md
docs/.gitignore:1:tmp/    docs/tmp/x.md
docs/.gitignore:1:tmp/    docs/tmp/keep.md
```

`!keep.md` does **not** rescue `docs/tmp/keep.md`, because git cannot re-include a
file inside an excluded directory. That rule is not expressible as a flat pattern
list, and it is one of several — precedence across nested files, directory-only
patterns, leading-`/` anchoring, `**` semantics that differ from glob `**`,
`.git/info/exclude`, and `core.excludesFile`. A translation layer would be subtly
wrong in ways that silently change which files are validated, which is the exact
failure class this proposal set exists to remove.

### 2. Adding the `ignore` package instead — rejected on this repo's own terms

`ignore` implements gitignore semantics correctly, is ~30 KB, and has no
dependencies. It is also **absent** from the tree — verified not present even
transitively (`grep -c '"node_modules/ignore"' package-lock.json` → 0). Adding it
means a lockfile change, and CLAUDE.md devotes an entire section to how that goes
wrong here: `npm install <dep>` on Windows drops the top-level `@emnapi/*` entries
and reddens every Linux CI job at once, so the dep must be **spliced by hand** and
diffed against `origin/main`.

That cost is payable but it buys strictly less than the probe option: `ignore`
still needs docmeta to find, read, and correctly stack every nested `.gitignore`,
plus `.git/info/exclude` and the global excludes file. `git check-ignore` does all
of that by construction.

### 3. Performance of a subprocess — measured, acceptable

Concern: shelling out on every run. Measured on this machine:

| Candidates | Half ignored | Wall clock |
|---|---|---|
| 5,000 | no | 0.111 s |
| 5,000 | yes | 0.260 s |

One subprocess, sub-second at 5,000 files. For comparison, a single remote schema
fetch is allowed 10 s ([0008](0008-remote-schema-durability.md)). Not a concern,
and it does not grow with repo size — only with candidate count, which is already
bounded by the glob.

### 4. Not a git repository — must degrade silently

Verified: outside a repo, git prints `fatal: not a git repository`. Extracted
tarballs, `npm pack` contents, and some Docker build contexts all hit this. The
implementation must treat a non-zero *setup* failure as "no filtering" and
continue, not as an error.

Critically, `git check-ignore` **exits 1 when nothing matched** — verified:

```
none-ignored -> exit 1
ignored      -> exit 0
```

So exit 1 is a normal, successful result meaning "keep everything". Conflating it
with failure would make the filter silently no-op in the common clean case, or
worse, error. This is the single most likely implementation bug.

### 5. `git` missing from `PATH` — same degradation, but say so

Minimal CI containers may lack a git binary. Degrade to no filtering, and emit a
one-line stderr diagnostic when `respectGitignore` was **explicitly** enabled in
config (the user asked for something that did not happen). Stay silent when it was
merely the default, or every non-git run gains noise.

### 6. Behavior change: files disappear from the checked set — the real risk

A repo currently validating gitignored files will check fewer files, and a run
that was red can turn green. That is the *dangerous* direction of change: the gate
gets quieter without the user asking.

Mitigations, in order of importance:

1. The dropped files were never in the repo, so not validating them is correct.
2. Report the count: `12 files checked, 3 skipped by .gitignore`. Silent removal
   is what makes this dangerous; a counted removal is auditable.
3. `--no-gitignore` restores the old behavior in one flag.
4. [0014](0014-empty-input-is-not-success.md) catches the pathological case — a
   repo whose entire docs tree is gitignored now errors instead of reporting a
   green zero.

Point 4 is why 0014 should land first. Without it, this proposal can turn a
working gate into a silent no-op.

### 7. Interaction with `--exclude` — additive, and order matters for reporting

`.gitignore` and `--exclude` compose: a file is skipped if either applies.
`--exclude` continues to be passed to `fast-glob`'s `ignore`, while gitignore
filtering happens after enumeration. That means the skipped-count in point 6
reflects only gitignore, not `--exclude`. Correct, and worth stating in the
reference page so the numbers are interpretable.

### 8. Interaction with `--ext` — ordering is a correctness question

Filter gitignore **before** the extension check, not after. Both orders produce
the same file set, but running `check-ignore` on the smaller post-extension list
is cheaper, while running it first keeps the skipped-count meaningful ("skipped
because ignored" vs "skipped because wrong extension" are different facts the
user may want separated). Decision: extension filter first for cost, and count
only extension-eligible files as gitignore-skipped, so the reported number
answers "how many candidate documents did .gitignore remove".

### 9. Worktrees — verified relevant to this repo

This repo's worktrees live at `.claude/worktrees/<name>/` with `.git` as a
**file**. `git check-ignore` resolves worktrees natively, so no special handling
is needed — but it is also the reason not to hand-roll `.git` discovery
(cf. [0004 § stress test 2](0004-config-upward-discovery.md), which must handle
the gitfile explicitly because it does *not* delegate to git).

### 10. Windows path separators — must normalize before the pipe

`resolveTargets` already normalizes to posix via `toPosix()`, and
`git check-ignore` wants forward slashes. Feed it the already-normalized relative
paths. Paths are also relative to the git root, not `cwd` — so the subprocess must
run with `cwd` set to the invocation directory and receive `cwd`-relative paths,
which git resolves correctly. Needs an explicit test from a subdirectory, since
that is where this class of bug lives (see 0004).

### 11. NUL-delimited input for hostile filenames — required

Newline-delimited breaks on filenames containing a newline. `git check-ignore`
supports `-z` for NUL-delimited input and output. Use it: the cost is zero and the
alternative is a rare, baffling failure.

## Implementation sketch

1. `test/load-files.test.ts` — a gitignored file is dropped from a glob expansion;
   an explicitly named gitignored file is kept.
2. `test/load-files.test.ts` — nested `.gitignore` honored; the
   `tmp/` + `!keep.md` case from the probe asserts git's semantics, not ours.
3. `test/load-files.test.ts` — `check-ignore` exit 1 (nothing ignored) keeps all
   files; simulated missing git keeps all files.
4. `test/load-files.test.ts` — run from a subdirectory of the git root.
5. `test/cli.integration.test.ts` — `--no-gitignore`; the skipped count appears in
   `pretty` output.
6. **Fixtures cannot live in `test/fixtures/`, and the reason is a trap.** A file
   this repo's own `.gitignore` ignores would never be committed, so a
   `test/fixtures/gitignored/` directory would arrive on CI *empty*. The test
   would then find nothing to ignore, assert that nothing was ignored, and
   **pass for the wrong reason** — a green test proving nothing.

   The test helper must therefore build a throwaway repo at runtime:

   ```
   mkdtemp() -> git init -> write .gitignore ("build/") -> write build/x.md and
   docs/x.md -> run resolveTargets -> assert build/x.md absent, docs/x.md present
   -> rm -rf the temp dir in afterEach
   ```

   Two assertions are non-negotiable, per the red/green agreement:
   - the test **fails** when the `git init` step is removed (proving the filter,
     not the fixture layout, is what excludes the file);
   - the temp directory is cleaned up even when the test fails.

   Without the first, this test can pass on a machine where `git` is absent and
   the filter silently no-ops (stress test 5).

Then `reference/configuration.mdx` (`respectGitignore`), `reference/cli.mdx`
(`--no-gitignore`, enforced by `npm run docs:check-cli`), and the "Default
ignores" section of `reference/cli.mdx`.
