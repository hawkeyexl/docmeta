# 0003 — SARIF and JUnit reporters

- **Status:** Implemented
- **Serves:** Devin · D3 "Feed results into our tooling", D1 (PR surfacing)
- **Depends on:** The `FieldError` extension from [0001 §
  Prerequisite](0001-validation-baseline.md#prerequisite-fielderror-needs-a-machine-identity);
  repo-root-relative paths (see stress test 2, couples to
  [0004](0004-config-upward-discovery.md))
- **Touches:** `src/reporters/index.ts`, new `src/reporters/sarif.ts` and `src/reporters/junit.ts`, `src/cli.ts`

## Problem

`ReportFormat` is `"pretty" | "json" | "github"`. That covers a human at a
terminal and an annotation on a PR diff, and nothing else.

The gap is **persistence**. `--format github` emits `::error` workflow commands,
which render on the PR and then vanish with the job log. Nothing accumulates.
There is no history, no "when did this regress", no dashboard, and no
security-tab entry. There is no way to see metadata debt trending down across a
quarter. `--format json` is machine-readable but in a docmeta-specific shape, so
every consumer writes a bespoke adapter.

Two standard formats close this, and they serve different jobs:

- **SARIF 2.1.0**, the interchange format for static analysis. GitHub code
  scanning, GitLab, Azure DevOps, and most quality dashboards ingest it
  directly. Findings become tracked alerts with state across commits.
- **JUnit XML**, which is what CI systems parse for the "Tests" tab. Jenkins,
  GitLab, CircleCI, and Azure all render it natively, and Devin's D1 recipe list
  already names Jenkins and GitLab.

## Proposal

```
docmeta validate --format sarif   # SARIF 2.1.0 to stdout
docmeta validate --format junit   # JUnit XML to stdout
```

Both are `validate`-only for now (see stress test 8).

### SARIF shape

```jsonc
{
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "version": "2.1.0",
  "runs": [{
    "tool": { "driver": {
      "name": "docmeta",
      "version": "3.4.0",
      "informationUri": "https://hawkeyexl.github.io/docmeta/",
      "rules": [{
        "id": "google:okf:0.1/required",
        "name": "OkfRequired",
        "shortDescription": { "text": "Required property missing" },
        "helpUri": "https://hawkeyexl.github.io/docmeta/fix/"
      }]
    }},
    "results": [{
      "ruleId": "google:okf:0.1/required",
      "level": "error",
      "message": { "text": "must have required property 'type'" },
      "locations": [{ "physicalLocation": {
        "artifactLocation": { "uri": "docs/intro.md" },
        "region": { "startLine": 1 }
      }}],
      "partialFingerprints": { "docmetaViolation/v1": "a1b2c3d4e5f60718" }
    }]
  }]
}
```

Three details carry the design:

- **`ruleId` is `<schemaRef>/<keyword>`.** This needs `keyword` on `FieldError`,
  which is [0001](0001-validation-baseline.md)'s prerequisite. A rule id built
  from the message prose would rename itself on any Ajv upgrade. Every
  historical alert in the consumer would then close and reopen as new.
- **`rules[]` is emitted only for rules actually hit** in this run, deduplicated.
  Enumerating every possible keyword for every schema would mean compiling and
  walking each schema, for no consumer benefit.
- **`partialFingerprints` reuses 0001's fingerprint verbatim.** This is what
  lets GitHub track one alert across commits as the file moves and lines shift.
  Two features, one identity function. That is the strongest argument for
  building the `FieldError` extension once, properly.

### JUnit shape

One `<testsuite>` per run, one `<testcase>` per **file**, one `<failure>` per
violation:

```xml
<testsuites name="docmeta" tests="2" failures="1" errors="0">
  <testsuite name="docmeta" tests="2" failures="1">
    <testcase name="docs/intro.md" classname="docmeta.validate"/>
    <testcase name="docs/api.md" classname="docmeta.validate">
      <failure type="google:okf:0.1/required"
               message="/type must have required property 'type' (line 1)"/>
    </testcase>
  </testsuite>
</testsuites>
```

File-as-testcase, not violation-as-testcase, so the count in the CI tab reads
"2 tests, 1 failed" and matches `2 files checked, 1 failed`. Violation-as-testcase
would make the test count fluctuate with document quality, which reads as a
broken suite.

## Stress test

### 1. `level` has no source, so all findings are `error`

SARIF wants `error` / `warning` / `note`, and docmeta has no severity concept
(the same absence [0001](0001-validation-baseline.md) declines to fix). Emitting
everything as `error` is honest but forfeits SARIF's main triage axis. Accepted
for now, and it is the strongest future argument for per-schema severity: severity
would light up in SARIF consumers for free. Noted so this is a known limitation
rather than an oversight.

### 2. `artifactLocation.uri` must be repo-root-relative (real coupling to 0004)

This is the one that breaks in practice. docmeta emits `cwd`-relative posix
paths (`resolveTargets` returns `relative(cwd, abs)`). GitHub code scanning
resolves `artifactLocation.uri` **against the repository root**. Run docmeta
from `docs/` and every SARIF result points at a path that does not exist in the
repo. GitHub silently drops those results, so the upload "succeeds" with zero
alerts.

That is the same false-green shape as [0004](0004-config-upward-discovery.md),
one layer out. SARIF therefore needs a repo-root base:
`uriBaseId: "%SRCROOT%"` with `originalUriBaseIds`, or paths rebased onto the git
root. Either way SARIF needs to *know* the repo root, which is exactly the
boundary-detection 0004 introduces. Build 0004 first and reuse its boundary.

### 3. `startLine` when `line` is unknown (omit the region, never invent one)

SARIF requires `startLine >= 1`. `lineFor()` returns `undefined` for formats and
pointers with no position, and `col` is never populated at all (see
[0013](0013-cleanup-dead-code-and-exit-codes.md)). Emitting `startLine: 0` is
schema-invalid, and emitting `1` silently mislocates every such finding at the
top of the file. Omit `region` entirely. SARIF allows a location with only an
`artifactLocation`, and consumers render it as a file-level alert, which is
truthful.

### 4. Parse errors have no rule, so they need a synthetic id

`parseErrorResult` builds a `FieldError` with `schema: "(parse)"` and no keyword.
`ruleId: "(parse)/undefined"` is garbage. Reserve `docmeta/parse-error` as an
explicit synthetic rule with its own `rules[]` entry. Same for the schema
resolution failures that reuse `parseErrorResult`. Worth catching now: these are
the findings a user most needs to see, and they are the ones a naive
implementation mangles.

### 5. JUnit XML has no authoritative schema, so this is pinned to the common subset

There is no single JUnit spec. Jenkins, GitLab, and Azure each accept a
different superset. The design sticks to attributes all three honor: `name`,
`tests`, `failures`, `errors`, `classname`, `type`, and `message`. It avoids the
contested ones, which are `system-out`, nested suites, and `time` (meaningless
here). Must be verified against at least Jenkins and GitLab before release
rather than assumed.

### 6. XML escaping, which is the injection surface

Violation messages contain schema-authored text (`must match pattern
"^[a-z]+$"`), and file paths can contain `&`. Ajv messages can carry `<` and `>`
from a schema's own `pattern`. Escape `& < > " '` in every attribute value and
text node. This is the single most likely bug in a hand-rolled XML writer. So it
gets its own test, with a fixture whose schema `pattern` contains `<`, `&`, and
a quote. No XML library dependency for ~30 lines of writer.

### 7. `--format sarif` plus a failing exit code (a documentation trap)

`upload-sarif` must run even when `validate` exits 1, or nothing is ever
uploaded. The failing case is precisely the case with findings. The recipe needs
`continue-on-error: true` on the docmeta step, or `if: always()` on the upload,
and that is not obvious. It belongs in the CI recipes page, not as a footnote:

```yaml
- run: docmeta validate "**/*.md" -f sarif > docmeta.sarif
  continue-on-error: true
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with: { sarif_file: docmeta.sarif }
```

### 8. Should `fill` gain these too? (no, and the reason generalizes)

Parity ([0005](0005-command-parity.md)) argues every command should share
`--format`. But SARIF and JUnit describe *findings in files*, and `fill`'s
output is *proposals with confidence scores*. That is a different domain object.
Forcing it in would mean encoding a skipped optional property as a SARIF
"result", which misrepresents it. `fill` gets `github` (annotations for
required-but-unfilled) per 0005; it does not get SARIF or JUnit. Parity means
consistent surfaces where they make sense, not identical surfaces everywhere.

### 9. Size on a large docset, measured as a non-issue

A 5,000-file docset with 3 violations each yields roughly 15,000 SARIF results.
At ~350 bytes each that is ~5 MB, under GitHub's 10 MB SARIF limit but not by
much. The realistic mitigation is that a repo with 15,000 violations is using
[0001](0001-validation-baseline.md) and reporting only new ones. Worth a note in
the reference page, not a cap in the writer. Silently truncating findings would
be worse than a rejected upload.

### 10. `$schema` collision in the output, which is a naming hazard

The SARIF envelope's own `$schema` key sits next to docmeta's document-level
`$schema` directive. They are unrelated but will confuse anyone reading a SARIF
file while debugging schema resolution. Nothing to fix; flagged for the docs.

## Implementation sketch

1. In `test/reporters.test.ts`, SARIF output parses, validates against the SARIF
   2.1.0 meta-schema (Ajv is already a dependency), and has stable key order.
2. In `test/reporters.test.ts`, `ruleId` derives from `schema` + `keyword`,
   `(parse)` maps to `docmeta/parse-error`, and an unknown line omits `region`.
3. In `test/reporters.test.ts`, `partialFingerprints` matches the fingerprint
   from `src/core/baseline.ts`, asserted against the same helper, so the two
   cannot drift.
4. In `test/reporters.test.ts`, a JUnit escaping fixture with `<`, `&`, `"` in a
   schema `pattern` and in a file path.
5. In `test/cli.integration.test.ts`, `-f sarif` and `-f junit` on
   `missing-type.md`, and `--format` validation rejecting unknown values with
   exit 2.
6. For fixtures, reuse `missing-type.md` and `bad-timestamp.md`, and add
   `test/fixtures/xml-hostile.schema.json`.

Then `reference/output-and-exit-codes.mdx` (two new format sections),
`reference/cli.mdx` (`npm run docs:check-cli` enforces the `--format` value list),
and the GitLab/Jenkins recipes plus the `upload-sarif` recipe in `ci/recipes.mdx`.

## What implementation corrected

Two things research found after this was written, recorded here rather than
edited into the text above so the change is visible.

### The fingerprint caveat needed documenting, not fixing

Stress test notes that `partialFingerprints` reuses the baseline fingerprint
verbatim. What it does not say is that the fingerprint **deliberately excludes
the file path**, so *two files with the same violation share one fingerprint*.
That is correct in both consumers. The path sits beside the fingerprint in each,
as the baseline's entry key and as SARIF's `artifactLocation.uri`. GitHub
derives alert identity from fingerprint **plus rule plus location**, exactly as
`applyBaseline` combines key and fingerprint. So the two files still track as
separate alerts. But it means the fingerprint alone is not an alert key, which a
consumer could easily assume, so the reference page states it outright.

### The SARIF meta-schema had to be vendored, and it is draft-04

The sketch says "Ajv is already a dependency", implying the conformance check
just works. It does not. Two corrections:

- **Tests must not reach the network**, so the meta-schema is committed as
  `test/fixtures/sarif-2.1.0.schema.json` rather than fetched.
- **It is a draft-04 schema.** The OASIS TC published SARIF 2.1.0's meta-schema
  against `http://json-schema.org/draft-04/schema#`, and stock Ajv 8 refuses to
  compile it. The already-present `ajv-draft-04` is the exact compiler needed.
  That is no new dependency, but not the obvious import either. (The schemastore
  mirror at `json.schemastore.org` has been converted to draft-07; the OASIS
  original is the authoritative one and is what is vendored.)

### Three sharp edges the proposal did not name

- **`ValidationResult.file` had to be threaded to the reporter with its frame.**
  `render()` received only `(results, summary, opts)`, and `runValidate` built
  its `FingerprintContext` inline and threw it away. So nothing downstream could
  rebase a path or reproduce a fingerprint. `ValidateRun` now returns it.
- **`searchPath` in `src/core/config.ts` already walked for `.git`, but its
  return type erased the answer**: a one-element chain meant *either* "cwd is
  the repository root" *or* "there is no repository". Extracted as
  `findGitRoot(cwd): string | null`.
- **The CLI's `if (text.length > 0)` output guard was wrong for these formats.**
  It existed because `renderGithub` returns `""` on a clean run, and it would
  have made a clean SARIF run write nothing, which `upload-sarif` rejects
  outright. Emptiness is now a property of the format (`OMITTED_WHEN_CLEAN`),
  not of the text.
