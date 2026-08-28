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
| `docmeta:core:1.0.0-proposal.1` | What is this page? | 7 (requires `title`, `description`) |
| `docmeta:stewardship:1.0.0-proposal.1` | Is it cared for? | 7 |
| `docmeta:audience:1.0.0-proposal.1` | Who does it serve; who may see it? | 5 |
| `docmeta:lifecycle:1.0.0-proposal.1` | Where is it in its life? | 4 (+ the deprecation rule) |
| `docmeta:structure:1.0.0-proposal.1` | What does it connect to? | 6 |
| `docmeta:ai-context:1.0.0-proposal.1` | How did machines make it; how may they use it? | 4 |
| `docmeta:evals:1.0.0-proposal.1` | What must be true of this page? | 4 keys |
| `docmeta:kg:1.0.0-proposal.1` | What does the knowledge graph know about it? | the `kg` envelope |
| `docmeta:artifact-evals:1.0.0-proposal.1` | What must a session using this artifact have done? | 3 keys under `metadata` |

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
built-ins, 220 distinct keys once the in-flight platform schemas land); and a
design walk through the in-progress metadata contracts of three tools in
the same family (docevals, dockg, moose-tracevals), which the common
vocabularies below replace.

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
   namespaces are never claimed by the house ids: each belongs to its own
   vocabulary in the set, so a fault in an eval entry or a `kg` field is
   attributed to that vocabulary, never to a house id.
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
  fails `docmeta:lifecycle:1.0.0-proposal.1` and nothing else — the report names the
  domain, not a 33-field monolith.
- **Immutability makes fat ids expensive.** Fields on different cadences
  frozen behind one version number means any movement is a new 33-field id.

The six claim **disjoint** field sets (33 fields, zero collisions — pinned by
test), so stacking all six behaves exactly like the monolith did.

## The six house vocabularies

`*` = required. All ids are `additionalProperties: true`.

**docmeta:core:1.0.0-proposal.1** — `title`\*, `description`\*, `id`, `type`, `keywords`,
`authors`, `language`. The descriptive floor, and the only id in the default
set that requires anything. The shared keys are claimed at the loosest lawful definition
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

**docmeta:stewardship:1.0.0-proposal.1** — `owner`, `stakeholders`, `reviewed-by`,
`last-reviewed`, `review-interval` (ISO 8601 duration), `verified-against`,
`source-of-truth`. The review dates are records, not freshness gates — JSON
Schema cannot compare a date to today, and the overdue-review case is pinned
as *passing*; a freshness grader reads the same `last-reviewed` field
and is the thing that owns the clock.

**docmeta:audience:1.0.0-proposal.1** — `audiences`, `personas`, `journeys`, `intent`,
`visibility` (enum `draft → restricted → confidential → internal → public`,
folding the generator draft flag and the access axis into one switch).

**docmeta:lifecycle:1.0.0-proposal.1** — `lifecycle` (enum
`draft | published | deprecated | archived`), `replaced-by`, `supersedes`,
`remove-by`; `deprecated` ⇒ `replaced-by` or `remove-by` required. The
inverse edges (`replaced-by`/`supersedes`) live on two files and are not
cross-checked here — the knowledge graph (`prov:wasRevisionOf`) is where
the pair reconciles.

**docmeta:structure:1.0.0-proposal.1** — `applies-to` (flat labels, the harvest fallback of
`kg.applies-to`), `not-applicable-to` (its carve-out, fallback of
`kg.not-applicable-to`), `concepts` (glossary terms, fallback of
`kg.concepts`), `prerequisites`, `next-steps`, `related-pages` (suffixed in
step with `kg.related-concepts` — each name says what it points at). The
negative is here **for parallelism**, added in review round 5: `applies-to`
had a page-level twin and its negative did not, so the only way to say "not
the FIPS build" was to open a `kg` block. Disjointness between the pair stays
a graph-layer (SHACL) check at both altitudes — JSON Schema cannot compare two
sibling lists, and the contradicting page is pinned as *passing*, exactly as
the overdue review is.

Round 5 also asked two questions about the existing pair, and the answer to
both was that the field already covers it — recorded here because "no change"
is only a useful verdict if the reasoning is written down:

- **A more advanced page on the same topic is a `next-steps` entry.** No
  `advanced` or `deeper-dive` key, and no ordering among next-steps, because
  *more advanced* is a claim about the reader rather than the page: it is
  derived from two pages sharing `concepts` while pointing at `personas` of
  different levels. That is principle 5 (facts live at their altitude) doing
  the same work that cut reader `expertise`. The cost is real and admitted —
  a docs set with no persona definitions cannot derive it.
- **"See also" is the rendered label for `related-pages`.** The heading is
  editorial, the key is semantic, and there is deliberately no `see-also`
  alias: one fact reachable by two keys is the second surface this family
  exists to prevent. `related-pages` already accepts URLs, so a style guide
  that splits "See also" from an off-site "Learn more" is making a rendering
  decision over one field, not needing two.

