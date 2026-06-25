# CLAUDE.md

Guidance for agents working in this repository.

## What docmeta is

A TypeScript CLI (published to npm) that validates the **presence and format**
of document metadata (frontmatter / headers) against **JSON Schema**, built for
CI. The pipeline is: load files → extract metadata (format-specific) → resolve a
schema set per file → validate → report. Everything after extraction operates on
the generic `ExtractedMetadata` shape, so new input formats never touch
validation, schema resolution, or reporting.

Key layers:
- `src/extractors/` — per-format metadata extraction behind the
  `MetadataExtractor` interface (`src/types.ts`). New formats are an isolated
  change to one file plus registration in `src/extractors/index.ts`.
- `src/commands/` — command cores (`validate`, `get`, `schemas`), kept free of
  CLI/IO plumbing so they can be unit-tested directly.
- `src/cli.ts` — thin commander wrapper over the command cores.
- `src/core/` — shared file resolution, config, schema resolution, validation.
- `src/reporters/` — output formatting (pretty / json / github).

## Working agreements

These are project preferences. Follow them unless the user says otherwise.

### Commands must have parallel behaviors

Every subcommand should expose a **consistent surface**. When one command gains
an input affordance, the others should match it (where it makes sense). Concrete
baseline shared by `validate` and `get`:

- Targets are **positional** `[paths...]` — files, directories, and globs.
- `-` reads **stdin** (requires `--as <format>` to pick an extractor).
- `paths:` from `docmeta.config.yaml` is the **fallback** when no positional
  paths are given.
- No inputs and no config is an **operational error** (`DocmetaError`, exit 2),
  not silent empty output.
- Shared flags use the same names/semantics: `--as`, `--ext`, `--exclude`,
  `-c/--config`, `-f/--format`.

Do not introduce per-command input conventions (e.g. an `--in` option on one
command but positional paths on another). If a parser limitation forces a
difference, prefer changing how the *other* argument is supplied rather than
breaking parity. (This is pre-1.0; breaking CLI changes are acceptable — do not
keep deprecated aliases unless asked.)

### Red/green TDD

Develop test-first:

1. **Red** — write or adjust tests for the new behavior and run them; confirm
   they fail for the right reason.
2. **Green** — implement the minimum to make them pass.
3. **Refactor** — clean up with the tests as a safety net.

When a behavior change makes existing tests fail correctly (e.g. a removed flag),
update those tests as part of the red step rather than working around them.

### Test fixtures per feature

When a feature needs sample input, add a **dedicated fixture** under
`test/fixtures/` rather than embedding large literals in tests or reusing an
unrelated fixture. Keep fixtures minimal and named for what they exercise (e.g.
`bad-timestamp.md`, `missing-type.md`). Inline string content is fine for small
stdin/parse cases.

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
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest run (unit + built-bin CLI integration)
npm run build       # tsup -> dist/ (needed before CLI integration tests)
```

Command cores are tested directly in `test/*.test.ts`; the full CLI is exercised
against the built `dist/cli.js` in `test/cli.integration.test.ts`.
