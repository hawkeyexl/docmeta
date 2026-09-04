# 0011: Reconcile the content strategy with `fill`

- **Status:** Implemented
- **Serves:** The writing process itself. `content-strategy/` is the mandated
  input to every docs task
- **Touches:** `docs/content-strategy/cujs.md`, `docs/content-strategy/information-architecture.md`, `docs/content-strategy/personas.md`
- **Scope note:** This is a **strategy-record** fix, not a docs-content fix. See
  "What is actually missing".

## Problem

`fill` arrived in `1.4.0`, as `dc341ab feat(cli): add a fill subcommand…`. It
has been developed steadily since, through provider detection (`2f60978`),
schema-order independence (`4c14a39`), and a local model (`23349e5`, `cebded8`).
The content strategy in `docs/content-strategy/` predates it and was never
updated.

Concretely:

- **`cujs.md` has no fill CUJ.** It has two addendum paragraphs bolted onto the
  ends of M1 and T1. One opens "On an existing docset the journey does not end
  at a green gate…". The other opens "Theo's failure is usually a *missing*
  field…". That is useful prose, but no numbered journey. So nothing in the CUJ
  list names the outcome "retrofit metadata onto a docset that never had it".
- **`information-architecture.md`'s content-set tables list no fill page.** Not in
  Get started, Set up, CI, Schemas, Fix, or Reference. The nav tree has no mention.
- **The source-of-truth table *does* have a row** for "`fill` command &
  confidence gate" → `src/commands/fill.ts`, `fill-prompt.ts`, `fill-types.ts`.
  That row points at no page in the content set. It is the one place the
  strategy acknowledges fill, and it is dangling.

`CLAUDE.md` and `content-strategy/README.md` both mandate consulting these files
**before** any writing task. They say "Identify the persona… Find the matching
CUJ… Check the IA map… If you are adding a new page, record it there". So an
agent or contributor following the process correctly will conclude that fill
content has no home. The strategy is actively misleading, not merely stale.

## What is actually missing, which is narrower than it first appears

Stress-testing this proposal changed its scope. The shipped **docs** cover fill
substantially better than the strategy record suggests:

| Surface | Coverage today |
|---|---|
| `set-up/retrofit.mdx` | **Step 6, "Close the backlog with `fill`".** Covers `--dry-run`, `--confidence 0.9`, the review-the-diff workflow, one-folder-per-commit, and the hand-off to the ratchet. This *is* the M1-tail journey page. |
| `fix/index.mdx` | Theo's `fill` shortcut. |
| `reference/cli.mdx` §`fill` | Full flag table, "Which properties get filled", "The confidence gate", "Which formats can be written", exit codes, examples. |
| `reference/configuration.mdx` | The `fill:` config block. |
| `reference/formats.mdx` | Writability per format. |

The original framing was "fill has no journey page, no reference page". That was
wrong, and this proposal does **not** ask for a new journey page. Rewriting
`retrofit.mdx` step 6 into a separate page would duplicate working content, and
create a second thing to keep in sync.

The genuine gaps are:

1. **The strategy record itself** (the three files above).
2. **Provider selection, cost, and privacy.** No page covers what `fill`
   transmits, what it costs, or how to run it without a network. That is
   [0012](0012-fill-cost-and-privacy.md), and it is the only *content* gap here.

## Proposal

### 1. Add a numbered CUJ under Maya

```
### M4 · Retrofit metadata onto a docset that never had it

Maya has 1,200 pages that predate the standard. She needs to: choose a
permissive starting schema, get the gate green on day one, then close the
backlog rather than hand-editing 1,200 files — deciding per folder whether a
proposed value is good enough to keep, and knowing what the inference costs
and what leaves her machine.

Served by: set-up/retrofit.mdx (the journey), reference/cli.mdx#fill (the
contract), and the provider/cost/privacy page from 0012.
```

M4, not a new persona. See stress test 1. The two existing addendum paragraphs
in M1 and T1 stay. They are the cross-references from the neighbouring journeys,
and M4 is where the journey is actually named.

### 2. Record the pages that already exist

Add to `information-architecture.md`'s content set:

