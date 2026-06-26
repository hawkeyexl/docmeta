# Contributing to docmeta

Thanks for your interest in improving docmeta. This guide covers local setup, the development loop, and the conventions the project follows. Whether you're fixing a bug or adding support for a new input format, the steps below should get you productive quickly.

## Prerequisites

- **Node.js 20 or later** (see `engines` in `package.json`).
- npm (ships with Node).

## Setup

```bash
git clone https://github.com/hawkeyexl/docmeta.git
cd docmeta
npm install
```

`npm install` runs the `prepare` script, which sets up the Husky git hooks (including the `commit-msg` hook that lints your commit messages — see [Commit messages](#commit-messages)).

## Development loop

Three scripts cover everyday work:

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest run
npm run build       # tsup -> dist/
```

A couple of things worth knowing:

- **Command cores are unit-tested directly.** Tests in `test/*.test.ts` exercise the command cores (`validate`, `get`, `schemas`) and the shared core modules without going through the CLI.
- **CLI integration tests run against the built `dist/`.** `test/cli.integration.test.ts` invokes the compiled binary, so run `npm run build` before `npm test` if you've changed anything the integration tests depend on. Otherwise those tests run against a stale (or missing) build.

Before opening a pull request, make sure `npm run typecheck` and `npm test` both pass.

## Test-first development (red/green)

Please develop test-first:

1. **Red** — write or adjust tests for the new behavior and run them. Confirm they fail for the right reason.
2. **Green** — implement the minimum needed to make them pass.
3. **Refactor** — clean up with the tests as a safety net.

When a behavior change makes existing tests fail correctly (for example, you removed a flag), update those tests as part of the red step rather than working around them.

### A test fixture per feature

When a feature needs sample input, add a dedicated fixture under `test/fixtures/` rather than embedding large literals in a test or reusing an unrelated fixture. Keep fixtures minimal and name them for what they exercise (for example, `bad-timestamp.md`, `missing-type.md`). Small inline strings are fine for stdin or quick parse cases.

## TypeScript conventions

The project runs with strict TypeScript, including `noUncheckedIndexedAccess`. A few habits keep the build green:

- Guard indexed access and regex capture groups before using them.
- Avoid unsound casts and non-null assertions (`!`).

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and are linted by commitlint (locally via the Husky `commit-msg` hook, and on pull requests in CI). The commit type drives automated releases through [semantic-release](https://semantic-release.gitbook.io/):

| Commit type | Release |
|-------------|---------|
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` or a `BREAKING CHANGE:` footer | major |

Scope work where it helps readers. New input formats use the `extractors` scope:

```text
feat(extractors): add TOML frontmatter support
```

This is pre-1.0, so breaking CLI changes are acceptable when they improve the tool — call them out with `feat!:` or a `BREAKING CHANGE:` footer so the release tooling bumps the major version.

## Keeping commands consistent

Every subcommand should expose a consistent surface. When one command gains an input affordance, the others should match it where it makes sense. The shared baseline for `validate` and `get`:

- Targets are positional `[paths...]` — files, directories, and globs.
- `-` reads stdin (and requires `--as <format>` to pick an extractor).
- `paths:` from `docmeta.config.yaml` is the fallback when no positional paths are given.
- Shared flags use the same names and semantics: `--as`, `--ext`, `--exclude`, `-c/--config`, `-f/--format`.

Avoid introducing per-command input conventions (for example, an `--in` option on one command but positional paths on another).

When you change the CLI surface — add, rename, or remove a command, argument, flag, or default — update the [CLI reference](docs/src/content/docs/reference/cli.mdx) to match. A drift check enforces this:

```bash
npm run build         # the check reads the built CLI
npm run docs:check-cli # fails if the page and src/cli.ts disagree
```

The script (`scripts/check-cli-reference.mjs`) introspects the real commander program via `buildProgram()` and compares the documented commands, arguments, options, and value-defaults against the code. Descriptions stay hand-written; only the machine-checkable surface is enforced. CI runs this on every push.

## Adding a new input format

Metadata extraction is a pluggable layer. A new format is an isolated change — it never touches validation, schema resolution, or reporting. To add one:

1. **Implement the `MetadataExtractor` interface** (defined in [`src/types.ts`](src/types.ts)) in a new file under `src/extractors/`. Use an existing extractor — say `src/extractors/markdown.ts` — as a template.
2. **Register it** in [`src/extractors/index.ts`](src/extractors/index.ts) by adding it to the `EXTRACTORS` array.
3. **Add a test and fixture.** Cover the new format in `test/extractors.test.ts` and add a minimal sample under `test/fixtures/`, following the red/green flow above.

The `MetadataExtractor` interface returns an `ExtractedMetadata` object: the parsed `data`, whether a metadata block was `present`, the `format` name, and a `lineFor()` function that maps a field to its source line for precise error annotations. Set `implemented: true` once the extractor is wired up; roadmap stubs can register with `implemented: false` so the `schemas` command can report them as planned.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
