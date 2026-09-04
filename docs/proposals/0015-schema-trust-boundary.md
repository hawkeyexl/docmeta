# 0015: A trust boundary for document-supplied schemas

- **Status:** Implemented
- **Serves:** Devin · D2 "Govern one schema across many repos"; Sara · S3
- **Touches:** `src/core/resolve-schema.ts`, `src/core/config.ts`, `src/core/schema-registry.ts`
- **Reserved by:** [0008 § stress test 6](0008-remote-schema-durability.md), which
  deferred this and left a load-bearing note at `src/core/schema-registry.ts`
- **Blocks:** [0009](0009-publish-builtin-schemas.md), which publishes https URLs
  aliasing built-ins and normalizes the pattern this constrains

## Problem

A document's own `$schema` may name a built-in id, a local path, or a remote
URI. **That is the feature**, it is documented, and this proposal does not take
any of it away.

What is missing is a way for a repo that accepts **untrusted contributions** to
say: documents here do not get to choose their own contract.

Schema resolution puts a file's `$schema` *above* config, at `resolve-schema.ts`
precedence step 2 of 5. So one line of frontmatter in a pull request selects the
schema that file is judged against. Reproduced against 3.10.0, with a local
stand-in for an attacker-controlled host serving `{"type":"object"}`, which is a
schema that constrains nothing:

```console
$ cat docmeta.config.yaml
schemas:
  - google:okf:0.1

$ cat contributed.md
---
title: Contributed page
$schema: http://127.0.0.1:62467/permissive.json
---

$ docmeta validate "*.md"
✓ contributed.md
✗ honest.md
    (root)  must have required property 'type'  (line 1)  [google:okf:0.1]

2 files checked, 1 passed, 1 failed
```

The contributor who **opts out** of the standard is the one who passes. The
honest document, playing by the config's rules, is the one that fails. It also
bypasses `schemas:`, vendoring, and integrity pins in one move. Every durability
control 0008 added sits below `$schema` in the precedence chain.

For a solo author or a trusted team this is exactly right and must keep working.
For a public docs repo it inverts the gate.

### Two smaller holes with the same root cause

A document-supplied ref is trusted exactly as much as an operator-supplied one.
That shows up twice more, and neither fix costs anyone a feature.

**Path traversal.** A local `$schema` is `resolve`d and read with no
containment:

```
$schema: ../../../../../../etc/passwd
```

"A local path" reasonably means *a schema in this project*, not any file the CI
process can open.

**Content echo.** The parse failure quotes the file back. Confirmed on Node 24:

```
docmeta: Schema file "…" is not valid JSON:
  Unexpected token 'r', "root:x:0:0"... is not valid JSON
```

Node embeds a content prefix in `JSON.parse`'s message, and `schema-registry.ts`
interpolates that message verbatim. The excerpt reaches stderr **and** the
`json` and `sarif` reports, which the formats workflow uploads to code scanning.
So it is readable by whoever opened the pull request. That is roughly ten bytes
of an arbitrary readable file per run, repeatable with a different path each
time.

## Proposal

Additive. **The default behavior of every existing setup is unchanged.**

### 1. `schemaTrust:`, a new config key

```yaml
schemaTrust:
  documentRefs: any          # default — today's behavior, all three kinds
  # documentRefs: local      # built-in ids and in-repo files; no URLs
  # documentRefs: none       # config decides; a document's $schema is ignored
  hosts:                     # only consulted when documentRefs is `any`
    - schemas.example.com
```

`hosts:` present means a document-supplied URL must match one of them; absent
means any host, as today.

**Config- and CLI-supplied refs are never filtered.** An operator wrote those,
and `-s ./x.json` is a person at a keyboard, not an attack surface. The key
constrains one thing: refs that arrive from inside a document.

### 2. Enforce in `resolveSchemaSet`, not in `loadSchema`

`resolveSchemaSet` is the last place that knows **where a ref came from**. It
takes `fileSchema`, `cliSchemas`, and `config` as separate parameters, and
flattens them into an anonymous `string[]`. By the time `loadSchema` sees a ref
it is just a string, and no provenance survives.

