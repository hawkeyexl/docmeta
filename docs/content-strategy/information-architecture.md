# Information architecture & content set

## IA design principle

The site is organized by user intent, not by document type. Each top-level section maps to a persona's job-to-be-done. The landing page is a router: "What do you want to do?" leads users into the matching track. Reference material is a flat lookup shelf that journeys deep-link into. It supports navigation, and does not drive it.

**Frontmatter requirement:** every page in `docs/src/content/docs/**` must include `title` and `description` in its frontmatter. Authoring agents must not create pages without both fields.

---

## Navigation tree

```
Home — "What do you want to do?" router + 30-second proof
│
├─ Get started                     (universal on-ramp → feeds M1)
│
├─ Set up validation  (Maya)       → M1, M2, M3, M4
│
├─ Run it in CI       (Devin)      → D1, D2, D3, D4
│
├─ Define & evolve schemas (Sara)  → S1, S2, S3
│
├─ Fix a failing check (Theo)      → T1   (highest-traffic; cross-cutting)
│
└─ Reference (lookup shelf)        → Built-in schemas (registry) · CLI ·
                                      query · Config · Schema resolution ·
                                      Formats · Output & exit codes · API ·
                                      Action · OKF · Taxonomies · Docusaurus
```

### Directory mapping (Starlight content paths)

| Nav section | Directory |
|---|---|
| Get started | `get-started/` |
| Set up validation | `set-up/` |
| Run it in CI | `ci/` |
| Define & evolve schemas | `schemas/` |
| Fix a failing check | `fix/` |
| Reference | `reference/` |

---

## Content set (mapped to CUJs)

★ = launch priority (Phase 1). Every page is justified by the CUJ it serves. Pages without a ★ are Phase 2 or Phase 3.

### Get started (on-ramp)

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Landing / router page | All | ★ | Value prop, who it's for, 30-second quickstart. Links to each persona track. |
| Install & first validation | M1 | ★ | `npx docmeta validate <file>`, read pass/fail output, Node 24+ requirement. |

### Set up validation (Maya)

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Stand up validation for your repo | M1 | ★ | Anchor guide threading install → config → schema → CI. |
| Create your `docmeta.config.yaml` | M1 | ★ | paths, exclude, schemas, discovery keys with types and defaults. |
| Apply different schemas to different folders | M3 | ★ | Overrides, glob precedence, multi-schema per file. |
| Roll out a new required field without breaking the build | M2 | | Tool-supported ratchet (0001): the field goes `required` immediately and `--write-baseline` records the backlog. Rewritten from the four-stage manual rollout, whose hand-maintained `overrides:` glob list the baseline replaces. Now also carries the DDL one-statement ratchet (0024) for fields whose backfill value is uniform. |
| Retrofit docmeta into an existing docs repo | M1/M2/M4 | | Start lenient, tighten over time. Cross-cutting guide. Step 6 ratchets via the baseline, in step with the M2 page. Step 7 carries the M4 `fill` journey and hands off to the egress page below. There is deliberately no separate `fill` journey page, because splitting step 7 out would duplicate working content. |
| Run `fill` under a data-egress policy | M4, D1 | | The security-review answers for the step 7 `fill` pass. It covers what each inference call transmits. That is the path as matched, the whole metadata block, and the whole file including front matter. It is also each candidate's lifted subschema with its `description`, and every `$defs`/`definitions` block, referenced or not. It covers what the pre-gating cache retains, and the `--local` / `--offline` / `--max-turns` bounds. Consequences and decisions only, because the flag surface stays in the drift-checked CLI reference. Source of truth: `src/commands/fill-prompt.ts`, `src/commands/fill.ts`. |

