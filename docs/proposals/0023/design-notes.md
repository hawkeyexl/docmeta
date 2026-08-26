# Default-schema design notes — working ledger

**Status: design phase — proposal drafted, review open. Nothing is
canonical.** The record is `docs/proposals/0023-metadata-vocabularies.md`;
the community-facing page is
`docs/src/content/docs/proposals/frontmatter-vocabularies.mdx` (passes the
dogfood gate and the docs build). Nine draft schemas live unregistered
under `src/schemas/` — the six house ids below plus evals, kg, and
artifact-evals. Spec-by-example: `test/default-schema.test.ts` (red until
registration, by design) and the runnable ladders `docs/proposals/0023/ladders/*.cjs` (plus `compat-check.cjs`, the composability cross-check) — and `test/default-schema.test.ts` runs green via file refs, with only default-set membership skipped until registration.

## The principles (settled through the field walk)

1. **Weak floors teach bad habits.** `title` + `description` required as
   non-empty strings — a recorded exception to the composability law
   (Docusaurus allows empty; DCMI allows arrays; both are override cases).
2. **One value is a string; many values are a list.** No per-field trivia.
   DCMI's repeated-element forms for `type`/`language` are override cases.
3. **Claim content, never rendering.** Killed `tags`, `slug`, `image`,
   `layout` (and the presentation group as a concept).
4. **Derivable facts lie.** Killed `updated`, `date`, `next-review`,
   `contact`-as-a-second-reach-field. Git owns change dates; `last-reviewed`
   + `review-interval` derive the due date; dates only a human can assert
   stay (`last-reviewed`, `remove-by`).
5. **Facts live at their altitude.** `stakeholders` is page-level (who to
   consult about THIS page) — deliberately distinct from the project-level
   `stakeholders` cut in the exploration brief's addendum (its draft 0021 — not main's query proposal); `expertise` fell because level
   belongs to the persona definitions the page points at.
6. **Enumerate only what is switched-on and bounded** (`visibility`,
   `lifecycle`); **recommend openly** elsewhere — `risks` uses the open-enum
   idiom (`anyOf` of enum + free string).
7. **Compose, don't duplicate.** `action` comes from
   `passo-uno:seven-action:1.0` in the default set; `kg` (dockg) and
   `metadata.evals` (moose-tracevals) stay unclaimed; the classification
   story is three layers: `type` (what the page is) · `action` (what the
   reader is doing) · `intent` (the specific job).

## The six house vocabularies — 32 fields, split by intent

Designed as one large schema, then split by owner directive into six
intent-scoped ids (superseding the earlier `docmeta:frontmatter:1.0` id
ruling — the split is why): `docmeta:core:1.0` (required pair; the only
default-set candidate), `docmeta:stewardship:1.0`, `docmeta:audience:1.0`,
`docmeta:lifecycle:1.0`, `docmeta:structure:1.0` (honoring the recorded
naming decision recorded in the exploration brief for the relational schema), `docmeta:ai-context:1.0`.
Disjoint by construction (0 collisions, pinned) — stacking all six behaves
exactly like the monolith, and every error is attributed to one intent.
Verified: `npx vitest run test/default-schema.test.ts` — green via file
refs into the drafts (default-set membership skipped until registration).
Field homes:

- **Core (docmeta:core:1.0):** title*, description* — and every string core
  claims is non-empty, with type/language single-valued even against DCMI
  (the recorded exception family)
  plus id, type, keywords, authors, language
- **Stewardship (docmeta:stewardship:1.0):** owner, stakeholders,
  reviewed-by, last-reviewed, review-interval, verified-against,
  source-of-truth
- **Audience & intent (docmeta:audience:1.0):** audiences, personas,
  journeys, intent, visibility
  (enum: draft → restricted → confidential → internal → public)
- **Lifecycle (docmeta:lifecycle:1.0):** lifecycle (enum:
  draft|published|deprecated|archived; deprecated ⇒ replaced-by or
  remove-by), replaced-by, supersedes, remove-by
- **Structure (docmeta:structure:1.0):** applies-to, concepts,
  prerequisites, next-steps, related-pages (renamed in step with kg's
  related-concepts — each says what it points at)
