# 0019 — `docmeta init` is rejected, not deferred

- **Status:** Accepted
- **Supersedes:** the `init` half of [0010](0010-init-and-schema-inference.md). Its `schemas infer` half shipped and stands.
- **Serves:** Maya · M1
- **Touches:** nothing. That is the point.

## Decision

There will be no `docmeta init`. 0010 deferred it and left the question open;
this closes it, so nobody re-derives the same four hazards from scratch.

## Why the deferral became a rejection

0010 made the case already, and nothing since has moved it:

> four hazards, each with a failure mode measured in confused hours, for a saving
> measured in seconds of typing

The hazards are unchanged — refusing to overwrite an existing config, warning
about an ancestor config that [0004](0004-config-upward-discovery.md)'s upward
walk would let a new one silently shadow, sequencing detection so it never writes
a config that [0014](0014-empty-input-is-not-success.md) then makes exit 2, and
choosing among several plausible `paths:` candidates without guessing quietly.

Two things have changed, and both weaken `init` further rather than strengthening
it:

**`schemas infer` shipped, and took the half that had the asymmetry.** The
question nothing else in docmeta could answer was "what metadata do we actually
have?". That now has a command. What `init` would have saved was never the
knowing; it was the typing.

**The onboarding path is documented and starts with a real command.**
`set-up/retrofit.mdx` opens with *Take a coverage reading* (`schemas infer`),
then *Start with a permissive schema*. A reader following it reaches a working
config without ever wanting `init`, and the config it hands them is
copy-pasteable in full.

## What would reopen it

Not "someone asks for it" — a config that is genuinely hard to write by hand.
Today's is four lines. If `paths:`, `schemas:` and `overrides:` grow to the point
where a correct starting config is not obvious from the reference page, the
saving stops being seconds and the trade changes.

0010's stress test 10 still binds if that day comes: `init` must not also infer a
schema, or it writes a config plus a schema ratifying the current state in one
step — which is 0010's stress test 1 failure, automated.

## Consequences

- `docs/proposals/README.md` no longer lists `init` as actionable.
- 0010 keeps its text and its reasoning; only its `Status:` line points here.
- The gap `init` was meant to fill is served by `schemas infer` plus a
  copy-pasteable config, and the retrofit page is where that path lives.