### Run it in CI (Devin)

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Add docmeta to CI with the GitHub Actions recipe | D1 | ★ | From `examples/`. |
| CI recipes: GitLab CI, Jenkins, pre-commit | D1 | ★ | Fills current GitHub-only gap. |
| Exit codes & PR annotations contract | D1 | ★ | 0/1/2 semantics, `--format github` annotation output. |
| Govern a shared schema across repos | D2 | | Vendoring (`schemas vendor`, integrity pins), and the URL form with its tradeoff: remote `$schema`, 10 s timeout, caching, versioning. |
| Consume results programmatically | D3 | | `--format json`, `get` command, TypeScript API. |
| Gate on rules that span files | D4 | | `docmeta query` and the one-row-per-file table it builds. Covers joins as `--check` CI gates, such as dangling refs and duplicate slugs. Covers `-f json` and the `--db` export. Names apply-by-default writes (`--dry-run` previews, `--check` never mutates) without manualing them. Doc-detective steps run the real gates over `test/fixtures/query/`. Source of truth: `src/commands/query.ts`, drift-checked via the CLI reference. |

### Define & evolve schemas (Sara)

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Author a schema for your metadata standard | S1 | ★ | Required/recommended, `uri`/`date-time` formats; uses `extra.schema.json` fixture. |
| How schema resolution works & how to wire it | S2 | ★ | The 5-level precedence chain; `$schema` in a file; ref kinds (builtin/file/url). |
| Versioning & dialects | S3 | | 2020-12 through draft-04, and how to evolve without breaking CI. Includes the DDL section (0024). ALTER edits the resolved schema and migrates the corpus in one statement. It edits in place for a file schema and forks for a built-in, with versioning left as the deliberate move. |
| Built-in OKF schema, explained | S1 | | `google:okf:0.1`: fields, dialect, spec link. |
| Built-in taxonomy schemas | S1 | | `diataxis:diataxis:1.0`, `tgdp:templates:1.0`, and `passo-uno:seven-action:1.0`: vocabularies, why `type` vs `action`, which pair competes for `type`, why both `type` schemas require their key and Seven-Action does not, composing with OKF, crosswalk. |
| Built-in Docusaurus schemas | S1, M3 | | `docusaurus:docs:3.10`, `docusaurus:blog:3.10`, `docusaurus:pages:3.10`: the three plugin front matter contracts, field by field. These are platform schemas rather than editorial ones. They require nothing, so they are format checks that compose with any vocabulary. Covers what they deliberately skip (cross-field TOC levels, unknown keys) and the per-directory override config a Docusaurus site needs. |
| Built-in platform schemas | S1, M3 | | `astro:starlight:0.41`, `antora:page:3.1`, `sphinx:docinfo:9.1`, `myst:frontmatter:1.10`: the non-Docusaurus toolchain contracts. Carries the rule that a platform schema requires exactly what the generator refuses to build without. That is why Starlight and Antora demand `title` while Sphinx and MyST demand nothing. Also the AsciiDoc typing rules (attribute values are strings, bare attributes are `true`) and the pre-1.0 pin caveat for Starlight. |
| Built-in metadata vocabularies | S1 | | `ogp:article:1.0`, `dcmi:elements:1.1`, `microsoft:learn:1.0`: how a page describes itself to something outside the docs site. Open Graph is the only built-in checking something no build tool checks. Covers the two `format` traps: `og:locale` uses underscores, and `ms.date` is MM/DD/YYYY rather than ISO. Also carries the standing rule on not enumerating a vocabulary whose published list is not authoritative. |
| Element metadata in XML and HTML | S1, S2 | | The rule that the containing element is the namespace (`article.byline`, `prolog.author`, `head.title`). What each format lifts by convention, and what it declines. The `elements:` config path syntax (slash-separated, `@attr`), and the update-vs-create write boundary. The page the rule lives on; the DITA page links to it. |
| Built-in Agent Skills schemas | S1 | | `agentskills:skill:1.0` and `anthropic:claude-skill:2.1`: the two `SKILL.md` front matter contracts. Carries the one place docmeta closes `additionalProperties`, and why. The packaging and upload path hard-errors on a key outside the standard's six. A permissive schema would therefore pass a file that cannot ship. Also the Claude Code extension set. It covers the three enumerated fields, and why `model` is not one of them. It covers the boolean-spelling trap in YAML 1.2 as well. |
| Built-in Claude Code subagent schema | S1 | | `anthropic:claude-subagent:2.1`: the agent definition contract under `.claude/agents/`. Carries why this one requires `name` and `description` when the `SKILL.md` schema requires nothing. An agent file missing either does not load, and the `name` case is silent. Also the four fields that look like skill fields and are not. Those are `tools`/`disallowedTools` vs `allowed-tools`/`disallowed-tools`, and `background`, which takes two spellings here and six there. Then the five enumerated sets, and the two places the shipped loader is broader than the published docs (`isolation: remote`, `permissionMode: manual`). |
| Built-in DITA schema | S1 | | `oasis:dita-metadata:1.3` and the ten prolog keys. Why a map spells five of them `topicmeta.*`, and why both metadata channels are validated. What `fill` creates, why `<vrm>` is keyed for itself, and what checks the written output. |

