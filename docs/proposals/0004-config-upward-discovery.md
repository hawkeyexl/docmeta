# 0004 — Config discovery walks up, and config paths resolve config-relative

- **Status:** Implemented (#74)
- **Serves:** every persona; prevents a false-green CI result
- **Blocks:** [0001](0001-validation-baseline.md) (baseline path resolution)
- **Touches:** `src/core/config.ts`, `src/core/schema-registry.ts`, `src/commands/{validate,get,fill}.ts`

## Problem

Two defects, one root cause: **docmeta assumes the config file lives in `cwd`**.

`loadConfig` only ever looks in `cwd`:

```ts
for (const name of CONFIG_NAMES) {
  const p = resolve(cwd, name);
  // ...
}
return null;   // nothing found -> fall back to DEFAULT_SCHEMAS
```

### Defect 1 — running from a subdirectory silently changes the contract

Sandbox: `docmeta.config.yaml` at the root pins `schemas: [./strict.schema.json]`,
which requires `owner`. The document has `type: guide, title: Hi` — it satisfies
the built-in default set, and violates the configured one.

```console
$ cd $SB && docmeta validate "docs/**/*.md"
✗ docs/api/page.md
    (root)  must have required property 'owner'  (line 1)  [./strict.schema.json]
1 file checked, 0 passed, 1 failed, 1 error
exit=1

$ cd $SB/docs && docmeta validate "api/*.md"
✓ api/page.md
1 file checked, 1 passed, 0 failed, 0 errors
exit=0
```

**Same file, same tool, exit 1 from one directory and exit 0 from another.** The
subdirectory run silently swapped the project's contract for the built-in
default and reported success. This is not a noisy failure the user will notice —
it is a green build that should be red. Anything that runs docmeta with a
non-repo-root working directory hits it: a monorepo package script, a `make -C`
target, a pre-commit hook invoked from a subdirectory, a CI job with a
`working-directory:` key, or a developer who just `cd docs`.

### Defect 2 — `-c` pointing outside `cwd` is already broken

The `-c/--config` flag lets the config live anywhere, so config-dir ≠ cwd is
*already* reachable, and both relative-path kinds resolve against the wrong base:

```console
$ cd $SB/docs && docmeta validate api/page.md -c ../docmeta.config.yaml
exit=2
docmeta: Schema file not found: "./strict.schema.json".

$ cd $SB/docs && docmeta validate -c ../c2.yaml     # c2.yaml: paths: ["docs/**/*.md"]
exit=0
0 files checked, 0 passed, 0 failed, 0 errors

$ cd $SB && docmeta validate -c ./c2.yaml           # control: config dir == cwd
exit=0
✓ docs/api/page.md
1 file checked, 1 passed, 0 failed, 0 errors
```

A local `schemas:` ref hard-errors (exit 2, at least loud). A `paths:` glob
silently resolves to nothing and **exits 0** — false green again, via a
different route.

## Proposal

### 1. Discovery walks up, and stops at a project boundary

```
cwd, then each ancestor, until a boundary directory (inclusive), then give up.
```

A directory is a **boundary** if it contains `.git`. If **no** ancestor has
`.git`, only `cwd` is considered — the walk does not happen at all.

> **As implemented.** The original text said the walk should "stop after the
> user's home directory" when no `.git` ancestor exists. That was changed to
> requiring a `.git` ancestor. Searching home would let a stray
> `~/docmeta.config.yaml` govern any run under it — including this repo's own
> `fill.test.ts` and `cli.integration.test.ts`, which work in OS temp
> directories beneath the user's home. A project-scoped config has no meaning
> without a project boundary, so with no boundary the behavior stays exactly
> what it is today: `cwd` only.

Order within a directory stays `docmeta.config.yaml` then `docmeta.config.yml`.
First file found wins; the walk stops there. No merging of multiple configs (see
stress test 3).

### 2. Relative paths in a config resolve relative to the config file

`loadConfig` already returns `{ config, path }`. Thread the config's directory
through as the base for:

- `paths:` globs,
- `exclude:` globs,
- local-file `schemas:` and `overrides[].schemas` refs,
- the `baseline:` path from [0001](0001-validation-baseline.md).

For every user whose config is in `cwd` — i.e. everyone today — config-dir and
cwd are the same directory, so **this is a no-op for existing setups**. It only
changes cases that are currently broken.

Positional CLI paths stay `cwd`-relative. They are typed by a human in a shell;
the shell's directory is the right base, and shell completion depends on it.

> **As implemented.** A run uses *either* positional paths *or* config `paths:`,
> never both, so there is one resolution base per run:
> `base = usedConfigPaths ? configDir : cwd`. `paths:`, `exclude:`, and every
> file read go through it.
>
> Local-file schema refs from `schemas:`/`overrides[].schemas` are rebased to
> **absolute** paths rather than to base-relative ones, and only when
> `configDir !== cwd`. `loadSchema` reads a file ref relative to
> `process.cwd()`, which a base-relative ref would not survive in the
> config-`paths:` case (`configDir === base`, but neither equals `process.cwd()`),
> and which a library caller passing an explicit `cwd` would not survive at all.
> Guarding on `configDir !== cwd` keeps the ref string byte-identical for every
> setup that works today, so no existing report changes.

### 3. Report which config was used

`loadConfig` returns the resolved path; nothing surfaces it. Add a stderr
diagnostic on non-`pretty` formats and a header line on `pretty`:

```
Using docmeta.config.yaml (../..)
```

Cheap, and it is the difference between a five-minute diagnosis and an hour of
confusion when a run picks up an unexpected ancestor config.

## Stress test

### 1. Walking to the filesystem root — rejected

The naive version walks until `/` or `C:\`. That lets a stray
`docmeta.config.yaml` in `$HOME`, or worse in `C:\`, silently govern every repo
on the machine. It also makes behavior depend on files outside the repo, so CI
and local disagree. The `.git` boundary keeps the search inside the project.

Stopping at `$HOME` — the fallback this proposal originally specified for the
no-`.git` case — was rejected for the same reason during implementation, and for
a concrete one: this repo's own `fill.test.ts` and `cli.integration.test.ts`
work in OS temp directories that live under the user's home on Windows and
macOS, so a `~/docmeta.config.yaml` would have silently governed the test suite.
**With no `.git` ancestor, only `cwd` is searched** — today's behavior,
unchanged. That is also the honest answer: without a project boundary there is
no project for a project-scoped config to scope.

### 2. No `.git` — the worktree case, verified relevant here

This very repo runs from `.claude/worktrees/<name>/`, where `.git` is a **file**,
not a directory. A boundary check of `isDirectory()` would walk straight past it
into the parent checkout and could pick up the *outer* branch's config — a new
instance of exactly the bug CLAUDE.md already documents for `node_modules`
resolution in worktrees. The check must be `existsSync(join(dir, ".git"))`,
accepting both a directory and a gitfile.

No OS-specific branching is needed. A Windows gitfile holds an absolute
`gitdir: C:\path\to\...\worktrees\<name>`, but boundary detection only asks whether
`.git` **exists**, never what it points at — so `existsSync` is true either way and
one line covers Windows, Linux, submodules, and worktrees alike. Stated explicitly
so an implementer does not go hunting for a platform special case that is not
required.

### 3. Merging ancestor configs — rejected

ESLint-style cascading (merge each ancestor, nearest wins per key) was
considered. Rejected: docmeta's `schemas:` is a **set** that a file must satisfy
in full, and `overrides:` is first-match-wins ordered. Merging two ordered
override lists has no obvious correct semantics, and a partially merged schema
set silently changes what "the contract" means. First-found-wins is
predictable and explains itself in one sentence.

### 4. A subdirectory config shadowing the root — accepted and intended

With first-found-wins, `docs/docmeta.config.yaml` shadows the root config for
runs inside `docs/`. That is the intended escape hatch for a genuinely different
subtree, and it is consistent with `overrides:` at the root. It does mean two
ways to express per-directory rules; the reference page should point at
`overrides:` as the default and per-directory configs as the exception.

### 5. Does the walk change any currently-passing run? — analyzed

A run that finds a config today keeps finding the same one (cwd is searched
first). A run that finds none today may now find an ancestor's, which is the
entire point — but it means a repo relying on the *default* schema set while a
config exists above it will change behavior. That is a fix, not a regression, and
the new "Using …" line makes it visible. It is nonetheless a **behavior change
that warrants a minor-version note**, and per CLAUDE.md this project is pre-1.0
about CLI breaks anyway.

### 6. Escape hatch for "ignore any ancestor config" — required

Once the walk exists, a user needs a way to opt out (testing, a deliberately
unconfigured run, generating a baseline against defaults). Add `--no-config`.
Without it, the only way to get default behavior is to `cd` somewhere outside the
repo, which is absurd.

### 7. Symlinks and case-insensitive filesystems — bounded

The walk uses `path.dirname` on an already-resolved absolute path, so it follows
the logical path, not symlink targets. On Windows, `docmeta.config.YAML` matches
case-insensitively at the OS layer, which is inconsistent with Linux CI. Not
introduced by this change and not worth special-casing; noted so it is not
mistaken for a new bug.

### 8. Cost of the walk — measured as negligible

Worst case is two `readFile` attempts per ancestor. Depth from a docs
subdirectory to a git root is typically under six. Compared to the existing
per-run remote schema fetch (10 s timeout, per
[0008](0008-remote-schema-durability.md)) this is noise. `loadConfig` is called
once per command invocation, not per file.

### 9. Interaction with 0014 — this proposal is not sufficient alone

Defect 2's `paths:` case exits 0 with zero files. Fixing resolution makes the
glob match, but a *typo'd* glob in a correctly-located config still silently
exits 0. 0004 and [0014](0014-empty-input-is-not-success.md) are complementary;
neither subsumes the other.

## Implementation sketch

1. `test/config.test.ts` — walk finds an ancestor config; stops at a `.git`
   **file** as well as a directory; stops at home; `--no-config` suppresses.
2. `test/config.test.ts` — returned `path` is absolute and its directory is
   exposed for callers.
3. `test/resolve-schema.test.ts` — a local `schemas:` ref resolves against the
   config directory, not cwd (reproduces defect 2A as a red test).
4. `test/load-files.test.ts` — `paths:`/`exclude:` resolve against the config
   directory (reproduces defect 2B).
5. `test/cli.integration.test.ts` — the subdirectory false-green from defect 1
   now exits 1; the "Using …" line appears.
6. Fixtures: `test/fixtures/nested-config/` with a root config, a nested doc, and
   a local schema referenced relatively.

Then `reference/configuration.mdx` (discovery order and the resolution base) and
`reference/cli.mdx` for `--no-config` (`npm run docs:check-cli` enforces).