Guarding in the resolver means no provenance plumbing through
`LoadSchemaOptions`, and no need to sit ahead of the `urlCache` short-circuit.
It also means the refusal is already handled well. `runValidate` and `runFill`
both catch a throw from `resolveSchemaSet`, and turn it into a per-file
`keyword: "schema"` finding. So a refused document is **one failing file**, at
exit 1, rather than an aborted run. And in `github` or `sarif` output the
annotation lands on the offending document in the pull request.

### 3. Contain a document-supplied local path

A document ref resolving outside the **repository root** is refused. The git
root rather than the config directory, so a monorepo referencing
`../shared/x.json` keeps working. With no git root, fall back to the config
directory and say so in the message.

Config- and CLI-supplied paths are untouched.

### 4. Stop echoing file bytes on a parse failure

Keep the position information, drop the quoted excerpt, for a **file** ref.

This deliberately does not touch the *remote response* excerpt. `73c625f` put
that in front of the operator on purpose. A response body from a URL the
operator configured is not the same as bytes off their disk.

## Stress test

### 1. `hosts:` is bypassable by a redirect, so say so rather than implying otherwise

`fetch` follows redirects by default with no re-check, so an allowlisted host
that answers `302 https://attacker.example/permissive.json` defeats the list.
Closing it means `redirect: "manual"` and re-checking each hop, which is a
larger change to the fetch path than this proposal wants to make.

Recorded as a **known limit of `hosts:`**, documented where the key is
documented. `documentRefs: local` has no such hole, which is the honest advice
for a repo that actually distrusts its contributors. An allowlist is a
convenience for a known-good publisher, not a security boundary.

### 2. `documentRefs: local` must not break the self-describing document

`test/fixtures/schema-ref.md` carries `$schema: google:okf:0.1`, which is a
built-in id. Under `local` it must keep passing, and under `none` it must fall
through to config. If `local` broke built-ins it would break the documented
"self-describing document" pattern for everyone who adopted it. That is a much
larger blast radius than the hole being closed.

### 3. An older docmeta ignores the key and fails open, and cannot be fixed here

`parseConfig` walks a fixed list of known keys and silently drops the rest;
there is no top-level unknown-key rejection. So a repo that sets
`schemaTrust:` and then runs an older binary gets **no guard and no warning**.

That is inherent to shipping any new guard, because an old version predates it.
No amount of care in this proposal changes it. The mitigation is a version floor
in CI, as `npx docmeta@^3.11`. The reference page should say so plainly, rather
than leaving the operator to assume the key is load-bearing everywhere.

One point is worth noting separately. Adding top-level unknown-key rejection
would turn a *misspelled* `schemaTrust:` from a silent no-op into an error. That
is a real improvement, and a breaking change for anyone with a stray key. So it
belongs in [0013](0013-cleanup-dead-code-and-exit-codes.md), not here.

### 4. The same URL from two sources, and why the pin sidecar was not reused

`SchemaPin` travels beside the ref in a `ReadonlyMap<string, SchemaPin>` keyed
on the ref string. That pattern was the obvious candidate for carrying
provenance too. It does not work. A map keyed on the ref cannot distinguish the
same URL arriving from config *and* from a document in one run. The case is not
hypothetical. A repo that vendors `https://…/house/2.1.json` and also has a
document naming it directly would get one entry for two meanings.

Guarding in the resolver avoids the question entirely, because the branch that
produced the ref is still on the stack.

### 5. `--schema` is not a trust boundary

Tempting to filter it for symmetry. Wrong: `--schema` is typed by whoever runs
the command, and a person who can pass a flag can also edit the config. Treating
it as untrusted would add friction with no attacker removed. It stays unfiltered
in every mode, and a test pins that so a later "consistency" pass does not
quietly change it.

### 6. Ajv cannot widen the blast radius, verified

If Ajv resolved a `$ref` inside a fetched schema to a remote URL, a guard at
docmeta's own loader would be insufficient. An allowlisted schema could then
pull in anything. It does not. The Ajv instances are constructed with
`{allErrors: true, strict: false}` and nothing else. `loadSchema` is not wired
into Ajv's own `loadSchema` option, and `compileAsync` is never called. A remote
`$ref` is a hard `MissingRefError` at compile time. Verified against the pinned
Ajv 8.20.0.

