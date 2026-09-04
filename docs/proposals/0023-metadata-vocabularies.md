# 0023 — the docmeta metadata vocabularies

- **Status:** Proposed. Open for community review before anything registers
- **Serves:** Sara · S1 "Define our metadata standard as a schema" · S2 "Wire schemas to the right documents"
- **Relates to:** An earlier, unmerged house-vocabulary exploration whose
  briefing seeded this work. That exploration numbered its own drafts 0021
  and 0022 on its branch. Those numbers have since been taken on `main` by
  the `docmeta query` proposals. So references here to "the exploration's
  0021/0022" mean the unmerged drafts, never the shipped query records
- **Touches:** `docs/proposals/0023/`, which holds the nine draft schemas
  under `schemas/`, the verification ladders under `ladders/`, and the
  working design notes. Also `test/default-schema.test.ts`,
  `test/fixtures/default-schema/` and `docs/src/content/docs/proposals/`.
  Also `docs/astro.config.mjs`, for the published Proposals sidebar group,
  and `.github/workflows/formats-demo.yml`, which excludes the new fixtures
  from the demo's code-scanning feed

## Summary

Nine metadata vocabularies, published by docmeta, designed as one family:

| Id | One question it answers | Fields |
|---|---|---|
| `docmeta:core:1.0.0-proposal.3` | What is this page? | 7 (requires `title`, `description`) |
| `docmeta:stewardship:1.0.0-proposal.1` | Is it cared for? | 8 |
| `docmeta:audience:1.0.0-proposal.1` | Who does it serve; who may see it? | 5 |
| `docmeta:lifecycle:1.0.0-proposal.1` | Where is it in its life? | 4 (+ the deprecation rule) |
| `docmeta:structure:1.0.0-proposal.1` | What does it connect to? | 6 |
| `docmeta:ai-context:1.0.0-proposal.1` | How did machines make it; how may they use it? | 4 |
| `docmeta:evals:1.0.0-proposal.2` | What must be true of this page? | 4 keys |
| `docmeta:kg:1.0.0-proposal.1` | What does the knowledge graph know about it? | the `kg` envelope |
| `docmeta:artifact-evals:1.0.0-proposal.2` | What must a session using this artifact have done? | 4 keys under `metadata` |

Three families (`core`, `evals`, `artifact-evals`) are at `1.0.0-proposal.2`
after review round 6; the other six stay at `1.0.0-proposal.1`. The round-6
section below records what changed and why the rest did not move.

**Nothing in this proposal is registered.** The drafts live at
`docs/proposals/0023/schemas/`, outside `src/schemas/`, which is the
registry the immutability guard freezes and not a staging area. Nothing is
in `BUILTINS`, `PUBLISHED_ALIAS`, `DEFAULT_SCHEMAS`, or the manifest, and
`schemas:sync` has not run. The spec suite `test/default-schema.test.ts`
runs green **today** by validating through file refs into the drafts, the
same `runValidate` path shipped code uses. One `describe.skip` block
(default-set membership, the only thing file refs cannot test) is flipped
on by the registration PR. Registration, publication, and the default-set
change land in that follow-up PR, only after the community review this
proposal exists to invite. The review surface is the site's Proposals
sidebar group: a hub overview
(`docs/src/content/docs/proposals/frontmatter-vocabularies.mdx`) plus a
dedicated page per vocabulary. That is nine pages, each with fields,
examples, rationale, and its own review asks.

## Why a family, and why now

docmeta ships built-ins that transcribe contracts other people published, such
as Hugo's front matter, DITA's prolog, and Open Graph. These nine are the first
it would publish itself. They cover the facts a docs set needs to stay
*maintained* and *machine-consumed*, which no generator defines and no standard
owns. Those facts are ownership, review, audience, applicability, lifecycle,
relationships, AI provenance and guidance, and per-document quality contracts.

The evidence base has four parts. First, a context-engineering model for
AI-ready documentation. That is the maturity ladder `id · type · description ·
owner` → typed applicability → eval-instrumented → drift-monitored, with
`intent`, `source-of-truth`, `risks`, and per-page sample questions. Second, a
survey of 225 writing skills' entry criteria as a metadata demand signal. Third,
the registry's own key space, at 19 built-ins and 220 distinct keys once the
in-flight platform schemas land. Fourth, a design walk through the in-progress
metadata contracts of three tools in the same family: docevals, dockg, and
moose-tracevals. The common vocabularies below replace those.

