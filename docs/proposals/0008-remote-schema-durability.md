# 0008: Remote schema durability: vendoring, integrity, offline

- **Status:** Implemented
- **Serves:** Devin · D2 "Govern one schema across many repos"
- **Touches:** `src/core/schema-registry.ts`, `src/core/config.ts`, `src/cli.ts`, new `docmeta schemas vendor`
- **Relates to:** [0009](0009-publish-builtin-schemas.md) (which creates more URL refs to be durable about)

## Problem

D2's whole premise is one canonical schema URL governing many repos. The
implementation makes that a single point of failure with no mitigation.

`schema-registry.ts`:

```ts
const urlCache = new Map<string, Record<string, unknown>>();
const DEFAULT_TIMEOUT_MS = 10_000;
// ...
res = await fetch(ref, { signal: AbortSignal.timeout(timeoutMs) });
```

- **The cache is a `Map`, so it lives and dies with the process.** It correctly
  collapses N files into one fetch, and does nothing across runs.
- **No retry.** One transient failure fails the run.
- **No integrity check.** Whatever the URL serves is the contract.
- **No offline mode.** A network-less environment cannot validate at all.

Consider an org that followed D2's advice. Every CI job in every repo
hard-depends on one host being up within 10 seconds. When it is not, every
pipeline in the org fails simultaneously, with an error about a schema nobody
changed. `Validator.compile` deliberately does not cache failures, because "a
transient fetch failure must not poison the cache". That is right, and it also
means a flaky host produces flaky builds rather than a degraded-but-working
state.

There is precedent for the fix in-repo: `fill` already keeps a disk cache at
`.docmeta/cache` via `JsonCache`, and `.docmeta/` is already in `.gitignore`.

### One part of this is a standalone bug, shippable today

Stress test 3 below identifies a **live false green** that has nothing to do
with caching, vendoring, or TTLs. `loadSchema` checks `res.ok` but never checks
that the fetched JSON is actually a schema. Consider a JSON error envelope
served with HTTP 200, such as `{"error":"not found"}` from an API gateway, a
proxy, or a misconfigured bucket. It compiles as a schema with no constraints,
and therefore **passes every document**.

That guard is one condition and needs none of the rest of this proposal:

```ts
// A schema must constrain something. An object that constrains nothing is far
// more likely to be an error envelope served with HTTP 200 than a real schema.
const KEYS = ["$schema", "$id", "type", "properties", "required",
              "allOf", "anyOf", "oneOf"];
if (!KEYS.some((k) => k in fetched)) throw new DocmetaError(...);
```

It should be fixed in isolation, ahead of and independent of the caching and
vendoring work. It is the difference between a silently-passing gate and a
failing one. Tracked as implementation-sketch item 1.

## Proposal

Three layers, in increasing order of durability. The third is the one that
actually solves D2.

### 1. Disk cache with a TTL

Reuse the existing location and pattern:

```
.docmeta/schema-cache/<sha256(url)>.json
```

Written on a successful fetch, read when fresh. Default TTL 24 h; configurable:

```yaml
schemaCache:
  ttlHours: 24     # 0 disables the disk cache
```

Fixes the local developer loop and any CI that persists the workspace. Does
**nothing** for ephemeral runners (see stress test 1).

### 2. `--offline`

Never touch the network. Serve URL refs from the disk cache. If a ref is not
cached, fail with a `DocmetaError` that names the missing URL. This is what
makes an air-gapped or network-restricted build deterministic. It is also what
[0012](0012-fill-cost-and-privacy.md) needs, to be able to promise a "nothing
leaves this machine" mode across the whole tool.

### 3. Vendoring, the actual answer to D2

```
docmeta schemas vendor <url> [--dir .docmeta/schemas] [--config <path>]
```

Downloads the schema to a **committed** path, records its hash, and rewrites the
config to reference the local copy:

```yaml
schemas:
  - ref: ./schema/house-style.json
    source: https://schemas.example.com/house/2.1.json
    integrity: "sha256-9f8e7d6c…"
```

`schemas:` entries become `string | { ref, source?, integrity? }`. A plain string
keeps working, so this is additive.

Now the consuming repo's contract is a file in its own history. It is reviewable
in a PR, diffable when it changes, immune to the host being down, and pinned by
hash. Updating is `docmeta schemas vendor --update`, which produces a reviewable
diff. That is the same ergonomics as a lockfile.

## Stress test

### 1. A machine-local cache does not help CI (the finding that reorders the proposal)

This is the important one. GitHub-hosted runners start with an empty workspace,
so `.docmeta/schema-cache/` is cold on **every** run. Layer 1 therefore does
nothing for the exact population D2 describes, unless each repo also adds an
`actions/cache` step keyed on something. And a cache keyed on the schema URL
that restores a stale copy is *worse* than fetching, because it silently
validates against an old contract.

