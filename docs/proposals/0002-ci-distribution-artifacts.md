# 0002 — Packaged Action, pre-commit hook, container

- **Status:** Proposed
- **Serves:** Devin · D1 "Add the gate to our CI platform"
- **Touches:** new `action.yml`, new `.pre-commit-hooks.yaml`, `.github/workflows/release.yml`, `docs/src/content/docs/ci/recipes.mdx`, `docs/maintainers/releasing.md`

## Problem

D1's premise is a **low-maintenance gate with minimal per-repo config**. Every
integration docmeta offers is copy-paste YAML that the consumer then owns:

- `examples/docmeta.yml` is a workflow file to copy into `.github/workflows/`. It
  pins nothing, and when docmeta's recommended invocation changes, 40 repos have a
  stale copy.
- There is no `.pre-commit-hooks.yaml`, and `ci/recipes.mdx` opens its pre-commit
  section with a caution admitting it:

  > docmeta does **not** publish a pre-commit hook repository, so you cannot
  > reference it as a remote hook (`repo: https://...`). The supported approach is
  > a **local** hook that calls the docmeta CLI directly.

  A `local` hook means every consuming repo hand-writes `entry`, `language`,
  `files`, and `pass_filenames`, and none of them get updates.
- There is no container image, so non-Node CI images must install Node 24 first.

A docs page that exists to explain the absence of an artifact is a strong signal
the artifact should exist. Two of these are small; the third is optional.

## Proposal

### 1. A composite GitHub Action at the repo root

```yaml
# action.yml
name: docmeta
description: Validate document metadata against JSON Schema
inputs:
  paths:    { description: Files, dirs, or globs, required: false }
  schema:   { description: Schema ref (repeatable, newline-separated), required: false }
  config:   { description: Path to a docmeta config file, required: false }
  format:   { description: "pretty | json | github | sarif | junit", default: github }
  version:  { description: docmeta version to run, default: "3" }
  args:     { description: Extra raw arguments, required: false }
outputs:
  exit-code: { description: docmeta's exit code }
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with: { node-version: "24" }
    - shell: bash
      run: npx -y docmeta@${{ inputs.version }} validate ...
```

Consumer usage collapses to:

```yaml
- uses: hawkeyexl/docmeta@v3
  with:
    paths: "docs/**/*.md"
```

**Composite, not a bundled JS action.** A JS action requires committing a bundled
`dist/` built with `ncc` and keeping it in sync with every release — a second build
pipeline, and a well-known source of "the action runs last week's code". A
composite action that shells out to `npx docmeta@<version>` reuses the npm release
as the single artifact, so there is exactly one thing to version.

### 2. `.pre-commit-hooks.yaml`

```yaml
- id: docmeta
  name: docmeta validate
  description: Validate document metadata against JSON Schema
  entry: docmeta validate
  language: node
  types_or: [markdown, html, xml]
  require_serial: false
```

Consumers then get the remote-hook form the docs currently say is impossible:

```yaml
repos:
  - repo: https://github.com/hawkeyexl/docmeta
    rev: v3.4.0
    hooks: [{ id: docmeta }]
```

### 3. Container image — proposed, lowest priority

`ghcr.io/hawkeyexl/docmeta:3` built from a `node:24-alpine` base. Useful for
GitLab CI (`image:` per job) and Jenkins agents without Node. Explicitly ranked
below the other two: it adds registry auth, a multi-arch build matrix, and a third
artifact to version, in exchange for convenience the `npx` path mostly covers.

## Stress test

### 1. `prepare: husky` breaks `language: node` — the finding that shapes item 2

pre-commit's `language: node` clones the repo at `rev` and installs it in an
isolated environment. `package.json` has `"prepare": "husky"`, and npm runs
`prepare` on install-from-source. In pre-commit's environment there is no
`.git/hooks` context to wire up, and husky is a **devDependency** that
`--omit=dev` installs will not have fetched.

So the hook risks failing at install time with `sh: husky: not found`, in every
consuming repo, on first use. Mitigations, in preference order:

1. Guard the script: `"prepare": "husky || true"` — one character of slack, no new
   files. Loses the loud failure when husky is genuinely broken for contributors.
2. `"prepare": "node -e \"if(!process.env.CI && require('fs').existsSync('.git')) …\""` —
   precise, ugly.
3. Ship the hook from a separate minimal repo — defeats the point.

Recommend (1) plus an integration test that actually runs
`pre-commit try-repo` against a scratch repo. **This must be verified
empirically before release**; it is the single most likely reason a published hook
is dead on arrival, and it cannot be caught by reasoning alone.

### 2. `types_or` vs docmeta's own extension list — a drift surface