## The principles

Every field decision below traces to one of these. They were derived by
cutting, and each names what it cut.

1. **Weak floors teach bad habits.** `title` and `description` are required,
   non-empty, single strings. This is a recorded exception to the
   composability law. Dublin Core allows arrays and Docusaurus allows empty,
   and both are override cases. All three family repos' docs gates already
   enforce this.
2. **One value is a string, and many values are a list.** There is no
   per-field trivia. Single-valued facts are plain strings, and list-valued
   facts accept a string or a list everywhere.
3. **Claim content, never rendering.** Cut `tags`, `slug`, `image`, `layout`,
   and every navigation and position field. A generator-owned fact carried
   under a second name is worse than a collision, because a collision at
   least fails loudly.
4. **Derivable facts lie.** Cut `updated`, `date`, and the stored review
   due-date. Git owns change dates, and `last-reviewed` plus
   `review-interval` derive the deadline. The dates that stay are the ones
   only a human can assert, which are `last-reviewed` and `remove-by`.
5. **Facts live at their altitude.** `stakeholders` is page-level, meaning
   who to consult about *this* page. It is distinct from the project-level
   stakeholders the earlier exploration cut. Reader `expertise` fell, because
   level belongs to the persona definitions a page points at. Style guides
   and type-to-template mappings belong in config.
6. **Enumerate only what is switched-on and bounded, or published.**
   `visibility` and `lifecycle` are the only invented enums, because
   something downstream switches on each. The iiRDS enums in `docmeta:kg`
   stay closed because iiRDS publishes them. Everything else recommendable
   uses the **open-enum idiom**, an `anyOf` of an advisory enum and a free
   string. Editors and `fill` then see the recommendations while no correct
   document is rejected. That covers `risks`, the artifact grader family, and
   `provider`.
7. **Compose, don't duplicate.** `action` stays with
   `passo-uno:seven-action:1.0` in the default set. The classification story
   is three layers: `type` for what the page is, `action` for what the reader
   is doing, and `intent` for the specific job. The `evals`, `kg` and
   `metadata` namespaces are never claimed by the house ids. Each belongs to
   its own vocabulary in the set. So a fault in an eval entry or a `kg` field
   is attributed to that vocabulary, never to a house id.
8. **Deeper wins, and the top level is the harvest fallback.** Some `kg`
   block fields and page-level fields speak to the same fact: `type`,
   `concepts`, `applies-to`, and `supersedes`/`revision-of`. There the deeper
   declaration wins, per fact, and the page-level field feeds the graph when
   the block is silent.
9. **Machines propose, and humans retire the provenance.** The `provenance`
   pattern appears on the page as `docmeta:ai-context`, in the graph block as
   `kg.provenance`, and in both eval schemas. It is per-model entries naming
   proposed fields and confidence, deleted by humans as they review. It is
   one answer to "which of this metadata did a machine write, and has anyone
   checked?"

## Why six house ids and not one

The one-large-schema shape was designed first and split afterward, by intent,
for three reasons the split then proved:

- **Adoption curves differ.** A team can require `title` + `description` next
  Tuesday; requiring `personas` means *having* personas; `sample-questions`
  presupposes an eval loop. Each id is one adoption decision.
- **Error attribution becomes the intent.** Stacked, a bad `lifecycle` value
  fails `docmeta:lifecycle:1.0.0-proposal.1` and nothing else. The report
  names the domain, not a 33-field monolith.
- **Immutability makes fat ids expensive.** Fields on different cadences
  frozen behind one version number means any movement is a new 33-field id.

The six claim **disjoint** field sets (34 fields, zero collisions, pinned by
test), so stacking all six behaves like the monolith did.

## The six house vocabularies

`*` = required. All ids are `additionalProperties: true`.

