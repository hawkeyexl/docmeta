# CLAUDE.md

Guidance for agents working in this repository.

## What moose-meta is

A TypeScript CLI (published to npm) that validates the **presence and format**
of document metadata (frontmatter / headers) against **JSON Schema**, built for
CI. The pipeline is: load files → extract metadata (format-specific) → resolve a
schema set per file → validate → report. Everything after extraction operates on
the generic `ExtractedMetadata` shape, so new input formats never touch
validation, schema resolution, or reporting.

Key layers:
- `src/extractors/`: per-format metadata extraction behind the
  `MetadataExtractor` interface (`src/types.ts`). New formats are an isolated
  change to one file plus registration in `src/extractors/index.ts`.
- `src/commands/`: command cores (`validate`, `get`, `fill`, `schemas`), kept free of
  CLI/IO plumbing so they can be unit-tested directly.
- `src/cli.ts`: thin commander wrapper over the command cores.
- `src/core/`: shared file resolution, config, schema resolution, validation.
- `src/reporters/`: output formatting (pretty / json / github).

## Working agreements

These are project preferences. Follow them unless the user says otherwise.

### Commands must have parallel behaviors

Every subcommand should expose a **consistent surface**. When one command gains
an input affordance, the others should match it (where it makes sense). Concrete
baseline shared by `validate`, `get`, and `fill`:

- Targets are **positional** `[paths...]`: files, directories, and globs.
- `-` reads **stdin** (requires `--as <format>` to pick an extractor). It is one
  more input, processed *alongside* any named paths, never instead of them.
- `paths:` from `moose-meta.config.yaml` is the **fallback** when no positional
  paths are given.
- No inputs and no config is an **operational error** (`MooseMetaError`, exit 2),
  not silent empty output.
- Shared flags use the same names/semantics: `--as`, `--ext`, `--exclude`,
  `-c/--config`, `-f/--format`.

Do not introduce per-command input conventions (e.g. an `--in` option on one
command but positional paths on another). If a parser limitation forces a
difference, prefer changing how the *other* argument is supplied rather than
breaking parity. (This is pre-1.0; breaking CLI changes are acceptable, so do not
keep deprecated aliases unless asked.)

### Red/green TDD

Develop test-first:

1. **Red**: write or adjust tests for the new behavior and run them; confirm
   they fail for the right reason.
2. **Green**: implement the minimum to make them pass.
3. **Refactor**: clean up with the tests as a safety net.

When a behavior change makes existing tests fail correctly (e.g. a removed flag),
update those tests as part of the red step rather than working around them.

### Test fixtures per feature

When a feature needs sample input, add a **dedicated fixture** under
`test/fixtures/` rather than embedding large literals in tests or reusing an
unrelated fixture. Keep fixtures minimal and named for what they exercise (e.g.
`bad-timestamp.md`, `missing-type.md`). Inline string content is fine for small
stdin/parse cases.

### Content & documentation work

Before any user-facing writing or docs task, consult `docs/content-strategy/`:

1. Identify the **persona** the page serves: Maya (docs engineer), Devin (CI engineer), Sara (schema author), or Theo (contributor fixing a failure). See `personas.md`.
2. Find the matching **CUJ** in `cujs.md` (M1–M3, D1–D3, S1–S3, T1). Structure the content around reaching that outcome, not by document type or Diátaxis category.
3. Link into the **Reference shelf** (`reference/`) for exhaustive detail (flag tables, config keys, precedence chain). Journey pages explain the path; they don't duplicate reference.
4. Check `information-architecture.md` for the page's place in the content set and its ★ launch status.
5. Every page in `docs/src/content/docs/**` needs `title` and `description` frontmatter.

### Changing a dependency: splice the lockfile, never regenerate it

`npm install <dep>` **on Windows** does not just add that dep. It re-resolves
unrelated transitive packages and drops the top-level `@emnapi/core` /
`@emnapi/runtime` entries that satisfy `@napi-rs/wasm-runtime`, nesting copies
under `@rolldown/binding-wasm32-wasi` instead. npm prunes entries for optional
packages it won't install on the current platform while keeping the dependency
edges — an incomplete graph that `npm install` tolerates and `npm ci` rejects.
On Linux CI, every workflow starts with `npm ci`, so build-test, lint, docs and
doc-detective all go red at once with `Missing: @emnapi/core@<ver> from lock
file`.