So a disk cache is a developer-experience improvement mis-sold as a reliability
one. Vendoring (layer 3) is the reliability fix, because the artifact is in git.
Layer 1 stays in the proposal, ranked honestly.

### 2. Integrity pin vs. an intentionally moving URL, the D2 tension

D2 tells users to "version the URL so consumers pin a stable release", implying
immutable URLs. If a URL is immutable, an integrity pin is nearly redundant. If
it is mutable, as in `…/house/latest.json`, a pin turns every upstream edit into
a hard failure in every repo at once. That is either exactly what you want, with
no silent contract change, or a self-inflicted outage.

The resolution is that `integrity` is **opt-in**, written by `vendor`, because
vendoring implies "I want this exact bytes". A bare URL ref stays unpinned. The
reference page must state the tradeoff rather than recommending one blindly. It
should also note that with vendoring, the mutable-URL case degrades to "your
committed copy is stale". That is visible and safe, instead of "your build
changed meaning overnight".

### 3. Cache poisoning and TTL, where TTL is not a correctness mechanism

A cached-but-wrong schema persists for the whole TTL. That covers a MITM, a bad
deploy briefly serving a wrong file, or a proxy returning an error page with
HTTP 200. TTL expiry eventually heals it, which means "wrong for up to 24
hours". Only the hash pin makes this detectable. That reinforces vendoring over
caching.

The current code also checks `res.ok` but not `content-type`. A captive-portal
or proxy HTML page can parse as nothing at all, so `res.json()` throws and the
error says "Failed to fetch schema". That is acceptable, and an HTML page is not
valid JSON. The real hazard is a JSON error envelope such as `{"error":"not
found"}` served with 200. It compiles as an empty schema and **passes every
document**. That is a false green, and it is worth an explicit check. A fetched
schema must be an object, and must contain at least one of `$schema`, `$id`,
`type`, `properties`, `required`, or `allOf`. Cheap, and it turns a silent pass
into a clear error.

### 4. No retry, so add one narrowly

A single retry with ~500 ms backoff, on network errors and 5xx only. Not on 4xx,
because a 404 will not heal. Not more than one either. The 10 s timeout already
means a hung host costs 10 s, and three retries make it 30 s per URL. Bounded
cost, and it removes the most common flake.

### 5. Does `--offline` interact with built-ins? (no, and that is worth asserting)

Built-ins are bundled JSON imports, and local file refs are `readFile`. Neither
touches the network, so `--offline` only constrains URL refs. Worth a test
asserting `--offline` validates successfully against the default schema set.
That way nobody later "optimizes" a built-in into a URL fetch and breaks
air-gapped users. [0009](0009-publish-builtin-schemas.md) makes this a live
risk, since it introduces https URLs that *alias* built-ins.

### 6. `$schema` inside a document pointing at a URL, the uncontrolled case

Schema resolution precedence puts a file's own `$schema` above config. So a
document can name any URL and trigger a fetch, bypassing `schemas:` entirely and
therefore bypassing vendoring and any integrity pin. In a repo accepting outside
contributions, a PR can add `$schema: https://attacker.example/permissive.json`
and make its own file validate against a schema that requires nothing.

That is a genuine trust issue, not just a durability one, and it is out of scope
here. But it must be recorded. The fix is an allowlist, either
`allowRemoteSchemas: false` or a host allowlist in config, and it deserves its
own proposal.

**Tracked as a future security proposal, with `0015` reserved for it**, so the
cross-reference has somewhere to point before it is written. This matters more
than a normal deferral. `--offline` partially mitigates the hole *by accident*,
and accidental protection is exactly what a later implementer removes while
"simplifying", without knowing it was load-bearing. Whoever implements
`--offline` should add a code comment naming this. Whoever writes 0015 should
remove the comment and replace it with the real guard.

### 7. Where do vendored schemas live? (not under `.docmeta/`)

`.gitignore` already ignores `.docmeta/`, and vendored schemas **must be
committed**. Defaulting `--dir` to `.docmeta/schemas` would put them in an
ignored directory, and the user would discover on the next CI run that the file
is not there. Default to `./schema/`, which is unignored, and make the command
refuse to write into a gitignored path. That is checkable with the same `git
check-ignore` machinery [0006](0006-gitignore-aware-discovery.md) introduces.
Nice reuse, and also a genuine foot-gun if missed.

### 8. Concurrency, verified already correct

`Validator.compile` caches the in-flight **promise**, with a comment explaining
that caching the result made it a check-then-act race under `fill`'s worker
pool. A disk cache must preserve that. The read and write must sit inside the
existing promise-keyed path, not alongside it, or the race returns. Do not
restructure it.