pre-commit's `types_or` uses `identify`'s tags, which do not map cleanly onto
docmeta's six formats: `identify` has no tag for AsciiDoc or reStructuredText in
older versions, and `markdown` covers `.md` but `.mdx` is often untagged. A
mismatch means files silently not checked — the same false-green class as
[0014](0014-empty-input-is-not-success.md).

Safer: `files: '\.(md|mdx|adoc|rst|xml|dita|ditamap|html?)$'` as an explicit regex,
which is under docmeta's control and reviewable against `supportedExtensions()`.
Add a test asserting the regex and `supportedExtensions()` agree, or the two drift
the first time a format is added.

### 3. Action versioning against semantic-release — needs a release step

`release.yml` runs semantic-release, which tags `vX.Y.Z` and publishes to npm.
GitHub Actions consumers expect a **moving major tag** (`v3`) that a maintainer
force-updates on each release. semantic-release does not do this.

Add a post-release step that moves `v3` to the new tag. Two hazards:

- It must not run for prereleases (`next`, `feat/**` branches per
  `docs/maintainers/releasing.md`), or `v3` starts pointing at a prerelease.
- Force-pushing a tag is exactly the kind of operation that needs the release
  workflow's existing token permissions checked, not assumed.

The `version: "3"` input defaulting to a major range means the action and the npm
package can drift independently, which is a feature (a fixed action can pull a
patched CLI) and a hazard (a stale `v3` tag runs new CLI code against old input
wiring). Pin the default to the major only, and treat any input-contract change as
a major bump of both.

### 4. `npx -y` on every run — cost and a supply-chain note

`npx -y docmeta@3` resolves and downloads on each job. Measured elsewhere in this
set as seconds, and `actions/setup-node` caching does not cache `npx`'s temp
install. Acceptable, and the composite action can add `--prefer-offline`.

`-y` suppresses the install prompt, which also suppresses the "this package is not
installed, install it?" safety check. That is unavoidable for non-interactive CI
and is what the existing `examples/docmeta.yml` already does, so it introduces no
new exposure — but the action should pin `@3` rather than accept `@latest` so a
compromised future release is not silently pulled.

### 5. Does the Action need to duplicate every CLI flag? — no, and `args` is the escape hatch

Enumerating all of `validate`'s flags as inputs creates a second CLI surface to
keep in sync with `src/cli.ts` — and unlike `reference/cli.mdx`, there would be no
`docs:check-cli` equivalent guarding it. Expose only the four inputs a CI user
actually sets, plus a raw `args` passthrough. Document that `args` is the
supported way to reach anything else.

### 6. Composite actions cannot set a failing exit code cleanly — real limitation

A composite step that exits non-zero fails the job, which is usually right. But
[0003](0003-sarif-and-junit-reporters.md) needs the *opposite*: run docmeta,
capture SARIF, upload it, **then** fail. With a composite action the consumer must
add `continue-on-error: true` themselves, because the action cannot express
"fail after my caller's later steps". Document it; do not try to solve it with a
`fail-on` input, which would make the action's exit semantics differ from the
CLI's documented 0/1/2 contract.

### 7. Container image and `--format github` — verified compatible

Workflow commands are just stdout text, so `::error` annotations work from inside
a container. Noted because it is a common assumption that they need the host
runner.

### 8. Three artifacts, one CLI — the maintenance argument against item 3

Each artifact is a place the invocation contract can go stale. The Action and the
pre-commit hook both delegate to the npm package, so they carry ~10 lines of
wiring each. A container image carries a Dockerfile, a build matrix, registry
auth, and its own vulnerability-scan surface. Given `npx` already works inside any
Node-capable image, item 3 should wait for a concrete request rather than being
built speculatively.

## Implementation sketch

1. `action.yml` with the six inputs; a smoke workflow in `.github/workflows/` that
   uses `./` against `test/fixtures/missing-type.md` and asserts exit 1 plus an
   annotation on stdout.
2. `"prepare": "husky || true"` and a `pre-commit try-repo` integration check —
   red first: confirm the hook fails *before* the guard, so the guard is proven to
   be the fix rather than assumed.
3. `.pre-commit-hooks.yaml` with the explicit `files` regex; a test asserting the
   regex matches exactly `supportedExtensions()`.
4. `release.yml`: move the `v3` tag on stable releases only, gated on the branch.
5. `docs/maintainers/releasing.md`: document the moving-tag step, since that page
   is the audit record for release infrastructure.
6. `ci/recipes.mdx`: replace the "no official pre-commit hook repository" caution
   with the remote-hook recipe, and add the Action to the GitHub section. Keep the
   `local` hook recipe as the no-framework fallback.
