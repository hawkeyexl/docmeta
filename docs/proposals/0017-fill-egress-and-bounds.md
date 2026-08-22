# 0017 — What `fill` sends, and how to bound it

- **Status:** Accepted
- **Serves:** Maya · M4; Devin · D1
- **Touches:** `src/commands/fill-prompt.ts`, `src/commands/fill.ts`,
  `src/commands/fill-types.ts`, `src/cli.ts`, `src/core/config.ts`,
  `reference/cli.mdx`, `reference/configuration.mdx`
- **Supersedes:** [0012](0012-fill-cost-and-privacy.md), whose central evidence
  claim was already false on the day it was written
- **Relates to:** [0007](0007-html-xml-write-support.md), which extended `fill`
  to XML and DITA and so grew the population this proposal is about
- **Breaking:** yes — `--max-cost-usd` is removed (major)

## Problem

A docs team with a data-egress policy cannot get `fill` approved, because the
docs do not contain the facts a security review asks for.

`reference/cli.mdx:302` says `fill` "sends the page and its schema to an LLM
provider." That is true, and it is not an answer. A reviewer asks *how much*,
*which parts*, and *what is kept*, and the docs answer none of the three.

What is actually transmitted, read off the prompt builder rather than inferred:

| Item | What goes | Where |
|---|---|---|
| Page body | The first `BODY_CHAR_LIMIT = 12000` characters, front matter included; the rest is replaced by a `[body truncated]` marker | `fill-prompt.ts:22`, `:107`, `:133` |
| File path | `filePath` interpolated verbatim into the user prompt | `fill-prompt.ts:119-135` |
| Existing metadata | The whole extracted block, `JSON.stringify`'d, unfiltered | `fill-prompt.ts:119-135` |
| Schema prose | Every candidate property's own `description` | `fill-prompt.ts:108-117` |
| Schema internals | **All** `$defs` and `definitions` from every schema in the resolved set, referenced or not | `fill-prompt.ts:90-93` |

And what is retained afterwards:

| Item | What is kept | Where |
|---|---|---|
| Cache entry | The **pre-gating** `ProposalSet` — i.e. model output about the content that was then rejected for low confidence or for failing the schema | `fill.ts:101-105`, written at `:497` |

Three of these are worse than a reviewer would guess from the one-line
statement. File paths leave, which in a docs repo are often product names not
yet public. The `$defs` block leaves in full, so an internal schema's private
definitions travel even when no candidate references them. And the cache keeps
the *rejected* proposals, which is the opposite of the natural assumption that
only accepted values were stored.

This population just grew. [0007](0007-html-xml-write-support.md) made `fill`
work on XML and DITA, and the teams authoring in those formats skew enterprise
and regulated — exactly the teams whose approval process needs these numbers.

## Why 0012 was wrong, and what is actually missing

[0012](0012-fill-cost-and-privacy.md) opened with "`docmeta fill` sends document
content to a third-party API, and **no page in the docs says so**", supported by
a grep returning one unrelated hit. Both halves fail.

