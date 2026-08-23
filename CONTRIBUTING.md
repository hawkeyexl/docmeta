# Contributing to docmeta

Thanks for your interest in improving docmeta. This guide covers local setup, the development loop, and the conventions the project follows. Whether you're fixing a bug or adding support for a new input format, the steps below should get you productive quickly.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js 24 or later** (see `engines` in `package.json`).
- npm (ships with Node).

## Setup

```bash
git clone https://github.com/hawkeyexl/docmeta.git
cd docmeta
npm install
```

`npm install` runs the `prepare` script, which sets up the Husky git hooks (including the `commit-msg` hook that lints your commit messages; see [Commit messages](#commit-messages)).

## Development loop

Four scripts cover everyday work:

```bash
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint, type-aware
npm test            # vitest run
npm run build       # tsup -> dist/
```

A couple of things worth knowing:

- **Command cores are unit-tested directly.** Tests in `test/*.test.ts` exercise the command cores (`validate`, `get`, `fill`, `schemas`) and the shared core modules without going through the CLI. `fill` reaches an LLM provider, so its tests inject a `MockProvider` and never touch the network.
- **CLI integration tests run against the built `dist/`.** `test/cli.integration.test.ts` invokes the compiled binary, so run `npm run build` before `npm test` if you've changed anything the integration tests depend on. Otherwise those tests run against a stale (or missing) build.

- **Lint is type-aware.** eslint runs `typescript-eslint`'s `strictTypeChecked` set over `src/` and `test/`, so it needs type information and is slower than a syntax-only linter. It catches a class `tsc` does not: an *inferred* `any` crossing a boundary — a commander callback parameter, a `JSON.parse`, a `ReadableStream<any>` — where the unsafety never appears as the word `any` in the source.
- **Coverage is reported, not gated.** `npm run test:coverage` prints a summary; there are no thresholds to trip over. Treat a number that drops sharply as worth a look, not as a build failure.

Before opening a pull request, make sure `npm run typecheck`, `npm run lint`, and `npm test` all pass.

## Test-first development (red/green)

Please develop test-first:

1. **Red**: write or adjust tests for the new behavior and run them. Confirm they fail for the right reason.
2. **Green**: implement the minimum needed to make them pass.
3. **Refactor**: clean up with the tests as a safety net.

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

docmeta is past 1.0 and published to npm, so a breaking change is not free: semantic-release turns it into a major version and a release note. That is a cost worth paying when a change genuinely improves the tool, but not one to absorb by accident. Call breaking changes out with `feat!:` or a `BREAKING CHANGE:` footer so the release tooling bumps the major version — and prefer making the change cleanly over softening it with a deprecated alias, which leaves a permanent second surface behind.

## Keeping commands consistent

Every subcommand should expose a consistent surface. When one command gains an input affordance, the others should match it where it makes sense. The shared baseline for `validate`, `get`, and `fill`:

- Targets are positional `[paths...]`: files, directories, and globs.
- `-` reads stdin (and requires `--as <format>` to pick an extractor). It is one more input, so it is processed *alongside* any named paths, never instead of them.
- `paths:` from `docmeta.config.yaml` is the fallback when no positional paths are given.
- No inputs and no config is an operational error (exit 2), not silent empty output.
- Shared flags use the same names and semantics: `--as`, `--ext`, `--exclude`, `-c/--config`, `-f/--format`.

Avoid introducing per-command input conventions (for example, an `--in` option on one command but positional paths on another).

When you change the CLI surface, whether adding, renaming, or removing a command, argument, flag, or default, update the [CLI reference](docs/src/content/docs/reference/cli.mdx) to match. A drift check enforces this:

```bash
npm run build         # the check reads the built CLI
npm run docs:check-cli # fails if the page and src/cli.ts disagree
```

The script (`scripts/check-cli-reference.mjs`) introspects the real commander program via `buildProgram()` and compares the documented commands, arguments, options, and value-defaults against the code. Descriptions stay hand-written; only the machine-checkable surface is enforced. CI runs this on every push.

## Adding a new input format

Metadata extraction is a pluggable layer. A new format is an isolated change; it never touches validation, schema resolution, or reporting. To add one:

1. **Implement the `MetadataExtractor` interface** (defined in [`src/types.ts`](src/types.ts)) in a new file under `src/extractors/`. Use an existing extractor, say `src/extractors/markdown.ts`, as a template.
2. **Register it** in [`src/extractors/index.ts`](src/extractors/index.ts) by adding it to the `EXTRACTORS` array.
3. **Add a test and fixture.** Cover the new format in `test/extractors.test.ts` and add a minimal sample under `test/fixtures/`, following the red/green flow above.

The `MetadataExtractor` interface returns an `ExtractedMetadata` object: the parsed `data`, whether a metadata block was `present`, the `format` name, and a `lineFor()` function that maps a field to its source line for precise error annotations. Set `implemented: true` once the extractor is wired up; a format registered before its parser works sets `implemented: false`, which keeps it out of directory walks and has the `schemas` command report it as planned.

### Write support is optional

`MetadataExtractor` also has an optional `apply(content, patch)`, which
[`docmeta fill`](https://hawkeyexl.github.io/docmeta/reference/cli/#fill) uses to
write metadata back. Leaving it off is a valid choice, and the absence is the
capability check: `typeof extractor.apply === "function"`. TypeScript then makes
every call site handle the read-only case.

Only implement it if the format can round-trip without disturbing the rest of
the document. The test is whether you can find the exact character range the
value occupies: fenced frontmatter can, because the write is a splice of the
characters between the fences (`src/extractors/frontmatter-write.ts`), and so
can HTML, because parse5 reports a byte range for every tag and attribute
(`src/extractors/html-write.ts`). XML needs one step more, because xmldom
reports only where each attribute starts — `src/extractors/xml-locate.ts`
rebuilds the range, and documents why its line index has to recognise six
break forms rather than one. A format whose read is lossy should stay read-only
rather than guess: `rst` and `asciidoc` write only into a fenced block that
already exists, because their native docinfo and header syntax does not survive
a round trip.

A writer may also need more than one strategy within a format. `xml` writes
plain XML by setting a root attribute, but writes DITA into
`<prolog><metadata><othermeta/></metadata></prolog>` (or `<topicmeta>` for a
map), because DITA's DTD declares which root attributes a topic may carry and
adding an undeclared one produces a file the user's toolchain rejects. Where a
format has two such channels, `xml-read.ts` decides precedence once and reports
it, and `dita-write.ts` aims at what it reports.

Two rules apply to any writer you add:

- **Verify by re-parsing before returning.** A serializer bug should become a
  refusal, not a corrupted file.
- **Write back to wherever the read took the value from.** `fill` corrects
  values that are present but invalid, not just missing ones, so a format with
  more than one metadata channel can otherwise gain a correction beside the
  stale value the reader actually honors — a green report on a wrong page. Where
  precedence is decided, decide it once and share it: `html-read.ts` exports a
  `sources` map for exactly this, and `html-write.ts` aims at it rather than
  carrying its own copy of the rule.

Cover fenced formats in `test/frontmatter-write.test.ts` and others in their own
file (`test/html-write.test.ts`).

## Reporting a security issue

Not as a public issue. docmeta fetches schemas over the network and runs inside other people's CI pipelines, so a public report is a disclosure to every one of them before there is a version to upgrade to. Use [private vulnerability reporting](https://github.com/hawkeyexl/docmeta/security/advisories/new) instead; [SECURITY.md](SECURITY.md) covers the supported versions, the trust boundaries, and what is already a documented decision rather than a bug.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
