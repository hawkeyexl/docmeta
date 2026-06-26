# docmeta

Validate the **presence and format** of document metadata against **JSON Schema** — built for CI.

`docmeta` checks the frontmatter in your Markdown (and, soon, other formats) against one or more JSON Schemas. It ships with the [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) schema built in, follows [clig.dev](https://clig.dev) conventions, and returns a nonzero exit code (plus optional GitHub annotations) when validation fails.

## Install

```bash
npm install -g docmeta
# or run without installing:
npx docmeta validate "**/*.md"
```

Requires Node.js 20+.

## Quick start

```bash
# Validate a file, a directory (recursive), or a glob against OKF (the default)
docmeta validate docs/intro.md
docmeta validate docs/
docmeta validate "**/*.md"
```

```text
✗ docs/intro.md
    (root)      must have required property 'type'   (line 1)  [google:okf:0.1]
    /timestamp  must match format "date-time"        (line 9)  [google:okf:0.1]

12 files checked, 11 passed, 1 failed, 2 errors
```

## Schemas

### Built-in schemas

Built-ins are addressed by a `vendor:name:version` id. List them with:

```bash
docmeta schemas
```

| id | description |
|----|-------------|
| `google:okf:0.1` | Open Knowledge Format v0.1 — requires `type`; recommends `title`, `description`, `resource` (URI), `tags`, `timestamp` (ISO 8601); tolerates unknown keys. |

A schema reference (`<ref>`) is one of:

- a built-in id, e.g. `google:okf:0.1`
- a local file path ending in `.json`
- an `http(s)://` URL

### Validating against multiple schemas (a schema *set*)

Each file is validated against a **set** of schemas and passes only if it satisfies **every** one. Each error is tagged with the schema that produced it. The set is chosen by precedence:

1. **`--schema` (CLI, repeatable)** — applies to all files, overriding everything below.
2. **`$schema` in the file's frontmatter** — a single ref or a list:
   ```yaml
   ---
   $schema:
     - google:okf:0.1
     - ./schemas/house-style.json
   type: concept
   ---
   ```
3. **A matching `overrides` entry in the config** (per-glob).
4. **The config's default `schemas`.**
5. **The built-in default `google:okf:0.1`.**

The `$schema` key is stripped before validation, so it never trips `additionalProperties`/`required` checks.

## Config (`docmeta.config.yaml`)

Optional. Lets CI run a bare `docmeta validate`. All keys are optional:

```yaml
paths:
  - "docs/**/*.md"
exclude:
  - "**/drafts/**"
schemas:
  - google:okf:0.1
overrides:
  - files: "articles/**/*.md"
    schemas:
      - google:okf:0.1
      - ./schemas/article.json
```

See [examples/docmeta.config.yaml](examples/docmeta.config.yaml).

## CLI

```text
docmeta validate [paths...]        Validate metadata (default command)
docmeta get <fields> [paths...]    Print specific metadata values
docmeta schemas                    List built-in schemas and input formats
```

### `validate`

| flag | description |
|------|-------------|
| `-s, --schema <ref>` | Schema to validate against; repeatable; overrides `$schema`/config |
| `--ext <list>` | Comma-separated extensions for directory walks |
| `--exclude <glob>` | Glob to exclude; repeatable |
| `--as <format>` | Force an input format (e.g. `markdown`, `mdx`) — required for stdin |
| `-f, --format <format>` | Output: `pretty` (default), `json`, or `github` |
| `-c, --config <path>` | Path to a config file |
| `-q, --quiet` | In pretty output, hide passing files |
| `--no-color` | Disable color (also respects `NO_COLOR`) |

```bash
docmeta validate page.md -s google:okf:0.1 -s ./my.schema.json
docmeta validate "**/*.md" --format github --exclude "**/drafts/**"
cat page.md | docmeta validate - --as markdown
```

### `get`

`get` shares `validate`'s input handling: positional files, directories, and
globs; `-` for stdin (with `--as`); and `paths:` from config as a fallback.
Fields are a single comma-separated argument.

```bash
docmeta get title,type docs/intro.md
docmeta get type "**/*.md" --format json
cat page.md | docmeta get title - --as markdown
```

### Output & exit codes

- **pretty** (default): human-readable, grouped by file, colorized on a TTY.
- **json**: `{ summary, results[] }` to stdout for machine parsing.
- **github**: `::error file=…,line=…::[schema] field message` annotations.

| exit code | meaning |
|-----------|---------|
| `0` | all files valid |
| `1` | validation failures |
| `2` | operational/usage error (no paths, unknown schema, unsupported format, parse error) |

Primary output goes to **stdout**; diagnostics go to **stderr**.

## CI

Drop [examples/docmeta.yml](examples/docmeta.yml) into `.github/workflows/`, or add a step:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npx -y docmeta validate "**/*.md" --format github
```

## Supported formats & roadmap

Implemented:

- **Markdown** (`.md`, `.markdown`) and **MDX** (`.mdx`) — YAML frontmatter.
- **AsciiDoc** (`.adoc`, `.asciidoc`) — accepts either a leading YAML
  frontmatter block (`--- … ---`) or the native document header: the `= Title`
  line plus `:key: value` attribute entries. Attribute values are parsed as YAML
  scalars (so `2` → number, `true` → boolean); a valueless `:flag:` is `true`
  and an unset `:!flag:` is `false`.
- **reStructuredText** (`.rst`) — accepts either a leading YAML frontmatter
  block (`--- … ---`) or native page metadata: the document title (a section
  heading underlined, and optionally overlined, with punctuation) collected as
  `title`, plus a docinfo field list (`:key: value` entries) below it. Field
  values are parsed as YAML scalars (so `2` → number, `[a, b]` → array); a
  valueless `:flag:` is `true`. An explicit `:title:` field overrides the
  heading.
- **XML** (`.xml`) — reads the root element's attributes (e.g.
  `<document type="concept" version="2">`). Values are parsed as YAML scalars
  (so `2` → number, `true` → boolean); `xmlns`/`xmlns:*` namespace declarations
  are ignored.
- **HTML** (`.html`, `.htm`) — reads `<title>` and `<meta>` tags. `<meta
  name="X" content="Y">` (or `property="X"` for OpenGraph) becomes `X: Y`, with
  `content` parsed as a YAML scalar (so `2` → number, `true` → boolean); tags
  with neither `name` nor `property` (e.g. `charset`) are ignored.

Metadata extraction is a pluggable layer: new formats plug in behind the
extractor interface without changing validation, schema resolution, or
reporting. Future work includes MDX `export const meta` parsing and XML's
metadata-element style.

## Programmatic API

```ts
import { runValidate } from "docmeta";

const { results, summary } = await runValidate({
  inputs: ["docs/**/*.md"],
  cliSchemas: ["google:okf:0.1"],
});
```

## Contributing & releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and are linted by commitlint (a husky `commit-msg` hook locally, and `commitlint.yml` on PRs).

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/):

- Push/merge to `main` → version is computed from commit types (`fix:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE` → major; `perf:` does not release), then `CHANGELOG.md`/`package.json` are updated, a tag and GitHub Release are created, and the package is published to npm `@latest`.
- `next` → `@next` prerelease channel; `feat/**` branches → per-branch prerelease channels.

Requires an `NPM_TOKEN` repository secret (npm automation token); the default `GITHUB_TOKEN` handles the tag, release commit, and GitHub Release.

## License

MIT
