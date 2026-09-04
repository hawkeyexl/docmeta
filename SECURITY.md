# Security policy

docmeta runs inside other people's CI pipelines and fetches JSON Schemas over
the network. Both of those make it worth reporting problems properly rather
than publicly.

## Supported versions

| Version | Supported |
|---------|-----------|
| 4.x | Yes |
| < 4.0 | No |

Fixes land on the current `4.x` line and ship as an ordinary release. There are
no backports to older majors.

## Reporting a vulnerability

**Use GitHub private vulnerability reporting**, not a public issue:

> [Security tab → Report a vulnerability](https://github.com/hawkeyexl/docmeta/security/advisories/new)

A public issue about a CI tool is a disclosure to everyone already running it.
It lands days or weeks before there is a version to upgrade to. Private
reporting gives the same thread, the same maintainer, and a fix first.

If GitHub's private reporting is unavailable to you, email
**manuel.r.b.silva@gmail.com** with the same detail.

A useful report includes the docmeta version, the command, a schema or document
that reproduces it, and what an attacker gets out of it. A reproduction against
a supported version is what turns a report into a fix.

### What to expect

docmeta is maintained by one person, so these are real numbers rather than
aspirational ones:

- **Acknowledgement** within 5 business days.
- **An assessment** within 10 business days: whether it is in scope, and a rough
  severity.
- **A fix**, for anything confirmed, released as soon as it is ready, with a
  published advisory naming the affected versions.

Please hold off on public disclosure until the fixed release is out. You will
be credited in the advisory unless you would rather not be.

## Trust boundaries

docmeta touches two things it did not write. Both have been reasoned about in
the open, and the reasoning is worth reading before filing. It will tell you
whether you have found a bug or a documented decision.

### Remote and document-supplied schemas

A document's own `$schema` can name a built-in id, a path, or a URL. It sits
*above* config in the resolution chain. So on a repo that accepts outside pull
requests, one line of frontmatter can otherwise choose the contract that
document is judged against. That is what the `schemaTrust:` config key exists to
close. See [proposal 0015](docs/proposals/0015-schema-trust-boundary.md) and
[the configuration
reference](https://hawkeyexl.github.io/docmeta/reference/configuration/#schema-trust).

The following are **known and accepted**, documented where the key is
documented, and not vulnerabilities:

- `schemaTrust.hosts` is defeated by a redirect. `fetch` follows redirects
  without re-checking the host. An allowlist is a convenience for a known-good
  publisher; `documentRefs: local` is the actual boundary for a repo that
  distrusts its contributors.
- There is no private-range or link-local IP blocking. The test suite and
  ordinary local development both fetch schemas from `127.0.0.1`, and a
  blocklist would break both while `hosts:` already covers the case.
- An older docmeta ignores `schemaTrust:` and fails open. That is inherent to
  shipping any new guard; the mitigation is a version floor in CI.

The following **are** in scope:

- Any way past `documentRefs: local` or `documentRefs: none`.
- A document-supplied local path escaping the containment root.
- Ajv resolving a remote `$ref` from inside a fetched schema. A remote `$ref` is
  asserted to be a hard `MissingRefError`, and the whole resolver chokepoint
  design rests on that.
- Getting past the 10 s fetch timeout or the 5 MB response cap into resource
  exhaustion.
- An integrity pin verifying bytes it should not.

### What `docmeta fill` sends

`fill` sends document content to an LLM provider. **That** it does so is
documented, intended, and not a report. [Proposal
0017](docs/proposals/0017-fill-egress-and-bounds.md) and the [`fill`
reference](https://hawkeyexl.github.io/docmeta/reference/cli/#fill) enumerate
exactly what leaves the machine. That includes the file path and the full
`$defs` of every resolved schema. They also cover what the on-disk cache
retains, which is the proposal set *before* confidence gating.

Note that provider auto-detection is deliberately permissive: a stray
`OPENAI_API_KEY` in the environment redirects egress, by design. `--local`
is the opt-in that refuses every hosted provider.

In scope here:

- Content leaving the machine despite `--local`.
- A remote schema being fetched despite `--offline`.
- The cache writing outside its documented location, or provider credentials
  appearing in output, in the cache, or in an error message.

### Generally out of scope

- The contents of a schema you chose to point docmeta at. docmeta validates
  against what you give it.
- A permissive schema passing every document. That is what `schemaTrust:` is
  for.
- Scanner output with no working reproduction against a supported version.

## Hardening a CI setup

The controls exist; they are opt-in because the defaults have to keep working
for a solo author on a private repo. If your repo takes outside contributions:

- Set `schemaTrust: { documentRefs: local }` so a contributed document cannot
  choose its own contract.
- Vendor your schemas (`docmeta schemas vendor <url>`) and keep the integrity
  pin, so CI validates against a copy in your own history.
- Pin the action to a released tag, and pin a docmeta version floor so a new
  guard is actually present.
- For `fill`, pin `--provider` or pass `--local`. Left to detect, a runner that
  loses its key falls back to a local model rather than failing.

Never pass a credential as a docmeta flag. `fill` reads provider credentials
from the environment, which keeps them out of your shell history and out of CI
logs.