**docmeta:core:1.0.0-proposal.3**: `title`\*, `description`\*, `id`, `type`,
`keywords`, `language`, `locale`. This is the descriptive floor, and the only id
in the default set that requires anything. It has been purely descriptive since
review round 6. Who wrote the page is not part of what the page *is*, so
`authors` moved to stewardship with the other people, below. The shared keys are
claimed at the loosest lawful definition, taking `keywords` down to Antora's
comma-string, **except where looseness would teach a bad habit**. Those
exceptions are recorded here in full. The required pair is two non-empty single
strings. Every other string core claims is also non-empty, because `type: ""`
would otherwise reach the kg type derivation and template selection as a falsy
key. And `type` and `language` are single strings, even though Dublin Core's
repeatable elements permit arrays. A DCMI document using repeated `type` or
`language` is an override case, like its repeated titles. The `compat-check`
ladder pins every one of these as an expected-reject, so an exception this list
does not name fails the check. Round 8 added `locale` beside `language`, on the
W3C LTLI line. `language` is the language the text is written in. `locale` is
the set of international preferences its dates, numbers, calendar and sorted
lists follow. It is set only where the two differ, as in `language: en` with
`locale: de-DE`. Both are one non-empty string. A Unicode locale identifier is
recommended for `locale` and not enforced. See the round-8 note below.

**docmeta:stewardship:1.0.0-proposal.1**: `authors`, `owner`, `stakeholders`,
`reviewed-by`, `last-reviewed`, `review-interval` (ISO 8601 duration),
`verified-against`, `source-of-truth`. This is every people fact in the family,
behind one adoption decision. `authors` is attribution and `owner` is
answerability, and the two part company the moment an author moves on. `authors`
is the one field here claimed at the loosest lawful definition, up to MyST and
Docusaurus person objects and nothing looser. List members are strings or
objects, and never bare numbers. It is therefore the one field here that is not a
`stringList`. No claimant asks `owner` or `reviewed-by` to be anything but plain
names. The review dates are records, not freshness gates. JSON Schema cannot
compare a date to today, and the overdue-review case is pinned as *passing*. A
freshness grader reads the same `last-reviewed` field, and is the thing that
owns the clock.

**docmeta:audience:1.0.0-proposal.1**: `audiences`, `personas`, `journeys`, `intent`,
`visibility` (enum `draft → restricted → confidential → internal → public`,
folding the generator draft flag and the access axis into one switch).

**docmeta:lifecycle:1.0.0-proposal.1**: `lifecycle` (enum
`draft | published | deprecated | archived`), `replaced-by`, `supersedes`,
`remove-by`; `deprecated` ⇒ `replaced-by` or `remove-by` required. The
inverse edges (`replaced-by`/`supersedes`) live on two files and are not
cross-checked here. The knowledge graph (`prov:wasRevisionOf`) is where
the pair reconciles.

**docmeta:structure:1.0.0-proposal.1**: `applies-to` (flat labels, the harvest
fallback of `kg.applies-to`), `not-applicable-to` (its carve-out, fallback of
`kg.not-applicable-to`), and `concepts` (glossary terms, fallback of
`kg.concepts`). Then `prerequisites`, `next-steps`, and `related-pages`,
suffixed in step with `kg.related-concepts`, so each name says what it points
at. The negative is here **for parallelism**, added in review round 5.
`applies-to` had a page-level twin and its negative did not, so the only way to
say "not the FIPS build" was to open a `kg` block. Disjointness between the pair
stays a graph-layer SHACL check at both altitudes. JSON Schema cannot compare
two sibling lists, and the contradicting page is pinned as *passing*, as the
overdue review is.

Round 5 also asked two questions about the existing pair, and the answer to
both was that the field already covers it. They are recorded here because "no
change" is only a useful verdict if the reasoning is written down:

- **A more advanced page on the same topic is a `next-steps` entry.** No
  `advanced` or `deeper-dive` key, and no ordering among next-steps, because
  *more advanced* is a claim about the reader rather than the page. It is
  derived from two pages sharing `concepts` while pointing at `personas` of
  different levels. That is principle 5 (facts live at their altitude) doing
  the same work that cut reader `expertise`. The cost: a docs set with no
  persona definitions cannot derive it.
- **"See also" is the rendered label for `related-pages`.** The heading is
  editorial and the key is semantic, and there is no `see-also` alias. One
  fact reachable by two keys is the second surface this family exists to
  prevent. `related-pages` already accepts URLs. So a style guide that splits
  "See also" from an off-site "Learn more" is making a rendering decision over
  one field. It does not need two.

