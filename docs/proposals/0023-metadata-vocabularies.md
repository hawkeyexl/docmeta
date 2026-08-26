# 0023 — the docmeta metadata vocabularies

- **Status:** Proposed — open for community review before anything registers
- **Serves:** Sara · S1 "Define our metadata standard as a schema" · S2 "Wire schemas to the right documents"
- **Relates to:** an earlier, unmerged house-vocabulary exploration whose
  briefing seeded this work. That exploration numbered its own drafts 0021
  and 0022 on its branch; those numbers have since been taken on `main` by
  the `docmeta query` proposals, so references here to "the exploration's
  0021/0022" mean the unmerged drafts, never the shipped query records
- **Touches:** `docs/proposals/0023/` (the nine draft schemas under
  `schemas/`, the verification ladders under `ladders/`, and the working
  design notes), `test/default-schema.test.ts`,
  `test/fixtures/default-schema/`, `docs/src/content/docs/proposals/`,
  `docs/astro.config.mjs` (the published Proposals sidebar group),
  `.github/workflows/formats-demo.yml` (excludes the new fixtures from the
  demo's code-scanning feed)

## Summary

Nine metadata vocabularies, published by docmeta, designed as one family:

| Id | One question it answers | Fields |
|---|---|---|
| `docmeta:core:1.0` | What is this page? | 7 (requires `title`, `description`) |
| `docmeta:stewardship:1.0` | Is it cared for? | 7 |
| `docmeta:audience:1.0` | Who does it serve; who may see it? | 5 |
| `docmeta:lifecycle:1.0` | Where is it in its life? | 4 (+ the deprecation rule) |
| `docmeta:structure:1.0` | What does it connect to? | 5 |
| `docmeta:ai-context:1.0` | How did machines make it; how may they use it? | 4 |
| `docmeta:evals:1.0` | What must be true of this page? | revision of docevals `frontmatter-0.1` |
| `docmeta:kg:1.0` | What does the knowledge graph know about it? | revision of dockg `frontmatter-0.8` |
| `docmeta:artifact-evals:1.0` | What must a session using this artifact have done? | revision of moose-tracevals `artifact-evals-0.2` |

**Nothing in this proposal is registered.** The drafts live at
`docs/proposals/0023/schemas/` — deliberately *outside* `src/schemas/`, which
is the registry the immutability guard freezes, not a staging area. Nothing
is in `BUILTINS`, `PUBLISHED_ALIAS`, `DEFAULT_SCHEMAS`, or the manifest, and
`schemas:sync` has not run. The spec suite `test/default-schema.test.ts`
runs green **today** by validating through file refs into the drafts — the
same `runValidate` path shipped code uses — with one `describe.skip` block
(default-set membership, the only thing file refs cannot test) that the
registration PR flips on. Registration, publication, and the default-set
change land in that follow-up PR only after the community review this
proposal exists to invite. The review surface is the site's Proposals sidebar group: a hub overview
(`docs/src/content/docs/proposals/frontmatter-vocabularies.mdx`) plus a
dedicated page per vocabulary — nine pages, each with fields, examples,
rationale, and its own review asks.

## Why a family, and why now

docmeta ships built-ins that transcribe contracts other people published —
Hugo's front matter, DITA's prolog, Open Graph. These nine are the first it
would publish itself: the facts a docs set needs in order to be *maintained*
and *machine-consumed*, which no generator defines and no standard owns —
ownership, review, audience, applicability, lifecycle, relationships, AI
provenance and guidance, and per-document quality contracts.

The evidence base: a context-engineering model for AI-ready documentation
(the maturity ladder `id · type · description · owner` → typed applicability →
eval-instrumented → drift-monitored, with `intent`, `source-of-truth`,
`risks`, and per-page sample questions); a survey of 225 writing skills' entry
criteria as a metadata demand signal; the registry's own key space (19
built-ins, 220 distinct keys once the in-flight platform schemas land); and
the in-progress metadata contracts of three tools in the same family —
docevals, dockg, and moose-tracevals — whose drafts this proposal promotes
into common vocabularies rather than working around them.

## The principles

Every field decision below traces to one of these. They were derived by
cutting, and each names what it cut.

