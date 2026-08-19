## [3.4.2](https://github.com/hawkeyexl/docmeta/compare/v3.4.1...v3.4.2) (2026-08-19)


### Bug Fixes

* **config:** discover docmeta.config.yaml in ancestor directories ([#74](https://github.com/hawkeyexl/docmeta/issues/74)) ([8da9b0e](https://github.com/hawkeyexl/docmeta/commit/8da9b0e146aab3f08a9250e7d81835f55b552517))

## [3.4.1](https://github.com/hawkeyexl/docmeta/compare/v3.4.0...v3.4.1) (2026-08-18)


### Bug Fixes

* **cli:** treat an empty input set as an error, not success ([#73](https://github.com/hawkeyexl/docmeta/issues/73)) ([d448b81](https://github.com/hawkeyexl/docmeta/commit/d448b813d3df81d2d01233b474b4776be68ce149))

# [3.4.0](https://github.com/hawkeyexl/docmeta/compare/v3.3.0...v3.4.0) (2026-08-11)


### Features

* **schemas:** add built-in Docusaurus 3.10 front matter schemas ([#67](https://github.com/hawkeyexl/docmeta/issues/67)) ([2d308f1](https://github.com/hawkeyexl/docmeta/commit/2d308f15422e3fb37cacc8d4dc4b5c9295273c48))

# [3.3.0](https://github.com/hawkeyexl/docmeta/compare/v3.2.2...v3.3.0) (2026-08-11)


### Features

* **fill:** name the local model by its catalog alias ([#68](https://github.com/hawkeyexl/docmeta/issues/68)) ([cebded8](https://github.com/hawkeyexl/docmeta/commit/cebded8c686c04bdc0d17c9e998e4b50aa30f8d3))

## [3.2.2](https://github.com/hawkeyexl/docmeta/compare/v3.2.1...v3.2.2) (2026-08-10)


### Bug Fixes

* **validator:** compile each schema once, keyed by ref and by $id ([#65](https://github.com/hawkeyexl/docmeta/issues/65)) ([1462b6d](https://github.com/hawkeyexl/docmeta/commit/1462b6d921b029154ef96728dfec78f7c6c8a11b))

## [3.2.1](https://github.com/hawkeyexl/docmeta/compare/v3.2.0...v3.2.1) (2026-08-10)


### Bug Fixes

* **fill:** make schema-set order irrelevant to what `fill` proposes ([#64](https://github.com/hawkeyexl/docmeta/issues/64)) ([4c14a39](https://github.com/hawkeyexl/docmeta/commit/4c14a39e468abf5fab04a4e68154f093b65dddcd))

# [3.2.0](https://github.com/hawkeyexl/docmeta/compare/v3.1.0...v3.2.0) (2026-08-10)


### Features

* **fill:** detect an inference provider instead of assuming anthropic ([#62](https://github.com/hawkeyexl/docmeta/issues/62)) ([2f60978](https://github.com/hawkeyexl/docmeta/commit/2f60978e9ec3c5c872fd33d9714773f77ab6429f))

# [3.1.0](https://github.com/hawkeyexl/docmeta/compare/v3.0.1...v3.1.0) (2026-08-10)


### Features

* **extractors:** read .dita and .ditamap as XML ([#63](https://github.com/hawkeyexl/docmeta/issues/63)) ([09a8e22](https://github.com/hawkeyexl/docmeta/commit/09a8e22f71bc20938704474d9b5173d9e420732e))

## [3.0.1](https://github.com/hawkeyexl/docmeta/compare/v3.0.0...v3.0.1) (2026-08-10)


### Bug Fixes

* **schemas:** require `type` on the Diataxis vocabulary ([#61](https://github.com/hawkeyexl/docmeta/issues/61)) ([f7e611b](https://github.com/hawkeyexl/docmeta/commit/f7e611bafcdd6c9b3888a6a7f6e3cda5c9e7a115))

# [3.0.0](https://github.com/hawkeyexl/docmeta/compare/v2.0.0...v3.0.0) (2026-08-10)


### Features

* **schemas:** add a built-in Good Docs Project vocabulary ([#60](https://github.com/hawkeyexl/docmeta/issues/60)) ([4a3ea3b](https://github.com/hawkeyexl/docmeta/commit/4a3ea3b6b22c3706558268e66dc842a668817ede))


### BREAKING CHANGES

* **schemas:** `tgdp:templates:1.0` requires `type`. A document with no
`type` now fails against it where an earlier build of this branch passed.
Nothing released is affected, since the schema ships for the first time in
this change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

# [2.0.0](https://github.com/hawkeyexl/docmeta/compare/v1.4.1...v2.0.0) (2026-08-09)


* feat(schemas)!: add built-in Diataxis and Seven-Action vocabularies ([#56](https://github.com/hawkeyexl/docmeta/issues/56)) ([057f007](https://github.com/hawkeyexl/docmeta/commit/057f0078a466f7c381bd880f9bb3cde86aeeaa75))


### BREAKING CHANGES

* the `DEFAULT_SCHEMA` export is removed from the package
entry point. Use `DEFAULT_SCHEMAS`, which is a `readonly string[]` holding
the built-in default set rather than a single schema id.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* fix(schemas): freeze the exported default set

`DEFAULT_SCHEMAS` is part of the package entry point, and `readonly
string[]` is a compile-time constraint only — a JS consumer, or a TS one
casting it, could push onto the shared array and change the default for
every later resolution in a long-lived process. Freeze it, and cover both
halves: the export throws on mutation, and `resolveSchemaSet` keeps
handing back a fresh array callers may edit freely.

Also names the default *set* where docs/schemas/index.mdx still read as
though the fallback were OKF alone.
* `docmeta fill` now proposes an `action` value for every
document by default. Seven-Action is in the built-in default set, and
`fill` treats any schema property a document lacks as fillable regardless
of whether it is required — so a bare `docmeta fill` makes an inference
call per file. A document that already has an `action` meaning something
else is worse off: an invalid value is a candidate for *replacement*, and
fill writes to disk unless `--dry-run` is passed. To opt out, list the
schemas you want under `schemas:` in docmeta.config.yaml; that replaces
the default set entirely.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

## [1.4.1](https://github.com/hawkeyexl/docmeta/compare/v1.4.0...v1.4.1) (2026-08-04)


### Bug Fixes

* **docs:** repair frontmatter broken by the em-dash cleanup ([#54](https://github.com/hawkeyexl/docmeta/issues/54)) ([b1219d4](https://github.com/hawkeyexl/docmeta/commit/b1219d40bee004d144f58edcbfcca1d9d0ed1840)), closes [#52](https://github.com/hawkeyexl/docmeta/issues/52)

# [1.4.0](https://github.com/hawkeyexl/docmeta/compare/v1.3.0...v1.4.0) (2026-08-04)


### Features

* **cli:** add a fill subcommand that infers metadata behind a confidence gate ([#52](https://github.com/hawkeyexl/docmeta/issues/52)) ([dc341ab](https://github.com/hawkeyexl/docmeta/commit/dc341ab547cb7ae455b6432233b79e647bad264f))

# [1.3.0](https://github.com/hawkeyexl/docmeta/compare/v1.2.0...v1.3.0) (2026-07-21)


### Features

* **api:** export the frontmatter extractor ([#42](https://github.com/hawkeyexl/docmeta/issues/42)) ([2d6d212](https://github.com/hawkeyexl/docmeta/commit/2d6d21265e71cd0caa675e401a41c3feadc9e662))

# [1.3.0-docevals-builtin-schema.2](https://github.com/hawkeyexl/docmeta/compare/v1.3.0-docevals-builtin-schema.1...v1.3.0-docevals-builtin-schema.2) (2026-07-21)


### Bug Fixes

* **schemas:** correct stale key name in docevals reference; tighten llm allOf guard ([d3151fc](https://github.com/hawkeyexl/docmeta/commit/d3151fc11385f47a8936fb51a769127b67e0d499)), closes [#42](https://github.com/hawkeyexl/docmeta/issues/42)

# [1.3.0-docevals-builtin-schema.1](https://github.com/hawkeyexl/docmeta/compare/v1.2.0...v1.3.0-docevals-builtin-schema.1) (2026-07-21)


### Features

* **schemas:** add docevals:frontmatter:0.1 built-in and export extractFrontmatter ([99f7b11](https://github.com/hawkeyexl/docmeta/commit/99f7b1148ce71914c6684acf6a6c89f2dc334f81))
* **schemas:** add dockg:frontmatter:0.1 built-in schema ([7259f2b](https://github.com/hawkeyexl/docmeta/commit/7259f2b4d083a114797f0236efbd8e60681255be))

# [1.2.0](https://github.com/hawkeyexl/docmeta/compare/v1.1.0...v1.2.0) (2026-07-07)


### Bug Fixes

* **extractors:** correct TOML nested-key line map and rst fence fallback ([c8cdcb5](https://github.com/hawkeyexl/docmeta/commit/c8cdcb59ab45b29e11f7a7b177978b9a05f94ad4))
* **extractors:** recover AsciiDoc title after an unterminated fence ([f3a8bc8](https://github.com/hawkeyexl/docmeta/commit/f3a8bc8956932d9c44ad4c6186fd19c795b4ffab))
* **extractors:** reject a non-object frontmatter root ([84f8366](https://github.com/hawkeyexl/docmeta/commit/84f8366427f0083086097ead418aa94a9bda09cf))


### Features

* **extractors:** add TOML and JSON frontmatter support ([9089ddc](https://github.com/hawkeyexl/docmeta/commit/9089ddc1e71edf2a583e96a200fbf1813a2475ca))

# [1.1.0](https://github.com/hawkeyexl/docmeta/compare/v1.0.0...v1.1.0) (2026-06-27)


### Bug Fixes

* **get:** guard nested lookups against inherited props; address review nits ([c0fb28f](https://github.com/hawkeyexl/docmeta/commit/c0fb28f0296a2f918c7f91fc7ec4dbeba257aeab))


### Features

* **get:** resolve nested fields via dot-notation and JSON Pointer ([ae16994](https://github.com/hawkeyexl/docmeta/commit/ae16994bd64bf1b648ab9ea08043a818aa5825f7))

# [1.0.0](https://github.com/hawkeyexl/docmeta/compare/v0.1.0...v1.0.0) (2026-06-27)


* feat!: raise minimum Node to 24 and restore commander 15 ([f62532a](https://github.com/hawkeyexl/docmeta/commit/f62532af74c384f1871ec8e0f315b0f775346092))


### Bug Fixes

* **deps:** keep Node 20 support and repair lockfile sync for CI ([fab363e](https://github.com/hawkeyexl/docmeta/commit/fab363e999347804fe6093161c719b57836605bf))
* **extractors:** don't annotate RST errors at line 1 when no docinfo ([c0fddc1](https://github.com/hawkeyexl/docmeta/commit/c0fddc104c15790267f4d675c06e3f61b4f806b1))
* **extractors:** harden AsciiDoc frontmatter fallback and line mapping ([c7a4193](https://github.com/hawkeyexl/docmeta/commit/c7a4193d5db2fae08b3a7c3cd0ae82926094dd92))
* **extractors:** honor bare top-level keys in lineFor ([#7](https://github.com/hawkeyexl/docmeta/issues/7)) ([43c7eb0](https://github.com/hawkeyexl/docmeta/commit/43c7eb0071fbf718b95833e887fe5dc88fa0eb4d))
* **extractors:** validate RST title adornment char and length ([846b8bd](https://github.com/hawkeyexl/docmeta/commit/846b8bdb9889219f7242a774fda153271b304cc4))


### Features

* **cli:** unify get input handling with validate ([755dbfe](https://github.com/hawkeyexl/docmeta/commit/755dbfe7470f0b83680b528484c18408fb6d71e7))
* **core:** fetch and use externally-specified $schema URIs across dialects ([#8](https://github.com/hawkeyexl/docmeta/issues/8)) ([e775712](https://github.com/hawkeyexl/docmeta/commit/e77571278598eebab6e54f1f454e5a3ebac3c118))
* expose programmatic API via package exports and add CLI-reference drift check ([c92ab88](https://github.com/hawkeyexl/docmeta/commit/c92ab88b834dde1ccb20bad5df93769f4355d185))
* **extractors:** add AsciiDoc metadata support ([261c69b](https://github.com/hawkeyexl/docmeta/commit/261c69bff417c7b49dc58d1c9cd9796eca692ebf))
* **extractors:** add reStructuredText metadata support ([55ebdba](https://github.com/hawkeyexl/docmeta/commit/55ebdbae877ce62445c1ba78b6d66ec23dee94ec))
* **extractors:** add XML and HTML metadata support ([#5](https://github.com/hawkeyexl/docmeta/issues/5)) ([349b179](https://github.com/hawkeyexl/docmeta/commit/349b179fc5dadb7b79b01a4b72f1121196f6996f))
* **extractors:** extract the RST document title into metadata ([6b9d2ce](https://github.com/hawkeyexl/docmeta/commit/6b9d2ce8b3c3848866b4819e7d4da9626f09d910))


### BREAKING CHANGES

* docmeta now requires Node.js 24 or newer.

Verified with `npm ci`: typecheck, build and 124/124 tests pass; the
docs CLI-reference sync check passes.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