### 9. TTL clock skew and "fresh", where mtime beats an embedded timestamp

An embedded `fetchedAt` in the cache file can disagree with the filesystem after a
clock change or a restored cache. `mtime` is what `actions/cache` and rsync
preserve, and it cannot be forged by a stale cache entry. Minor, but it is the
kind of detail that produces a cache that never expires.

## Implementation sketch

1. In `test/schema-registry.test.ts`, fetched non-schema JSON (`{"error":"…"}`)
   is rejected rather than compiled as permissive. Red first, because this is a
   live false green today.
2. In `test/schema-registry.test.ts`, the disk cache is written on success, read
   when fresh, and bypassed when stale (mtime-based), and `ttlHours: 0` disables
   it.
3. In `test/schema-registry.test.ts`, one retry on 5xx and on network error and
   none on 404, asserting the request count via `test/helpers/schema-server.ts`.
4. In `test/cli.integration.test.ts`, `--offline` with a cold cache fails naming
   the URL, and `--offline` against the default built-in set succeeds.
5. In `test/config.test.ts`, `schemas:` accepts both a string and `{ ref,
   source, integrity }`, and a bad `integrity` fails with a clear message.
6. In `test/commands.test.ts`, `schemas vendor` writes the file, records the
   hash, rewrites config, and **refuses** a gitignored target directory.
7. For docs, `reference/schema-resolution.mdx` (cache, offline, integrity),
   `reference/cli.mdx` (`--offline` and `schemas vendor`, which `docs:check-cli`
   enforces), `reference/configuration.mdx` (`schemaCache`, object form of
   `schemas`), and `ci/govern-shared-schema.mdx`, which should be rewritten to
   lead with vendoring rather than a bare URL.

## What shipped, and what changed on the way

Delivered in three PRs. First the payload guard, size cap, in-flight dedup and
timeout-message fix. Then the cross-run cache and `--offline`. Then vendoring,
integrity pins, and `docmeta schemas vendor`.

Design changes, each against the stress test that produced it:

- **§7 (where vendored schemas live) was followed, and enforced rather than
  documented.** `--dir` defaults to `./schema`, and the command asks `git
  check-ignore` about the target *before* it downloads anything, exiting 2
  without writing. Two spellings are checked, the file and its directory. A
  directory-only pattern such as `vendor/` does not match the bare path while
  the directory does not yet exist. So git can only answer for the file
  underneath it. Where git cannot answer at all, with no repository or no `git`
  on `PATH`, the command proceeds and says so. Refusing every non-repository
  would make it unusable in an extracted tarball.

- **§2 (integrity vs. a moving URL) was resolved as proposed, and narrowed.**
  `integrity` is opt-in and written by `vendor`. It is now also **rejected on a
  built-in id or a URL**, at config-parse time and again in `loadSchema`. A
  built-in has no bytes on disk. A URL may legitimately be served from the
  schema cache, which stores the parsed schema rather than what the server sent.
  Either would have been a pin nothing could ever verify, and a config that
  reads as pinned and is not.

- **One algorithm, one encoding.** `sha256-<64 hex characters>` and nothing
  else. Every additional accepted form is another state the mismatch message
  has to be right about, and docmeta writes these strings itself.

- **A line-ending diagnosis, not anticipated by any stress test.** A vendored
  schema is committed. So `core.autocrlf`, or a `*.json text` attribute, can
  hand a checkout different bytes from the ones that were downloaded. That is a
  mismatch on a file nobody edited. It is reported as "the contents differ only
  in line endings", with a `.gitattributes` remedy, and checked in both
  directions. The pin survives, but the bytes it was taken from do not.

- **`resolveSchemaSet` still returns `string[]`.** The ref string is what every
  report, every baseline fingerprint, and `Validator`'s compile cache key are
  made of. `{source, integrity}` travels in a separate ref→pin map built from
  the *rebased* config, so both sides spell a local path identically.

- **`asSchemaList` is a separate parser.** `asStringList` also validates
  `paths`, `exclude`, and `overrides[].schemas`, so widening it in place would
  have widened all four. An unknown key in the mapping form is rejected rather
  than ignored. A typo'd `intergrity:` is the one failure here that is silent by
  default.

- **The CLI drift check learned to recurse.** `scripts/check-cli-reference.mjs`
  walked `program.commands` only and its doc-heading regex rejected a space, so
  a subcommand was unverified in both directions at once. Both fixed;
  `-f, --format` deliberately stays on the parent `schemas`, and bare `docmeta
  schemas` remains a default action rather than group help.

Out of scope and still open: **§6**, a document's own `$schema` naming an
arbitrary URL and bypassing `schemas:` entirely. `--offline` mitigates it by
accident; the code comment saying so is in `LoadSchemaOptions.offline` and
should be removed by whoever writes 0015.
