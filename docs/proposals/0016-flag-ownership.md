# 0016: Which command owns a flag, and where it may be written

- **Status:** Accepted
- **Serves:** Every persona; it is the rule behind
  `CONTRIBUTING.md § Keeping commands consistent`
- **Touches:** `src/cli.ts` (the rule's one implementation), any future subcommand
- **Prompted by:** Two real defects found while shipping
  [0010](0010-init-and-schema-inference.md)

## Problem

docmeta has one command group with subcommands (`schemas` → `vendor`, `infer`),
and a program level above both. A long flag can therefore be declared in more
than one place. Unless told otherwise, **commander binds a parent's option
wherever it appears in the argv**. So the meaning of a flag depends on where it
was written, and on which command happened to declare it. Neither is visible to
the person typing it.

Two defects, both found in the same week, both silent:

**`schemas infer <path> -f json` printed the pretty report and exited 0.** The
parent's `-f` swallowed it. A request docmeta can honor, served in a format
nobody asked for, with a success code. That is the same false-green shape as
`schemas -f github` being accepted and ignored before it was fixed.

**`schemas vendor <url> -f nonsense` is accepted and ignored.** `vendor` declares
no `-f` at all, so the value binds to the parent's, and nothing ever reads it. A
typo'd flag on a command that has no such flag exits 0.

Both come from one root cause, and it is not a bug in either command.

## The behavior, measured

Against a minimal commander program reproducing docmeta's shape:

| argv | default | `enablePositionalOptions()` |
|---|---|---|
| `schemas infer x -f json` | `fmt=pretty`, **wrong** | `fmt=json`, right |
| `validate docs/ --no-color` | works | **`error: unknown option '--no-color'`** |

That is the whole trade, and it is why the obvious fix is not the fix.

## Options considered

### A. `enablePositionalOptions()` (rejected, and the reason is structural)

It resolves ownership correctly, in that an option after a subcommand name
belongs to that subcommand. It also requires every parent option to *precede*
the subcommand, which breaks `docmeta validate docs/ --no-color`.

That is not an edge case here. `CONTRIBUTING.md` makes **paths positional on
every command**, so "flag written after a positional" is the ordinary shape of a
docmeta invocation, not an unusual one. Trading a common correct invocation for
an uncommon ambiguous one is the wrong direction.

### B. Never share a long name between a parent and its child (rejected)

Move the listing behavior to `schemas list -f` and leave `schemas` as pure group
help, so only one command declares `-f`.

Rejected because bare `docmeta schemas` is a **documented default action**, not
group help. [0005](0005-command-parity.md) decided that explicitly, the
reference page documents it, and integration tests depend on it. Removing the
default action to fix a flag-binding problem is a user-visible regression in
service of an implementation detail.

Worth keeping in view for *new* subcommands, though: not sharing a name is free
before the name exists, and expensive after.

### C. Explicit-source precedence (accepted)

Both commands may declare the flag. At read time, ask commander which one was
actually *typed*, and prefer that one. `getOptionValueSource(name)` returns
`"cli"` for a value the user supplied, and `"default"` for one commander filled
in.

This makes a flag mean what the command that declares it says, **wherever it is
written**, which is the property the two defects were missing.

## Decision

**A flag means what the declaring command says, wherever in the argv it appears.
Position is not ownership.**

Implemented as `formatFor` in `src/cli.ts`, which reads the option source on both
the subcommand and its parent and prefers whichever was explicitly set. Any
future flag shared between a parent and a child follows the same shape rather
than growing a second mechanism.

Corollaries, so this is a rule and not one function:

1. **A subcommand that declares a flag owns it**, even when the parent declares
   the same name and the flag was written before the subcommand.
2. **Program-level flags stay position-free.** `--no-color` and `-V` must work
   before or after any positional; this is what rules out option A.
3. **A new subcommand should not reuse a parent's long name** unless it means the
   same thing. The precedence rule makes sharing *safe*, not *good*.

## Stress test

### 1. Does precedence hide a genuine ambiguity? (yes, and that is the point)

`docmeta schemas -f json infer x` sets the parent's format explicitly and the
child's not at all, so the child gets `json`. Someone could argue the user meant
to format the *listing* and then asked for an inference instead.

They could, but there is no listing in that invocation. The subcommand ran. One
format was typed, one command produced output, and it used the typed format. The
alternative is to error on a combination that has exactly one sensible reading,
which trades a working invocation for a lecture.

### 2. The rule is stated in terms of `getOptionValueSource`, which is commander's

If commander changed that API the rule survives but the implementation would not.
Recorded because the rule is the durable part: *the typed value wins*. Any
mechanism that establishes which value was typed satisfies it.

### 3. It does not fix a flag the subcommand never declares (the known deviation)

Corollary 1 says a command owns the flags it declares. It says nothing useful
about `schemas vendor <url> -f nonsense`, where `vendor` declares no `-f`, the
parent's absorbs it, and nothing reads it. **This is a live deviation from the
rule** and is not fixed here.

Harmless today. `vendor` has no format to choose, so the only cost is a typo
exiting 0 instead of 2. The remedy, when it is worth doing, is the same
mechanism. A subcommand that does not declare a flag can ask its parent whether
that flag's source is `"cli"`, and refuse. Recorded rather than fixed, so the
deviation is a known one instead of a discovered one.

### 4. Why not test this once and trust it? (because the failure is silent)

Both defects exited **0** with plausible output. Neither would have been caught
by a test asserting "the command works", only by one asserting *which format came
back*. Every shared flag therefore needs a test that pins the flag's effect in
the ambiguous position, not merely the command's success. `test/cli.integration.test.ts`
carries one for `schemas infer -f json`.

## Consequences

- One helper, one rule, applied wherever a flag is shared.
- Adding a subcommand no longer requires reasoning about commander's binding
  order. It does require asking whether a name is already taken above.
- The `vendor -f` deviation stands, documented, with its remedy written down.