The claim was false **when it was written**, not merely stale. The transmit
statement and the four-step detection order shipped in `dc341ab` (#52,
2026-08-03); 0012 was written in `ed53e03` (#72, 2026-08-18), fifteen days
later, against docs that already carried it.

The grep missed it on wording. It searched for `sent to`; the page says
`sends`. A negative grep is evidence of a search term, not of an absence, and
0012 treated one as the other.

Re-checked against the current docs, this much is already published:

| Fact | Where |
|---|---|
| The page and its schema are sent to a provider | `cli.mdx:302` |
| The four-step detection order | `cli.mdx:302-311` |
| The local model downloads on first use, with a size, a directory, and an opt-out | `cli.mdx:313-322` |
| CI should pin a provider or a runner will silently fall back and download gigabytes | `configuration.mdx:275-277` |
| Cache location, machine-local, safe to delete, `.gitignore` it, `--no-cache` | `cli.mdx:386-389` |
| The cache stores the proposal **before** gating | `cli.mdx:382-384` |

Even the pre-gating fact — 0012's stress test 2, offered as a discovery — is
already on the page. It is framed as a cost-and-tuning affordance ("re-running
with a different `--confidence` costs nothing") rather than as a retention
statement, which is a framing problem, not a gap.

So the real gap is narrower and sharper than 0012 described:

> The docs say **that** content is sent. They never say **what**, **how much**,
> or **what is kept**.

That reframing is why this proposal is mostly about behavior rather than about
a new page. Two of the three missing answers are missing because the behavior
itself is not something you would want to write down: "we send the first 12,000
characters and stop reading your document" is a sentence that should change the
code, not get published.

One part of 0012 did ship, in a narrower form worth recording: `fill --offline`
exists (`cli.ts:670`) and means *never fetch a remote schema*. It does **not**
imply a local provider, which was 0012 § 2's actual request and its stress test
6's decision. `--offline` constrains schema fetching; nothing today constrains
inference.

## Decision

Four changes. Together they make the egress **knowable** and **boundable**.

### 1. Stop truncating. Chunk instead.

Remove `BODY_CHAR_LIMIT` truncation and the `[body truncated]` marker.

The reason truncation exists is that a page can overflow a model's input
context. The reason it is set to a constant is that the overflow point is not
knowable: `@hawkeyexl/inference`'s catalog entries carry `uri`, `sizeBytes`,
`license`, `tier`, and `notes` — and no per-model input context size. The
package's `maxTokens` is an **output** cap (`"maxTokens"` as a stop reason means
the *output* was cut off), not an input budget. Overflow cannot be predicted
from the catalog; it can only be hit.

So docmeta owns a chunk budget rather than borrowing one it cannot see. The old
12,000 becomes the **default chunk size** rather than the point at which the
document stops being read. One call per chunk, with the same candidate list each
time; merge the results by keeping the **highest-confidence proposal per
property**.

Merging on confidence introduces no new concept. Confidence is already the axis
on which a proposal lives or dies — `gate()` (`fill.ts:978-1005`) accepts or
rejects each proposal against `--confidence`, and reports the score by name when
it skips. Choosing between two proposals for the same property on the same
number is the same currency, spent once more.

A provider overflow error halves the budget and retries once. That is a **safety
net for a model with a smaller context than the default assumes**, not the
mechanism — the mechanism is the budget, and a design that relied on the retry
would be a design that discovers its own limits by failing in front of the user.

### 2. Drop `--max-cost-usd`. Add `--max-turns`.

Cost budgeting is the sole reason the priming call exists. With a budget set,
`fill` runs the first call **alone** and makes every other worker wait for it
(`fill.ts:301-320`), because a reservation needs an observed per-call cost and
there is none until one call has finished. The user-visible result is that the
first file is mysteriously slower, for a reason nothing in the output explains.

Removing the flag removes that machinery, and with it the `maxCostUsd` config
key (`config.ts:99`, `:158`, `:540`) and the `budgetExhausted` field
(`fill-types.ts:84`; `fill.ts:281`, `:438`, `:594`).

`--max-turns` replaces it, and it counts **calls, not files**. That is forced by
change 1: once a long page is several calls, a per-file cap stops describing the
work being done.

Breaking change. Major.

### 3. Add `--local`.

`--local` runs inference on this machine and **refuses a hosted provider**, even
when detection would have chosen one.

`--local` means `llama-cpp` only. **`claude-cli` does not qualify.** It is the
one provider where "local" is true of the process and false of the thing that
matters: the binary runs on your machine and the inference does not. The probe
is also weaker than the docs imply — `@hawkeyexl/inference` runs
`claude --version` and accepts exit code 0, checking nothing about
authentication. So `cli.mdx:307`'s "a signed-in `claude` CLI" is wrong twice
over, and change 4 fixes the wording.

This closes the stray-key hole 0012 identified: an unrelated `OPENAI_API_KEY` in
a developer's environment silently redirecting internal documentation to
OpenAI. It closes it **as an opt-in**, without changing what `auto` does by
default.

### 4. Bound the download size instead of quoting it.

`cli.mdx:315` says the local fallback fetches "between 2.6 GB and 6.7 GB, sized
to your machine". Those are the **retired** gemma tiers, and they went stale in
`cebded8`, which moved the dependency `^0.2.0 → ^0.3.0`:

| Alias | Size | Tier |
|---|---|---|
| `granite-4.1-3b-q2` | 1.41 GB | `fast` |
| `qwen3.5-4b` | 2.91 GB | `balanced` |
| `qwen3.5-9b` | 5.97 GB | `quality` |
| `gemma-4-e2b` | 2.62 GB | — (was `fast`) |
| `gemma-4-12b` | 6.72 GB | — (was `quality`) |

The published range is exactly the second pair. It was measured, it was correct,
and it described models nothing selects any more.

Replace it with **"under 10 GB, sized to your machine"**, enforced by a test
asserting every **tiered** catalog entry is under the bound. A precise figure is
what went stale; a bound with a test standing on it does not, because the next
catalog bump either stays inside it or fails a test that says so.

Also fix `cli.mdx:307` per change 3: the probe is `claude --version` exiting 0,
and it checks no authentication.

## Out of scope: making `auto` refuse hosted providers by default

That is the stronger fix, and it is not taken here.

The detection order was a deliberate decision in `2f60978 feat(fill): detect an
inference provider instead of assuming anthropic`, taken so `fill` works with
whatever credentials the user already has. Inverting it is a breaking behavioral
change to a reasoned position, and it deserves its own proposal arguing against
that reasoning rather than a paragraph inside this one.

`--local` gets the same protection for anyone who asks for it.

Stated plainly, because it is the honest summary of this whole document: **this
proposal makes `fill`'s egress knowable and boundable. It does not make it safe
by default.**

## Stress test

### 1. Does merging on confidence let an early guess beat a later fact?

Yes, and it is the sharpest cost of change 1.

Chunk 1 of a long reference page contains the intro; chunk 4 contains the
conclusion that actually settles the `description`. If the model is confidently
wrong about chunk 1 and hedges on chunk 4, the merge keeps the wrong one. Under
today's truncation the model would never have *seen* chunk 4 — so this is not a
regression, but it is not the clean win "we now read the whole document" sounds
like either.

Alternatives weighed and rejected. **Last chunk wins** is worse: it makes the
answer depend on document length rather than on evidence. **Re-ask with all
proposals in context** is a second prompt shape, a second failure mode, and more
egress — the opposite of what this proposal is for.

Kept as a known limit, documented where `--confidence` is documented: a
proposal's confidence is the model's, and across chunks docmeta trusts it to
compare. If that turns out to be wrong in practice the fix is a better merge
rule, not a return to reading a fraction of the file.

### 2. Chunking silently invalidates the cache key — and the key does not know it

`buildCacheKey` (`fill.ts:419-426`) is built from provider, model,
`fill-v${FILL_PROMPT_VERSION}`, the schema set, the candidate keys, and
`sha256(content)` of the **whole file**. Nothing in it mentions chunk size.

So two runs with different chunk budgets produce the same key and different
answers, and the second one silently gets the first one's cached result. The
retry path in change 1 makes this concrete rather than hypothetical: a run that
halved its budget on an overflow writes a cache entry indistinguishable from one
that did not.

The key must therefore carry the chunk budget, and `FILL_PROMPT_VERSION` must be
bumped so existing entries — produced by the truncating prompt — do not survive
the change. Both are one-line changes, and both are the kind of thing that is
free now and a silent wrong-answer bug later.

The cache otherwise stays **keyed per file on the merged result**. Caching per
chunk would key on a substring hash, which is a new content-derived artifact on
disk for no benefit the per-file key does not already give.

### 3. Is "under 10 GB" too loose for someone sizing a CI runner?

Partly, and the gap is worth naming rather than tightening.

For disk provisioning a bound is exactly right — provision 10 GB and no catalog
bump surprises you. For *time* it says nothing: 1.41 GB and 5.97 GB are very
different first-run waits on the same pipe, and the runner picks between them
from detected memory.

But the fix for that is not a tighter number in prose, which is the thing that
just went stale. It is the advice already published one paragraph away: **pin
`--provider` in CI**, and pin the model, at which point the size is a single
known value the operator chose. The bound serves the person provisioning; the
pin serves the person waiting.

One real limit on the bound, found while checking it: `gemma-4-26b-a4b` is
**14.25 GB**, above the bound. It is untiered — nothing selects it unless a
caller names it outright — so the test must assert over *tiered* entries, and
the docs sentence must be about what auto-selection can pick, not about the
catalog. Writing the test over the whole catalog would have failed immediately,
and writing the sentence without that qualifier would have made it false for
anyone who pins that alias by hand.

### 4. Is excluding `claude-cli` from `--local` surprising enough to say in help text?

Yes. It goes in the flag's own help text, not only in the reference page.

The rest of the CLI treats `claude-cli` as the local-ish option — no API key, no
per-token cost, a binary on your `PATH`. Someone reaching for `--local` has
already built the mental model where it counts, and the whole value of the flag
is that it is trustworthy without reading a page first. A flag that quietly
disagrees with the user's model about which providers are local is worse than no
flag, because it is believed.

Short enough to fit: `--local  run inference on this machine (llama-cpp only;
claude-cli is a local binary calling a hosted API)`.

### 5. Does dropping the cost cap leave users with no spend control?

No, but the control changes shape and the docs must say so rather than leave a
hole where a flag was.

`--max-turns` bounds the number of provider calls, which is the thing that
actually scales with a chunked run and the thing a user can reason about before
starting. `--local` costs nothing at all. What is genuinely gone is a cap
denominated in **dollars**, and with it the priming call that made a dollar cap
mean anything.

The trade is deliberate: the dollar cap was approximate (it reserves against an
observed average, so it overshoots), it made the first file slower for an
unexplained reason, and it was the only consumer of a whole concurrency
mechanism. A call cap is exact, needs no priming, and survives a price change.

### 6. Chunking multiplies calls — including for the provider that is free

A page that was one call is now several, on every provider. For hosted providers
that is spend, bounded by change 2. For `llama-cpp` it is wall-clock on the
user's own machine, bounded by nothing.

Accepted rather than mitigated. The alternative is reading part of the document,
which is the defect being fixed. Recorded so a later "why did local fill get
slower" is answered by this line rather than investigated.

## Consequences

- `fill` reads whole documents. A `description` inferred for a long reference
  page can finally reflect its conclusion.
- More calls per file, always. `--max-turns` counts **calls**, not files, and
  that difference is the user-visible face of chunking.
- `--max-cost-usd` and the `fill.maxCostUsd` config key are gone. Breaking,
  major, no deprecated alias (pre-1.0 policy).
- The priming call and `budgetExhausted` go with them; the concurrency path
  loses its only reason to serialize a first call.
- `--local` is a real egress guarantee for inference, distinct from `--offline`,
  which remains a guarantee about schema fetching. Two flags, two boundaries,
  and neither implies the other.
- The published download figure becomes a bound with a test behind it, scoped to
  tiered entries.
- `auto` behaves exactly as it does today. An unrelated `OPENAI_API_KEY` still
  redirects egress unless the user passes `--local`.

## Implementation sketch

1. `test/fill-prompt.test.ts` — assert the current truncation **before**
   changing it, so the chunking test is not the only thing standing on the
   behavior.
2. `src/commands/fill-prompt.ts` — chunk the body; delete `BODY_CHAR_LIMIT`'s
   truncation role and the `[body truncated]` marker; bump
   `FILL_PROMPT_VERSION`.
3. `src/commands/fill.ts` — per-chunk calls, confidence merge, overflow retry at
   half budget; add the chunk budget to `buildCacheKey` (stress test 2).
4. Remove `--max-cost-usd`, `maxCostUsd`, `budgetExhausted`, and the priming
   machinery across `src/cli.ts`, `src/core/config.ts`,
   `src/commands/fill-types.ts`, `src/commands/fill.ts`, `src/reporters/fill.ts`.
   Existing tests for the budget fail correctly and are removed in the red step.
5. Add `--max-turns` and `--local`, with the help text from stress test 4.
6. A test asserting every **tiered** entry in `LLAMA_MODELS` is under 10 GB.
7. `reference/cli.mdx` — what leaves the machine (the first table above), the
   `claude --version` correction at `:307`, the bound at `:315`, the two new
   flags, the removed one. Then `npm run build && npm run docs:check-cli`.
8. `reference/configuration.mdx` — drop `maxCostUsd`.
9. The dogfood check before pushing:
   `node dist/cli.js validate "docs/src/content/docs/**/*.{md,mdx}" -s ./docs/doc-frontmatter.schema.json`
