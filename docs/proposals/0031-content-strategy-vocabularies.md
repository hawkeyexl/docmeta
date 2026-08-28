# 0031 — the content-strategy vocabularies: audience, persona, journey

- **Status:** Proposed — open for community review before anything registers
- **Serves:** Sara · S1 "Define our metadata standard as a schema" · S2 "Wire
  schemas to the right documents"
- **Depends on:** [0023](0023-metadata-vocabularies.md) (the nine facet
  vocabularies these compose on, and the principles they inherit — this
  proposal adds to that family rather than restating it)
- **Relates to:** [0026](0026-corpus-checks-are-findings.md) (named `checks:`,
  which is what turns these documents from prose into a gate),
  [0027](0027-named-collections.md) (override groups as SQL views — with no
  `type` key to select on, the collection *is* how a check names a document
  class), [0021](0021-frontmatter-as-a-database.md) (the SQL projection those
  checks run over), [0028](0028-ddl-type-bridge.md) (enums as `CHECK IN`,
  which is how the coverage ladder reaches DDL)
- **Touches:** `docs/proposals/0031/` (the three draft schemas under
  `schemas/`, two ladders under `ladders/`),
  `test/content-strategy-schema.test.ts`,
  `test/fixtures/content-strategy/`, `docs/src/content/docs/proposals/`

## Summary

Three metadata vocabularies for the documents a content strategy is *made of*:

| Id | The document it governs | Requires | Claims |
|---|---|---|---|
| `docmeta:audience-profile:1.0.0-proposal.1` | A segment definition — who you serve | `id` | 5 |
| `docmeta:persona:1.0.0-proposal.1` | A persona definition — as whom | `id`, `role` | 8 |
| `docmeta:journey:1.0.0-proposal.1` | A critical user journey — to do what | `id`, `trigger`, `success-criteria`, `steps` | 7 |

Thirteen distinct keys across all three, twelve of which nothing else in the
registry claims.

