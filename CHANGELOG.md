## [4.1.1](https://github.com/hawkeyexl/docmeta/compare/v4.1.0...v4.1.1) (2026-08-22)


### Bug Fixes

* **ci:** stop squash merges from skipping the release ([#106](https://github.com/hawkeyexl/docmeta/issues/106)) ([ea27022](https://github.com/hawkeyexl/docmeta/commit/ea27022adb218a217941320b96a146aff80e1523)), closes [#103](https://github.com/hawkeyexl/docmeta/issues/103)

# [4.1.0](https://github.com/hawkeyexl/docmeta/compare/v4.0.0...v4.1.0) (2026-08-22)


### Features

* ship a GitHub Action and a pre-commit hook ([#104](https://github.com/hawkeyexl/docmeta/issues/104)) ([6c5bc75](https://github.com/hawkeyexl/docmeta/commit/6c5bc75e568e6c280ea8c0150737d5bbcff7b666))

# [4.1.0-action-and-precommit-hook.4](https://github.com/hawkeyexl/docmeta/compare/v4.1.0-action-and-precommit-hook.3...v4.1.0-action-and-precommit-hook.4) (2026-08-22)


### Bug Fixes

* accept newline-separated paths and args, and warn on shell quotes ([9ed407d](https://github.com/hawkeyexl/docmeta/commit/9ed407daa4510edef599fb2a28f24bddcef480bf))

# [4.1.0-action-and-precommit-hook.3](https://github.com/hawkeyexl/docmeta/compare/v4.1.0-action-and-precommit-hook.2...v4.1.0-action-and-precommit-hook.3) (2026-08-22)


### Bug Fixes

* let a broken husky fail loudly in the prepare guard ([510121d](https://github.com/hawkeyexl/docmeta/commit/510121d9d5ab30f23f1e40459bc4bb5449197553)), closes [#104](https://github.com/hawkeyexl/docmeta/issues/104)

# [4.1.0-action-and-precommit-hook.2](https://github.com/hawkeyexl/docmeta/compare/v4.1.0-action-and-precommit-hook.1...v4.1.0-action-and-precommit-hook.2) (2026-08-22)


### Bug Fixes

* pin setup-node in the action, and locate the run block by id ([e39cff7](https://github.com/hawkeyexl/docmeta/commit/e39cff721baedaff627322abd098e9d3c8e30cb8)), closes [#104](https://github.com/hawkeyexl/docmeta/issues/104)

# [4.1.0-action-and-precommit-hook.1](https://github.com/hawkeyexl/docmeta/compare/v4.0.0...v4.1.0-action-and-precommit-hook.1) (2026-08-22)


### Bug Fixes

* write exit-code before the action's script aborts ([e7edb32](https://github.com/hawkeyexl/docmeta/commit/e7edb323433b63742d0f23e2dd1ae4018f632510))


### Features

* ship a GitHub Action and a pre-commit hook ([7ccab63](https://github.com/hawkeyexl/docmeta/commit/7ccab6302da9d0840b863c3d110fdce614057126))

# [4.0.0](https://github.com/hawkeyexl/docmeta/compare/v3.13.0...v4.0.0) (2026-08-22)


* feat(fill)!: send the whole document, and add --local ([#102](https://github.com/hawkeyexl/docmeta/issues/102)) ([37d19d3](https://github.com/hawkeyexl/docmeta/commit/37d19d34accb1651018f55d13106f0fcc0cbbd18)), closes [#74](https://github.com/hawkeyexl/docmeta/issues/74) [97-#99](https://github.com/97-/issues/99)


### Bug Fixes

* **extractors:** stop a BOM shifting the columns HTML reports ([#100](https://github.com/hawkeyexl/docmeta/issues/100)) ([e1a1483](https://github.com/hawkeyexl/docmeta/commit/e1a1483a2ad6595c5b5d3ce4301babf4d45bebde)), closes [#99](https://github.com/hawkeyexl/docmeta/issues/99)


### Features

* **extractors:** read and write DITA prolog metadata ([#99](https://github.com/hawkeyexl/docmeta/issues/99)) ([d56cc84](https://github.com/hawkeyexl/docmeta/commit/d56cc84c13a0069e232be4b210ce0e23f7a7ccdd))
* **extractors:** write metadata back to HTML ([#97](https://github.com/hawkeyexl/docmeta/issues/97)) ([43a9b0e](https://github.com/hawkeyexl/docmeta/commit/43a9b0e33aecbf6580732fe3ccfef84ed223f3db)), closes [#99](https://github.com/hawkeyexl/docmeta/issues/99) [#62](https://github.com/hawkeyexl/docmeta/issues/62)
* **extractors:** write metadata back to XML ([#98](https://github.com/hawkeyexl/docmeta/issues/98)) ([c2036e3](https://github.com/hawkeyexl/docmeta/commit/c2036e37b84f1acb4c0c45cc55118d2c7b0c79c1))


### BREAKING CHANGES

* `--max-cost-usd` and the `fill.maxCostUsd` config key are
removed. Use `--max-turns` / `fill.maxTurns` to bound a run, or `--local`, which
costs nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* chore(release): 4.0.0-fill-local-and-chunking.1 [skip ci]

# [4.0.0-fill-local-and-chunking.1](https://github.com/hawkeyexl/docmeta/compare/v3.13.0...v4.0.0-fill-local-and-chunking.1) (2026-08-22)

* feat(fill)!: send the whole document, and add --local ([a92953e](https://github.com/hawkeyexl/docmeta/commit/a92953e3c8d8e6ed1fae1fada47a2ca9c56247f2)), closes [97-#99](https://github.com/97-/issues/99)

### Bug Fixes

* **extractors:** stop a BOM shifting the columns HTML reports ([#100](https://github.com/hawkeyexl/docmeta/issues/100)) ([e1a1483](https://github.com/hawkeyexl/docmeta/commit/e1a1483a2ad6595c5b5d3ce4301babf4d45bebde)), closes [#99](https://github.com/hawkeyexl/docmeta/issues/99)

### Features

* **extractors:** read and write DITA prolog metadata ([#99](https://github.com/hawkeyexl/docmeta/issues/99)) ([d56cc84](https://github.com/hawkeyexl/docmeta/commit/d56cc84c13a0069e232be4b210ce0e23f7a7ccdd))
* **extractors:** write metadata back to HTML ([#97](https://github.com/hawkeyexl/docmeta/issues/97)) ([43a9b0e](https://github.com/hawkeyexl/docmeta/commit/43a9b0e33aecbf6580732fe3ccfef84ed223f3db)), closes [#99](https://github.com/hawkeyexl/docmeta/issues/99) [#62](https://github.com/hawkeyexl/docmeta/issues/62)
* **extractors:** write metadata back to XML ([#98](https://github.com/hawkeyexl/docmeta/issues/98)) ([c2036e3](https://github.com/hawkeyexl/docmeta/commit/c2036e37b84f1acb4c0c45cc55118d2c7b0c79c1))

### BREAKING CHANGES

* `--max-cost-usd` and the `fill.maxCostUsd` config key are
removed. Use `--max-turns` / `fill.maxTurns` to bound a run, or `--local`, which
costs nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* fix(fill): refuse a document any failure cut short, not just the turn cap

Review found the same hole the turn-cap guard closed, reachable by a second
route. When a chunk failed part-way through a document, the guard only refused
if *nothing* had been collected — so one or more successful chunks were merged
and written as though they described the whole page.

Measured against a provider that succeeds twice then errors, on a file needing
seven chunks: the run reported no error and wrote a field inferred from two of
them. A transient upstream error on chunk three of a long reference page
therefore produced a `description` derived from its introduction, written into
the user's file, with nothing in the output saying the rest was never read.

The overflow path had it too: once the single halve-and-retry is spent, control
falls through and whatever chunks succeeded are accepted.

The guard is now "every chunk was read, or the document is refused", which
covers both routes and the turn cap, and a mutation test pins it.

Also sums token usage across chunks rather than caching the last call's, which
understated a chunked file by roughly its chunk count. Nothing reads it back
today — which is why it was worth correcting before something does.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* chore(release): 4.0.0-fill-local-and-chunking.2 [skip ci]

# [4.0.0-fill-local-and-chunking.2](https://github.com/hawkeyexl/docmeta/compare/v4.0.0-fill-local-and-chunking.1...v4.0.0-fill-local-and-chunking.2) (2026-08-22)

### Bug Fixes

* **fill:** refuse a document any failure cut short, not just the turn cap ([787607f](https://github.com/hawkeyexl/docmeta/commit/787607ff11db786cf168e4c3d0c852c068cd55d8))

* refactor(fill): drop two casts the library already types

Both were unnecessary rather than merely noisy, which is the reason to remove
them: `ProviderName` includes `"llama-cpp"`, so the literal is assignable to
`ProviderSelector` on its own, and `LLAMA_MODELS` is exported as
`Record<string, LlamaModelEntry>` with `sizeBytes` and an optional `tier`. Each
cast asserted a shape the compiler could already prove — and would have gone on
asserting it after the library changed.

Also records why the halve-and-retry path does not roll back its turn count:
those calls were made and billed, so un-counting them would make `--max-turns`
describe something other than what happened. It does mean a document that
triggers the retry costs more turns than its final chunk count suggests, which
is worth saying where the retry happens rather than leaving to be rediscovered.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* refactor(fill): drop dead billedCalls, and let the compiler find the next one

`billedCalls` was read only by `projectedCost()`, which computed the cost
reservation for `--max-cost-usd`. That function went with the priming machinery;
the declaration and the increment stayed, accumulating on every chunk call and
being discarded at the end of the run.

Enabling `noUnusedLocals` matters more than the deletion. `strict` does not
cover this class, so the only way to find it was to grep — which is not a check
anyone runs, and is exactly how it survived the removal that orphaned it. The
whole tree had two other violations, both unused imports (`ReportFormat` in
`cli.ts`, `Buffer` in `schemas.ts`), so the flag costs nothing and turns a
manual catch into a compiler guarantee. Verified against a deliberate write-only
local, which now fails the typecheck.

`noUnusedParameters` is left off: it still has one violation, and clearing it is
unrelated to this PR.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* fix(fill): reset cached usage on retry, and pin the overflow matcher

Two review nits. One was right, one was not, and the second is the more useful
of the two to write down.

`usageTotal` accumulated across the halve-and-retry, so a document whose first
attempt overflowed part-way through had those chunks' tokens counted again by
the second attempt. Reset before the retry: the figure describes the document,
not the run, and nothing reads it back yet — which is the moment to make it
right rather than after something does.

The other nit proposed dropping bare `exceeds` from `looksLikeOverflow`, because
it would match "rate limit exceeded" and "quota exceeded". The consequence would
have been real: overflow triggers a halve-and-retry, and halving *doubles* the
call count, so answering a rate limit that way would send twice the requests
that provoked it.

It does not match them. "exceeded" does not contain "exceeds". Checked against
both, plus "429 Too Many Requests" — none match, before or after. Dropping it
cost a genuine overflow instead: "Your input exceeds the maximum allowed length"
matched before and would not after. So the change is reverted, and the one
letter now has a comment explaining why it is deliberate.

The regression test that came out of this is the part worth keeping. It asserts
both directions — a rate limit does not re-chunk, a real overflow does — because
the first assertion alone passed with the matcher broken, which is how the wrong
fix looked correct for a few minutes. Loosening `exceeds` to `exceed` now fails
it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

* chore(release): 4.0.0-fill-local-and-chunking.3 [skip ci]

# [4.0.0-fill-local-and-chunking.3](https://github.com/hawkeyexl/docmeta/compare/v4.0.0-fill-local-and-chunking.2...v4.0.0-fill-local-and-chunking.3) (2026-08-22)

### Bug Fixes

* **fill:** reset cached usage on retry, and pin the overflow matcher ([e86767d](https://github.com/hawkeyexl/docmeta/commit/e86767da91eff25c75f04caabaa97d964b88c48a))

# [4.0.0-fill-local-and-chunking.3](https://github.com/hawkeyexl/docmeta/compare/v4.0.0-fill-local-and-chunking.2...v4.0.0-fill-local-and-chunking.3) (2026-08-22)


### Bug Fixes

* **fill:** reset cached usage on retry, and pin the overflow matcher ([e86767d](https://github.com/hawkeyexl/docmeta/commit/e86767da91eff25c75f04caabaa97d964b88c48a))

# [4.0.0-fill-local-and-chunking.2](https://github.com/hawkeyexl/docmeta/compare/v4.0.0-fill-local-and-chunking.1...v4.0.0-fill-local-and-chunking.2) (2026-08-22)


### Bug Fixes

* **fill:** refuse a document any failure cut short, not just the turn cap ([787607f](https://github.com/hawkeyexl/docmeta/commit/787607ff11db786cf168e4c3d0c852c068cd55d8))

# [4.0.0-fill-local-and-chunking.1](https://github.com/hawkeyexl/docmeta/compare/v3.13.0...v4.0.0-fill-local-and-chunking.1) (2026-08-22)


* feat(fill)!: send the whole document, and add --local ([a92953e](https://github.com/hawkeyexl/docmeta/commit/a92953e3c8d8e6ed1fae1fada47a2ca9c56247f2)), closes [97-#99](https://github.com/97-/issues/99)


### Bug Fixes

* **extractors:** stop a BOM shifting the columns HTML reports ([#100](https://github.com/hawkeyexl/docmeta/issues/100)) ([e1a1483](https://github.com/hawkeyexl/docmeta/commit/e1a1483a2ad6595c5b5d3ce4301babf4d45bebde)), closes [#99](https://github.com/hawkeyexl/docmeta/issues/99)


### Features

* **extractors:** read and write DITA prolog metadata ([#99](https://github.com/hawkeyexl/docmeta/issues/99)) ([d56cc84](https://github.com/hawkeyexl/docmeta/commit/d56cc84c13a0069e232be4b210ce0e23f7a7ccdd))
* **extractors:** write metadata back to HTML ([#97](https://github.com/hawkeyexl/docmeta/issues/97)) ([43a9b0e](https://github.com/hawkeyexl/docmeta/commit/43a9b0e33aecbf6580732fe3ccfef84ed223f3db)), closes [#99](https://github.com/hawkeyexl/docmeta/issues/99) [#62](https://github.com/hawkeyexl/docmeta/issues/62)
* **extractors:** write metadata back to XML ([#98](https://github.com/hawkeyexl/docmeta/issues/98)) ([c2036e3](https://github.com/hawkeyexl/docmeta/commit/c2036e37b84f1acb4c0c45cc55118d2c7b0c79c1))


### BREAKING CHANGES

* `--max-cost-usd` and the `fill.maxCostUsd` config key are
removed. Use `--max-turns` / `fill.maxTurns` to bound a run, or `--local`, which
costs nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

# [3.14.0-dita-write.1](https://github.com/hawkeyexl/docmeta/compare/v3.13.0...v3.14.0-dita-write.1) (2026-08-22)


### Features

* **extractors:** read and write DITA prolog metadata ([62ace6a](https://github.com/hawkeyexl/docmeta/commit/62ace6a2518c4c663b7a352f052e0ca123d0e4f0))
* **extractors:** write metadata back to HTML ([#97](https://github.com/hawkeyexl/docmeta/issues/97)) ([43a9b0e](https://github.com/hawkeyexl/docmeta/commit/43a9b0e33aecbf6580732fe3ccfef84ed223f3db)), closes [#99](https://github.com/hawkeyexl/docmeta/issues/99) [#62](https://github.com/hawkeyexl/docmeta/issues/62)
* **extractors:** write metadata back to XML ([#98](https://github.com/hawkeyexl/docmeta/issues/98)) ([c2036e3](https://github.com/hawkeyexl/docmeta/commit/c2036e37b84f1acb4c0c45cc55118d2c7b0c79c1))

# [3.14.0-xml-write.1](https://github.com/hawkeyexl/docmeta/compare/v3.13.0...v3.14.0-xml-write.1) (2026-08-22)


### Features

* **extractors:** write metadata back to HTML ([#97](https://github.com/hawkeyexl/docmeta/issues/97)) ([43a9b0e](https://github.com/hawkeyexl/docmeta/commit/43a9b0e33aecbf6580732fe3ccfef84ed223f3db)), closes [#99](https://github.com/hawkeyexl/docmeta/issues/99) [#62](https://github.com/hawkeyexl/docmeta/issues/62)
* **extractors:** write metadata back to XML ([8a1ba20](https://github.com/hawkeyexl/docmeta/commit/8a1ba20f7c40d1390a0a4325047abf736367b987))

# [3.14.0-html-write.1](https://github.com/hawkeyexl/docmeta/compare/v3.13.0...v3.14.0-html-write.1) (2026-08-21)


### Features

* **extractors:** write metadata back to HTML ([f085872](https://github.com/hawkeyexl/docmeta/commit/f0858726313359e6754fbb7f9d478c3ec5613326))

# [3.13.0](https://github.com/hawkeyexl/docmeta/compare/v3.12.1...v3.13.0) (2026-08-21)


### Features

* **schemas:** report metadata coverage with `docmeta schemas infer` ([#96](https://github.com/hawkeyexl/docmeta/issues/96)) ([88492bb](https://github.com/hawkeyexl/docmeta/commit/88492bb9b1e59c749c17b33569a8f3d34aae2f26))

## [3.12.1](https://github.com/hawkeyexl/docmeta/compare/v3.12.0...v3.12.1) (2026-08-20)


### Bug Fixes

* proposal 0013 cleanup — dead code, the unpopulated `col`, strict config keys ([#92](https://github.com/hawkeyexl/docmeta/issues/92)) ([1dde5b9](https://github.com/hawkeyexl/docmeta/commit/1dde5b9f54e1c1f938a86e4c7ea670554d96e832)), closes [#84](https://github.com/hawkeyexl/docmeta/issues/84)

# [3.12.0](https://github.com/hawkeyexl/docmeta/compare/v3.11.1...v3.12.0) (2026-08-20)


### Features

* **schemas:** publish the built-in schemas at stable URLs ([#91](https://github.com/hawkeyexl/docmeta/issues/91)) ([a9df163](https://github.com/hawkeyexl/docmeta/commit/a9df1632d9362f019dcfe14b7bc4f0a5a0033ef8))

## [3.11.1](https://github.com/hawkeyexl/docmeta/compare/v3.11.0...v3.11.1) (2026-08-20)


### Bug Fixes

* **schemas:** strip a leading BOM before parsing, never before hashing ([#94](https://github.com/hawkeyexl/docmeta/issues/94)) ([cde18dc](https://github.com/hawkeyexl/docmeta/commit/cde18dc7d3aef9d76ce77ce00388cc85f6b70d20))

# [3.11.0](https://github.com/hawkeyexl/docmeta/compare/v3.10.0...v3.11.0) (2026-08-20)


### Features

* **schemas:** let a repo constrain what a document's `$schema` may name ([#88](https://github.com/hawkeyexl/docmeta/issues/88)) ([214bbaa](https://github.com/hawkeyexl/docmeta/commit/214bbaa05498b4a802734c27d14d1677200b3242)), closes [#74](https://github.com/hawkeyexl/docmeta/issues/74) [#73](https://github.com/hawkeyexl/docmeta/issues/73)

# [3.10.0](https://github.com/hawkeyexl/docmeta/compare/v3.9.1...v3.10.0) (2026-08-20)


### Features

* **cli:** one input and output surface across validate, get, and fill ([#86](https://github.com/hawkeyexl/docmeta/issues/86)) ([7ecde9b](https://github.com/hawkeyexl/docmeta/commit/7ecde9bbf20c8154adebadb0565fd02c50cc24bd))

## [3.9.1](https://github.com/hawkeyexl/docmeta/compare/v3.9.0...v3.9.1) (2026-08-20)


### Bug Fixes

* **cli:** usage errors exit 2, and two adjacent output bugs ([#84](https://github.com/hawkeyexl/docmeta/issues/84)) ([6fed95a](https://github.com/hawkeyexl/docmeta/commit/6fed95af39c8cba6da249fc4a52c112981fb67b7))

# [3.9.0](https://github.com/hawkeyexl/docmeta/compare/v3.8.0...v3.9.0) (2026-08-20)


### Features

* **schemas:** vendor a remote schema into the repository and pin it ([#82](https://github.com/hawkeyexl/docmeta/issues/82)) ([ee70724](https://github.com/hawkeyexl/docmeta/commit/ee70724e9cb78c0b99b52baf499c019f2bd70d53))

# [3.8.0](https://github.com/hawkeyexl/docmeta/compare/v3.7.1...v3.8.0) (2026-08-20)


### Bug Fixes

* **schemas:** three schema-loading fixes — relative config refs, --offline dedup, future cache mtime ([#83](https://github.com/hawkeyexl/docmeta/issues/83)) ([92fc048](https://github.com/hawkeyexl/docmeta/commit/92fc048e39795a5f46d7df3f6635c208500127fa))


### Features

* **schemas:** cache fetched schemas across runs, and add --offline ([#81](https://github.com/hawkeyexl/docmeta/issues/81)) ([0b9a6d3](https://github.com/hawkeyexl/docmeta/commit/0b9a6d39bfc7aefca50e882cf038d2d4f552168f))

## [3.7.1](https://github.com/hawkeyexl/docmeta/compare/v3.7.0...v3.7.1) (2026-08-19)


### Bug Fixes

* **schemas:** reject a fetched payload that constrains nothing ([#80](https://github.com/hawkeyexl/docmeta/issues/80)) ([ad60b70](https://github.com/hawkeyexl/docmeta/commit/ad60b70b7add86f4be179d4e4abc443540e6a49e))

# [3.7.0](https://github.com/hawkeyexl/docmeta/compare/v3.6.0...v3.7.0) (2026-08-19)


### Features

* **reporters:** add SARIF and JUnit output ([#79](https://github.com/hawkeyexl/docmeta/issues/79)) ([bc01a59](https://github.com/hawkeyexl/docmeta/commit/bc01a59e737705b876bbbd2b155ba55179b1321f))

# [3.6.0](https://github.com/hawkeyexl/docmeta/compare/v3.5.0...v3.6.0) (2026-08-19)


### Features

* **cli:** honor .gitignore when walking directories and globs ([#77](https://github.com/hawkeyexl/docmeta/issues/77)) ([1f501ae](https://github.com/hawkeyexl/docmeta/commit/1f501aeee734384185f95fbd140a6ab8dd56953a))

# [3.5.0](https://github.com/hawkeyexl/docmeta/compare/v3.4.2...v3.5.0) (2026-08-19)


### Features

* **validate:** add a baseline so a standard can tighten today ([#76](https://github.com/hawkeyexl/docmeta/issues/76)) ([10421ac](https://github.com/hawkeyexl/docmeta/commit/10421ac7605208a4cb15e2933f50ed5abf7eb723))

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