- **AI context (docmeta:ai-context:1.0):** generated-by, provenance (the
  kg.provenance pattern generalized; entries retire under human review),
  risks (open enum: cost-incurring, destructive, irreversible, privileged,
  open-world, read-only, idempotent — first four from the
  context-engineering deck, last three mirroring MCP tool annotations),
  sample-questions (one question or a list, like every list field)

**Recorded intent for post-review (not applied):** append to
`DEFAULT_SCHEMAS`; requiring title+description on bare runs is a deliberate
`feat!:`; demo video per house rule.

**Open questions for the community draft:** the flattening of `applies-to`
to labels — the deck modeled named dimensions (product/deployment/
generation) and this loses them; the prefix-label convention
(`deploy:kubernetes`) is the escape hatch, and the model's author should
get a direct look; the `lifecycle` enum's org-ladder cost; `risks` naming now that assurances (`read-only`,
`idempotent`) sit in a field called risks; the `stakeholders` name against
the exploration brief's project-level cut (one honest paragraph required).

## docmeta:evals:1.0 — revised from docevals frontmatter-0.1

Claims four keys: `evals` (one assertion string, or a list of entries),
`eval-suite`, `eval-skip`, and `eval-provenance` (the generalized
provenance pattern under the reserved prefix). Entry forms: string shorthand · `use:` reference ·
inline definition (closed objects; typos fail loudly).

Graders — `ai | command | human | tool:<kebab>`, default `ai`:

