# docmeta

Validate the **presence and format** of document metadata against **JSON Schema**, built for CI.

<!-- badges: add npm version, build status, and license badges here -->

`docmeta` checks the metadata in your documents (Markdown frontmatter and more) against one or more JSON Schemas. It verifies that required fields are present and correctly formatted (a `type`, an ISO 8601 `timestamp`, a URI `resource`); it does not judge prose quality. It ships with the [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) schema built in, follows [clig.dev](https://clig.dev) conventions, and returns a nonzero exit code (plus optional GitHub annotations) when validation fails.

It can also **fill in** the metadata that is missing, so adopting a standard on an existing docset is not a data-entry project.

## Install

```bash
npm install -g docmeta
# or run it without installing:
npx docmeta validate "**/*.md"
```

Requires Node.js 24 or later.

## Quick start

Point `docmeta validate` at a file, a directory (walked recursively), or a glob. With no `--schema`, it validates against the built-in OKF schema.

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

Threshold 0.7 · 1 file · 1 field written · 1 skipped
```

Confidence is the last gate, not the only one. A proposal must first satisfy the
target property's own subschema, name a property your schema declares, and leave
the document still valid after the merge. Only then does `--confidence`
(default `0.7`) apply. Values below it are skipped and reported by name, never
written with a caveat, and the score itself never reaches your document.

`fill` writes in place by default, so run it on a clean tree and review the
diff. It needs credentials for an LLM provider (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, or a signed-in `claude` CLI). See the
[`fill` reference](https://hawkeyexl.github.io/docmeta/reference/cli/#fill) for
every flag.

## Supported formats

Markdown, MDX, AsciiDoc, reStructuredText, XML, and HTML. Run `docmeta schemas`
to list the built-in schemas, every supported format, and which formats `fill`
can write back to.

## Documentation

Full guides, recipes, and reference live on the documentation site:

**https://hawkeyexl.github.io/docmeta/**

| Track | What it covers |
|-------|----------------|
| [Get started](https://hawkeyexl.github.io/docmeta/get-started/) | Install and run your first validation. |
| [Set up validation](https://hawkeyexl.github.io/docmeta/set-up/) | Stand up validation for a repo: `docmeta.config.yaml`, per-folder schema overrides. |
| [Run it in CI](https://hawkeyexl.github.io/docmeta/ci/) | GitHub Actions and other CI recipes, exit codes, and PR annotations. |
| [Define & evolve schemas](https://hawkeyexl.github.io/docmeta/schemas/) | Author a schema, wire up resolution, and version it without breaking the build. |
| [Reference](https://hawkeyexl.github.io/docmeta/reference/cli/) | Every CLI flag, config key, the schema-resolution precedence chain, and output formats. |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, the test loop, and how to add support for a new input format.

## License

[MIT](LICENSE)
