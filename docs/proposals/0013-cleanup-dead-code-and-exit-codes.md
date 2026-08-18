# 0013 — Dead code, the unpopulated `col`, and usage exit codes

- **Status:** Proposed
- **Serves:** correctness and maintainability; no CUJ directly
- **Touches:** `src/extractors/stub.ts`, `src/extractors/{html,xml}.ts`, `src/types.ts`, `test/extractors.test.ts`, `CONTRIBUTING.md`
- **Note:** the exit-code item is **owned by [0005](0005-command-parity.md)**; it is described here for completeness because it belongs to the same defect class.

Three small items. None is urgent; each is the kind of thing that quietly costs
credibility because it makes the codebase's declared surface bigger than its real
one.

---

## Item 1 — `stub.ts` is unreachable, and its test only tests itself

`createStubExtractor` exists to register "roadmap" formats so detection can report
them as planned. Every registered extractor is now `implemented: true`, so nothing
calls it:

```console
$ grep -rn "createStubExtractor\|implemented: false" src/
src/extractors/stub.ts:9:export function createStubExtractor(
src/extractors/stub.ts:17:    implemented: false,
```

The knock-on effects:

- `extractorForExtension` guards with `ex?.implemented ? ex : undefined` — a branch
  that can never be false.
- `supportedExtensions()` filters on `.implemented` — a filter that never removes
  anything.
- `src/cli.ts:357` renders `implemented` / `planned` tags in `docmeta schemas`
  output, and `planned` is unreachable.
- `CONTRIBUTING.md § Adding a new input format` tells contributors "roadmap stubs
  can register with `implemented: false` so the `schemas` command can report them as
  planned" — documenting a facility with no users.
- The test already concedes the situation:

  ```ts
  it("stub extractors throw not-implemented", () => {
    // No registered format is a stub anymore; exercise the factory directly.
    const stub = createStubExtractor("planned", [".planned"], "future format");
  ```

  It constructs the thing under test purely to assert the thing under test behaves.
  It cannot fail for any reason a user would notice.

### This is a judgment call, not an obvious deletion

`createStubExtractor` is **not** exported from `src/index.ts`, so it is internal and
removable without a public break. But `implemented` **is** public — it appears in
`dist/index.d.ts` on both `MetadataExtractor` and the `listFormats()` return type —
so removing *it* is a breaking type change.

Three coherent options:

| Option | Keeps | Costs |
|---|---|---|
| **A. Keep everything** | The extension point CONTRIBUTING describes | Permanent dead branch, a self-referential test, and a `planned` state users never see |
| **B. Remove `stub.ts` and `implemented`** | Maximum simplicity | Public type break; CONTRIBUTING and the `schemas` output both change |
| **C. Remove `stub.ts`; keep `implemented`** | The public capability flag | One always-true field, honestly documented |

**Recommend C.** `implemented` is a meaningful *declaration* on the extractor
interface and costs nothing to keep, whereas the factory is 20 lines that exist so a
future author does not have to write `implemented: false` by hand — which is not a
burden worth a file. Delete the factory and its self-test, keep the field, and reword
CONTRIBUTING to say "set `implemented: false` on the extractor" rather than pointing
at a helper.

### Stress test

- **Does removing `stub.ts` reduce coverage of a real path?** No. The behavior a user
  can reach — an unsupported extension — is produced by `extractorForExtension`
  returning `undefined` and the command layer raising "Unsupported file type". That
  path is exercised by the CLI integration tests and is unaffected.
- **Would a future format actually want this?** The registry's design already makes a
  new format one file plus one array entry. A stub is a one-line `implemented: false`
  on a skeleton — no factory needed.
- **Is `implemented` distinguishable from `apply`-based writability?** Yes, and that
  is the argument for keeping it: `implemented` means "can read", `typeof apply ===
  "function"` means "can write". Two independent capabilities, and
  [0007](0007-html-xml-write-support.md) changes one of them for HTML without
  touching the other. Collapsing them would be wrong.

---

## Item 2 — `col` is declared and never populated

`FieldError.col` is documented as "1-based column, when known", and nothing sets it.
`renderGithub` already emits `col=` when present, so the plumbing is finished and the
producer is missing.

To the project's credit this is **honestly documented** rather than hidden —
`ci/consume-results.mdx:75` carries an aside titled *"line and col are optional; col
is absent today"*, and `content-strategy/README.md` uses it as the worked example of
why the tests, not the types, are the contract for emitted output. So this is not a
docs bug.

