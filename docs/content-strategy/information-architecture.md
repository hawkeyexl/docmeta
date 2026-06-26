# Information architecture & content set

## IA design principle

The site is organized by user intent, not by document type. Each top-level section maps to a persona's job-to-be-done. The landing page is a router: "What do you want to do?" leads users into the matching track. Reference material is a flat lookup shelf that journeys deep-link into — it supports navigation, it does not drive it.

**Frontmatter requirement:** every page in `docs/src/content/docs/**` must include `title` and `description` in its frontmatter. Authoring agents must not create pages without both fields.

---

## Navigation tree

```
Home — "What do you want to do?" router + 30-second proof
│
├─ Get started                     (universal on-ramp → feeds M1)
│
├─ Set up validation  (Maya)       → M1, M2, M3
│
├─ Run it in CI       (Devin)      → D1, D2, D3
│
├─ Define & evolve schemas (Sara)  → S1, S2, S3
│
├─ Fix a failing check (Theo)      → T1   (highest-traffic; cross-cutting)
│
└─ Reference (lookup shelf)        → CLI · Config · Schema resolution ·
                                      Formats · Output & exit codes ·
                                      Built-in schemas
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
| Install & first validation | M1 | ★ | `npx docmeta validate <file>`, read pass/fail output, Node 20+ requirement. |

### Set up validation (Maya)

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Stand up validation for your repo | M1 | ★ | Anchor guide threading install → config → schema → CI. |
| Create your `docmeta.config.yaml` | M1 | ★ | paths, exclude, schemas, discovery keys with types and defaults. |
| Apply different schemas to different folders | M3 | ★ | Overrides, glob precedence, multi-schema per file. |
| Roll out a new required field without breaking the build | M2 | | Incremental ratchet, staged rollout across a large repo. |
| Retrofit docmeta into an existing docs repo | M1/M2 | | Start lenient, tighten over time. Cross-cutting guide. |

### Run it in CI (Devin)

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Add docmeta to CI — GitHub Actions recipe | D1 | ★ | From `examples/`. |
| CI recipes: GitLab CI, Jenkins, pre-commit | D1 | ★ | Fills current GitHub-only gap. |
| Exit codes & PR annotations contract | D1 | ★ | 0/1/2 semantics, `--format github` annotation output. |
| Govern a shared schema by URL | D2 | | Remote `$schema`, 10 s timeout, per-run caching, versioning. |
| Consume results programmatically | D3 | | `--format json`, `get` command, TypeScript API. |

### Define & evolve schemas (Sara)

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Author a schema for your metadata standard | S1 | ★ | Required/recommended, `uri`/`date-time` formats; uses `extra.schema.json` fixture. |
| How schema resolution works & how to wire it | S2 | ★ | The 5-level precedence chain; `$schema` in a file; ref kinds (builtin/file/url). |
| Versioning & dialects | S3 | | 2020-12 through draft-04; evolve without breaking CI. |
| Built-in OKF schema, explained | S1 | | `google:okf:0.1`: fields, dialect, spec link. |

### Fix a failing check (Theo)

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Read & fix a validation failure | T1 | ★ | Error → field → line → fix → re-run. Common failures: missing `type`, bad `date-time`, schema not found, parse error. Uses `missing-type.md` and `bad-timestamp.md` fixtures. |
| FAQ | T1 cross | | "No frontmatter?", "Which schema fired?", "Validate one field?", etc. |

### Reference (lookup shelf — supports all journeys)

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| CLI reference | All | ★ | `validate`/`get`/`schemas`; every flag. Source of truth: `src/cli.ts`. |
| Configuration reference | M1, D1 | ★ | Full `docmeta.config.yaml` keys, types, defaults, CLI-merge precedence. Source of truth: `src/core/config.ts`. |
| Schema resolution reference | S2, D2 | ★ | Precedence chain + ref kinds + dialects. Source of truth: `resolve-schema.ts`, `schema-registry.ts`, `validator.ts`. |
| Supported formats reference | All | ★ | Extractor/extension/metadata-model table: Markdown, MDX, AsciiDoc, RST, XML, HTML. Source of truth: `src/extractors/`. |
| Output formats & exit codes | D1, D3 | ★ | `pretty`/`json`/`github` shapes; `NO_COLOR`/TTY behavior. Source of truth: `src/reporters/index.ts`. |
| Glossary | All | | frontmatter, extractor, schema set, dialect, `$schema`, OKF. |

### Supporting / project

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Slimmed README | All | ★ | Hook, badges, 5-line quickstart, links into site. Lives at repo root, not in site. |
| CONTRIBUTING.md | — | ★ | Dev setup, red/green TDD, Conventional Commits, how to add an extractor. |

---

## Source-of-truth mapping

Reference pages must never contradict the source code. Before writing any Reference page, cross-read the corresponding file:

| Reference page | Source file(s) |
|---|---|
| CLI reference | `src/cli.ts` |
| Configuration reference | `src/core/config.ts` |
| Schema resolution reference | `src/core/resolve-schema.ts`, `src/core/schema-registry.ts`, `src/core/validator.ts` |
| Supported formats reference | `src/extractors/index.ts`, individual extractors |
| Output formats & exit codes | `src/reporters/index.ts` |
| Built-in OKF schema | `src/schemas/okf/0.1.json` |

---

## Phased rollout

- **Phase 1 — Launch (★):** home + on-ramp, M1 anchor guide + config page, M3 overrides page, D1 CI recipes + exit codes page, S1 + S2 schemas pages, T1 fix-it page, full Reference shelf (6 pages).
- **Phase 2 — Depth:** M2, M-cross retrofit, D2, D3, S3, OKF explained, FAQ, Glossary.
- **Phase 3 — Polish:** CONTRIBUTING, case studies, cross-persona refinements.

---

## Journey walk-through test

Before declaring any ★ CUJ complete, follow all its linked pages from start to finish and confirm:
1. A user reaches the stated outcome without leaving the track (except deliberate Reference lookups).
2. Every code example uses a `test/fixtures/` file that CI actually runs.
3. Every page has `title` and `description` frontmatter.