Round 6 moved one field between two of these ids, and the reasoning is
recorded for the same reason round 5's non-changes are:

- **`authors` moved from core to stewardship.** Core answers *what is this
  page*. Who wrote it answers *is it cared for*, which is the question
  stewardship already asks. The split now falls where principle 5, facts live
  at their altitude, puts it. Core is description, and stewardship is the
  people and the dates. The concrete gain is one adoption decision instead of
  two. A team wiring up attribution is already wiring up `owner` and
  `reviewed-by`, and `authors` arriving with them is what they expected.
  Field counts move, with core going 7 → 6 and stewardship 7 → 8. The family
  total stays 33 and disjoint. The cost is that stewardship is no longer
  uniform in shape. `authors` keeps its own type union rather than the
  `stringList` its neighbors share. MyST and Docusaurus person objects are
  legal there, and nowhere else in the schema. One alternative was
  rejected: normalizing `authors` down to `stringList` for tidiness. That
  would break the compatibility rule against two documented claimants, to make
  one schema look neater.

**docmeta:ai-context:1.0.0-proposal.1**: `generated-by`, `provenance`, `risks`
and `sample-questions`. The recommended `risks` flags are `cost-incurring ·
destructive · irreversible · privileged · open-world · read-only · idempotent`.
The first four come from the context-engineering model, and the last three
mirror MCP's tool annotations.

## The quality and graph vocabularies

`docmeta:evals`, `docmeta:kg`, and `docmeta:artifact-evals` are **common
vocabularies**, like the six house ids: any tool can implement them, and
other schemas can compose on top of them. Nothing about them is tool-owned,
and no schema or docs page presents them through another tool's contract.
The vocabularies stand on their own claims.

The design work that produced them walked the in-progress draft contracts of
three tools in this family: docevals, dockg, and moose-tracevals. It reworked
those drafts into the common shape. The ledgers below are the record of that
walk. They say what each draft capability became, and what each tool's
superseding ADR must cover when it adopts the common vocabulary. All three tools
had recorded "schemas are published by the tool that owns them", with *don't
re-propose a docmeta built-in* rules. This proposal reverses that on purpose,
with a new dividing line. **docmeta publishes common metadata vocabularies, and
tools implement behavior against them: graders, graphs, runtimes.** Each repo
owes a superseding ADR, since the rule is supersede, never amend. The reversal
is cheap now and only now. docevals and moose-tracevals have never shipped, so
every break below is visible and costs nothing.