So the resolver really is a sufficient chokepoint. This is the assertion most
worth a regression test, because it is the assumption the whole design rests on.

### 7. No IP or private-range blocking

Blocking link-local and private ranges would stop `http://169.254.169.254/`, the
cloud metadata address, and is a tempting addition. It is also wrong here. The
test suite and ordinary local development both fetch schemas from `127.0.0.1`. A
blocklist would break both, while an allowlist already covers the case.

Stated explicitly so nobody adds one later believing it was an oversight.

### 8. `documentRefs: none` still reports the ignored ref

Silently discarding a document's `$schema` would leave an author wondering why
their schema is not being applied. Under `none`, the ref is ignored **and** a
notice says so. Ignoring input without saying so is the failure mode this whole
proposal set exists to remove.

## Implementation sketch

1. In `test/commands.test.ts`, reproduce the pass-by-opting-out from the Problem
   section **before** any guard exists, along with the traversal excerpt. A test
   that asserts only the new refusal would pass against code that never had the
   bug.
2. In `src/core/config.ts`, `schemaTrust` parsing. It mirrors
   `parseSchemaCache`'s nested-mapping shape, and rejects unknown keys inside
   the mapping the way the `schemas:` entry parser does.
3. In `src/core/resolve-schema.ts`, the guard, in the `fileSchema` branch.
4. In `src/core/schema-registry.ts`, drop the excerpt for a file ref. **Delete**
   the 0015 note in `LoadSchemaOptions.offline`, and point at the real guard.
5. In `test/resolve-schema.test.ts`, per mode and per ref kind. `--schema` and
   config refs stay unfiltered in every mode, and a built-in `$schema` passes
   under `local`.
6. In `test/cli.integration.test.ts`, the Problem reproduction end to end with
   `documentRefs: local`, now failing the contributed file.
7. For docs, `reference/configuration.mdx` (the key, the version floor, the
   redirect limit) and `reference/schema-resolution.mdx` (what a document may
   reference and how a repo constrains it). Also `ci/govern-shared-schema.mdx`,
   which is the D2 page, and the natural home for "your repo takes outside pull
   requests".

## What shipped

Four commits, one per numbered part above, each landing red-first.

| Part | Where |
|---|---|
| `schemaTrust:` parsing | `src/core/config.ts`, in `parseSchemaTrust`, shaped after `parseSchemaCache` |
| The guard | `src/core/resolve-schema.ts`, in `assertDocumentRefAllowed`, in the `fileSchema` branch |
| Containment | same function; the boundary comes from `schemaTrustRoot` in `config.ts`, reusing `findGitRoot` |
| The excerpt | `src/core/schema-registry.ts`, in `withoutFileExcerpt`, file branch only |

Two decisions differ from a literal reading of the text above, and both come
out of the stress test rather than around it:

**Containment applies in `any`, not only in `local`**, per stress test §"Two
smaller holes". The traversal fix "costs nobody a feature". Making a repo opt
into it would have left the hole open in every default setup, which is every
setup. `$schema: ../../../../etc/passwd` is refused with no config at all.
`schemas:` and `--schema` are untouched, so an operator's schema kept beside the
project still resolves.

**The containment root is a parameter, not something the resolver discovers.**
`resolveSchemaSet` is synchronous and pure, and runs once per file. Finding a
git root is a filesystem walk. So `ResolveParams.trustRoot` is settled once per
run by `runValidate` and `runFill`, and omitting it skips containment. That is a
real precondition rather than a hidden default. It is documented on the field,
and pinned end to end in `test/commands.test.ts`. A unit test alone could not
tell a wired core from an unwired one.

Everything else landed as written. Three stress tests each have a test standing
on them. Those are 5, `--schema` unfiltered in every mode; 2, a built-in
`$schema` passing under `local`; and 6, Ajv raising `MissingRefError` rather
than chasing a remote `$ref`. Stress tests 1 and 3 are the redirect limit of
`hosts:` and the version floor. Both are documented at
`reference/configuration.mdx#schema-trust`, which is what they asked for.

The note this proposal was reserved by, in `LoadSchemaOptions.offline`, is
gone: `offline` is a durability control again, and the comment points at the
real guard.