1. **Weak floors teach bad habits.** `title` and `description` are required,
   non-empty, single strings — a recorded exception to the composability law
   (Dublin Core allows arrays, Docusaurus allows empty; both are override
   cases). All three family repos' docs gates already enforce exactly this.
2. **One value is a string; many values are a list.** No per-field trivia:
   single-valued facts are plain strings, list-valued facts accept a string
   or a list everywhere.
3. **Claim content, never rendering.** Cut `tags`, `slug`, `image`, `layout`,
   and every navigation and position field. A generator-owned fact carried
   under a second name is worse than a collision, because a collision at
   least fails loudly.
4. **Derivable facts lie.** Cut `updated`, `date`, and the stored review
   due-date. Git owns change dates; `last-reviewed` + `review-interval`
   derive the deadline; the dates that stay are the ones only a human can
   assert (`last-reviewed`, `remove-by`).
5. **Facts live at their altitude.** `stakeholders` is page-level (who to
   consult about *this* page — deliberately distinct from the project-level
   stakeholders the earlier exploration cut); reader `expertise` fell,
   because level belongs to the persona definitions a page points at;
   style guides and type-to-template mappings belong in config.
6. **Enumerate only what is switched-on and bounded — or published.**
   `visibility` and `lifecycle` are the only invented enums (something
   downstream switches on each); the iiRDS enums in `docmeta:kg` stay closed
   because iiRDS publishes them. Everything else recommendable uses the
   **open-enum idiom** — `anyOf` of an advisory enum and a free string — so
   editors and `fill` see the recommendations while no correct document is
   rejected: `risks`, the artifact grader family, `provider`.
7. **Compose, don't duplicate.** `action` stays with
   `passo-uno:seven-action:1.0` in the default set; the classification story
   is three layers — `type` (what the page is), `action` (what the reader is
   doing), `intent` (the specific job). The `evals`, `kg` and `metadata`
   namespaces are never claimed by the house ids: a claimed key lands on
   `docmeta fill`'s menu, and each of those vocabularies has its own fill
   loop in the tools that implement it.
8. **Deeper wins; the top level is the harvest fallback.** Where a `kg` block
   field and a page-level field speak to the same fact — `type`, `concepts`,
   `applies-to`, `supersedes`/`revision-of` — the deeper declaration wins,
   per fact, and the page-level field feeds the graph when the block is
   silent.
9. **Machines propose; humans retire the provenance.** The `provenance`
   pattern (per-model entries naming proposed fields and confidence, deleted
   by humans as they review) appears on the page (`docmeta:ai-context`), in
   the graph block (`kg.provenance`), and in both eval schemas — one answer
   to "which of this metadata did a machine write, and has anyone checked?"

## Why six house ids and not one

The one-large-schema shape was designed first and split afterward, by intent,
for three reasons the split then proved:

- **Adoption curves differ.** A team can require `title` + `description` next
  Tuesday; requiring `personas` means *having* personas; `sample-questions`
  presupposes an eval loop. Each id is one adoption decision.
- **Error attribution becomes the intent.** Stacked, a bad `lifecycle` value
  fails `docmeta:lifecycle:1.0` and nothing else — the report names the
  domain, not a 32-field monolith.
- **Immutability makes fat ids expensive.** Fields on different cadences
  frozen behind one version number means any movement is a new 32-field id.

The six claim **disjoint** field sets (32 fields, zero collisions — pinned by
test), so stacking all six behaves exactly like the monolith did.

## The six house vocabularies

`*` = required. All ids are `additionalProperties: true`.