### Fix a failing check (Theo)

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Read & fix a validation failure | T1 | ★ | Error → field → line → fix → re-run. Common failures: missing `type`, bad `date-time`, schema not found, parse error. Uses `missing-type.md` and `bad-timestamp.md` fixtures. Includes the `fill` shortcut for missing fields. |
| FAQ | T1 cross | | "No frontmatter?", "Which schema fired?", "Validate one field?", etc. |

### Reference (lookup shelf that supports all journeys)

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Built-in schemas (registry) | S1, M1 | ★ | The hub for everything docmeta ships. One table of all twenty-three ids, with what each constrains, what it requires, and which two are on by default. Then the editorial-vs-platform distinction, and the three ways to turn one on. The OKF, taxonomy, Docusaurus, platform, vocabulary, DITA, Agent Skills, and Claude Code subagent pages are its detail pages. Source of truth: `src/core/schema-registry.ts`, `src/core/resolve-schema.ts`. |
| CLI reference | All | ★ | `validate`/`get`/`query`/`fill`/`schemas`; every flag. The `query` section is the flag surface only. The command's contract lives on its own page below, so the two cannot drift. Source of truth: `src/cli.ts`, guarded by `npm run docs:check-cli`. |
| `query` command reference | D4, D3, M2, S3 | | The lookup page for the largest module in the repo. Covers the `docs` table (system and data columns, value encoding, `lineFor`/`explicit_null`), and named collections as read-only views. Covers the vocabulary split, where DML edits the files and DDL edits the schema. Covers the DDL type bridge (formats as column types, `CHECK IN` as `enum`), which schema an `ALTER` edits, and every refusal it raises. Then `-s` as the DDL target, write-by-default with `--dry-run` as the preview, and rows as findings. Then bound parameters, the six output formats, the `--db` export, and the exit-code contract. Doc-detective steps run the whole surface over `test/fixtures/query/`, `collections/`, and `ddl-bridge/`. Source of truth: `src/commands/query.ts`, `src/core/{projection,collections,checks}.ts`, `src/reporters/query.ts`. |
| Configuration reference | M1, D1 | ★ | Full `docmeta.config.yaml` keys, types, defaults, CLI-merge precedence. Source of truth: `src/core/config.ts`. |
| Schema resolution reference | S2, D2 | ★ | Precedence chain + ref kinds + dialects. Source of truth: `resolve-schema.ts`, `schema-registry.ts`, `validator.ts`. |
| Supported formats reference | All | ★ | Extractor/extension/metadata-model table: Markdown, MDX, AsciiDoc, RST, XML, HTML. Source of truth: `src/extractors/`. |
| Output formats & exit codes | D1, D3 | ★ | `pretty`/`json`/`github` shapes; `NO_COLOR`/TTY behavior. Source of truth: `src/reporters/index.ts`. |
| GitHub Action reference | D1 | ★ | Every input and output of `hawkeyexl/docmeta@v4`, with defaults, the one-item-per-line rule for multi-value inputs, and why globs reach docmeta unexpanded. Source of truth: `action.yml`, guarded by `npm run docs:check-action`. |
| TypeScript API reference | D3 | | Every symbol the programmatic entry point publishes, with a purpose per export. That covers command cores, schema resolution, config, cache, reporters, extractors, and result types. Drift-checked against the built `dist/index.d.ts` by `npm run docs:check-api`, so a new export cannot ship undocumented. Source of truth: `src/index.ts`. |
| Glossary | All | | frontmatter, extractor, schema set, dialect, `$schema`, OKF. |

