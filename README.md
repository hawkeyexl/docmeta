# docmeta → manni

**docmeta is now [`manni`](https://github.com/hawkeyexl/manni).** Its commands
live under `manni meta`, and everything else about the tool is unchanged:
exit codes, output formats, the programmatic API, the built-in schemas.

```bash
npm install -D manni
npx manni meta validate docs/
```

| Then | Now |
|---|---|
| `docmeta validate …` | `manni meta validate …` (a `docmeta` bin still ships in `manni`) |
| `docmeta.config.yaml` | `manni.config.yaml`, with your keys under `meta:` |
| `uses: hawkeyexl/docmeta@v4` | `uses: hawkeyexl/manni@v1` |
| `- id: docmeta` (pre-commit) | `- id: manni-meta`, repo `hawkeyexl/manni` |
| https://hawkeyexl.github.io/docmeta/ | https://hawkeyexl.github.io/manni/ |

The last docmeta release is **4.14.0**. It is the 4.13 tool plus a notice on
stderr saying the above. The package is deprecated on npm; installing it tells
you the same thing.

## What this repository still serves

The published built-in schemas. A `$schema` or `$ref` written against
`https://hawkeyexl.github.io/docmeta/schemas/<name>/<version>.json` is a
promise that those bytes never change, and this repository keeps serving them
from [`schemas/`](schemas/) exactly as they were. `manni` resolves both the old
and the new URL to its bundled copy, so no document needs to be edited.

Everything else that used to be here — source, tests, docs, the Action, the
release pipeline — lives in `hawkeyexl/manni` with its full history. Issues and
pull requests go there.
