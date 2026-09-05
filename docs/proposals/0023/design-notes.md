# Default-schema design notes: working ledger

**Status: design phase. Proposal drafted, review open. Nothing is canonical.**
The record is `docs/proposals/0023-metadata-vocabularies.md`. The
community-facing surface is the docs site's Proposals group. That is a hub
overview at `docs/src/content/docs/proposals/frontmatter-vocabularies.mdx`, plus
one dedicated page per vocabulary, nine in all. All pass the dogfood gate and
the docs build. Nine draft schemas live unregistered under
`docs/proposals/0023/schemas/`: the six house ids below, plus evals, kg and
artifact-evals. Round 6 moved `core`, `evals` and `artifact-evals` to
`1.0.0-proposal.2`, and round 8 moved `core` on to `1.0.0-proposal.3`. The other
six stay at `1.0.0-proposal.1`. Spec-by-example lives in
`test/default-schema.test.ts`, which is red until registration by design, and in
the runnable ladders at `docs/proposals/0023/ladders/*.cjs`, plus
`compat-check.cjs`, the composability cross-check. `test/default-schema.test.ts`
runs green via file refs, with only default-set membership skipped until
registration.

**2026-08-26 ruling: no design-lineage presentation.** The schemas and the
docs pages name no tools and no draft-contract versions; the vocabularies
stand on their own claims. The walk's history lives only here and in
proposal 0023's design ledgers, framed as record, not identity.

**2026-08-31 ruling: `authors` moves to stewardship.** Core is the answer to
*what is this page*, and who wrote it is a fact about the page's care, which
is what stewardship already collects. The move puts all four people fields
(`authors`, `owner`, `stakeholders`, `reviewed-by`) behind one adoption
decision and leaves core purely descriptive. Core 7 → 6 fields, stewardship
7 → 8; the family total stays 33 and disjoint. `authors` keeps its own loose
shape rather than stewardship's `stringList`, because it must still accept
MyST and Docusaurus person objects, which `owner` and `reviewed-by` never do.

**2026-09-02 ruling: `language` stays, and there is no `locale` key.** The
question was whether the family needs a `locale` field, or whether `language`
should be renamed to one. Neither. A BCP 47 tag already carries region and
script, as in `pt-BR` and `zh-Hant-TW`, so a second key would hold one fact
twice. Everything a locale means beyond the tag is rendering, which core never
claims: formatting, collation, text direction, and which site tree a page
renders in. The W3C's language-tags-and-locale-identifiers spec draws the same
line, where a language tag identifies content and a locale identifies
preferences. The rename lost on four counts. Every standard the family composes
with names the fact `language`, through `dc:language`, `inLanguage`, `lang` and
`xml:lang`, and core's method is to share the claimant's name. `locale` reopens
the `en_US` versus `en-US` spelling split that `og:locale` already suffers. It
has no RDF target, where `language` lands on `dcterms:language`. And even
Starlight keys locales by directory, as `zh-cn`, while the content tag is
`lang: zh-CN`. The strongest argument for the rename is that `language` is
overloaded with programming languages in technical docs. That is answered in the
description rather than the name. It was applied in place at core proposal.2, as
a description change only with no shape change. The field now says it is the
locale field, and that region and script subtags are expected. The core review
page carries the decision. And the one docs example that taught `locale: en`, in
`set-up/new-required-field.mdx`, now says `language: en`.