**docmeta:evals:1.0.0-proposal.2** is the ledger against docevals' draft
`frontmatter-0.1`. It claims `evals`, which is one assertion string or a list of
entries in string shorthand, `use:` config reference, or inline definition form.
It also claims `eval-suite`, `eval-skip` and `eval-provenance`. Renames are
`name`→`id`, `llm`→`ai`, and camelCase→kebab, giving `success-exit-codes`,
`timeout-ms` and `generated-assertion-hash`, with the `generated` wrapper
flattened. Removed is the object form, with settings hoisted, and 0.1's
`generatedBy` superseded by the page's `generated-by`. Added are `severity-map`,
their documented-but-rejected field, now landed; `provider`; the single-string
shorthand; and `human` ⇒ `assertion`. Added too are the review round's guard
rails: `command` ⇒ `grader: command`, `generated-assertion-hash` never without
`command`, and 0.1's defaults restored as `severity: error` and `eval-skip:
false`. Grader kinds `ai | command | human | tool:*` stay closed-plus-namespace,
because schema conditionals switch on them. `command` without a `command` is the
generation contract. The docevals-side ledger is a superseding ADR, plus a
resolver that reads the new spellings and the top-level provenance. It also has
a **reserved `eval-` prefix** that rejects unrecognized `eval-*` keys. That restores the
closed block's loud-typo property at the open page root. Round 6, as
`proposal.2`, added `weight`, `target`, `runs` and `model` to entries, and
`weight` to the `use:` form. It also moved the prefix guard from prose into the
schema. See the round-6 section.

**docmeta:kg:1.0.0-proposal.1** is the ledger against dockg's draft
`frontmatter-0.8`. The closed `kg` envelope survives, because it is what lets a
typo-catching block coexist with an open page. It carries `label` (was
`prefLabel`), `alt-labels`, `broader`, `narrower`, `related-concepts` (was
`related`), and `concepts` (was `subjects`). It carries `type`, formerly
`topicType`, which is the deeper twin of the page's `type` and derivable from it
when absent. It carries `applies-to`, `about-product-lifecycle` (was
`softwareLifecyclePhase`), `about-product-aspect` (was `softwareSubject`), the
negations, `sections`, `revision-of` and `derived-from`. Finally `provenance`,
array-only, with the deprecated single-object shape dropped. Every label list
gains the single-string shorthand, so every 0.8-valid document stays valid. The
RDF mapping lives in field descriptions, where it always did. iiRDS spells its
properties kebab upstream, so 0.8's camelCase was already a translation. The
dockg-side ledger is a superseding ADR, plus a deriver that reads kebab keys,
applies the deeper-wins fallback, derives `type`, and normalizes the shorthand.

**docmeta:artifact-evals:1.0.0-proposal.2** is the ledger against
moose-tracevals' draft `artifact-evals-0.2`. It is the page-side trio one level
down. An artifact's top level is the host tool's contract, and `metadata` is its
sanctioned extension bag. So it claims `metadata.evals`, which is one
assertion or the list, with 0.2's `criteria` container dissolved. It also claims
`metadata.eval-skip` and `metadata.eval-provenance`. Entries share the evals
vocabulary: `id`\*, `assertion`, `type`, `severity`, `evidence`, and `examples`
with string-or-list anchors. `id` was an optional position-derived `name`, which
orphaned cached verdicts. Then `options`, `provider`, `skip` and
`severity-map`, plus the `command` family with `{trace}` substitution and the
same guard rails as the page side. So one entry vocabulary genuinely ports.
`proposal.1` kept one asymmetry, with `assertion` unconditional here where the
page side lets a tool grader be its own check. Round 6 removed it, and
`proposal.2` ports the page side's conditional block verbatim. The grader is a
full open enum. Recommended values are `ai · human · command · tool-usage ·
skill-invoked · file-access · turn-count · cost · regex · json-output`, plus the
page side's `tool:*` spelling, so one grader name ports across both
vocabularies. Any kebab name is legal and registry-validated. In `proposal.1` no
schema conditional switched on the grader at all. In `proposal.2` the assertion
rule branches on `ai`, `human` and `command`, and the enum stays open because an
unknown name matches none of those branches. `human` here is judged per session.
Every trace is new, so there is no verdict caching. The 0.2 defaults, `severity:
error` and skip `false`, are restored.

**doc-structure-lint** was looked at, and is not a schema. Improve it by
**selection, not validation**. Pick the template from the page's `type` via a
type→template map in `templates.yaml`. Its own open issue asks for
frontmatter-driven selection, and its proposed `template:` key would collide
with Starlight's, so it should not be used. Then resolve its "frontmatter
validation" roadmap item by delegation to docmeta. Housekeeping found in passing
is recorded in `design/default-schema-design-notes.md`.

## Versioning the family (added in review round 5)

The nine carry **three-segment semver**, where the twenty-one registered
built-ins carry two. That is not an inconsistency to tidy away later. A
built-in's version is the **upstream thing's** version. `hugo:page:0.165` is
Hugo's number, `astro:starlight:0.41` is Starlight's, and `dcmi:elements:1.1` is
the DCMI spec's. docmeta does not get to mint a patch segment for a release Hugo
never shipped. For `docmeta:*`, docmeta *is* upstream, so it owns the whole
string. The vendor segment already says whose version it is.

What each segment means for a *schema*, so that a bump states a fact:

| Segment | Means | Example |
|---|---|---|
| MAJOR | a document that used to validate now fails | new required field, removed field, tightened constraint, narrowed enum |
| MINOR | a document that used to fail may now pass; every old one still validates | new optional field, loosened constraint, widened enum |
| PATCH | **no** validation-behavior change at all | `description`, `title`, `$comment` |

The third segment is forced by `check-builtin-schemas.mjs`. A published schema's
bytes may never change, and adding an entry is free. So the only lawful way to
fix a typo in a field `description` is to publish a new version. On these ids
the descriptions substantially *are* the deliverable. With two segments the
only move is `1.1`, which announces new fields when none were added. `1.0.1`
says what actually happened. PATCH is also the one bump that can be *proved*
rather than asserted. Run the ladders against both versions, and require an
identical verdict on every case.

While the family is under review the drafts carry a semver **prerelease**
tag, not build metadata: `1.0.0-proposal.1`, and `1.0.0-proposal.2` for the
three families round 6 revised. The hyphen matters. Prerelease sorts *below*
the `1.0.0` these register as, and standard range matching excludes it, so
nobody depends on a draft by accident. Spelled `+proposal.1` it would compare
**equal** to the release, which is the opposite of what a review draft wants.
Anyone "fixing" the punctuation to match the phrase "build metadata" would
silently invert the ordering.

## Review round 6, on scoring, targeting and versioning

Round 6 revised three families to `1.0.0-proposal.2`. Those are `evals`,
`artifact-evals` and `core`. The other six stay at `proposal.1`. A bump would
announce a revision none of them made, and leave six pairs of byte-identical
files to explain. `test/default-schema.test.ts` and
`ladders/compat-check.cjs` each carry a per-family `VERSIONS` table, so a
family's next bump is still a one-line edit. The full reasoning is in the design
notes, at § Review round 6. The decisions were these:

- **`weight`**, in both eval families, on the inline and the `use:` forms. It
  is a positive number, default 1. It changes how much an outcome moves an
  aggregate score, and never the eval's own pass or fail. The binary outcome
  is what SARIF, JUnit and findings baselines consume downstream.
  Zero is excluded, because a weightless eval is a silent disable, and `skip`
  already means that loudly.
- **`target`**, in both. It is what the grader receives. For a page that is
  `body` (default), `raw`, or `frontmatter`. For a session it is `transcript`
  (default), `last-message`, `files`, or `artifact`. Either side also accepts
  a `{source: file, path}` object naming a companion file. It is distinct
  from `evidence`, which hints where to look inside what is graded. `target`
  selects the bytes, so deterministic graders honour it too. It is named
  `target` rather than `focus` because it selects data, must serve graders
  that have no focus, and does not collide with `evidence`.
- **`runs` and `model`**, in both. `runs` is a per-eval ensemble count, from 1
  to 50, capped because runs multiply cost directly. `model` is the judging
  model. Both, with the pre-existing `provider`, are constrained to `ai` evals
  by a conditional. `model` also lets an eval name a judge other than the
  model that wrote what it grades. That turns the self-preference warning
  `generated-by` enables into something a tool can act on.
- **`assertion` became conditional in `artifact-evals`.** The page side's
  block is ported verbatim. `ai`, `human` and a bare entry require an
  assertion, and `command` requires an assertion or a command. A `tool-usage`
  criterion says everything in `options`, so the old unconditional
  requirement forced authors to write a sentence no grader reads.
- **The `eval-` prefix guard is encoded, not described.** `evals` carries
  `"^eval-(?!suite$|skip$|provenance$)": false` at its root and
  `artifact-evals` the equivalent inside `metadata`. Asking consumers to
  implement the guard in prose meant one implementer did and one did not.
- **`docmeta-vocabularies` was added in round 6 and withdrawn in round 7.**
  Round 6 gave `core` a map from family name to the vocabulary version the
  file targets, nested as `metadata.docmeta-vocabularies` on artifacts. A tool
  could then check the declared version before the `eval-` guard rejected a
  newer vocabulary's key as a typo. Round 7 removed it from both schemas, the
  ladders, and the pages. The prefix guard stands without it. An unrecognized
  `eval-*` key is rejected, whichever version wrote it.
- **`locale` added to core in round 8, distinct from `language`.** Core's
  `language` description used to say it was the locale field, and that there
  was no `locale` key. The reason given was that a BCP 47 tag carries region
  and script. The
  W3C's Language Tags and Locale Identifiers spec treats them as two facts.
  A language tag identifies the language of the content. A locale identifies
  a set of international preferences. Those are a language, a region, and the
  calendar, numbering system and collation that formatting needs, written as
  `-u-` extension keywords. An English page written to German conventions is
  `language: en` with `locale: de-DE`, and a single tag cannot record both.
  `locale` is one non-empty string. A Unicode locale identifier is
  recommended and not enforced. `-u-` extensions are legal, and the hyphen
  form is preferred over the `en_US` of `og:locale`. Leave it out wherever it
  would only repeat `language`. Rendering stays unclaimed, because the key
  records conventions already written into the text, not which site tree
  renders it. Core goes from 6 fields to 7, and the family from 33 to 34.
  Core moves to `proposal.3`, because a new key is a shape change and round 6
  bumped the version for one.
- **The `use:` form's overrides stop at the page's relationship to the
  check.** Those are `skip`, `type`, `severity`, `options` and `weight`.
  `provider`, `model` and `runs` say how the tool executes, and stay
  run-wide. `target` would let one name read different bytes on different
  pages, which is the confusion `use:` exists to prevent.
- **Not changed, though it looked like it should be.** `artifact-evals.grader`
  keeps its open `anyOf`, a kebab pattern plus the recommended enum, rather
  than a top-level `pattern`. Read shallowly this looks like a missing
  constraint. It is a documented decision.

## Placement intent (decided in design, applied only after review)

- **All nine append to `DEFAULT_SCHEMAS`.** Corrected 2026-08-26 from
  core-only, because the family is the default rather than a recommended
  add-on. A bare run then requires `title` and `description`. That is a
  deliberate breaking change, marked `feat!:`, which enforces the floor every
  docs gate in this family already enforces. It also validates every other
  family key a page carries: the invented enums, the deprecation rule, the
  `kg` block's closure, and the eval entry shapes. It ships with the demo
  video the house rules require of a feature. Beyond the required pair, a
  bare run newly rejects three things. First, empty strings on core's keys.
  Second, the DCMI array form of `language`; array `type` already fails bare
  runs today, since okf types it string. Third, malformed values under any
  key the other eight claim. So `lifecycle: experimental`, a typo'd `kg`
  field, or a malformed eval entry fails bare where it silently passed
  before. The eight require nothing, so a page valid on the required pair
  alone stays valid.
- The whole family therefore lands on a bare `docmeta fill` menu. That is
  accepted on purpose, because the default set is the teaching surface for
  what frontmatter should contain.
- Registration mechanics (imports, `BUILTINS`, `PUBLISHED_ALIAS`,
  `schemas:sync`, docs counts, reference pages) are the follow-up PR's work,
  after this review round.

## Verification

Everything runs today, without registration, from the repo root:

```bash
npx vitest run test/default-schema.test.ts        # the six house ids, via file refs; green now
node docs/proposals/0023/ladders/evals-examples.cjs          # page evals ladder
node docs/proposals/0023/ladders/kg-examples.cjs             # kg ladder (incl. the 0.8 fidelity case)
node docs/proposals/0023/ladders/artifact-evals-examples.cjs # artifact evals ladder
node docs/proposals/0023/ladders/compat-check.cjs            # composability vs every current built-in
```

The spec suite validates through the shipped `runValidate` path, using file refs
into the drafts. It pins disjointness, attribution, the enums, the conditionals,
and the freshness limitation. Only default-set membership is skipped until
registration. Each ladder includes the migration negatives, where old spellings
and shapes fail loudly. The three reworked vocabularies each include a
translated capability-fidelity case, proving no capability was lost. The
compat-check probes every shared key with the other claimants' most extreme
legal values. It expects only the recorded exceptions, and exits non-zero on
anything else. It is the reproducible evidence behind principles 1 and 7.

## Open questions for the review

1. **`applies-to` flattened to labels.** The context-engineering model this
   grew from used named dimensions: product, deployment, generation. The
   family simplified to flat labels, with a prefix convention such as
   `deploy:kubernetes` as the escape hatch. The model's author should get a
   direct look.
2. **The `lifecycle` enum's ladder cost.** Typo-catching and an airtight
   deprecation rule, bought at the price that `experimental`/`retired`
   ladders must override the key.
3. **`risks` holding assurances.** `read-only` and `idempotent` are
   assurances in a field named risks; the framing is "assessed: none", and
   absence means unassessed. Does the name survive review?
4. **`stakeholders` against the earlier project-level cut.** This field is
   page-scoped, meaning who to consult about *this* page, and it inherits the
   SME evidence. The earlier exploration cut a project-level field of the
   same name. The distinction must hold up.
5. **Default-on placement of the whole family.** All nine ship in the
   default set. Requiring the pair is the one hard nudge. Every other family
   key a page carries gets validated on bare runs, and the full menu appears
   on a bare `fill`. Is family-wide default the right aggressiveness?
6. **Runtime vocabularies.** Grader `options` names (`maxUsd`, `maxAgeDays`)
   remain camelCase. Whether kebab-case reaches into runtime contracts is
   each tool's call.
7. **Where machine-production fields live.** `generated-by` and `provenance`
   sit in `docmeta:ai-context:1.0.0-proposal.1`. Yet the evals
   self-preference-bias check and the kg harvest both read `generated-by`,
   and the provenance trail describes fills across every stacked schema.
   That is an argument they belong in core instead. With the whole family
   default-on, the practical difference shrinks to override cases. The
   attribution question still stands.
8. **TOML frontmatter and the date fields.** `smol-toml` yields native date
   objects. So the W3CDTF string fields validate only for YAML and JSON
   frontmatter. That holds until the TOML date normalization in the in-flight
   platform schemas PR (#117) lands. This is a sequencing dependency, not a design
   choice.
9. **What users pin, now that patch bumps are real.** Three-segment semver
   makes a documentation fix a new id, and pinning `docmeta:core:1.0.0`
   everywhere means every such fix churns every config. The usual answer is
   a second, *moving* reference, with `docmeta:core:1` resolving to the
   latest `1.x`. But that cuts against `PUBLISHED_ALIAS`. That is an
   exact-string table with no prefix rule, on purpose, so that a URL naming a
   version that does not exist stays a 404 instead of resolving to something
   else
   ([`schema-registry.ts:105`](../../src/core/schema-registry.ts)). A
   moving alias also cannot be byte-pinned, so `check-published-schemas.mjs`
   would have to assert it resolves to *some* known exact version rather
   than to a fixed hash. Deferred to the registration PR, but it is the
   question the version scheme creates.

## Stress test

What was tried against this design during the walk, and what it changed:

1. **The one-large-schema shape was built first and attacked second.** Its
   32 fields validated and stacked cleanly, but every error named one
   monolithic id and every adoption was all-or-nothing. The six-way split by
   intent came out of that attack, and the disjointness test exists so the
   split cannot silently regress into overlap.
2. **The composability law was probed mechanically, not asserted.** The
   compat-check ladder throws the other claimants' most extreme legal values
   at every shared key. It caught the law's real perimeter. The exceptions
   are core's non-empty floor, and its single-valued `type` and `language`
   against DCMI's repeatable elements. Both are recorded above and pinned as
   expected-rejects.
3. **`grader: script` was added and then removed.** Splitting the generation
   contract out of `command` gave every grader one clean requirement, and
   cost a grader kind. The owner chose fewer kinds. The two-state `command`
   lifecycle is now stated in the schema as contract, rather than discovered
   as magic. `command` ⇒ `grader: command` closes the payload-on-an-ai-eval
   hole the review found.
4. **The kg camelCase-mirrors-SKOS defense collapsed under its own
   evidence.** iiRDS spells its properties kebab upstream, so half of 0.8's
   camelCase was already a translation. The rename went through, and the RDF
   mapping lives in descriptions, where it always did.
5. **The empty-list hole was found by the review, not the design.**
   `owner: []` satisfied the ownership gate and `evals: []` read as
   eval-covered. `minItems` + `uniqueItems` now run through every
   one-or-list shape, and the page-level twins match kg's `labelList`
   exactly, which the fixture suite pins.
6. **The freshness limitation was pinned rather than papered over.** A
   decades-overdue `last-reviewed` validates, by design and by test. Schemas
   cannot read clocks. The field-ranged W3CDTF pattern only keeps impossible
   dates, such as month 13, from turning downstream date math into NaN.

## Do not

- Register, sync, or default any of these ids before the review concludes.
- Edit this proposal to match what later ships. Supersede it (house rule).
- Claim `evals`, `kg`, or `metadata` from any house id.
- Add a key to one house id that another already claims; the disjointness
  test pins this.
