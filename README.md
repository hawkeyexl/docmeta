# docmeta

Validate the **presence and format** of document metadata against **JSON Schema**, built for CI.

[![npm](https://img.shields.io/npm/v/docmeta?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/docmeta)
[![CI](https://github.com/hawkeyexl/docmeta/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hawkeyexl/docmeta/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/docmeta?color=5fa04e&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/docmeta?color=blue)](LICENSE)

`docmeta` checks the metadata in your documents (Markdown frontmatter and more)
against one or more JSON Schemas. It verifies that required fields are present
and correctly formatted: a `type`, an ISO 8601 `timestamp`, a URI `resource`. It
does not judge prose quality. It ships with 23 [built-in
schemas](https://hawkeyexl.github.io/docmeta/reference/built-in-schemas/). They
cover content vocabularies such as the [Open Knowledge Format
(OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md),
[Diátaxis](https://diataxis.fr/), [The Good Docs
Project](https://www.thegooddocsproject.dev/template), and the [Seven-Action
model](https://passo.uno/seven-action-model/). They also cover the front matter
contracts of site generators such as
[Docusaurus](https://docusaurus.io/docs/api/plugins/@docusaurus/plugin-content-docs#markdown-front-matter)
3.10, Hugo, Jekyll, and MkDocs Material. Run `docmeta schemas` for the full
list. It follows [clig.dev](https://clig.dev) conventions and returns a nonzero
exit code (plus optional GitHub annotations) when validation fails.

It can also **fill in** the metadata that is missing, so adopting a standard on an existing docset is not a data-entry project.

## Install

```bash
npm install -g docmeta
# or run it without installing:
npx docmeta validate "**/*.md"
```

Requires Node.js 24 or later.

## Quick start

Point `docmeta validate` at a file, a directory (walked recursively), or a glob. With no `--schema`, it validates against the default set: the built-in OKF schema plus `passo-uno:seven-action:1.0`, which constrains an optional `action` field and requires nothing on its own.

```bash
docmeta validate docs/intro.md
```

```text
✗ docs/intro.md
    (root)      must have required property 'type'   (line 1)  [google:okf:0.1]
    /timestamp  must match format "date-time"        (line 9)  [google:okf:0.1]

1 file checked, 0 passed, 1 failed, 0 errors
```

A clean run exits `0`; validation failures exit `1`; operational errors (no input, unknown schema, parse error) exit `2`.

## Run it in CI

On GitHub Actions, use the packaged action. It sets up Node, pins the CLI, and
defaults to inline PR annotations:

```yaml
- uses: actions/checkout@v4
- uses: hawkeyexl/docmeta@v4
  with:
    paths: "docs/**/*.md"
```

Every input is in the [Action
reference](https://hawkeyexl.github.io/docmeta/reference/action/). Other
platforms run the CLI directly. The [CI
recipes](https://hawkeyexl.github.io/docmeta/ci/recipes/) cover GitLab CI,
Jenkins, and the rest.

To catch problems before they reach CI, docmeta publishes a
[pre-commit](https://pre-commit.com/) hook. The whole configuration is three
lines, and the file-matching pattern is derived from the extensions docmeta
actually reads rather than hand-written:

```yaml
repos:
  - repo: https://github.com/hawkeyexl/docmeta
    rev: v4.1.2
    hooks:
      - id: docmeta
```

## Fill in what's missing

`docmeta fill` infers the metadata properties your schema asks for but a page
does not carry, and writes back the values it is confident about. It is the
fast way to clear the backlog on a repo that has never enforced metadata.

```bash
docmeta fill docs/ --dry-run     # preview; writes nothing
docmeta fill docs/               # apply
```

```text
✓ docs/intro.md
    /description  A tour of the CLI and its four commands.  0.91
    below 0.7: /resource 0.38

anthropic/claude-sonnet-4-5 · Threshold 0.7 · 1 file · 1 field written · 1 skipped
```

Confidence is the last gate, not the only one. A proposal must first satisfy the
target property's own subschema. It must name a property your schema declares,
and it must leave the document still valid after the merge. Only then does
`--confidence` (default `0.7`) apply. Values below it are skipped and reported
by name. They are never written with a caveat, and the score itself never
reaches your document.

`fill` writes in place by default, so run it on a clean tree and review the
diff.

It picks an LLM provider by detecting one. The order is `ANTHROPIC_API_KEY`,
then `OPENAI_API_KEY`, then a signed-in `claude` CLI, then a local model that
needs no credentials at all. That means it works with whatever you have, and it
reports which provider it used. Pass `--provider` to pin one. That is worth
doing in CI. Left to detect, a runner that loses its key falls back to the local
model, and downloads it rather than failing the build.

Pass `--local` when the document must not leave the machine. It runs inference
on-device and **refuses every hosted provider**, a signed-in `claude` CLI
included. That CLI runs locally, but its inference does not. See the [`fill`
reference](https://hawkeyexl.github.io/docmeta/reference/cli/#fill) for every
flag and for what the local fallback costs.

## Supported formats

Markdown, MDX, AsciiDoc, reStructuredText, XML (including DITA topics and maps),
and HTML. Run `docmeta schemas` to list the built-in schemas, every supported
format, and which formats `fill` can write back to.

`fill` writes to all of them. It splices the exact character range of the value
rather than re-serializing the document. Comments, entity spellings, attribute
order, indentation, and a DOCTYPE all survive untouched.

## Documentation

Full guides, recipes, and reference live on the documentation site:

**https://hawkeyexl.github.io/docmeta/**

| Track | What it covers |
|-------|----------------|
| [Get started](https://hawkeyexl.github.io/docmeta/get-started/) | Install and run your first validation. |
| [Set up validation](https://hawkeyexl.github.io/docmeta/set-up/) | Stand up validation for a repo: `docmeta.config.yaml`, per-folder schema overrides. |
| [Run it in CI](https://hawkeyexl.github.io/docmeta/ci/) | GitHub Actions and other CI recipes, exit codes, and PR annotations. |
| [Define & evolve schemas](https://hawkeyexl.github.io/docmeta/schemas/) | Author a schema, wire up resolution, and version it without breaking the build. |
| [Reference](https://hawkeyexl.github.io/docmeta/reference/cli/) | Every CLI flag, Action input, config key, the schema-resolution precedence chain, and output formats. |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, the test loop, and how to add support for a new input format.

## License

[MIT](LICENSE)
