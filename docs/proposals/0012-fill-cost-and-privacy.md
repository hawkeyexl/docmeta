# 0012 — `fill`: what it transmits, what it costs, how to run it offline

- **Status:** Proposed
- **Serves:** Maya · M4 (per [0011](0011-fill-in-content-strategy.md)), Devin · D1
- **Touches:** new `docs/src/content/docs/set-up/fill-providers.mdx`, `src/commands/fill.ts` (one flag), `reference/cli.mdx`
- **Relates to:** [0008](0008-remote-schema-durability.md) (`--offline` should mean one thing tool-wide)

## Problem

`docmeta fill` sends document content to a third-party API, and **no page in the
docs says so.** Searching the published docs for any statement about what is
transmitted returns nothing:

```console
$ grep -rn "12,000\|12000\|body truncated\|transmit\|sent to\|privacy\|air-gap" docs/src/content/docs/
docs/src/content/docs/ci/consume-results.mdx:75:<Aside … title="line and col are optional; col is absent today">
```

The one hit is unrelated. The cache *location* is documented
(`reference/cli.mdx:242`, plus `--no-cache`), but not what is in it or where the
data went first.

What is actually transmitted, per `src/commands/fill-prompt.ts` and
`src/commands/fill.ts`:

| Item | Detail |
|---|---|
| Document body | Up to `BODY_CHAR_LIMIT = 12000` characters, then truncated with a `[body truncated]` marker |
| Existing metadata | The full extracted metadata block |
| File path | `filePath` is interpolated into the user prompt |
| Schema fragments | Each candidate property's own subschema, lifted verbatim from the user's schema, including its `description` |

Stored on disk afterwards: the raw pre-gating proposals, in `.docmeta/cache`, keyed
on `sha256(content)` plus provider, model, prompt version, schema set, and candidate
keys.

This matters because of how the provider is chosen. `DEFAULT_PROVIDER = "auto"`
detects, in order: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, a signed-in `claude` CLI,
then a local model. The README already warns about the CI consequence — a runner
that loses its key silently falls back to downloading a local model instead of
failing — but the reverse is the compliance question: **on a developer's laptop with
an unrelated `OPENAI_API_KEY` in the environment, `docmeta fill` will send internal
documentation to OpenAI, and nothing in the docs told them that would happen.**

For a docs team at a company with a data-egress policy, that is a gating question
with no answer on the site. It is also the question that decides whether `fill` — the
feature that makes M4 viable — can be used at all.

## Proposal

### 1. A page: "Choosing a `fill` provider"

In `set-up/`, adjacent to `retrofit.mdx`, which links to it from Step 6. Prose only,
no flag tables — `reference/cli.mdx` is the drift-checked file and must stay the
single home for the flag surface ([0011](0011-fill-in-content-strategy.md) § stress
test 3).

Sections:

- **What leaves your machine, exactly** — the table above, verbatim, with the 12,000
  character limit named and the file path called out. No hedging.
- **What is stored locally** — `.docmeta/cache`, pre-gating proposals, `sha256`
  content keys, gitignored, safe to delete, `--no-cache` to skip.
- **The detection order, and why it can surprise you** — the four-step order, with
  the "unrelated `OPENAI_API_KEY`" scenario stated as the worked example.
- **Pinning a provider, and why CI should always pin** — `--provider`, and the
  README's silent-local-fallback warning promoted from a README aside to a
  first-class recipe.
- **Running with nothing leaving the machine** — `--provider llama-cpp`, what it
  downloads, when, and how large; plus `--offline`.
- **Cost** — how `--max-cost-usd` behaves, including the priming call.

### 2. `fill --offline`

`--provider llama-cpp` keeps *inference* local but does not make the run
network-free: a URL schema ref still fetches. Make `--offline` mean the same thing
across the tool as it does in [0008](0008-remote-schema-durability.md) — no network
for any reason — and on `fill` additionally imply a local provider, failing if one
is not available rather than reaching for a hosted API.

One concept, one flag, tool-wide. Without this, "run docmeta with no egress" needs
two flags and a caveat, and the caveat is the part users miss.

## Stress test

### 1. Is the local model *actually* zero-egress? — needs verifying before claiming it

The page will say "nothing leaves your machine". That is only true after the model
weights are already present; the first run **downloads a multi-gigabyte model** from
a model host. So the honest claim is "no document content leaves your machine, and
the model is fetched once from <host>".

The docs must name the host and the approximate size, because "offline mode
downloaded 2 GB from an unexpected domain" is exactly the surprise that gets a tool
banned in a regulated environment. Numbers must be measured, not estimated, and
re-checked whenever the catalog alias changes (it already has twice: `23349e5`,
`cebded8`).