**Nothing here is registered, and none of it is ever default-on.** The drafts
live at `docs/proposals/0031/schemas/`, outside `src/schemas/`. Nothing is in
`BUILTINS`, `PUBLISHED_ALIAS`, or `DEFAULT_SCHEMAS`, and `schemas:sync` has not
run. Unlike 0023's nine, these three are **override-only by construction** —
see [Placement](#placement-override-only-by-construction), which is a
consequence of the design rather than a review decision, and is pinned by test
so a later PR cannot quietly change it.

The spec suite `test/content-strategy-schema.test.ts` runs green **today**,
validating through file refs into the drafts — the same `runValidate` path
shipped code uses — with no skipped block, because there is no default-set
membership to wait for.

## Why these, and why now

0023 gave a *page* three keys for pointing at a content strategy:

```yaml
audiences: [administrators]
personas: [persona-platform-admin]
journeys: [cuj-install]
```

and then said, of `personas`, "may dangle if you keep no personas — adopt it
when you do." That is the honest description of a half-built bridge. The
references have no other end. Nothing in the family says what a persona
document *is*, so nothing can check that `persona-platform-admin` exists,
nothing can tell a journey with three uncovered steps from one with none, and
the coverage claim a docs set most wants to make — *we serve these readers on
these journeys, and here are the gaps* — stays a slide deck.

These three are the other end. They are what 0023's `structure` vocabulary was
already assuming when it declined to add an `advanced` key, on the grounds
that "more advanced" is derived from "two pages sharing `concepts` while
pointing at `personas` of different levels" — a derivation that needs persona
documents to have levels in a form a machine can read. It admitted the cost in
the same breath: "a docs set with no persona definitions cannot derive it."
This proposal is how a docs set gets persona definitions.

### The evidence base

The design is modelled on a **real, public, working strategy corpus**:
[`Promptless/promptless.ai`](https://github.com/Promptless/promptless.ai),
under `docs/content_strategy/` — six audiences, six personas, sixteen CUJs, and
an information-architecture proposal, all as frontmattered Markdown, all
derived bottom-up from customer and prospect interviews, all cross-referenced
by stable ids. Their own README states the model in one line:

```
audience (aud-*) ──< persona (persona-*) ──< journey (cuj-*) ──> doc touchpoint
```

Three things about that corpus made it worth designing against rather than
inventing from first principles:

1. **It is frontmatter-first on purpose.** Their maintenance note asks
   contributors to "keep frontmatter assertion-dense (e.g. CUJ `steps[].doc`
   routes) so it can later be link-checked." That is a request for exactly the
   capability this proposal supplies, written by someone who did not have it.
2. **It already runs docmeta**, on `src/content/docs` — so the strategy corpus
   sits in the same repo as a docmeta config that deliberately does not reach
   it. The gap is visible from inside the tool.
3. **It is large enough to disagree with.** Thirty-odd documents across three
   shapes is enough to see which fields are load-bearing, which are one team's
   business model, and which are the same fact under two names.

Their fields are the input, not the output. The [ledger](#the-ledger) below
records every rename, merge, and cut, and the example ladder carries a
capability-fidelity case per schema — a real document from that corpus,
translated, proving the translation loses nothing.

## The rule that makes these different: facets and document types

0023's nine are **facet** vocabularies. They describe a page from one angle,
they stack, they require almost nothing, and they are disjoint so that a bad
value is attributed to exactly one intent. `docmeta:audience` is a facet: it
says a page *has* an audience.

These three are **document-type** vocabularies. They say a document *is* an
audience. That difference changes three things:

| | Facet id (0023) | Document-type id (this proposal) |
|---|---|---|
| Requires | only core requires anything | the facts without which the document is not that kind of document |
| Stacking | all nine stack on any page | mutually exclusive, because those required sets conflict |
| Placement | proposed default-on | override-only, always |

What it does **not** change is that a document-type id is still just a schema
over frontmatter, and still has to compose with everything else a repo runs.

**Reuse, don't re-claim.** A document-type id claims only keys no facet id
claims. An audience document names itself with `title`/`description`
(`docmeta:core`), lists its member personas with `personas`
(`docmeta:audience`), records its own upkeep with `owner`/`last-reviewed`
(`docmeta:stewardship`), and retires with `lifecycle: archived`
(`docmeta:lifecycle`). A strategy document is a page, and it inherits the
family it sits in. This is why the three are thin: thirteen keys, where a
from-scratch design had thirty.

**`id` is the one exception, and it only narrows.** `docmeta:core` claims `id`
as an optional non-empty string; the three require it, at the same floor. That
is a strict narrowing, so anything valid for a document-type id is still valid
for core, and the spec suite pins that a blank `id` is a finding under *both*
at the same floor rather than a contradiction. Narrowing is the only re-claim
permitted, and both the suite and `compat-check.cjs` assert that `id` is the
only shared key.

**The three may share keys with each other**, and do: `evidence`,
`evidence-strength`, and `needs`. Each is wired to its own directory, so no
document is ever judged by two of them, and a coverage report reading
`evidence` across the whole strategy corpus wants one column, not three.

### There is deliberately no `type` key

An earlier draft of this proposal pinned `type` to a constant — `type: audience`,
`type: persona`, `type: journey` — so a misfiled document would fail by name.
It was dropped, and the reason is the most important composability decision
here.

`type` is the **most contested key in the registry**. `google:okf:0.1` requires
it. `diataxis:diataxis:1.0` requires it *and* limits it to four values.
`docmeta:core` claims it. `docmeta:kg` mirrors it one level down as the deeper
twin. DCMI permits it repeated. A `const` on that key does not add a fact —
it **forbids every other claimant's**, which makes the schema unstackable with
all of them at once.

`compat-check.cjs` proves this rather than asserting it: it reconstructs the
const-`type` draft and reports the result beside the shipped one.

```
UNSTACKABLE        const-type persona + Diataxis (type: explanation)
UNSTACKABLE        const-type persona + okf (type: concept)
UNSTACKABLE        const-type persona + DCMI (repeated type)
STACKS   as shipped: persona + Diataxis
STACKS   as shipped: persona + okf
STACKS   as shipped: persona + DCMI
```

**What settles which document is which is the `overrides:` glob, not a key
inside the file.** The config already made that statement; the constant was a
second, weaker copy of it that could disagree with the first — a page in
`personas/` carrying `type: audience` had two answers and no tiebreak. Deleting
it removes a fact declared twice, which is the same reasoning 0023 used to cut
`updated` and `date`.

**The cost is real and is not hidden.** Misfiling detection weakens rather than
vanishing, because the required sets still discriminate:

| Filed into | Judged by | Verdict |
|---|---|---|
| a journey into `personas/` | persona | **fails** — no `role` |
| a persona into `journeys/` | journey | **fails** — no `trigger`, `success-criteria`, `steps` |
| a persona into `audiences/` | audience-profile | **passes** — `id` is all it requires |

The third row is a genuine hole, pinned as a passing case in both the ladder
(`A8`) and the spec suite so it stays a known cost rather than a surprise. A
team that wants it closed writes one `check:` over the collection, which is
strictly more capable than the constant was because it can also catch the
*inverse* — an audience document sitting outside `audiences/`.

## The three vocabularies

`*` = required. All three are `additionalProperties: true` at the root, so a
team keeps its own strategy fields; adopting these is additive.

### `docmeta:audience-profile:1.0.0-proposal.1`

`id`\*, `traits`, `needs`, `evidence`, `evidence-strength`.

- **`traits`** — flat labels for what defines the segment: `enterprise`,
  `multi-repo`, `procurement-driven`. Named dimensions were tried and
  simplified away for the same reason `applies-to` was in 0023: every org
  segments on different axes, and a fixed set of axis keys is a guess about
  someone else's business. An org that wants axes prefixes them —
  `maturity:enterprise`, `stage:prospect`, `owner:established-docs-team` —
  which is the same escape hatch in the same convention. This one field
  absorbs four of the source corpus's.
- **`needs`** — what the segment most needs documented, as labels. The field
  that makes coverage checkable: a label here that no page claims under
  `applies-to` or `concepts` is a documented gap in a documented segment, and
  that is a query rather than an opinion.

### `docmeta:persona:1.0.0-proposal.1`

`id`\*, `role`\*, `expertise`, `goals`, `pains`, `needs`, `evidence`,
`evidence-strength`.

- **`role`\*** is the one required fact beyond identity. A persona without a
  role is a label: it names a group without saying who is in it, and every
  downstream judgment hangs off it. Singular and unenumerated — it is prose
  about one person-shaped reader, not a taxonomy.
- **`expertise`** is where reader level lives, and **this is the field 0023
  cut from the page on purpose.** `docmeta:audience` records that it has no
  `expertise` key because "level belongs to the persona definitions a page
  points at"; `docmeta:structure` records the same reasoning again when it
  refuses an `advanced` key. The fact was cut from the page because it had
  nowhere better to be. Here is the somewhere better.
- **`expertise` also absorbs the source corpus's `prerequisites`**, for two
  reasons. It duplicates: `git-and-prs` appears in both lists on the same
  persona, at slightly different confidence. And `prerequisites` is claimed by
  `docmeta:structure`, where it means the *opposite* thing — what a page needs,
  not what a reader has. One key reachable at two altitudes with inverted
  meanings would poison every query over it. The compat-check pins that a
  persona may carry both keys with neither shadowing the other.
- **`goals` / `pains`** are prose one-liners, kept apart because pains are what
  the docs must actually answer, and because a persona with goals and no pains
  is usually a persona nobody interviewed.
- **`needs`** is the label-shaped counterpart, same key as the audience
  vocabulary's, so one report reads both altitudes.

### `docmeta:journey:1.0.0-proposal.1`

`id`\*, `trigger`\*, `success-criteria`\*, `steps`\*, `entry-point`,
`evidence`, `evidence-strength`.

- **`trigger`\*** — what puts the reader on this path. Required, because a
  journey with no trigger is a table of contents: you cannot tell whether the
  entry point is right, and you cannot tell two journeys over the same pages
  apart.
- **`success-criteria`\*** — how you know the reader finished. The single most
  valuable field here: it is what turns a journey from a description into
  something testable. Stated as an outcome for the reader, never as a page they
  reached.
- **`entry-point`** — where the reader actually arrives. Deliberately *not*
  derived from `steps[0]`, because it frequently differs: readers land where
  search and marketing send them and work backwards. In the source corpus the
  two differ on several CUJs, and the gap is itself a finding.
- **`steps`\*** — the ordered path, one entry per thing the reader has to do.
  Order is the array's; there is no rank or weight field. Non-empty, because an
  empty list would read to a coverage report as a fully covered journey — the
  exact failure the vocabulary exists to catch. Distinct from `next-steps`
  (`docmeta:structure`), which is one page's unordered follow-ons; these are
  one reader's ordered path.

Each step is `{ stage*, doc, coverage, note }`:

- **`stage`\*** — what the reader is trying to do, in their terms (`choose an
  access scope`, not `read the permissions page`). The only required key,
  because a step that names only a document has recorded the answer without the
  question.
- **`doc`** — the page that serves it. When `coverage` says the page is
  missing, this is the route it *should* live at; writing the intended address
  down is what lets a gap become a ticket and later a redirect that resolves.
- **`coverage`** — `covered · partial · missing · cross-reference`. Closed,
  because a gap report switches on it. **`cross-reference` requires `doc`**,
  which is the family's conditional idiom applied one level down: a value that
  defers to something else must say what, exactly as `lifecycle: deprecated`
  requires `replaced-by` or `remove-by`. A hand-off that names no journey is
  indistinguishable from an unassessed step, and the report cannot follow the
  edge. `missing` deliberately does *not* require `doc` — a team that has found
  a gap but not yet decided where the page goes is in a real state.
- **`note`** — why the coverage is what it is. What keeps a `partial` from
  being re-investigated every quarter.

`steps` is deliberately **not** `uniqueItems`, which is the one place the trio
departs from "every list carries `minItems` + `uniqueItems`". That rule is
about *label sets*, where a repeat is always noise. This is an ordered record
array — the same category as `command` and `success-exit-codes` in
`docmeta:evals`, which are likewise not deduplicated — and a journey that
genuinely revisits a stage (review, fix, review again) is a real shape.
Rejecting it to catch a copy-paste would trade a real shape for a cosmetic one.

**The step object is closed** — the one closure anywhere in the trio — with an
`^x-` prefix as the documented escape hatch for team bookkeeping (`x-issue`,
`x-owner`). It is the same trade the `kg` envelope makes in 0023, for the same
reason: no generator competes for these keys, and a misspelled `coverage` on an
open object is invisible, so the report reads the step as unassessed while the
author believes it is filled in. That is a fail-open, on the one record the
whole report is built from. Closing a **nested** object costs nothing in
composability — no other schema reaches inside `steps[]` — which is exactly why
the closure is affordable here and the `type` constant was not.

### `evidence` and `evidence-strength`, on all three

A strategy document is a claim about people. The difference between a
researched segment and an invented one is invisible in the prose and decisive
for anyone acting on it.

- **`evidence`** — what the claim rests on: `customer-interviews`,
  `support-tickets`, `analytics`, `search-logs`, `assumed`. The **open-enum
  idiom** from 0023 — an advisory enum plus a free string — so editors and
  `fill` see the recommendations while an org-specific research channel stays a
  correct document.
- **`evidence-strength`** — `strong · moderate · thin · assumed`. Closed,
  because a strategy-coverage report switches on it and an unrecognized value
  would fail open. That is the same asymmetry `visibility` has against
  `audiences` in `docmeta:audience`, one field apart, for the same reason.
  Absence means unassessed, not strong.

These are deliberately not `verified-against` (`docmeta:stewardship`), which
names *the one version of the thing a page describes*. Freshness, though, is
not re-invented: a strategy document goes stale like anything else, and
`last-reviewed` + `review-interval` already own that.

**Nor are they provenance.** 0023's principle 9 — "machines propose; humans
retire the provenance" — puts `generated-by` and `provenance` in
`docmeta:ai-context`, and repeats the pattern inside `kg` and both eval
schemas. Strategy documents are among the likeliest things in a repo to be
machine-drafted (a persona synthesised from call transcripts is the obvious
case), so the question of where their provenance lives is a fair one. The
answer is that it is already published and needs no new claim: a strategy
document stacking `docmeta:ai-context` gets `generated-by` and the
per-model `provenance` trail on exactly the terms every other page gets them,
and the two facts are genuinely different — `generated-by` says *who wrote this
frontmatter*, `evidence` says *what the claim about people rests on*. A persona
can be `generated-by: claude-opus-5` with `evidence: [customer-interviews]`
(a machine summarised real research) or with `evidence: [assumed]` (a machine
made it up), and those are the two cases a reviewer most needs told apart.

### Three copies of `evidenceSource`

The `evidence` `$defs` are duplicated across all three schemas rather than
shared by `$ref`. That is the family's existing precedent, not a shortcut:
`stringList` is copied across the facet ids and `provenanceEntry` across four
of them, because a published schema must be self-contained — a cross-file
`$ref` would make one id's resolution depend on another id's URL being
reachable, which is the durability problem 0008 exists to avoid. The cost is
real and worth stating: widening the recommended-source list later means three
new versions published in lockstep, since published bytes are immutable.

## Composability

The claim that these compose is not an assertion; it is
`docs/proposals/0031/ladders/compat-check.cjs`, run against **21 registered
built-ins and the 9 drafts of 0023**, with every invariant wired to the exit
code so it cannot fail open. Four things it establishes:

**1. The key space is almost entirely uncontested.** Twelve of the thirteen
keys have no other claimant anywhere in the registry:

```
=== keys shared with anything outside the trio ===
id  (claimed in the trio by: audience-profile, persona, journey)
    also claimed by: docusaurus:docs:3.10, docmeta:core:1.0.0-proposal.1

allowance holds: the only externally-claimed key is id
trio-only keys (no other claimant anywhere): 12 of 13
```

The allowance is enforced, not observed: a future key that collides with
anything increments `findings` and fails the run.

**2. The one shared key narrows without breaking anyone.** Every other
claimant's legal `id` spelling still passes — Docusaurus's path-shaped
`folder/doc`, a Hugo slug, a DCMI URI. What the trio adds is that `id` must be
present and non-empty, which core already said about the non-empty half.

**3. Everything a repo actually runs rides through untouched.** The probe list
covers the 0023 family's own keys (`personas`, `journeys`, `audiences`,
`owner`, `last-reviewed`, `lifecycle`, the `kg` envelope), generator keys
(Starlight's `sidebar` object, Hugo's `draft`, Docusaurus's `tags`/`slug`), and
the source corpus's unclaimed extras (`firmographics`, `maturity`,
`team_context`) — 28 probes, every expected pass passing and every REJECT a
recorded design decision.

**4. Real documents survive real stacks.** One persona document is validated
against every member of each set at once:

| Stack | Verdict |
|---|---|
| persona + the whole 0023 family (8 ids) | stacks |
| persona + core + Starlight + okf | stacks |
| persona + Diataxis | stacks |
| persona + DCMI | stacks |
| journey + core + Starlight + okf | stacks |
| the trio on one document | **blocked, by design** |

The last row is the design working: the three remain mutually exclusive, now
enforced by conflicting `required` sets rather than by a `type` constant.

**Where composability is deliberately imperfect**, and why each is affordable:

- **The closed step object.** `additionalProperties: false` is the one closure,
  and it is nested — no other schema in the registry reaches inside `steps[]`,
  so nothing can be broken by it. The `^x-` escape is a second extension idiom
  in a family that otherwise uses only "open root", and open question 5 asks
  whether that is worth it.
- **`evidence-strength`'s closed enum.** Any repo already using that key with a
  different vocabulary must override. No other schema claims it, so the blast
  radius is one key in one repo.
- **The empty list is rejected everywhere.** A repo that writes `needs: []` to
  mean "assessed, none" must use absence instead. This is 0023's rule, applied
  consistently rather than re-argued.

## The ledger

What each field of the source corpus became. Every rename is a decision this
proposal owes an answer for; every cut names what replaced it.

### Audience

| Source field | Becomes | Why |
|---|---|---|
| `id` | `id`\* | required |
| `type: audience` | *(nothing)* | the `overrides:` glob says which document is which; see [no `type` key](#there-is-deliberately-no-type-key). It survives untouched as an unclaimed extra |
| `segment` | `title` (core) | the segment's name is the document's title; a second key for it is one fact under two names |
| `maturity` | `traits: [maturity:*]` | one org's axis, expressible in the prefix convention |
| `docs_owner` | `traits: [owner:*]` + prose | a label for querying, a paragraph for reading |
| `firmographics` | `traits` | same fact, unprefixed |
| `relationship_stages` | `traits: [stage:*]` | a third axis; the escape hatch already covers it |
| `features_emphasized` | `needs` | generalized past one product's feature list |
| `personas` | `personas` (facet) | already claimed by `docmeta:audience`; reuse, don't re-claim |
| `underrepresented: true` | `evidence-strength: thin` | a boolean named for one end of a ladder is a ladder |

### Persona

| Source field | Becomes | Why |
|---|---|---|
| `name` | `title` (core) | the persona's name is the document's title |
| `type: persona` | *(nothing)* | as above |
| `audience` | `audiences` (facet) | plural key, `stringList` shape accepts the single value; cardinality is not enforced, because a persona spanning segments is legal |
| `team_context` | `description` (core) | it is a one-line summary, which is what `description` is |
| `role` | `role`\* | required |
| `proficiency` | `expertise` | the name 0023 used when it cut the field from the page |
| `prerequisites` | merged into `expertise` | duplicates it, and collides with `docmeta:structure` at the inverted meaning |
| `goals`, `pains` | `goals`, `pains` | unchanged |
| `content_types` | `needs` | same fact as the audience's, so the same key |
| `journeys` | `journeys` (facet) | already claimed |

### Journey

| Source field | Becomes | Why |
|---|---|---|
| `type: cuj` | *(nothing)* | as above. "CUJ" stays the word people say; `journeys` is the key every page already uses to point here |
| `title` | `title` (core) | already claimed |
| `personas` | `personas` (facet) | already claimed |
| `trigger` | `trigger`\* | required |
| `entry_point` | `entry-point` | kebab, per the family |
| `success_criteria` | `success-criteria`\* | kebab, required |
| `steps[].stage` | `steps[].stage`\* | required within the step |
| `steps[].doc` | `steps[].doc` | unchanged |
| `steps[].exists: true \| partial \| false \| ref` | `steps[].coverage: covered \| partial \| missing \| cross-reference` | see below |
| `steps[].note` | `steps[].note` | unchanged |

**The `exists` rename is the one substantive break, and it is a typing fix.**
`exists: true` is a YAML boolean; `exists: partial` is a string. A key whose
value is sometimes a boolean and sometimes an enum member is a trap in three
directions: YAML 1.1 also reads `no` and `off` as booleans, so `exists: no`
means something different from `exists: "no"`; TOML and JSON frontmatter type
the same key differently again (0023 already carries a sequencing dependency on
TOML date normalization for the same class of reason); and the question is not
boolean anyway, since `partial` and `ref` are not degrees of existence. Renaming
the key to `coverage` and closing the ladder makes the old spelling fail loudly
rather than pass as a stray key — which is what the closed step object buys,
and what the ladder's four migration negatives pin. It is also the **only**
place a source-corpus spelling breaks: everything else on the three tables
either keeps its name, moves to a key the family already published, or survives
untouched as an unclaimed extra.

### Not claimed

- **`type`.** The largest deliberate non-claim, and the one the composability
  section exists to justify.
- **The `_overview.md` index files** (`type: overview`, `scope`, and a list of
  ids). The set of audiences *is* the set of audience documents, so an index is
  a derivable fact, and 0023's principle 4 says derivable facts lie — the list
  goes stale the first time someone adds a file and forgets. `docmeta query`
  generates it; a `check:` can assert the two agree if a team wants to keep the
  file. An overview document validates fine under the facet ids alone, and
  since it lives beside its siblings, a team wiring an `overrides:` glob should
  exclude it or name the glob narrowly.
- **The information-architecture document.** One file, one shape, one repo —
  not yet evidence of a common vocabulary. If it recurs, it is a fourth id.

## Placement: override-only, by construction

**These three are never in `DEFAULT_SCHEMAS`, and this is not a review
question.** Each requires facts no ordinary page carries — `id` everywhere,
plus `role`, or the journey trio — so defaulting one would fail every page in
every repo that is not that kind of strategy document. That rule is already
written down in the codebase, about a different schema, for the same reason —
`src/core/resolve-schema.ts`:

> Diataxis is deliberately absent: it both requires and constrains `type`, so
> defaulting it would fail every repo not already on Diataxis.

The requiring half is enough on its own.

They are wired by `overrides:`, one glob per document type, which is precisely
the mechanism 0004 and 0005 exist to make ordinary:

```yaml
# docmeta.config.yaml
paths:
  - "docs/**/*.md"

overrides:
  - name: strategy_audiences
    files: "docs/content-strategy/audiences/[!_]*.md"
    schemas: ["docmeta:core:1.0.0", "docmeta:audience:1.0.0", "docmeta:audience-profile:1.0.0"]
  - name: strategy_personas
    files: "docs/content-strategy/personas/[!_]*.md"
    schemas: ["docmeta:core:1.0.0", "docmeta:audience:1.0.0", "docmeta:persona:1.0.0"]
  - name: strategy_journeys
    files: "docs/content-strategy/journeys/[!_]*.md"
    schemas: ["docmeta:core:1.0.0", "docmeta:audience:1.0.0", "docmeta:journey:1.0.0"]
```

Three things about that config are load-bearing:

- **An override's `schemas:` replaces the set, it does not extend it** — so the
  facet ids a strategy document wants (`core` for `title`/`description`,
  `audience` for `personas`/`journeys`) are listed explicitly. Leaving them out
  silently stops checking them.
- **The `[!_]` glob excludes the `_overview.md` index**, which is a different
  shape and is deliberately unclaimed.
- **`name:` makes each group a named collection** (0027) — a SQL view over the
  corpus, whose membership is the *resolution winner* rather than the glob.
  With no `type` key to select on, this is how a check names a document class,
  and it is more precise than `type` would have been: a file that names its own
  `$schema` leaves the view, and the views are disjoint by construction.

Registration would add the three ids to `BUILTINS` and `PUBLISHED_ALIAS` and
change **nothing** about the default set; the spec suite asserts the default
set's exact contents so that stays true by test rather than by intention.

The consequence for `docmeta fill` is the point, not a side effect: the family
menu on a bare `fill` is unchanged, and a `fill` inside `personas/` offers
`role`, `goals`, `pains` — because the override put that contract there.

## What this unlocks

The vocabularies are only half the value; the other half is that a strategy
becomes gateable. All the checks below are ordinary `checks:` entries (0026)
over the shipped SQL projection (0021) — no new engine, no new command.

**A reference that dangles is a finding.** Today `personas: [persona-typo]`
fails nothing, anywhere.

```yaml
checks:
  - name: persona-reference-resolves
    query: >-
      SELECT d._path AS path, 'personas' AS key,
             'no persona document defines "' || j.value || '"' AS message,
             lineFor(d._path, 'personas') AS line
      FROM docs d,
           json_each(CASE WHEN json_valid(d.personas)
                          THEN d.personas ELSE json_array(d.personas) END) j
      WHERE d.personas IS NOT NULL
        AND j.value NOT IN (SELECT id FROM strategy_personas)
```

Two details matter. `FROM strategy_personas` is the named collection, not
`WHERE type = 'persona'` — the config's glob is the single source of truth for
what a persona document is, which is the whole point of dropping `type`. And
the `json_valid` guard is because `personas` accepts the single-string
shorthand, which is stored as text rather than a JSON array.

**A persona no page serves is a finding**, and so is its mirror, a page whose
audience nobody defined. **A journey whose steps are all `missing` is a
finding** worth a warning even though every document in it validates — that is
the report the source corpus writes by hand today, in a Markdown table, and
regenerates when it drifts. **A misfiled document is a finding too**, which is
how a team closes the audience-direction hole:

```yaml
  - name: personas-live-in-the-personas-directory
    query: >-
      SELECT _path AS path, 'role' AS key,
             'a document with a role belongs in personas/' AS message
      FROM docs WHERE role IS NOT NULL
        AND _path NOT IN (SELECT _path FROM strategy_personas)
```

## Versioning

Inherited from 0023 unchanged: three-segment semver, because for `docmeta:*`
docmeta is upstream and owns the whole string; MAJOR when a document that used
to validate now fails, MINOR when one that used to fail may now pass, PATCH for
no validation-behavior change at all. The drafts carry the prerelease
`1.0.0-proposal.1` — a semver **prerelease**, not build metadata, so it sorts
below the `1.0.0` these would register as. Open question 9 of 0023 (what users
pin, now that patch bumps are real) applies here identically and is not
re-litigated.

## Verification

Everything runs today, without registration, from the repo root:

```bash
npx vitest run test/content-strategy-schema.test.ts
node docs/proposals/0031/ladders/content-strategy-examples.cjs
node docs/proposals/0031/ladders/compat-check.cjs
```

The **spec suite** validates through the shipped `runValidate` path (file refs
into the drafts) and pins the field sets, the reuse rule (`id` is the only key
shared with the 0023 family), the narrowing, the absence of any `type` claim,
kebab spelling, root openness, step closure, the misfiling verdicts including
the recorded hole, the `cross-reference` conditional, a real stack with
Diataxis, and — the guard rail this proposal owes the reader — that the default
set is exactly what it already was and that none of the three ids is
registered.

The **example ladder** runs 38 cases across the three schemas: positives from
minimal to full, a capability-fidelity case per schema (a real document from
the public corpus, translated, proving nothing was lost), and the migration
negatives, where the source corpus's current spellings fail loudly —
`exists: true`, `coverage: ref`, and a misspelled step key. A conformance
audit against the nine facet drafts is what added the last two cases and the
`cross-reference` conditional; the patterns those nine establish are checked
against, not assumed.

The **compat-check** is the composability evidence: the overlap map against 21
built-ins and the 9 drafts of 0023, 28 law probes, 9 real stacks, and the
three-way const-`type` counterfactual. It exits non-zero on any collision
outside the recorded allowance, so it cannot fail open.

## Open questions for the review

1. **`audience-profile` is a compromise name.** `docmeta:audience` is taken by
   the facet, and renaming a draft that is itself under review to free the name
   would be worse. If 0023's review renames the facet — `docmeta:page-audience`
   is the obvious candidate — this family should take the bare `docmeta:audience`
   and the asymmetry disappears. `docmeta:segment` was the other candidate and
   is recorded in the stress test.
2. **The audience-direction misfiling hole.** `audience-profile` requires only
   `id`, so a persona filed into `audiences/` validates. The options are: live
   with it and let a `check:` close it (this proposal's position), require
   something of an audience document (`traits`? — but a stub segment is
   legitimate), or accept a `type` constant on that one id and lose its
   stackability. Reviewers should say which.
3. **`traits` flattens four source fields into labels.** Same trade as
   `applies-to` in 0023, and the same open question: does the prefix convention
   (`maturity:enterprise`) actually get used, or does everyone overlay their own
   schema with real axis keys?
4. **`evidence-strength`'s ladder cost.** Four rungs bought typo-catching and a
   report that can count. A team whose vocabulary is `validated`/`hypothesis`
   must override the key.
5. **The closed step object and the `^x-` escape.** It is the only closure in
   the trio and introduces a second extension idiom into a family that
   otherwise uses only "open root". Worth the typo catch, or should the step be
   open and the migration break be loud only through `coverage`'s enum?
6. **Should `role` really be required?** It is the field that makes a persona a
   persona, but it also means a team cannot stub `id` + `title` and fill in
   later — the thing the audience vocabulary explicitly allows. It is also the
   only thing standing between a misfiled journey and a green run.
7. **`needs` shared between audience and persona.** One column for one report,
   or two subtly different facts that will drift — "what the segment needs" vs
   "what this reader needs" — collapsed too early?
8. **Cardinality on `audiences` for a persona.** The source corpus is strictly
   one persona to one audience; this proposal does not enforce it, on the
   grounds that a persona spanning segments is legal. Nobody has yet produced
   one.
9. **Journey step `doc` values are unconstrained strings.** They are routes in
   the source corpus, but a repo-relative path or a URL is equally sensible, and
   no format keyword covers all three. Link-checking them is a check's job, not
   a schema's — but should the schema at least forbid whitespace?

## Stress test

1. **The `type` constant was designed in, and measured out.** It was in the
   first draft on the strength of a real benefit — a misfiled document failing
   by name. `compat-check.cjs`'s counterfactual block is what killed it: the
   const made the schema unstackable with Diataxis, okf *and* DCMI, which is
   every `type` claimant in the registry. The counterfactual is kept in the
   ladder rather than deleted, so a future revision that reintroduces the
   constant is told what it costs. What the removal gave back, beyond
   stackability, is that document identity is now declared once — in the config
   — instead of twice with no tiebreak.
2. **One vocabulary with a `type` discriminator was designed first.** A single
   `docmeta:content-strategy` id with conditionals on `type` validated all
   three shapes and could be wired in one line. It lost on error attribution —
   every failure named the same id — and on a `oneOf` over three branches
   producing Ajv errors that name all three, so a missing `role` reported as
   "matched none of the schemas." It would also have died at step 1 above, for
   the same reason.
3. **`docmeta:segment` was the other name, and nearly won.** `segment` /
   `persona` / `journey` is three clean bare nouns with no collision and no
   asymmetry. It lost on obviousness: a published vocabulary id is read by
   people who did not read this document, and `audience-profile` needs no beat
   to connect to the word the rest of the family already uses.
4. **The `personas` collision was resolved by not colliding.** The first draft
   claimed `personas` on the audience schema, meaning "member personas," beside
   the facet's `personas`, meaning "personas this page serves." Same shape,
   different subject, and a query over the corpus would have mixed them. The
   reuse rule came out of that, and both the suite and the compat-check pin it.
5. **`prerequisites` was in the persona draft and was cut for the same reason**
   — `docmeta:structure` claims it at the inverted meaning. It is the second
   collision the reuse rule caught, and the one that would have been hardest to
   notice later, because both readings are plausible in isolation.
6. **`exists` survived one round as a boolean/string union** before the YAML
   1.1 `no`/`off` case killed it. The union validated fine in Ajv; it was the
   frontmatter layer, not the schema layer, where it broke.
7. **The empty-list hole was checked for deliberately this time**, because 0023
   found it the hard way (`owner: []` satisfying an ownership gate). Every
   list here carries `minItems` + `uniqueItems`, `steps` carries `minItems`, and
   the ladder pins `traits: []`, `goals: []` and `steps: []` as rejects.
8. **Default-on was never on the table, and the test says so rather than the
   prose.** The suite asserts `DEFAULT_SCHEMAS` is exactly
   `["google:okf:0.1", "passo-uno:seven-action:1.0"]`, so a future registration
   PR that adds one of these to the default set fails a test rather than
   surviving a review.
9. **A structural conformance audit was run against the nine facet drafts**,
   mechanically rather than by eye — every property and `$defs` entry checked
   for a `description`, every string for `minLength`, every array for
   `minItems`/`uniqueItems`, every open enum for branch order, and the root for
   `additionalProperties`. It found three real gaps in this proposal's drafts:
   `evidenceList` had no `description` in any of the three, `steps` had no
   `uniqueItems` and no recorded reason, and no schema here used the family's
   conditional idiom despite having an obvious case for it. The first was
   fixed, the second was recorded as a deliberate departure with its reasoning,
   and the third became the `cross-reference` ⇒ `doc` rule. The audit's own
   findings against 0023's nine are reported to that proposal's review rather
   than fixed here.

## Do not

- Register, sync, or publish any of these ids before the review concludes.
- **Put any of the three in `DEFAULT_SCHEMAS`, ever** — each requires facts an
  ordinary page has no reason to carry, and the spec suite fails if it happens.
- **Add a `type` constant back** without re-running `compat-check.cjs`'s
  counterfactual and answering what it costs. The misfiling catch it buys is
  available as a `check:` that also catches the inverse.
- Edit this proposal to match what later ships — supersede it (house rule).
- Claim a key from a 0023 facet id in one of these. `id` is the only permitted
  narrowing, and both the spec suite and the compat-check pin the list.
- Add a `see-also`-style alias for a renamed source field. The ledger above is
  the migration record; a second spelling is the second surface this family
  exists to prevent.
