# 0009 — Publish the built-in schemas at stable URLs

- **Status:** Proposed
- **Serves:** Sara · S1 "Define our metadata standard as a schema"; external consumers
- **Depends on:** URL→built-in aliasing (stress test 1) — without it this proposal is a regression
- **Touches:** new `docs/public/schemas/**`, `src/core/schema-registry.ts`, a copy+verify script, `.github/workflows/docs.yml`

## Problem

docmeta ships seven schemas — OKF, Diátaxis, TGDP, Seven-Action, and three
Docusaurus 3.10 contracts — and they are reachable **only from inside docmeta**, as
`vendor:name:version` ids resolved from a bundled `Map` in
`src/core/schema-registry.ts`.

Consequences:

- A team that wants to validate OKF frontmatter with any other JSON Schema tool
  cannot, without copying the file out of `node_modules`.
- Sara cannot `$ref` the built-in OKF schema from her own schema to extend it,
  which is the single most natural thing a schema author wants to do and is
  precisely S1's job ("start from it or deviate deliberately").
- The docs describe these schemas in prose across four reference pages, and a
  reader who wants the actual JSON has nowhere to click.

The site already deploys on every docs change, so serving seven static JSON files
is nearly free.

## Proposal

Serve each built-in from the docs site at a version-pinned, **immutable** path:

```
https://hawkeyexl.github.io/docmeta/schemas/okf/0.1.json
https://hawkeyexl.github.io/docmeta/schemas/diataxis/1.0.json
https://hawkeyexl.github.io/docmeta/schemas/seven-action/1.0.json
https://hawkeyexl.github.io/docmeta/schemas/tgdp/1.0.json
https://hawkeyexl.github.io/docmeta/schemas/docusaurus-docs/3.10.json
https://hawkeyexl.github.io/docmeta/schemas/docusaurus-blog/3.10.json
https://hawkeyexl.github.io/docmeta/schemas/docusaurus-pages/3.10.json
```

Astro serves `docs/public/**` at the site root, and the site's `base` is
`/docmeta`, so `docs/public/schemas/okf/0.1.json` lands at the URL above.
`docs/public/` does not exist yet and is created by this work.

The path mirrors `src/schemas/<dir>/<version>.json` exactly, so the mapping needs
no table.

### The files are generated, not authored

`src/schemas/` stays the single source of truth. A script copies each schema into
`docs/public/schemas/` and a test asserts byte equality, so the two cannot drift.
Copy at build time via the existing docs build, and verify in CI.

## Stress test

### 1. Published URLs must resolve to the bundled copy — otherwise this is a regression

The trap. Once `https://…/schemas/okf/0.1.json` exists, users will write it in a
document's `$schema` or in config. `classifyRef` returns `kind: "url"` for
anything matching `^https?://`, so docmeta would **fetch its own built-in over the
network** — slower, subject to the 10 s timeout, broken offline, and broken in the
air-gapped case [0008](0008-remote-schema-durability.md) is trying to guarantee.

So `loadSchema` must alias known published URLs back to the bundled objects,
before any fetch:

```ts
const PUBLISHED_ALIAS = new Map([
  ["https://hawkeyexl.github.io/docmeta/schemas/okf/0.1.json", "google:okf:0.1"],
  // …
]);
```

This is a hard prerequisite, not a nice-to-have. Without it, publishing makes
docmeta strictly worse for anyone who uses the URLs it advertises.

Consequence to test explicitly: `--offline` must still succeed against a document
whose `$schema` is a published URL.

### 2. Changing `$id` to the URL — rejected, and it is not cosmetic

Every built-in already has `$id` set to its docmeta id (verified):

```
src/schemas/okf/0.1.json: $id=google:okf:0.1
src/schemas/diataxis/1.0.json: $id=diataxis:diataxis:1.0
```

The tidy-looking move is to change `$id` to the https URL so the served file is
self-describing. Rejected:

- `Validator.compileUncached` registers and looks up schemas **by `$id`** (added in
  `1462b6d fix(validator): compile each schema once, keyed by ref and by $id`).
  Changing every `$id` changes every cache key and the identity Ajv dedupes on.
- Any user who wrote `$schema: google:okf:0.1` in a document is relying on the
  current id. Changing `$id` risks a resolution mismatch between the ref string and
  the registered id.
- [0001](0001-validation-baseline.md)'s fingerprints include the schema **ref**,
  not `$id`, so baselines survive — but only because the ref is what is hashed.
  That is a narrow escape, not a reason to churn ids.

Decision: keep `$id` as the docmeta id; serve the file at a URL that differs from
its `$id`. Some strict JSON Schema tooling warns when a schema's `$id` disagrees
with its retrieval URI. That warning is acceptable and must be **documented on the
built-in schemas reference page**, because a schema author who hits it will
otherwise assume the published file is broken.

### 3. Immutability — needs enforcement, not just intent

The value of a pinned URL is that its content never changes. Nothing stops a
future PR editing `src/schemas/okf/0.1.json`, which would silently change the
contract for every external consumer of the published URL — the exact failure
[0008](0008-remote-schema-durability.md) adds integrity pins to detect.

Enforce it: a CI check that hashes each `src/schemas/<dir>/<version>.json` against
a committed manifest and fails if an **existing** version's hash changes. A
genuine fix ships as a new version file. This is a real constraint on the project,
and it is the reason to do this deliberately rather than casually: publishing a URL
is a promise.

The manifest shape has to be specified, or two implementers will pick differently
and the check becomes its own merge-conflict source. Use
`src/schemas/manifest.json`, sorted by key, one entry per published file:

