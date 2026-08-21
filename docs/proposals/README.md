# Design proposals

Internal design docs for changes that are bigger than a single PR's commit
message. Like `../content-strategy/` and `../maintainers/`, these live inside
`docs/` but outside `docs/src/content/docs/**`, so they are **not published** to
the site and are not covered by the dogfood validation or doc-detective run.

## Status vocabulary

| Status | Meaning |
|---|---|
| `Proposed` | Written, stress-tested, not yet accepted. |
| `Accepted` | Agreed; safe to implement as written. |
| `Implemented` | Shipped. The doc stays as the rationale record. |
| `Rejected` | Considered and declined. The doc stays; the reason is the value. |
| `Superseded by NNNN` | Replaced. |

## The set

These came out of a review of the shipped product against the intent recorded in
`../content-strategy/`. Each doc names the persona and CUJ it serves, carries a
**Stress test** section recording what was tried against the design and what
changed as a result, and lists what it depends on.

| # | Proposal | Serves | Status |
|---|---|---|---|
| [0001](0001-validation-baseline.md) | Validation baseline (ratchet) | Maya · M2 | Implemented |
| [0002](0002-ci-distribution-artifacts.md) | Packaged Action, pre-commit hook, container | Devin · D1 | Proposed |
| [0003](0003-sarif-and-junit-reporters.md) | SARIF and JUnit reporters | Devin · D3 | Implemented |
| [0004](0004-config-upward-discovery.md) | Config discovery walks up | all | Implemented |
| [0005](0005-command-parity.md) | Command parity, flags with fallbacks | all | Implemented |
| [0006](0006-gitignore-aware-discovery.md) | `.gitignore`-aware file discovery | all | Implemented |
| [0007](0007-html-xml-write-support.md) | `fill` write support for HTML (XML/DITA stay read-only) | Maya · M1 | Proposed |
| [0008](0008-remote-schema-durability.md) | Remote schema durability | Devin · D2 | Implemented |
| [0009](0009-publish-builtin-schemas.md) | Publish built-in schemas at stable URLs | Sara · S1 | Implemented |
| [0010](0010-init-and-schema-inference.md) | `docmeta init` and schema inference | Maya · M1 / Sara · S1 | Proposed |
| [0011](0011-fill-in-content-strategy.md) | Fold `fill` into the content strategy | strategy debt | Proposed |
| [0012](0012-fill-cost-and-privacy.md) | `fill` cost, privacy, and offline operation | Maya · M4 / Devin · D1 | Proposed |
| [0013](0013-cleanup-dead-code-and-exit-codes.md) | Dead code, unpopulated fields, usage exit codes | correctness | Implemented |
| [0014](0014-empty-input-is-not-success.md) | An empty input set is not success | correctness | Implemented |
| [0015](0015-schema-trust-boundary.md) | A trust boundary for document-supplied schemas | Devin · D2 / Sara · S3 | Implemented |
| [0016](0016-flag-ownership.md) | Which command owns a flag, and where it may be written | all (CLI surface) | Accepted |

0014 was not in the original review. It surfaced while stress-testing 0004 and
is the most severe item in the set: **docmeta currently exits `0` when it
validates nothing at all**, including when an explicitly named file does not
exist.

0015 was reserved by 0008 § stress test 6 and written later. A document's
`$schema` outranks config, so in a repo that takes outside pull requests a
contributor can pick the schema their own file is judged against — and the file
that opts out of the standard is the one that passes. It adds an opt-in
constraint; it does not narrow what `$schema` may reference by default.

## Dependency order

At a glance, so a planning pass does not have to reconstruct it from 16 headers.

```
0014 ──┬─> 0006          (0006 can turn a gate into a silent no-op without 0014)
       └─> 0001          (a ratchet makes "0 findings" normal, so 0014 first)

0004 ──┬─> 0001          (baseline paths must resolve config-relative)
       ├─> 0003          (SARIF needs repo-root-relative URIs)
       └─> 0006          (both need the repo root / .git boundary)

0001 ──┬─> 0003          (shared FieldError identity — see below)

0008 ──┬─> 0009          (publishing adds URL refs that must stay durable)
       └─> 0015          (0008 reserved it; --offline is the accidental guard)
0015 ──> 0009            (0009 normalizes document $schema URLs; constrain first)
0011 ──> 0012            (0012 is the content gap 0011's journey walk exposes)
```

**Safe to start in any order, no blockers:** 0002, 0007, 0010, 0011, 0012, 0013.

**Shipped so far:** 0001, 0003, 0004, 0005, 0006, 0008, 0014, 0015, and the
standalone false-green guard called out in
[0008 § Problem](0008-remote-schema-durability.md#problem). The dependency graph
above is kept as the record of why they landed in that order.

**Next, if you want the thread continued:** 0009. It is the only proposal with a
live blocker that just cleared — 0015 had to constrain document-supplied URLs
before 0009 started publishing built-ins as URLs.

## Shared prerequisite

0001 and 0003 both need a violation to have a **stable machine identity**, and
`FieldError` does not carry one today — `toFieldError` in `src/core/validator.ts`
keeps Ajv's prose `message` and discards `keyword`, `schemaPath`, and `params`.
Both proposals therefore depend on the `FieldError` extension described in
[0001 § Prerequisite](0001-validation-baseline.md#prerequisite-fielderror-needs-a-machine-identity).
Implement it once, in whichever lands first.

## Reproducing the evidence

Every "Problem" section cites commands that were actually run against the built
CLI at `3.4.0`. To re-run them:

```bash
npm ci && npm run build
```

Then follow the transcript in the proposal. Sandboxes are disposable temp dirs;
nothing in this repo is mutated.