### 2. Does the cache leak content into a shared location? — verified no, with one caveat

`CACHE_DIR = ".docmeta/cache"` is joined to `cwd`, so it is per-project, and
`.gitignore` already lists `.docmeta/`. Verified. The caveat: the cache holds
**pre-gating** proposals, i.e. model output that was rejected for low confidence or
for failing the schema. A user who assumes "only accepted values were kept" is
wrong. Worth stating, because someone will grep the cache while debugging and be
surprised by rejected values.

### 3. Is `sha256(content)` in the cache key a privacy problem? — no, and say why

A hash of the document is not the document. But the cache *value* contains proposals
derived from content, so the cache is content-adjacent regardless. The honest
framing: the cache is as sensitive as the documents, is local and gitignored, and
`--no-cache` avoids writing it. Do not oversell the hash as anonymisation.

### 4. Truncation at 12,000 characters is a quality claim, not just a privacy one

Documenting the limit answers "why did fill do badly on my long page?" — a
frequently-asked question the docs currently cannot answer. Worth putting in the
same place as the privacy statement, because it is the same fact viewed from the
other side. Also note the truncation is character-based, so a long page's later
sections are never seen, which is why a `description` inferred for a long reference
page may miss its own conclusion.

### 5. Should provider detection require opt-in instead? — considered, rejected here

The strongest privacy fix is not documentation: make `auto` refuse to use a hosted
provider unless explicitly allowed, so an incidental `OPENAI_API_KEY` cannot cause
egress. That would be a **breaking behavioral change** to a feature whose detection
order was a deliberate, recent decision (`2f60978 feat(fill): detect an inference
provider instead of assuming anthropic`) taken so that `fill` works with whatever
credentials the user has.

Out of scope for a docs proposal, and it deserves its own. Recording the argument
because it is the real fix and this proposal is the mitigation: documentation makes
the behavior *knowable*; it does not make it *safe by default*. If the maintainer
wants safe-by-default, that is a separate accepted trade against the 2f60978
rationale.

### 6. `--offline` implying a local provider — a scope wrinkle worth naming

On `validate`, `--offline` is purely a network constraint. On `fill` it would also
select a provider, which is more than "no network" literally says. The alternative —
`--offline` errors when the detected provider is hosted, and the user must also pass
`--provider llama-cpp` — is more explicit but makes the common case two flags.

Decision: imply it, and print what was chosen (`llama-cpp/granite-4.1-3b-q2`), which
`fill` already does in its report footer. An implied choice that announces itself is
not a hidden one.

### 7. Does this page duplicate `reference/cli.mdx` §fill? — bounded by the split

`cli.mdx` already documents `--provider`, `--model`, `--max-cost-usd`, `--no-cache`,
and the confidence gate. This page must not restate the flag table (stress test 3 in
0011). The division: `cli.mdx` says *what the flags do*; this page says *what the
consequences are and how to decide*. The IA's own rule already states it — "journey
pages explain the path and link into reference for exhaustive detail".

### 8. Where does the priming call belong in a cost explanation? — it is load-bearing

`fill.ts` runs the first call **alone** when `maxCostUsd` is set, because otherwise
the first `concurrency` files all check a budget that is still `$0` and the limit is
meaningless. That is a real, user-visible behavior (the first file is slower) with a
non-obvious cause. It belongs in the cost section, because someone will otherwise
report it as a bug.

### 9. Is a dogfood risk introduced? — yes, and it is the usual one

This page will contain a `description:` with a colon-space if written carelessly
(e.g. `description: fill: what leaves your machine`), which `CLAUDE.md` flags as an
invalid-YAML trap that breaks the deploy gate. Quote it. Mechanical, and it is the
documented way this repo breaks its own docs build.

## Implementation sketch

Docs-first, with one code change:

1. Measure the local-model download: host, size, and when it is fetched. Record the
   numbers in the page. **Do not write the page before measuring** — stress test 1
   turns on real figures.
2. Write `set-up/fill-providers.mdx` with `title` and `description` frontmatter
   (quoted — stress test 9).
3. Link it from `retrofit.mdx` Step 6 and from `reference/cli.mdx` §fill.
4. `test/cli.integration.test.ts` — `fill --offline` selects a local provider and
   makes no network call; fails clearly when no local model is available.
5. `test/cli.integration.test.ts` — `validate --offline` and `fill --offline` share
   the flag name and the no-network guarantee ([0008](0008-remote-schema-durability.md)).
6. `reference/cli.mdx` for `--offline` on both commands, then
   `npm run build && npm run docs:check-cli`.
7. Run the dogfood check before pushing:
   `node dist/cli.js validate "docs/src/content/docs/**/*.{md,mdx}" -s ./docs/doc-frontmatter.schema.json`