```json
{
  "version": 1,
  "schemas": {
    "docusaurus-blog/3.10.json": "sha256-2f0c…",
    "docusaurus-docs/3.10.json": "sha256-8ab1…",
    "okf/0.1.json": "sha256-9f8e…"
  }
}
```

Rules that make it unambiguous:

- **Key** is the path relative to `src/schemas/`, posix separators, so it is
  platform-stable.
- **Value** is `sha256-<hex>` over the file's exact bytes — no JSON
  canonicalization, because the published artifact is the bytes.
- **Adding** a version adds a key; the check fails only when an **existing** key's
  value changes, so new schemas need no ceremony.
- **Removing** a key fails the check too: a published URL must not 404 after
  someone deletes the source file.
- Sorted keys keep the diff to one line per change, which is what keeps this from
  becoming a conflict magnet.

A regenerate script (`npm run schemas:manifest`) writes it, and the CI check runs
the script and fails on a dirty tree — the same pattern as `docs:check-cli`, so
there is one idiom in the repo rather than two.

Note this repo has already edited built-ins in place —
`f7e611b fix(schemas): require type on the Diataxis vocabulary` changed
`diataxis:diataxis:1.0` and shipped as a **major** version bump of docmeta. That
was defensible for a bundled schema. Once the URL is public it would break
consumers who never upgraded docmeta at all. The manifest check is what makes the
new rule stick.

### 4. Editor autocomplete — the weakest of the claimed benefits, stated honestly

A tempting pitch is "now editors can autocomplete your frontmatter". Mostly they
cannot: YAML language servers resolve `$schema` for YAML *files*, not for YAML
frontmatter embedded in Markdown, and docmeta's `$schema` is a docmeta directive
that `Validator.validate` deliberately strips before validating. Some editors
support frontmatter schemas via their own settings (`yaml.schemas` glob mapping),
which works with these URLs but does not need the file's `$schema` at all.

Real benefits, in order: `$ref` from a user's own schema (S1), use by non-docmeta
tooling, and a clickable link from the reference pages. The proposal should be sold
on those.

### 5. `$ref`-ing a built-in is impossible today — by **any** route

Tested rather than assumed, and the result is worse than expected. Ajv is
constructed with no `loadSchema` option, so a remote `$ref` cannot resolve:

```console
$ docmeta validate p.md -s ./extends-remote.json
exit=2
docmeta: Schema "./extends-remote.json" failed to compile:
  can't resolve reference https://hawkeyexl.github.io/docmeta/schemas/okf/0.1.json from id #
```

And the built-in **id** form fails identically, even though that schema is bundled
and registered:

```console
$ docmeta validate p.md -s ./extends-builtin.json      # allOf: [{ $ref: "google:okf:0.1" }]
exit=2
docmeta: Schema "./extends-builtin.json" failed to compile:
  can't resolve reference google:okf:0.1 from id #
```

So S1's stated job — "understand what the built-in OKF schema already provides so
she can start from it or deviate deliberately" — has no `$ref` path at all.
Composition is only reachable through the schema **set** (listing OKF alongside a
custom schema, which is AND-composition and does work). Extending, overriding, or
narrowing a built-in from inside your own schema does not.

That is an independent gap that publishing does not fix and could disguise: once
the URLs exist, users will try exactly this `$ref` and get a compile error that
looks like the published file is broken.

Fix: register all seven built-ins with each Ajv instance up front via `addSchema`,
under both their `$id` and their published URL. Bounded to seven schemas, needs no
network, and makes both forms above compile. Recommended as part of this proposal
rather than deferred, because publishing without it invites the failure.

### 6. Hosting on GitHub Pages — caching and MIME

Pages serves `.json` as `application/json` and sets a short `Cache-Control`. Fine
for tooling. Two notes: Pages has no `Access-Control-Allow-Origin` guarantee for
browser-based consumers (it does send `*` today, but it is not contractual), and
Pages can 404 during a deploy. Neither matters for the CLI (which aliases to
bundled copies) and both matter for external consumers, so the docs should suggest
vendoring per [0008](0008-remote-schema-durability.md) for anything load-bearing.

### 7. Duplicated JSON in the repo — drift risk, cheaply closed

Copying seven files into `docs/public/` creates two copies of each schema. A test
asserting byte equality closes it, and must run in the normal `npm test` (not only
in the docs workflow) or the copy will drift in a PR that does not touch docs.
Alternative considered: an Astro dynamic endpoint importing from `../../src/schemas`
— avoids duplication but couples the docs build to a path outside `docs/`, and the
docs package has its own `package.json`/`node_modules`. The copy plus equality test
is simpler and the failure mode is louder.

## Implementation sketch

1. `test/schema-registry.test.ts` — a published URL ref resolves to the bundled
   schema with **zero** fetches (assert against `test/helpers/schema-server.ts`
   request count, or a `fetch` spy).
2. `test/schema-registry.test.ts` — the alias map covers exactly
   `listBuiltins()`; adding a built-in without a URL fails the test.
3. `test/builtin-schemas.test.ts` — hash manifest: every existing
   `<dir>/<version>.json` matches its recorded hash.
4. `test/builtin-schemas.test.ts` — `docs/public/schemas/**` is byte-identical to
   `src/schemas/**`.
5. `test/validator.test.ts` — a user schema `$ref`-ing a published built-in URL
   compiles offline (stress test 5).
6. `test/cli.integration.test.ts` — `--offline` validates a document whose
   `$schema` is a published URL.
7. Docs: `reference/built-in-schemas.mdx` gains a URL column, the `$id`-vs-URL
   note, and the immutability promise; the OKF, taxonomy, and Docusaurus pages
   link to their JSON.
