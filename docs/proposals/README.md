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
| [0002](0002-ci-distribution-artifacts.md) | Packaged Action, pre-commit hook, container | Devin · D1 | Implemented (#104) |
| [0003](0003-sarif-and-junit-reporters.md) | SARIF and JUnit reporters | Devin · D3 | Implemented |
| [0004](0004-config-upward-discovery.md) | Config discovery walks up | all | Implemented |
| [0005](0005-command-parity.md) | Command parity, flags with fallbacks | all | Implemented |
| [0006](0006-gitignore-aware-discovery.md) | `.gitignore`-aware file discovery | all | Implemented |
| [0007](0007-html-xml-write-support.md) | `fill` write support for HTML (XML/DITA stay read-only) | Maya · M1 | Superseded by [0018](0018-write-support-shipped-for-all-three.md) |
| [0008](0008-remote-schema-durability.md) | Remote schema durability | Devin · D2 | Implemented |
| [0009](0009-publish-builtin-schemas.md) | Publish built-in schemas at stable URLs | Sara · S1 | Implemented |
| [0010](0010-init-and-schema-inference.md) | `docmeta init` and schema inference | Maya · M1 / Sara · S1 | Partly shipped — `infer` landed; `init` rejected by [0019](0019-no-docmeta-init.md) |
| [0011](0011-fill-in-content-strategy.md) | Fold `fill` into the content strategy | strategy debt | Proposed |
| [0012](0012-fill-cost-and-privacy.md) | `fill` cost, privacy, and offline operation | Maya · M4 / Devin · D1 | Superseded by [0017](0017-fill-egress-and-bounds.md) |
| [0013](0013-cleanup-dead-code-and-exit-codes.md) | Dead code, unpopulated fields, usage exit codes | correctness | Implemented |
| [0014](0014-empty-input-is-not-success.md) | An empty input set is not success | correctness | Implemented |
| [0015](0015-schema-trust-boundary.md) | A trust boundary for document-supplied schemas | Devin · D2 / Sara · S3 | Implemented |
| [0016](0016-flag-ownership.md) | Which command owns a flag, and where it may be written | all (CLI surface) | Accepted |
| [0017](0017-fill-egress-and-bounds.md) | What `fill` sends, and how to bound it | Maya · M4 / Devin · D1 | Implemented (#102) |
| [0018](0018-write-support-shipped-for-all-three.md) | Write support shipped for HTML, XML **and** DITA | Maya · M1, M4 / Theo · T1 | Superseded by [0020](0020-element-metadata.md) |
| [0019](0019-no-docmeta-init.md) | `docmeta init` is rejected, not deferred | Maya · M1 | Accepted |
| [0020](0020-element-metadata.md) | Element metadata in XML and HTML, and the DITA schema it unblocks | Sara · S1 / Maya · M1, M4 | Implemented |
| [0021](0021-frontmatter-as-a-database.md) | The corpus is a database: `docmeta query` | Devin · D1, D3 / Maya · M2 | Implemented (#120) |
| [0022](0022-sql-write-back.md) | Write-back: an UPDATE against the corpus edits the files | Maya · M2, M4 / Devin · D3 | Implemented (#122) |
| [0023](0023-metadata-vocabularies.md) | The docmeta metadata vocabularies — nine ids, drafts and worked examples under [0023/](0023/), reviewed publicly at the site's Proposals page | Sara · S1 / S2 | Proposed |
| [0024](0024-standard-sql-vocabulary.md) | Standard SQL vocabulary: DML edits the files, DDL edits the schema | Maya · M2, M3 / Sara · S1, S3 / Devin · D3 | Implemented (#125, #126) |
| [0025](0025-query-dry-run-polarity.md) | query writes by default, `--dry-run` previews | Devin · D4 / Maya · M2 | Implemented |
| [0026](0026-corpus-checks-are-findings.md) | Corpus checks are findings: named `checks:` in config, run by `validate` | Devin · D4 / Maya · M2 | Implemented (#132) |
| [0027](0027-named-collections.md) | Named collections: override groups as SQL views | Devin · D4 / Maya · M2 | Implemented (#134) |
| [0028](0028-ddl-type-bridge.md) | The DDL type bridge: formats as column types, enums as CHECK IN | Sara · S1, S3 / Maya · M2, M3 | Implemented (#135) |
| [0029](0029-query-for-scripts.md) | query for scripts: CSV output and bound parameters | Devin · D3, D4 | Implemented (#133) |
| [0030](0030-query-schema-flag.md) | `-s/--schema` on `query`: naming the contract DDL evolves | Sara · S1, S3 / Maya · M2, M3 | Implemented (#139) |
| [0031](0031-content-strategy-vocabularies.md) | The content-strategy vocabularies — audience, persona and journey *definition* documents, the other end of 0023's dangling references. Drafts and ladders under [0031/](0031/); override-only, never default | Sara · S1 / S2 | Proposed |

0014 was not in the original review. It surfaced while stress-testing 0004 and
is the most severe item in the set: **docmeta currently exits `0` when it
validates nothing at all**, including when an explicitly named file does not
exist.

0015 was reserved by 0008 § stress test 6 and written later. A document's
`$schema` outranks config, so in a repo that takes outside pull requests a
contributor can pick the schema their own file is judged against — and the file
that opts out of the standard is the one that passes. It adds an opt-in
constraint; it does not narrow what `$schema` may reference by default.

0017 is the first proposal written under `CLAUDE.md § Proposals are historical
records`. It supersedes 0012 rather than correcting it: 0012's evidence grep
searched for `sent to` while the docs said `sends`, so it concluded no page
documented `fill`'s egress when one had for two weeks. The gap it was reaching
for is real and narrower — the docs say *that* content is sent, never *what*,
*how much*, or *what is kept* — and 0017 answers it mostly by changing the
behavior rather than describing it.

## Dependency order

At a glance, so a planning pass does not have to reconstruct it from 29 headers.

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
0011 ──> 0012 ──> 0017   (0012 is the content gap 0011's journey walk exposes;
                          0017 supersedes it — the gap was real, the evidence wasn't)

0021 ──┬─> 0026          (checks run on the query engine)
       ├─> 0027
       ├─> 0028
       └─> 0029
0001 ──> 0026            (check findings ride the baseline)
0024 ──┬─> 0027          (its "scope the run to one override group" remedy gets a name)
       ├─> 0028          (extends 0024's deliberately thin type mapping)
       └─> 0030          (the `--schema <ref>` its design text sketched, shipped as query's -s)
```

The four `Proposed` SQL items (0026–0029) are independent of each other except that
0026 and 0029 both grow `query`'s `-f` value list — each specifies the combined
six-value surface, and whichever is implemented second merges into the one const.
Recommended implementation order is 0026 → 0029 → 0027 → 0028 — impact-first, with the
two config-touching ones (0026, 0027) landed apart so the second rebases trivially.

**Safe to start in any order, no blockers:** 0011.

**Shipped so far:** everything the table above marks `Implemented` — through 0025 that
is all but 0011 and 0023 (`Proposed`), 0016 and 0019 (`Accepted`, nothing to ship), and
the superseded/rejected halves the Status column records — plus the standalone
false-green guard called out in
[0008 § Problem](0008-remote-schema-durability.md#problem). The dependency graph
above is kept as the record of why the early set landed in the order it did.

**Next, if you want the thread continued:** the 0026 → 0029 → 0027 → 0028 order above.
(This line pointed at 0009 until 0009 shipped; the Status column, not this paragraph,
is the ground truth for what remains.)

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