**2026-09-03 ruling. `locale` joins core as its own key, on the W3C LTLI line.**
This supersedes the 2026-09-02 ruling above, which stays as written. That ruling
said a BCP 47 tag already carries the locale, so a second key would record one
fact twice. That is true only when the language and the locale happen to match.
The W3C's Language Tags and Locale Identifiers spec, at w3.org/TR/ltli, treats
them as two facts. A language tag identifies the language the content is in. A
locale identifies a set of international preferences. That is usually a language
plus a region. It also covers whatever else formatting needs, such as the
calendar, the numbering system, or the collation order, written as `-u-`
extension keywords. Take an English page whose dates, amounts and sorted lists
follow German conventions. It is `language: en` with `locale: de-DE`, and a
single tag cannot record both. So the family now has both keys, split where the
spec splits them. `language` is what the text is written in, the same fact that
`lang`, `xml:lang`, `hreflang` and `dc:language` carry. `locale` is the set of
conventions the content follows. Two of the earlier objections are still true,
and are now handled in the field descriptions instead of being reasons to leave
the key out. Rendering is still not claimed. Which site tree a page renders in,
its text direction, and how a generator formats the values it computes all stay
with the generator. `locale` records only conventions that are already in the
text, which is a fact about the content. The `en_US` versus `en-US` spelling
split is handled the way `language` handles its own spelling. The description
recommends a Unicode locale identifier in hyphen form, and names `og:locale` as
the neighbor that uses the underscore. Nothing is enforced, so the two keys are
equally strict. Two more objections still hold, and neither costs anything.
`locale` has no RDF target, so kg harvests nothing from it. And no built-in
claims a bare `locale`. So the compat ladder pins the family's own shape rather
than another claimant's values. That shape is one non-empty string, with the
underscore form passing. A language tag can stand in as a locale identifier on
its own. LTLI says so, and asks content authors to pick tags that are canonical
Unicode locale identifiers. So `locale` is optional, and should be left out
wherever it would only repeat `language`. It shipped as core `1.0.0-proposal.3`,
because a new key is a shape change and round 6 bumped the version for one. So
proposal.2 keeps the bytes it had. Core goes from 6 fields to 7, and the family
from 33 to 34. The test pin and the compat probes are updated. The core page
records the decision, and asks reviewers whether the hyphen form should be
enforced.

**2026-08-26 correction: the whole family is default.** All nine append to
`DEFAULT_SCHEMAS`, superseding the core-only intent below wherever it
appears. Bare runs require the pair, validate every family key present,
and put the full menu on bare `fill`, accepted as the teaching surface.

## The principles (settled through the field walk)

1. **Weak floors teach bad habits.** `title` and `description` are required as
   non-empty strings. That is a recorded exception to the composability law,
   since Docusaurus allows empty and DCMI allows arrays, and both are override
   cases.
2. **One value is a string, and many values are a list.** There is no per-field
   trivia. DCMI's repeated-element forms for `type` and `language` are override
   cases.
3. **Claim content, never rendering.** Cut `tags`, `slug`, `image` and `layout`,
   and the presentation group as a concept.
4. **Derivable facts lie.** Cut `updated`, `date`, `next-review`, and `contact`
   as a second reach field. Git owns change dates. `last-reviewed` plus
   `review-interval` derive the due date. Dates only a human can assert stay,
   which are `last-reviewed` and `remove-by`.
5. **Facts live at their altitude.** `stakeholders` is page-level, meaning who
   to consult about THIS page. It is distinct from the project-level
   `stakeholders` cut in the exploration brief's addendum, which was its draft
   0021 rather than main's query proposal. `expertise` fell because level
   belongs to the persona definitions the page points at.
6. **Enumerate only what is switched-on and bounded**, meaning `visibility` and
   `lifecycle`, and **recommend openly** elsewhere. `risks` uses the open-enum
   idiom, an `anyOf` of an enum and a free string.
7. **Compose, don't duplicate.** `action` comes from
   `passo-uno:seven-action:1.0` in the default set. `kg` from dockg and
   `metadata.evals` from moose-tracevals stay unclaimed. The classification
   story is three layers: `type` for what the page is, `action` for what the
   reader is doing, and `intent` for the specific job.

## The six house vocabularies: 34 fields, split by intent

Designed as one large schema, then split by owner directive into six
intent-scoped ids. That supersedes the earlier `docmeta:frontmatter:1.0` id
ruling, and the split is why. The six are `docmeta:core` (the required pair),
`docmeta:stewardship`, `docmeta:audience`, `docmeta:lifecycle`,
`docmeta:structure` (honoring the naming decision recorded in the exploration
brief for the relational schema), and `docmeta:ai-context`. Core is at
`1.0.0-proposal.3` since round 8, and the other five are at `1.0.0-proposal.1`.
They are disjoint by construction, at 34 fields with 0 collisions, pinned.
Stacking all six behaves like the monolith, and every error is attributed to one
intent. Verified with `npx vitest run test/default-schema.test.ts`, green via
file refs into the drafts, with default-set membership skipped until
registration. The field homes are:

- **Core (docmeta:core:1.0.0-proposal.3):** title*, description*, plus id, type,
  keywords, language and locale. Every string core claims is non-empty, and type
  and language are single-valued even against DCMI, which is the recorded
  exception family. `locale` was added 2026-09-03 on the W3C LTLI line.
  `language` is what the text is written in, and `locale` the preferences its
  content follows, set only where the two differ.
- **Stewardship (docmeta:stewardship:1.0.0-proposal.1):** authors, owner,
  stakeholders, reviewed-by, last-reviewed, review-interval, verified-against,
  source-of-truth. `authors` moved from core 2026-08-31, because attribution is
  a fact about care rather than about what the page is. It keeps its own shape,
  since person objects are legal here and not in `stringList`.
- **Audience & intent (docmeta:audience:1.0.0-proposal.1):** audiences,
  personas, journeys, intent, visibility. The `visibility` enum is draft →
  restricted → confidential → internal → public.
- **Lifecycle (docmeta:lifecycle:1.0.0-proposal.1):** lifecycle, replaced-by,
  supersedes, remove-by. The `lifecycle` enum is
  draft|published|deprecated|archived, and deprecated ⇒ replaced-by or
  remove-by.
- **Structure (docmeta:structure:1.0.0-proposal.1):** applies-to,
  not-applicable-to, concepts, prerequisites, next-steps, related-pages.
  `not-applicable-to` was added in review round 5, for parallelism, because the
  positive had a page-level twin and its negative did not. `related-pages` was
  renamed in step with kg's related-concepts, so each says what it points at.
- **AI context (docmeta:ai-context:1.0.0-proposal.1):** generated-by,
  provenance, risks, sample-questions. `provenance` generalizes the
  kg.provenance pattern, and entries retire under human review. `risks` is an
  open enum of cost-incurring, destructive, irreversible, privileged,
  open-world, read-only and idempotent. The first four come from the
  context-engineering deck, and the last three mirror MCP tool annotations.
  `sample-questions` takes one question or a list, like every list field.

**Recorded intent for post-review, not applied.** Append all nine to
`DEFAULT_SCHEMAS`, corrected 2026-08-26 from core-only. Requiring title and
description on bare runs is a deliberate `feat!:`. A demo video follows the
house rule.

**Open questions for the community draft.** First, the flattening of
`applies-to` to labels. The deck modeled named dimensions, as product,
deployment and generation, and this loses them. The prefix-label convention
`deploy:kubernetes` is the escape hatch, and the model's author should get a
direct look. Second, the `lifecycle` enum's org-ladder cost. Third, the `risks`
naming, now that assurances such as `read-only` and `idempotent` sit in a field
called risks. Fourth, the `stakeholders` name against the exploration brief's
project-level cut, which needs one paragraph.

## docmeta:evals (proposal.1 revised from docevals frontmatter-0.1; proposal.2 in round 6 below)

Claims four keys: `evals` (one assertion string, or a list of entries),
`eval-suite`, `eval-skip`, and `eval-provenance` (the generalized
provenance pattern under the reserved prefix). Entry forms: string
shorthand · `use:` reference · inline definition (closed objects; typos
fail loudly).

Graders (`ai | command | human | tool:<kebab>`, default `ai`):