**docmeta:ai-context:1.0.0-proposal.1** — `generated-by`, `provenance`, `risks`
(recommended flags `cost-incurring · destructive · irreversible · privileged ·
open-world · read-only · idempotent`; the first four from the
context-engineering model, the last three mirroring MCP's tool annotations),
`sample-questions`.

## The quality and graph vocabularies

`docmeta:evals`, `docmeta:kg`, and `docmeta:artifact-evals` are **common
vocabularies**, exactly like the six house ids: any tool can implement them,
and other schemas can compose on top of them. Nothing about them is
tool-owned, and no schema or docs page presents them through another tool's
contract — the vocabularies stand on their own claims.

The design work that produced them walked the in-progress draft contracts
of three tools in this family — docevals, dockg, and moose-tracevals — and
reworked those drafts into the common shape. The ledgers below are the
record of that walk: what each draft capability became, and what each
tool's superseding ADR must cover when it adopts the common vocabulary.
All three tools had recorded "schemas are published by the tool that owns
them" with *don't re-propose a docmeta built-in* rules. This proposal
reverses that deliberately, with a new dividing line: **docmeta publishes
common metadata vocabularies; tools implement behavior — graders, graphs,
runtimes — against them.** Each repo owes a superseding ADR (supersede,
never amend). The reversal is cheap now and only now: docevals and
moose-tracevals have never shipped, so every break below is loud and free.

**docmeta:evals:1.0.0-proposal.1** — ledger vs docevals' draft `frontmatter-0.1`.
Claims `evals` (one
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

**docmeta:kg:1.0.0-proposal.1** — ledger vs dockg's draft `frontmatter-0.8`. The
closed `kg` envelope
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

**docmeta:artifact-evals:1.0.0-proposal.1** — ledger vs moose-tracevals' draft
`artifact-evals-0.2`. The page-side trio one level down, because an artifact's top level is the
host tool's contract and `metadata` is its sanctioned extension bag:
`metadata.evals` (one assertion or the list; 0.2's `criteria` container
dissolved), `metadata.eval-skip`, `metadata.eval-provenance`. Entries share
the evals vocabulary (`id`\* — was optional position-derived `name`, which
orphaned cached verdicts — `assertion`\*, `type`, `severity`, `evidence`,
`examples` with string-or-list anchors, `options`, `provider`, `skip` and
`severity-map` — so one entry vocabulary genuinely ports, with one
asymmetry: `assertion` is unconditional here where the page side lets a
tool grader be its own check — and the
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

## Versioning the family (added in review round 5)

The nine carry **three-segment semver**, where the twenty-one registered
built-ins carry two. That is not an inconsistency to tidy away later: a
built-in's version is the **upstream thing's** version — `hugo:page:0.165` is
Hugo's number, `astro:starlight:0.41` is Starlight's, `dcmi:elements:1.1` is
the DCMI spec's — and docmeta does not get to mint a patch segment for a
release Hugo never shipped. For `docmeta:*`, docmeta *is* upstream, so it owns
the whole string. The vendor segment already says whose version it is.

What each segment means for a *schema*, so a bump is a claim and not a mood:

| Segment | Means | Example |
|---|---|---|
| MAJOR | a document that used to validate now fails | new required field, removed field, tightened constraint, narrowed enum |
| MINOR | a document that used to fail may now pass; every old one still validates | new optional field, loosened constraint, widened enum |
| PATCH | **no** validation-behavior change at all | `description`, `title`, `$comment` |

The third segment is not decoration, it is forced by
`check-builtin-schemas.mjs`: a published schema's bytes may never change, and
adding an entry is free. So the only lawful way to fix a typo in a field
`description` — and on these ids the descriptions substantially *are* the
deliverable — is to publish a new version. With two segments the only move is
`1.1`, which announces new fields when none were added. `1.0.1` says what
actually happened. PATCH is also the one bump that can be *proved* rather than
asserted: run the ladders against both versions and require an identical
verdict on every case.

While the family is under review the drafts are `1.0.0-proposal.1` — a semver
**prerelease**, not build metadata. The hyphen is load-bearing. Prerelease
sorts *below* the `1.0.0` these register as, and standard range matching
excludes it, so nobody depends on a draft by accident. Spelled `+proposal.1`
it would compare **equal** to the release, which is the opposite of what a
review draft wants; anyone "fixing" the punctuation to match the phrase "build
metadata" would silently invert the ordering.

## Placement intent (decided in design, applied only after review)

- **All nine append to `DEFAULT_SCHEMAS`** (corrected 2026-08-26 from
  core-only: the family is the default, not a recommended add-on). A bare
  run then requires `title` and `description` — a deliberate breaking
  change (`feat!:`), enforcing the floor every docs gate in this family
  already enforces — and validates every other family key a page carries:
  the invented enums, the deprecation rule, the `kg` block's closure, the
  eval entry shapes. Ships with the demo video the house rules require of
  a feature. Full disclosure of the bare-run breaking surface: beyond the
  required pair, a bare run newly rejects empty strings on core's keys,
  the DCMI array form of `language` (array `type` already fails bare runs
  today, since okf types it string), and malformed values under any key
  the other eight claim — `lifecycle: experimental`, a typo'd `kg` field,
  or a malformed eval entry fails bare where it silently passed before.
  The eight require nothing, so a page valid on the required pair alone
  stays valid.
- The whole family therefore lands on a bare `docmeta fill` menu. Accepted
  deliberately: the default set is the teaching surface for what
  frontmatter should contain.
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
old spellings and shapes failing loudly — and the three reworked
vocabularies each include a translated capability-fidelity case proving no
capability was lost. The
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
5. **Default-on placement of the whole family.** All nine ship in the
   default set: requiring the pair is the one hard nudge, every other
   family key a page carries gets validated on bare runs, and the full
   menu appears on a bare `fill`. Is family-wide default the right
   aggressiveness?
6. **Runtime vocabularies.** Grader `options` names (`maxUsd`, `maxAgeDays`)
   remain camelCase — whether kebab-case reaches into runtime contracts is
   each tool's call.
7. **Where machine-production fields live.** `generated-by` and `provenance`
   sit in `docmeta:ai-context:1.0.0-proposal.1`, yet the evals self-preference-bias check
   and the kg harvest both read `generated-by`, and the provenance trail
   describes fills across every stacked schema — an argument they belong in
   core instead; with the whole family default-on the practical difference
   shrinks to override cases, but the attribution question stands.
8. **TOML frontmatter and the date fields.** `smol-toml` yields native date
   objects, so the W3CDTF string fields validate only for YAML/JSON
   frontmatter until the TOML date normalization in the in-flight platform
   schemas PR (#117) lands — a sequencing dependency, not a design choice.
9. **What users pin, now that patch bumps are real.** Three-segment semver
   makes a documentation fix a new id, and pinning `docmeta:core:1.0.0`
   everywhere means every such fix churns every config. The usual answer is
   a second, *moving* reference — `docmeta:core:1` resolving to the latest
   `1.x` — but that cuts against `PUBLISHED_ALIAS`, which is deliberately an
   exact-string table with no prefix rule, precisely so a URL naming a
   version that does not exist stays a 404 instead of resolving to something
   else ([`schema-registry.ts:105`](../../src/core/schema-registry.ts)). A
   moving alias also cannot be byte-pinned, so
   `check-published-schemas.mjs` would have to assert it resolves to *some*
   known exact version rather than to a fixed hash. Deferred to the
   registration PR, but it is the question the version scheme creates.

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
7. **A mechanical conformance audit, run from outside.** Drafting
   [0031](0031-content-strategy-vocabularies.md) against this family meant
   first working out what patterns it actually establishes, which is a
   different question from what it says it establishes. Checking every
   property and `$defs` entry for a `description`, every string for a floor,
   every array for `minItems`/`uniqueItems`, and every open enum for branch
   order found three things the nine had drifted on, all since closed:
   - **Twenty nodes carried no `description`** — most of `evals` and
     `artifact-evals`, and, worst, the two envelope roots themselves:
     `kg` and `metadata`, the single most visible field in each of those
     schemas. On ids where the descriptions substantially *are* the
     deliverable, and where `fill` menus and editor completion read exactly
     that string, an undescribed envelope root is the gap that matters most.
   - **`generated-assertion-hash` accepted the empty string** in both eval
     schemas — no `pattern`, no `minLength`. The same class as the
     `owner: []` hole found in the earlier round: a hash that compares falsy
     matches nothing, so a generation contract could look recorded and be
     inert. Floored at `minLength: 1`.
   - **Four of the nine titles did not say "vocabulary"** (`docmeta eval
     declarations`, `docmeta artifact eval declarations`, `docmeta
     knowledge-graph frontmatter`, `docmeta core page vocabulary`), while
     this proposal's own prose insists all nine are common vocabularies.
     `docmeta schemas list` prints titles, so the drift was user-visible.
     Normalized to `docmeta <name> vocabulary (<version>)`.

   The audit's remaining flags were checked and are correct as they stand:
   the other unfloored strings carry `pattern`s that already exclude the
   empty string; `command` and `success-exit-codes` are ordered arrays where
   a repeat is meaningful, so they take no `uniqueItems`; and the `default`
   annotations are the restored 0.1 defaults this proposal argued for.

## Do not

- Register, sync, or default any of these ids before the review concludes.
- Edit this proposal to match what later ships — supersede it (house rule).
- Claim `evals`, `kg`, or `metadata` from any house id.
- Add a key to one house id that another already claims — the disjointness
  test pins this.