### Recommendation: populate it, do not remove it

Removing the field is the cheap answer and the wrong one, because two other proposals
want columns:

- [0003](0003-sarif-and-junit-reporters.md) — SARIF `region` supports
  `startColumn`, which turns a file-level alert into a precise one.
- `--format github` annotations already accept `col`.

And the data is available in the parsers already in use:

- `html.ts` requests `sourceCodeLocationInfo` and reads `startLine`; parse5 supplies
  `startCol` on the same object at no extra cost.
- `xml.ts` reads `attr.lineNumber`; `@xmldom/xmldom` exposes `columnNumber` alongside
  it.

Frontmatter is harder — the `yaml` library gives node offsets, so a column needs an
offset→line/col conversion over the block. Worth doing, but it is the second step.

Proposed scope: populate `col` for `html` and `xml` first (both are one property
away), then frontmatter. Leave it `undefined` for formats that genuinely cannot
supply it — the field is already optional and every consumer handles absence.

### Stress test

- **Does adding `col` change existing output?** Yes, for `--format github`
  (`col=` appears) and `--format json` (a new key). Additive for JSON consumers;
  visible in `github` annotation positioning. `renderPretty` ignores `col` entirely,
  so terminal output is unchanged. Needs a note in the changelog, and the
  `consume-results.mdx` aside must be updated or it becomes false.
- **Is a column meaningful for a `required` violation?** No — `toFieldError` points
  `required` at the *parent* object and names the missing property in the message.
  There is no column for something absent. Populate `col` only for violations whose
  `instancePath` resolves to a node that exists, or GitHub will draw a caret at an
  arbitrary spot. This is the subtlety that makes "just set col" wrong.
- **Interaction with [0001](0001-validation-baseline.md):** `col` must **not** enter
  the baseline fingerprint, for the same reason `line` does not. Already excluded by
  that design; asserting it in a test prevents a well-meaning future addition.

---

## Item 3 — usage errors exit 1, and the contract says 2

`reference/output-and-exit-codes.mdx` defines `1` as "one or more files failed
validation" and `2` as "operational or usage error". Commander's own parse failures
exit **1**:

```console
$ docmeta validate --nope x.md
error: unknown option '--nope'
exit=1

$ docmeta get
error: missing required argument 'fields'
exit=1
```

Meanwhile docmeta's own checks behave correctly:

```console
$ docmeta validate x.md -f bogus
docmeta: Unknown --format "bogus". Use pretty, json, or github.
exit=2

$ docmeta fill --confidence 5 x.md
docmeta: --confidence must be a number between 0 and 1, got 5.
exit=2
```

So a typo'd **value** exits 2 and a typo'd **flag name** exits 1. A pipeline that
branches on the documented contract concludes that documents failed validation when
in fact nothing ran. Given the project's stated clig.dev discipline, this is a plain
contract violation.

**Owned by [0005 § 4 and § stress test 5](0005-command-parity.md)**, which specifies
the `program.exitOverride()` fix and — importantly — the blast radius: `exitOverride`
makes commander throw for `--help` and `--version` too, so those must be mapped back
to exit 0 explicitly or `docmeta --help` starts failing. Not repeated here; recorded
so this defect class is enumerated in one place.

Related and **not** covered by 0005: `docmeta valdiate docs/` exits 0 because
`validate` is the default command and the typo is absorbed as a path. That is
[0014](0014-empty-input-is-not-success.md) § "And it swallows typo'd subcommands".

---

## Implementation sketch

Independent, in any order. Items 1 and 2 are each a single small PR.

1. **Item 1** — delete `src/extractors/stub.ts` and the self-referential test; keep
   `implemented`; reword `CONTRIBUTING.md § Adding a new input format`. Decide
   explicitly whether to keep the unreachable `planned` branch in `src/cli.ts:357`
   (recommend keeping — one line, and it becomes reachable the moment anyone sets
   `implemented: false`).
2. **Item 2, red first** — `test/extractors.test.ts` asserts `col` for an `html`
   `<meta>` violation and an `xml` root-attribute violation; asserts `col` is
   `undefined` for a `required` violation; `test/reporters.test.ts` asserts `col=`
   appears in `github` output only when set. Then populate from parse5's `startCol`
   and xmldom's `columnNumber`. Update the `consume-results.mdx` aside and
   `content-strategy/README.md`, which uses `col` as its example of a declared-but-
   unpopulated field — that example needs replacing once it is no longer true.
3. **Item 3** — see [0005](0005-command-parity.md).