| Grader | Requirement | Notes |
|---|---|---|
| `ai` | assertion | replaces 0.1's `llm`; optional `provider` picks a model endpoint or agent runner, validated at run time by the inference dependency |
| `command` | assertion or command | no `command` = generation contract: tooling generates a check script, writes back `command` + `generated-assertion-hash` (flattened from 0.1's `generated.assertionHash`) |
| `human` | assertion | new rule: a reviewer must have something to verify |
| `tool:*` | nothing | the tool is the check; `options` are the grader's runtime contract, outside the schema |

Vocabularies: `type: capability | regression` (default regression);
`severity: error | warning | info` (only error fails); `severity-map`
translates a tool's per-finding severities (meaningful on `tool:*` only).

**Fidelity ledger vs docevals frontmatter-0.1:**

- Renamed. `name`→`id`, `llm`→`ai`, `successExitCodes`→`success-exit-codes`,
  `timeoutMs`→`timeout-ms`, and
  `generated.assertionHash`→`generated-assertion-hash`
- Removed. The object form, with `suite` and `skip` hoisted to `eval-suite` and
  `eval-skip`. Also `generatedBy`. The top-level `generated-by` in
  docmeta:ai-context:1.0.0-proposal.1 owns AI provenance, and the
  self-preference-bias check reads it there
- Added. `severity-map`, their documented-but-schema-rejected field, plus
  `provider`, the single-string shorthand, and the human⇒assertion rule
- Unchanged. Entry forms, grading semantics, `capability|regression`,
  `error|warning|info`, the `tool:*` open family, kebab id pattern

**Placement intent (corrected 2026-08-26):** default set, with the whole
family. The original opt-in call feared the bare `fill` menu; the
correction accepts it as the teaching surface.

**docevals-side ledger, in their repo, post-review.** A superseding ADR over
01000, which said "schemas are published by the tool that owns them". The new
line is that docmeta publishes generic metadata vocabularies, and tools own
domain ontologies. The resolver reads the kebab spellings, top-level
`generated-by`, and `eval-suite` and `eval-skip`. It must **reserve the `eval-`
prefix**, erroring on unrecognized top-level `eval-*` keys. That restores the
closed block's loud-typo property at the open page root. `frontmatter-valid`
points at the docmeta-published URL. Still open: whether grader runtime option
names such as `maxAgeDays`, `maxGrade` and `maxSimilarity` also go kebab.

**Verified ladder.** All 23 cases are in `ladders/evals-examples.cjs`. They
cover single-string shorthand, list shorthand, and a mixed list with references.
Then flat `eval-suite` and `eval-skip: true`. Then ai default and
ai-with-provider, command in authored, post-generation and explicit-maximal
forms, and human maximal. Then the tool spread: freshness, doc-structure-lint,
vale with severity-map, and differentiation. The negatives pin six failures. The
0.1 object form fails, the `llm` spelling fails, and the `generated` wrapper
fails. Misspelled entry fields fail, ai and human without assertion fail, and
`eval-skip` as a string fails.

## docmeta:kg:1.0.0-proposal.2 (revised from dockg frontmatter-0.8)

One closed `kg` envelope (kept on purpose: a closed typo-catching block
coexisting with an open page), nothing required, files without `kg` pass.
Verified ladder: `ladders/kg-examples.cjs` (12 positive + 16 negative,
including the 0.8 worked example translated, the fidelity proof, and the three
document-lineage relations side by side). Round 7 added `translation-of`; the
count claimed here had also drifted from what the file ran.

**Fidelity ledger vs 0.8:**

- Renamed to kebab and plain language. The RDF mapping lives in descriptions,
  where it always did, and iiRDS is kebab upstream anyway.
  The renames are prefLabel → **label**, altLabels → alt-labels, and subjects →
  **concepts**. That last one is the nominal twin of the page-level field, and
  the same fact, with deeper winning. Then related → **related-concepts**, in
  step with the page-level rename to related-pages. Then topicType → **type**,
  the nominal twin of the page-level `type`, where the open page value derives
  it and the closed iiRDS enum here wins. Then appliesTo → applies-to, and
  softwareLifecyclePhase → **about-product-lifecycle**, where the about-ness is
  structural: what the page is ABOUT, never the page's own `lifecycle`. Then
  softwareSubject → **about-product-aspect**, whose aspects are architecture,
  interface and system-requirement, and which pairs with
  about-product-lifecycle. Then notApplicableTo → not-applicable-to,
  notSoftwareSubject → not-about-product-aspect, revisionOf → revision-of, and
  derivedFrom → derived-from. Also the provenance entries' generated-by, and the
  provenance `fields` enum values, which are self-referential and renamed with
  the fields. broader and narrower stay bare, and nothing collides.
- Removed. kg.generatedBy, because the top-level `generated-by` owns page
  provenance. Also the deprecated single-object `provenance` shape from 0.2 and
  0.3. The provenance ARRAY survives whole. It is per-model entries of
  generated-by, fields and confidence, and it is fill's human-review trail. No
  timestamp, ever, because dockg's determinism invariant forbids wall-clock.
- Widened. Every label and enum list takes single-string shorthand, and every
  0.8-valid document stays valid.
- Kept. dependentRequired, where hierarchy ⇒ pref-label. All three iiRDS enums
  stay closed, because published lists are the authority constraint 3 asks for.
  Also negative scope, sections with free slug keys, where brokenSectionRef is
  the build-layer check, and the confidence trail.

**Owner rulings, the harvest rule.** *Deeper wins, and the top level is the
harvest fallback*, per fact rather than per page. So kg.subjects beats
`concepts` for subjects. Everything the block doesn't speak to still harvests.
That is `generated-by`, `supersedes` and `replaced-by` → prov:wasRevisionOf, and
`prerequisites` → dcterms:requires. Also `related` and `next-steps` →
dcterms:references, `applies-to` values → iirds:ProductVariant, and `concepts` →
dcterms:subject and skos:Concept. Legacy kg.generatedBy beats top-level by the
same rule. D4 is accepted, so a kg-less `topic-type` derives from the page's
`type`. That mapping is how-to→task, tutorial→learning, explanation→concept,
reference→reference, and troubleshooting→troubleshooting, and an explicit block
wins. The dockg-side ledger is a superseding ADR over "never a docmeta
built-in". It also needs a deriver that reads kebab keys, the fallback rule, the
type derivation, and single-string normalization.

## docmeta:artifact-evals (proposal.1 revised from moose-tracevals artifact-evals-0.2; proposal.2 in round 6 below)

Eval declarations for instruction artifacts, meaning skills, agents and
project-rules. The page-side trio appears verbatim one level down, as
`metadata.evals` (one assertion or the list), `metadata.eval-skip` and
`metadata.eval-provenance`. The artifact's top level is the host tool's
contract, and `metadata` is its sanctioned extension bag. 0.2's `criteria`
container is dissolved the same way the page side's object form was, so the word
criteria leaves the family vocabulary. `metadata` stays open, so other tools'
members pass untouched. Entry objects are closed, and the loud-typo guard is the
same `eval` prefix reservation, applied inside `metadata`. The verified ladder
is `ladders/artifact-evals-examples.cjs`.

**Fidelity ledger vs 0.2** (tracevals unshipped, so breaks are free):

- Renamed. The optional position-derived `name` became a **required `id`** on
  the object form, because position-derived ids orphan cached verdicts. The
  string shorthand stays the id-less path. Also `llm` → `ai`.
- Changed. The grader went from a closed enum of 8 to an **open enum**. The
  recommended values are ai, human, command, tool-usage, skill-invoked,
  file-access, turn-count, cost, regex and json-output. The page side's tool:*
  spelling is also recommended. Any kebab name is legal, and validated by the
  registry at run time. The grader principle across both eval schemas is *closed
  where the schema switches on the value, open where only the runtime registry
  does*. The page side's ai|command|human conditionals are the switching
  case. The cost is that a stale `llm` passes the schema and is rejected by the
  registry.
- Widened. `examples` pass and fail went to string-or-list, in both eval
  schemas, because the artifact side's anchor lists are real usage.
- Added. `provider`, on ai evals. Also `metadata.eval-provenance`, the family
  pattern, with entries keyed `evals:` like the page side. Also the
  single-string block shorthand, `metadata.evals: <assertion>`, and the `human`
  and `command` graders from the page side. `human` is judged per session,
  because every trace is new, so there is no verdict caching, unlike pages.
  `command` runs an executable over `{trace}` with the same generation contract,
  writing back command and generated-assertion-hash. This makes the two eval
  schemas' entry vocabularies structurally aligned.
  One deliberate asymmetry remained in proposal.1. `assertion` was
  unconditionally required here, where every eval must be self-describing. On
  the page side it is conditional, because there a tool grader is its own check.
  Round 6 removed the asymmetry, below.
- Unchanged. The `metadata` envelope, which is the host contract. Also type and
  severity verbatim, evidence and options, string shorthand entries, and every
  session-grader kind.
- With id and assertion always required in proposal.1, most of the earlier
  conditional machinery was unnecessary. The entry kept only the command-family
  guards: command and its settings ⇒ `grader: command`, and hash ⇒ command.
- The tracevals-side ledger is a superseding ADR over "never a docmeta
  built-in". Extract, write and fill read `id` and the new spellings, and the
  grader registry rejects unknown kinds, `llm` included.

## doc-structure-lint: frontmatter fit (looked at, not a schema)

Owner's own repo, alpha, dormant since 2025-01, with 0.0.5 never published. The
verdict is to improve by **selection, not validation**. The plumbing is about
60% there. remark-frontmatter is wired, so a `---` block is a yaml node and
never miscounted as content. `structure.frontmatter` is populated and handed to
the validator, where `// TODO: Check frontmatter` sits unimplemented. And open
issue #13 already asks for template selection from frontmatter, "to lint
multiple different kinds of documents in a single run". Today `--template` is
required, and broadcast over every file in a directory.

- **Do this.** Select the template from the page's `type` via a type→template
  map in templates.yaml, which puts a repo-level fact at repo-level altitude.
  CLI `-t` overrides, and there is zero new frontmatter vocabulary. Do NOT use
  issue #13's proposed `template:` key. Starlight claims `template` as an enum
  of doc and splash, so `template: how-to` breaks stacked platform validation.
  If a per-page override is ever needed, a kebab house-free key such as
  `structure-template` is the safe spelling.
- **Don't do this.** Do not grow frontmatter-validation rules, which is a README
  roadmap item. docmeta owns that layer. Template-conditional requirements, such
  as "how-tos must carry intent", are already expressible as if/then on `type`
  in an org schema. Resolve the roadmap item by documented delegation, and
  delete the TODO.
- Housekeeping found in passing. The frontmatter extractor is a hand-rolled line
  splitter that shreds nested YAML. The repo already depends on `yaml`, so it
  should parse properly. TOML `+++` frontmatter is not enabled, and would
  inflate paragraph counts. Two latent bugs are suspected. The AJV key pattern
  `^[A-Za-z0-9-_]+$` disagrees with the repo's own spaced section keys, such as
  "Next steps". And a positional section-match dereferences undefined, raising a
  TypeError rather than a finding, when a document has fewer sections than its
  template. Both are relevant to docevals grader robustness.

## Family walk status: COMPLETE

- **docevals** → docmeta:evals:1.0.0-proposal.2
- **dockg** → docmeta:kg:1.0.0-proposal.2
- **moose-tracevals** → docmeta:artifact-evals:1.0.0-proposal.2

All drafts live under `docs/proposals/0023/schemas/`, outside the frozen
registry. They are verified by the `ladders/*.cjs` runs and the green spec
suite. Proposal 0023 and the published review pages are up. Next is the
community review itself.

## Review round 6, on scoring, targeting and versioning

Three families move to `1.0.0-proposal.2`: `evals`, `artifact-evals` and `core`.
The other six stay at proposal.1 unchanged. Bumping them would announce a
revision none of them made, and leave six pairs of byte-identical files to
explain. `test/default-schema.test.ts` and `ladders/compat-check.cjs` each carry
a per-family `VERSIONS` table so a family's next bump is still a one-line edit.

Six decisions, and the reasoning that is not already in the field
descriptions.

**`weight` (both eval families).** Positive number, default 1. It changes how
much an outcome moves an aggregate and never the eval's own pass/fail. The
binary outcome is what SARIF, JUnit and findings baselines consume downstream,
and a score leaking into it would change all three at once. Zero is excluded on
purpose. A weightless eval is a silent disable, and `skip` already means that
loudly.

**`target`, not `focus` (both).** `claude plugin eval` spells this twice
(`target` on its `regex` grader, `focus` on its `llm` grader) for the same
union of values. One name, and `target` is the right one for three reasons.
It names a data selector rather than an emphasis. `evidence` already
occupies the hint slot in both our families, so `focus` collides with it
while `target` does not, leaving the pair legible. And it has to serve
deterministic graders, which have no focus. That the source design reaches
for `target` on its deterministic grader is itself the evidence.

Members differ by family because the subjects do. A page takes `body`, `raw` or
`frontmatter`, and a session takes `transcript`, `last-message`, `files` or
`artifact`. Both share a `{source: file, path}` object form, branched with
if/then in the house style.

**`runs` and `model` (both).** Per-eval ensemble count and judging model.
Capped at 50 because runs multiply cost directly. Both, plus the
pre-existing `provider`, are now constrained to `ai` evals by a conditional.
proposal.1 stated that for `provider` in prose while giving command's fields
a hard conditional, an asymmetry with no reason behind it.

`model` also has a second purpose worth recording. It lets an eval name a judge
other than the model that produced what it grades. `ai-context`'s `generated-by`
already says a judge should know when it is grading its own author. Without a
per-eval `model`, a tool could only warn about that, never fix it.

**`assertion` becomes conditional in `artifact-evals`.** It was flatly
required there and conditionally required on the page side. A `tool-usage`
criterion says everything in `options`, just as a page-side `tool:freshness`
one does, so the requirement forced authors to write a sentence no grader
reads. The page side's `allOf` block is ported verbatim: `ai`, `human` and a
bare entry still require an assertion; `command` requires an assertion or a
command.

**The `eval-` prefix guard is encoded, not described.** Both families asked
consumers to reject unrecognized `eval-*` keys in prose, and neither enforced
it. So a consumer validating against the published bytes got the guard only if
it implemented one itself. moose-docevals did. moose-tracevals, following the
description faithfully, did not. Now `evals` carries
`"^eval-(?!suite$|skip$|provenance$)": false` at the root, and `artifact-evals`
the equivalent inside `metadata`.

**`docmeta-vocabularies` in `core` was withdrawn in round 7.** Round 6 added it
so a file could say which vocabulary version it targets. The guard above could
then check the version, before rejecting an unknown `eval-*` key as a typo. It
was nested as `metadata.docmeta-vocabularies` on artifacts and, after a
follow-up, constrained there to the same shape with `minProperties: 1`. Round 7
removed it from both schemas, the ladders, the test's field pin, and the pages.
The guard stands without it. An unrecognized `eval-*` key is rejected, whichever
version wrote it.

**Not changed, though it looked like it should be.** `artifact-evals.grader` has
no top-level `pattern`. It is an `anyOf` of `^(tool:)?[a-z0-9][a-z0-9-]*$` plus
a recommended enum. Its description already explains the open-kebab design. It
also explicitly accepts the page side's `tool:` namespace, "so one grader
spelling ports across both eval vocabularies". Read shallowly this looks like a
missing constraint. It is a documented decision, and it stands.

### Round 6 follow-up: where the `use:` form's overrides stop

Review asked whether `weight`'s absence from `evalReference` was an
intentional boundary or an omission. **Omission.** `weight` went onto
`inlineEval` and nobody looked at the reference form, which is how most
pages actually join an aggregate. It is there now, and `weight` is hoisted
into `$defs` so the two forms cannot drift on what a weight is.

Asking the question did expose where the line belongs, which was not written
down anywhere. The `use:` form's overrides are statements about **this page's
relationship to a check the corpus owner defined**. They say whether it applies
(`skip`), what kind of claim it is here (`type`), and how badly failing matters
(`severity`). They also say what it measures here (`options`), and how much it
counts (`weight`).

Two groups stay out, for different reasons:

- **`provider`, `model` and `runs`** say how the tool executes, not what the
  page claims. A corpus where each page picks its own judge model is one no
  operator can cost, cache, or reason about. The run-wide setting exists so that
  decision has one place.
- **`target`** would let a named eval read different bytes on different pages.
  One name would then mean two things in one corpus, which is the confusion
  `use:` exists to prevent. An eval that needs a different subject is a
  different eval, and defining it costs one config entry.