**docmeta:core:1.0** — `title`\*, `description`\*, `id`, `type`, `keywords`,
`authors`, `language`. The descriptive floor and the only id intended for the
default set. The shared keys are claimed at the loosest lawful definition
(`authors` up to MyST/Docusaurus person objects and nothing looser — list
members are strings or objects, never bare numbers; `keywords` down to
Antora's comma-string) **except where looseness would teach a bad habit**,
and those exceptions are recorded here in full: the required pair is two
non-empty single strings; every other string core claims is also non-empty
(`type: ""` otherwise reaches the kg type derivation and template selection
as a falsy key); and `type` and `language` are single strings even though
Dublin Core's repeatable elements permit arrays. A DCMI document using
repeated `type`/`language` is an override case, exactly like its repeated
titles. The `compat-check` ladder pins every one of these as an
expected-reject, so an exception this list does not name fails the check.

**docmeta:stewardship:1.0** — `owner`, `stakeholders`, `reviewed-by`,
`last-reviewed`, `review-interval` (ISO 8601 duration), `verified-against`,
`source-of-truth`. The review dates are records, not freshness gates — JSON
Schema cannot compare a date to today, and the overdue-review case is pinned
as *passing*; docevals' freshness grader reads the same `last-reviewed` field
and is the thing that owns the clock.

**docmeta:audience:1.0** — `audiences`, `personas`, `journeys`, `intent`,
`visibility` (enum `draft → restricted → confidential → internal → public`,
folding the generator draft flag and the access axis into one switch).

**docmeta:lifecycle:1.0** — `lifecycle` (enum
`draft | published | deprecated | archived`), `replaced-by`, `supersedes`,
`remove-by`; `deprecated` ⇒ `replaced-by` or `remove-by` required. The
inverse edges (`replaced-by`/`supersedes`) live on two files and are not
cross-checked here — dockg's graph (`prov:wasRevisionOf`) is where the pair
reconciles.

**docmeta:structure:1.0** — `applies-to` (flat labels, the harvest fallback of
`kg.applies-to`), `concepts` (glossary terms, fallback of `kg.concepts`),
`prerequisites`, `next-steps`, `related-pages` (suffixed in step with
`kg.related-concepts` — each name says what it points at).

**docmeta:ai-context:1.0** — `generated-by`, `provenance`, `risks`
(recommended flags `cost-incurring · destructive · irreversible · privileged ·
open-world · read-only · idempotent`; the first four from the
context-engineering model, the last three mirroring MCP's tool annotations),
`sample-questions`.

## The quality and graph vocabularies

`docmeta:evals`, `docmeta:kg`, and `docmeta:artifact-evals` are **common
vocabularies**, exactly like the six house ids: any tool can implement them,
and other schemas can compose on top of them. They are not sibling-owned
contracts that docmeta happens to host. Their designs descend from three
tools' in-progress drafts — docevals, dockg, and moose-tracevals — and those
tools are the expected first implementers, which is why each gets a fidelity
ledger below: the ledger records design lineage, not ownership.

All three source tools had recorded "schemas are published by the tool that
owns them" with *don't re-propose a docmeta built-in* rules. This proposal
reverses that deliberately, with a new dividing line: **docmeta publishes
common metadata vocabularies; tools implement behavior — graders, graphs,
runtimes — against them.** Each source repo owes a superseding ADR
(supersede, never amend). The reversal is cheap now and only now: docevals
and moose-tracevals have never shipped, so every break below is loud and
free.

**docmeta:evals:1.0** (from docevals `frontmatter-0.1`) — claims `evals` (one
assertion string or a list of entries: string shorthand, `use:` config
reference, or inline definition), `eval-suite`, `eval-skip`,
`eval-provenance`. Renames: `name`→`id`, `llm`→`ai`, camelCase→kebab
(`success-exit-codes`, `timeout-ms`, `generated-assertion-hash` — the
`generated` wrapper flattened). Removed: the object form (settings hoisted;
0.1's `generatedBy` superseded by the page's `generated-by`). Added:
`severity-map` (their documented-but-rejected field, landed), `provider`, the
single-string shorthand, `human` ⇒ `assertion`, and the review round's guard
rails: `command` ⇒ `grader: command`, `generated-assertion-hash` never
without `command`, and 0.1's defaults restored (`severity: error`,
`eval-skip: false`). Grader kinds
`ai | command | human | tool:*` stay closed-plus-namespace because schema
conditionals switch on them; `command` without a `command` is the generation
contract. docevals-side ledger: superseding ADR; resolver reads the new
spellings and the top-level provenance; **reserve the `eval-` prefix** and
reject unrecognized `eval-*` keys, restoring the closed block's loud-typo
property at the open page root.

**docmeta:kg:1.0** (from dockg `frontmatter-0.8`) — the closed `kg` envelope
survives (it is what lets a typo-catching block coexist with an open page):
`label` (was `prefLabel`), `alt-labels`, `broader`, `narrower`,
`related-concepts` (was `related`), `concepts` (was `subjects`), `type` (was
`topicType` — the deeper twin of the page's `type`, derivable from it when
absent), `applies-to`, `about-product-lifecycle` (was
`softwareLifecyclePhase`), `about-product-aspect` (was `softwareSubject`),
the negations, `sections`, `revision-of`, `derived-from`, `provenance`
(array-only; the deprecated single-object shape dropped). Every label list
gains the single-string shorthand — every 0.8-valid document stays valid.
The RDF mapping lives in field descriptions, where it always did (iiRDS
spells its properties kebab upstream; 0.8's camelCase was already a
translation). dockg-side ledger: superseding ADR; deriver reads kebab keys,
applies the deeper-wins fallback, derives `type`, and normalizes the
shorthand.

**docmeta:artifact-evals:1.0** (from moose-tracevals `artifact-evals-0.2`) —
the page-side trio one level down, because an artifact's top level is the
host tool's contract and `metadata` is its sanctioned extension bag:
`metadata.evals` (one assertion or the list; 0.2's `criteria` container
dissolved), `metadata.eval-skip`, `metadata.eval-provenance`. Entries share
the evals vocabulary (`id`\* — was optional position-derived `name`, which
orphaned cached verdicts — `assertion`\*, `type`, `severity`, `evidence`,
`examples` with string-or-list anchors, `options`, `provider`, `skip` and
`severity-map` — so one entry vocabulary genuinely ports — and the
`command` family with `{trace}` substitution and the same guard rails as the
page side). The grader is a full open enum — recommended `ai · human ·
command · tool-usage · skill-invoked · file-access · turn-count · cost ·
regex · json-output`, plus the page side's `tool:*` spelling so one grader
name ports across both vocabularies; any kebab name legal,
registry-validated — because no schema conditional switches on it. `human`
here is judged per session: every trace is new, so no verdict caching. The
0.2 defaults (`severity: error`, skip `false`) are restored.

**doc-structure-lint** (looked at, not a schema): improve by **selection, not
validation** — pick the template from the page's `type` via a type→template
map in `templates.yaml` (its own open issue asks for frontmatter-driven
selection; its proposed `template:` key would collide with Starlight's and
should not be used), and resolve its "frontmatter validation" roadmap item by
delegation to docmeta. Housekeeping found in passing is recorded in
`design/default-schema-design-notes.md`.

## Placement intent (decided in design, applied only after review)

- `docmeta:core:1.0` **appends to `DEFAULT_SCHEMAS`.** A bare run then
  requires `title` and `description` — a deliberate breaking change
  (`feat!:`), enforcing the floor every docs gate in this family already
  enforces. Ships with the demo video the house rules require of a feature.
  Full disclosure of the bare-run breaking surface: beyond the required
  pair, a bare run newly rejects empty strings on core's keys and the DCMI
  array form of `language` (array `type` already fails bare runs today,
  since okf types it string).
- The other eight are **opt-in built-ins**: the recommended stack, adopted
  deliberately. Defaulting them would put their entire field menu on every
  bare `docmeta fill` run.
- Registration mechanics (imports, `BUILTINS`, `PUBLISHED_ALIAS`,
  `schemas:sync`, docs counts, reference pages) are the follow-up PR's work,
  after this review round.

## Verification

Everything runs today, without registration, from the repo root:

```bash
npx vitest run test/default-schema.test.ts        # the six house ids, via file refs — green now
node docs/proposals/0023/ladders/evals-examples.cjs          # page evals ladder
node docs/proposals/0023/ladders/kg-examples.cjs             # kg ladder (incl. the 0.8 fidelity case)
node docs/proposals/0023/ladders/artifact-evals-examples.cjs # artifact evals ladder
node docs/proposals/0023/ladders/compat-check.cjs            # composability vs every current built-in
```

The spec suite validates through the shipped `runValidate` path (file refs
into the drafts) and pins disjointness, attribution, the enums, the
conditionals, and the freshness limitation; only default-set membership is
skipped until registration. Each ladder includes the migration negatives —
old spellings and shapes failing loudly — and each lineage-bearing vocabulary includes
a translated capability-fidelity case proving no capability was lost. The
compat-check probes every shared key with the other claimants' most extreme
legal values, expects exactly the recorded exceptions, and exits non-zero on
anything else — it is the reproducible evidence behind principles 1 and 7.

## Open questions for the review

1. **`applies-to` flattened to labels.** The context-engineering model this
   grew from used named dimensions (product / deployment / generation); the
   family simplified to flat labels with a prefix convention
   (`deploy:kubernetes`) as the escape hatch. The model's author should get a
   direct look.
2. **The `lifecycle` enum's ladder cost.** Typo-catching and an airtight
   deprecation rule, bought at the price that `experimental`/`retired`
   ladders must override the key.
3. **`risks` holding assurances.** `read-only` and `idempotent` are
   assurances in a field named risks; the framing is "assessed: none", and
   absence means unassessed. Does the name survive review?
4. **`stakeholders` vs the earlier project-level cut.** This field is
   page-scoped (who to consult about *this* page) and inherits the SME
   evidence; the earlier exploration cut a project-level field of the same
   name. The distinction must hold up.
5. **Default-on placement of `docmeta:core:1.0`**, and whether requiring the
   pair on bare runs is the right nudge.
6. **Runtime vocabularies.** Grader `options` names (`maxUsd`, `maxAgeDays`)
   remain camelCase — whether kebab-case reaches into runtime contracts is
   each tool's call.
7. **Where machine-production fields live.** `generated-by` and `provenance`
   sit in `docmeta:ai-context:1.0`, yet the evals self-preference-bias check
   and the kg harvest both read `generated-by`, and the provenance trail
   describes fills across every stacked schema — an argument they belong in
   core (always present) instead. Relatedly, adopting the recommended stack
   means six refs in every config; whether a bundle id is worth its own
   immutable surface is open.
8. **TOML frontmatter and the date fields.** `smol-toml` yields native date
   objects, so the W3CDTF string fields validate only for YAML/JSON
   frontmatter until the TOML date normalization in the in-flight platform
   schemas PR (#117) lands — a sequencing dependency, not a design choice.

## Stress test

What was tried against this design during the walk, and what it changed:

1. **The one-large-schema shape was built first and attacked second.** Its
   32 fields validated and stacked cleanly, but every error named one
   monolithic id and every adoption was all-or-nothing; the six-way split by
   intent came out of that attack, and the disjointness test exists so the
   split cannot silently regress into overlap.
2. **The composability law was probed mechanically, not asserted.** The
   compat-check ladder throws the other claimants' most extreme legal values
   at every shared key. It caught the law's real perimeter: the exceptions
   are exactly core's non-empty floor and its single-valued `type`/`language`
   against DCMI's repeatable elements — recorded above, pinned as
   expected-rejects.
3. **`grader: script` was added and then removed.** Splitting the generation
   contract out of `command` gave every grader one clean requirement, and
   cost a grader kind; the owner chose fewer kinds, and the two-state
   `command` lifecycle is now stated in the schema as contract rather than
   discovered as magic — with `command` ⇒ `grader: command` closing the
   payload-on-an-ai-eval hole the review found.
4. **The kg camelCase-mirrors-SKOS defense collapsed under its own
   evidence.** iiRDS spells its properties kebab upstream, so half of 0.8's
   camelCase was already a translation; the rename went through, and the RDF
   mapping lives in descriptions, where it always did.
5. **The empty-list hole was found by the review, not the design.**
   `owner: []` satisfied the ownership gate and `evals: []` read as
   eval-covered; `minItems` + `uniqueItems` now run through every
   one-or-list shape, and the page-level twins match kg's `labelList`
   exactly — which the fixture suite pins.
6. **The freshness limitation was pinned rather than papered over.** A
   decades-overdue `last-reviewed` validates, by design and by test: schemas
   cannot read clocks, and the field-ranged W3CDTF pattern only keeps
   impossible dates (month 13) from turning downstream date math into NaN.

## Do not

- Register, sync, or default any of these ids before the review concludes.
- Edit this proposal to match what later ships — supersede it (house rule).
- Claim `evals`, `kg`, or `metadata` from any house id.
- Add a key to one house id that another already claims — the disjointness
  test pins this.