| Page | CUJ | ★ | Notes |
|---|---|---|---|
| Retrofit docmeta into an existing docs repo | M1/M2/**M4** | | Already shipped. Step 6 carries the `fill` journey. |
| `fill` providers, cost, and privacy | **M4**, D1 | | New. See [0012](0012-fill-cost-and-privacy.md). |

And extend the `fill` source-of-truth row to name the pages it governs, so it stops
dangling.

### 3. Note the inference dependency in `personas.md`

Neither Maya nor Devin is described as someone who makes a build-vs-buy or
data-egress decision. Yet `fill` puts that decision in front of both. One
sentence in each profile, not a new persona.

## Stress test

### 1. A new "fill user" persona (rejected)

`fill` is used by Maya, for retrofit at scale, and by Theo, to fix one file
fast. Both already exist, and their motivations are already recorded. A fifth
persona defined by a *feature* rather than a *job* would invert the document's
organizing principle. Every future feature would then argue for the same
treatment.

### 2. A new top-level nav section, "Fill in missing metadata" (rejected)

It is tempting, being a distinct-sounding job with enough surface to fill a
section. But `information-architecture.md`'s stated principle is "each top-level
section maps to a persona's job-to-be-done". Fill is a **tool used inside**
M1/M2/M4/T1, not a job someone arrives with. A feature-shaped section would be
the first exception to the principle, and the principle is the document's main
asset.

One counter-argument was considered and rejected on evidence. A user *does*
arrive thinking "I need to bulk-fill metadata". But they arrive at
`retrofit.mdx` via the Set-up track, which is where that intent already lands.
Search will find the fill sections regardless of nav shape.

### 3. Extracting a `reference/fill.mdx` (rejected, and there is a mechanical reason)

Splitting fill's contract out of `reference/cli.mdx` looks tidy. It would break
the only drift check the docs have. `scripts/check-cli-reference.mjs` parses
**`reference/cli.mdx` specifically**, since `DOC_PATH` defaults to that one
file. It compares commands, arguments, options, and value-defaults against
`buildProgram()`. Flags documented anywhere else are unchecked, and will
silently drift.

So any new fill page must be **prose-only, with no flag tables**, or it must
become the drift-checked file instead. Keeping the flag surface in `cli.mdx` is
the cheaper, safer answer. It also constrains
[0012](0012-fill-cost-and-privacy.md). That page explains providers, cost, and
egress, and links to `cli.mdx` for `--provider`, `--model`, `--max-cost-usd`,
and `--no-cache`.

### 4. Does M4 overlap M2 to the point of redundancy? (no, and the boundary is worth stating)

M2 is "tighten the standard without breaking the build", which is schema
strictness over time. M4 is "populate fields that are absent", which is document
content. They meet at the ratchet: fill a folder, then promote the field.
`retrofit.mdx` already sequences both, which is why it serves M1, M2, and M4
rather than needing to be split. [0001](0001-validation-baseline.md) sharpens
the boundary. With a baseline, M2 becomes mostly mechanical, and M4 becomes the
interesting half.

### 5. Is the strategy record load-bearing enough to be worth fixing? (yes, and this is the test that justifies the proposal)

The counter-argument is that these are internal notes and the shipped docs are
fine, so this is bookkeeping. But the process treats them as **inputs**, not
notes. `content-strategy/README.md` step 5 says "If you are adding a new page,
record it there", and `CLAUDE.md` makes consulting them mandatory before
user-facing writing.

The observable consequence is already in the repo. Fill shipped in 1.4.0,
`retrofit.mdx` step 6 was written, and the IA was **not** updated. So the
process was followed for the code and skipped for the record. Left alone, the
next feature does the same, and the strategy's usefulness decays until nobody
consults it. The fix is cheap now, and gets more expensive with every feature.

### 6. Do the ★ launch markers need revisiting? (out of scope, but flag it)

The IA's phased rollout describes Phase 1/2/3 with ★ marking launch priority. Every
★ page and most Phase 2 pages now exist, so the markers no longer distinguish
anything. Re-scoring them is a separate editorial pass; noted so this proposal is
not mistaken for having done it.

## Implementation sketch

No code, no tests, no `docs:check-cli` involvement. Three file edits:

1. In `cujs.md`, add M4 under Maya, and leave the M1/T1 addenda as
   cross-references.
2. In `information-architecture.md`, add the two content-set rows. Add M4 to the
   Set-up section's CUJ list, and extend the `fill` source-of-truth row to name
   its pages.
3. In `personas.md`, one sentence each in Maya's and Devin's profiles about the
   provider and egress decision.

Then verify by walking the "Journey walk-through test" the IA already defines
against M4. Follow `retrofit.mdx` end to end, and confirm a reader reaches a
filled, reviewed folder without leaving the track. The gap that walk will expose
is precisely [0012](0012-fill-cost-and-privacy.md), which is the intended
outcome.