| Grader | Requirement | Notes |
|---|---|---|
| `ai` | assertion | replaces 0.1's `llm`; optional `provider` picks a model endpoint or agent runner, validated at run time by the inference dependency |
| `command` | assertion or command | no `command` = generation contract: tooling generates a check script, writes back `command` + `generated-assertion-hash` (flattened from 0.1's `generated.assertionHash`) |
| `human` | assertion | new rule — a reviewer must have something to verify |
| `tool:*` | nothing | the tool is the check; `options` are the grader's runtime contract, outside the schema |

Vocabularies: `type: capability | regression` (default regression);
`severity: error | warning | info` (only error fails); `severity-map`
translates a tool's per-finding severities (meaningful on `tool:*` only).

**Fidelity ledger vs docevals frontmatter-0.1:**

- Renamed: `name`→`id`, `llm`→`ai`, `successExitCodes`→`success-exit-codes`,
  `timeoutMs`→`timeout-ms`, `generated.assertionHash`→`generated-assertion-hash`
- Removed: the object form (`suite`/`skip` hoisted to `eval-suite`/`eval-skip`);
  `generatedBy` (the top-level `generated-by` in docmeta:ai-context:1.0 owns AI
  provenance; the self-preference-bias check reads it there)
- Added: `severity-map` (their documented-but-schema-rejected field),
  `provider`, the single-string shorthand, the human⇒assertion rule
- Unchanged: entry forms, grading semantics, `capability|regression`,
  `error|warning|info`, the `tool:*` open family, kebab id pattern

**Placement intent:** opt-in built-in, NOT the default set — a schema
claiming `evals` puts the block on `docmeta fill`'s menu, and docevals'
own fill is the intended proposer. Stack the six house ids with
`docmeta:evals:1.0` deliberately.

**docevals-side ledger (their repo, post-review):** a superseding ADR over
01000 ("schemas are published by the tool that owns them" → the new line:
docmeta publishes generic metadata vocabularies, tools own domain
ontologies); resolver reads the kebab spellings, top-level `generated-by`,
and `eval-suite`/`eval-skip`; **reserve the `eval-` prefix** — error on
unrecognized top-level `eval-*` keys, restoring the closed block's
loud-typo property at the open page root; `frontmatter-valid` points at the
docmeta-published URL. Open: whether grader runtime option names
(`maxAgeDays`, `maxGrade`, `maxSimilarity`) also kebab.

**Verified ladder** (all in `ladders/evals-examples.cjs`, 23 cases): single-string shorthand; list shorthand; mixed list with
references; flat `eval-suite`; `eval-skip: true`; ai default and
ai-with-provider; command authored/post-generation/explicit-maximal; human
maximal; tool spread (freshness, doc-structure-lint, vale + severity-map,
differentiation). Negatives pin: 0.1 object form fails, `llm` spelling
fails, `generated` wrapper fails, misspelled entry fields fail, ai/human
without assertion fail, `eval-skip` as string fails.

## docmeta:kg:1.0 — revised from dockg frontmatter-0.8

One closed `kg` envelope (kept deliberately: a closed typo-catching block
coexisting with an open page), nothing required, files without `kg` pass.
Verified ladder: `ladders/kg-examples.cjs` (9 positive + 7 negative,
including the 0.8 worked example translated — the fidelity proof).

**Fidelity ledger vs 0.8:**

- Renamed (kebab + plain language; the RDF mapping lives in descriptions,
  where it always did — iiRDS is kebab upstream anyway):
  prefLabel → **label** · altLabels → alt-labels · subjects →
  **concepts** (nominal twin of the page-level field — same fact, deeper
  wins) · related → **related-concepts** (in step with the page-level
  rename to related-pages) · topicType → **type** (nominal twin of the
  page-level `type`: the open page value derives it, the closed iiRDS
  enum here wins) · appliesTo → applies-to · softwareLifecyclePhase →
  **about-product-lifecycle** (the about-ness is structural: what the
  page is ABOUT, never the page's own `lifecycle`) · softwareSubject →
  **about-product-aspect** (aspects: architecture | interface |
  system-requirement; pairs with about-product-lifecycle) ·
  notApplicableTo → not-applicable-to · notSoftwareSubject →
  not-about-product-aspect · revisionOf → revision-of · derivedFrom →
  derived-from; provenance entries' generated-by; the
  provenance `fields` enum values (self-referential, renamed with the
  fields). broader/narrower stay bare — nothing collides.
- Removed: kg.generatedBy (top-level `generated-by` owns page provenance);
  the deprecated single-object `provenance` shape (0.2/0.3). The
  provenance ARRAY survives whole: per-model entries of generated-by +
  fields + confidence, fill's human-review trail. No timestamp, ever —
  dockg's determinism invariant forbids wall-clock.
- Widened: every label/enum list takes single-string shorthand; every
  0.8-valid document stays valid.
- Kept: dependentRequired (hierarchy ⇒ pref-label), all three iiRDS enums
  closed (published lists = the authority constraint 3 asks for), negative
  scope, sections with free slug keys (brokenSectionRef is the build-layer
  check), confidence trail.

**Owner rulings — the harvest rule:** *deeper wins; the top level is the
harvest fallback*, per fact, not per page. kg.subjects beats `concepts`
for subjects while everything the block doesn't speak to still harvests
(`generated-by`, `supersedes`/`replaced-by` → prov:wasRevisionOf,
`prerequisites` → dcterms:requires, `related`/`next-steps` →
dcterms:references, `applies-to` values → iirds:ProductVariant,
`concepts` → dcterms:subject/skos:Concept). Legacy kg.generatedBy beats
top-level by the same rule. D4 accepted: derive kg-less `topic-type` from
the page's `type` (how-to→task, tutorial→learning, explanation→concept,
reference→reference, troubleshooting→troubleshooting); explicit block
wins. dockg-side ledger: superseding ADR over "never a docmeta built-in";
deriver reads kebab keys + the fallback rule + the type derivation;
single-string normalization.

## docmeta:artifact-evals:1.0 — revised from moose-tracevals artifact-evals-0.2

Eval declarations for instruction artifacts (skills, agents,
project-rules). The page-side trio appears verbatim one level down —
`metadata.evals` (one assertion or the list), `metadata.eval-skip`,
`metadata.eval-provenance` — because the artifact's top level is the host
tool's contract and `metadata` is its sanctioned extension bag. 0.2's
`criteria` container is dissolved the same way the page side's object form
was, so the word criteria leaves the family vocabulary. `metadata` stays
open (other tools' members pass untouched); entry objects are closed; the
loud-typo guard is the same `eval` prefix reservation, applied inside
`metadata`. Verified ladder: `ladders/artifact-evals-examples.cjs`.

**Fidelity ledger vs 0.2** (tracevals unshipped — breaks are free):

- Renamed: optional position-derived `name` → **required `id`** on the
  object form (position-derived ids orphan cached verdicts; the string
  shorthand stays the id-less path); `llm` → `ai`.
- Changed: grader closed-enum(8) → **open enum** (recommended: ai, human, command,
  tool-usage, skill-invoked, file-access, turn-count, cost, regex,
  json-output — plus the page side's tool:* spelling; any kebab name
  legal, registry-validated at run time).
  The grader principle across both eval schemas: *closed where the schema
  switches on the value (page side's ai|command|human conditionals), open
  where only the runtime registry does* — cost: a stale `llm` passes the
  schema and is rejected by the registry.
- Widened: examples pass/fail → string-or-list (both eval schemas — the
  artifact side's anchor lists are real usage).
- Added: `provider` (ai evals), `metadata.eval-provenance` (the family
  pattern; entries keyed `evals:` like the page side), the single-string
  block shorthand (`metadata.evals: <assertion>`), and the `human` and
  `command` graders from the page side — `human` is judged per session
  (every trace is new; no verdict caching, unlike pages), `command` runs
  an executable over `{trace}` with the same generation contract
  (command + generated-assertion-hash written back), making the two eval
  schemas' entry vocabularies fully congruent.
- Unchanged: the `metadata` envelope (host contract), type/severity
  verbatim, evidence/options, string shorthand entries, every
  session-grader kind.
- With id + assertion always required, 0.2's conditional machinery is
  unnecessary — the entry has no allOf at all.
- tracevals-side ledger: superseding ADR over "never a docmeta built-in";
  extract/write/fill read `id` and the new spellings; grader registry
  rejects unknown kinds (including `llm`).

## doc-structure-lint — frontmatter fit (looked at, not a schema)

Owner's own repo, alpha, dormant since 2025-01 (0.0.5 never published).
Verdict: improve by **selection, not validation**. The plumbing is ~60%
there: remark-frontmatter is wired (a `---` block is a yaml node, never
miscounted as content), `structure.frontmatter` is populated and handed to
the validator, where `// TODO: Check frontmatter` sits unimplemented — and
open issue #13 already asks for template selection from frontmatter "to
lint multiple different kinds of documents in a single run" (today
`--template` is required and broadcast over every file in a directory).

- **Do:** select the template from the page's `type` via a type→template
  map in templates.yaml (repo-level fact at repo-level altitude), CLI
  `-t` overriding — zero new frontmatter vocabulary. Do NOT use issue
  #13's proposed `template:` key: Starlight claims `template` as
  enum(doc|splash), so `template: how-to` breaks stacked platform
  validation; if a per-page override is ever needed, a kebab house-free
  key (`structure-template`) is the safe spelling.
- **Don't:** grow frontmatter-validation rules (README roadmap item) —
  docmeta owns that layer, and template-conditional requirements
  ("how-tos must carry intent") are already expressible as if/then on
  `type` in an org schema. Resolve the roadmap item by documented
  delegation; delete the TODO.
- Housekeeping found in passing: the frontmatter extractor is a
  hand-rolled line splitter that shreds nested YAML (the repo already
  depends on `yaml` — parse properly); TOML `+++` frontmatter is not
  enabled and would inflate paragraph counts; suspected latent bugs —
  the AJV key pattern `^[A-Za-z0-9-_]+$` vs the repo's own spaced
  section keys ("Next steps"), and a positional section-match undefined
  dereference (TypeError, not a finding) when a document has fewer
  sections than its template — both relevant to docevals grader
  robustness.

## Family walk status — COMPLETE

- **docevals** → docmeta:evals:1.0 · **dockg** → docmeta:kg:1.0 ·
  **moose-tracevals** → docmeta:artifact-evals:1.0. All drafts live under
  `docs/proposals/0023/schemas/` (outside the frozen registry), verified
  by the `ladders/*.cjs` runs and the green spec suite. Proposal 0023 and
  the published review page are up; next is the community review itself.