### Supporting / project

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Slimmed README | All | ★ | Hook, badges, 5-line quickstart, links into site. Lives at repo root, not in site. |
| CONTRIBUTING.md | n/a | ★ | Dev setup, red/green TDD, Conventional Commits, how to add an extractor. |

---

## Source-of-truth mapping

Reference pages must never contradict the source code. Before writing any Reference page, cross-read the corresponding file:

| Reference page | Source file(s) |
|---|---|
| CLI reference | `src/cli.ts` |
| `query` command reference | `src/commands/query.ts`, `src/core/projection.ts`, `src/core/collections.ts`, `src/core/checks.ts` (the column convention), `src/reporters/query.ts`, `src/cli.ts` (the flag gates) |
| TypeScript API reference | `src/index.ts`, the built `dist/index.d.ts` (guarded by `scripts/check-api-reference.mjs`) |
| Configuration reference | `src/core/config.ts` |
| Schema resolution reference | `src/core/resolve-schema.ts`, `src/core/schema-registry.ts`, `src/core/validator.ts` |
| Supported formats reference | `src/extractors/index.ts`, individual extractors, `src/extractors/frontmatter-write.ts` (writability) |
| Output formats & exit codes | `src/reporters/index.ts`, `src/reporters/fill.ts` |
| `fill`: CLI reference §`fill` (flags, drift-checked), Run `fill` under a data-egress policy (what is sent and kept), Retrofit step 7 (the journey) | `src/commands/fill.ts`, `src/commands/fill-prompt.ts`, `src/commands/fill-types.ts` |
| Built-in OKF schema | `src/schemas/okf/0.1.json` |
| Built-in taxonomy schemas | `src/schemas/diataxis/1.0.json`, `src/schemas/tgdp/1.0.json`, `src/schemas/seven-action/1.0.json`, `src/core/resolve-schema.ts` (the default set) |
| Built-in schemas (registry) | `src/core/schema-registry.ts` (the id list), `src/core/resolve-schema.ts` (the default set) |
| Built-in Docusaurus schemas | `src/schemas/docusaurus-docs/3.10.json`, `src/schemas/docusaurus-blog/3.10.json`, `src/schemas/docusaurus-pages/3.10.json`; upstream: `@docusaurus/plugin-content-*` front matter reference |
| Built-in platform schemas | `src/schemas/starlight/0.41.json`, `src/schemas/antora/3.1.json`, `src/schemas/sphinx/9.1.json`, `src/schemas/myst/1.10.json` |
| Built-in metadata vocabularies | `src/schemas/ogp/1.0.json`, `src/schemas/dcmi/1.1.json`, `src/schemas/microsoft-learn/1.0.json` |
| Element metadata | `src/extractors/element-key.ts`, `src/extractors/element-write.ts`, `src/extractors/xml-read.ts`, `src/extractors/html-read.ts`, `src/core/config.ts` (`elements:`) |
| Built-in DITA schema | `src/schemas/dita/1.3.json`, `src/extractors/dita.ts` (`DITA_LIFTS`, `DITA_CONTENT_MODEL`) |

---

## Phased rollout

- **Phase 1, Launch (★):** home + on-ramp, M1 anchor guide + config page, M3 overrides page. Then the D1 CI recipes + exit codes page, and the S1 + S2 schemas pages. Then the T1 fix-it page, and the full Reference shelf (7 pages).
- **Phase 2, Depth:** M2, M-cross retrofit, M4 egress page, D2, D3, S3, OKF explained, FAQ, Glossary.
- **Phase 3, Polish:** CONTRIBUTING, case studies, cross-persona refinements.

---

## Journey walk-through test

Before declaring any ★ CUJ complete, follow all its linked pages from start to finish and confirm:
1. A user reaches the stated outcome without leaving the track (except deliberate Reference lookups).
2. Every code example uses a `test/fixtures/` file that CI actually runs.
3. Every page has `title` and `description` frontmatter.