**Do not trust any whole-tree regeneration on Windows.** All of these produce
broken lockfiles:

- `npm install <dep>` — drops the emnapi entries
- `rm -rf node_modules package-lock.json && npm install` — breaks differently
- `npm install --package-lock-only` — same pruning
- **running `npm install` twice** — converges locally and passes `npm ci` *on
  Windows*, then still fails on Linux. A local `npm ci` pass does **not** prove CI.
- `npm link` / `npm unlink` — same pruning, and easy to miss because you ran it to
  test something else entirely. Running the doc-detective suite locally needs
  `npm link`, so **check `git status` afterwards and `git checkout --
  package-lock.json` if it was touched.**

The fix is to splice. Start from the committed lockfile
(`git show origin/main:package-lock.json`), copy in **only** what the change
genuinely introduces — the dep's own entry, `packages[""].dependencies`, and any
`dev`/`peer` flags that legitimately flip when a package becomes reachable from a
production dep — re-sort keys (root first, then lexicographic), and write it back.

Then diff the result against `origin/main`'s lockfile and confirm:

```
added: [...only genuinely new packages...]   removed: []   changed: [...only the above...]
```

`removed` must be empty, and every entry in `changed` must be one you can name.
That check is the real gate.

### Working in a worktree: run `npm ci` first

Worktrees live at `.claude/worktrees/<name>/`, **inside** the main checkout. A
worktree with no `node_modules` therefore does not fail — Node's resolution
walks up and silently finds the outer checkout's `node_modules`, which belongs
to whatever branch happens to be checked out there. `tsc` and `vitest` then run
against another branch's dependency tree, and the type errors and test failures
that come back read exactly like real code bugs. Diagnosing that once cost a
detour through four "pre-existing failures" that were nothing of the kind.

`npm ci` is the fix, and it is safe under the lockfile rule above: it installs
*from* `package-lock.json` and never rewrites it. (`npm install` does rewrite
it — see above.)

`npm run check:deps` asserts direct dependencies are installed in this checkout
at the locked versions, and names the outside directory when the walk happens.
It runs automatically before `test`, `typecheck`, and `build`, so the walk now
announces itself instead of being diagnosed. Before believing any failure that
smells like a dependency, check that it passes.

### Other conventions

- **Strict TypeScript.** `tsconfig` enables strict settings including
  `noUncheckedIndexedAccess`. Avoid unsound casts and non-null assertions; guard
  indexed access and regex capture groups.
- **Conventional Commits.** Commit messages are linted by commitlint and drive
  semantic-release (`fix:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE`
  → major). Scope extractor work as `feat(extractors): …`.
- **clig.dev output discipline.** Primary output to stdout, diagnostics to
  stderr; color only on a TTY and never under `NO_COLOR`/`--no-color`. Exit
  codes: `0` ok, `1` validation failures, `2` operational/usage errors.

## Commands

```bash
npm ci              # first thing in a fresh worktree — see the worktree note above
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest run (unit + built-bin CLI integration)
npm run build       # tsup -> dist/ (needed before CLI integration tests)
npm run check:deps  # deps installed here, at locked versions (auto-runs before the three above)
npm run docs:check-cli  # CLI reference must match src/cli.ts

# After editing anything under docs/, run the dogfood check too. moose-meta
# validates its own docs, and the Docs deploy is gated on it.
node dist/cli.js validate "docs/src/content/docs/**/*.{md,mdx}" \
  -s ./docs/doc-frontmatter.schema.json
```

Command cores are tested directly in `test/*.test.ts`; the full CLI is exercised
against the built `dist/cli.js` in `test/cli.integration.test.ts`.

**Editing docs frontmatter is a validation change, not a prose change.** A
`description:` containing `: ` is invalid YAML unless quoted, so a rephrase can
break the parse. Run the dogfood command above before pushing; it is what the
deploy gates on.
