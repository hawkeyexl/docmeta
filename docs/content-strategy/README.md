# Content strategy

This directory holds the durable content strategy for the docmeta documentation site. It is the reference every writing task should consult before drafting a page.

These files live inside `docs/` but outside `docs/src/content/docs/**`, so they are not published as end-user pages. They are internal working documents for agents and contributors.

## Files

| File | Contents |
|---|---|
| `audiences.md` | The four target audiences and why each matters. |
| `personas.md` | Full profiles for Maya, Devin, Sara, and Theo. |
| `cujs.md` | Critical User Journeys per persona, the end-to-end outcomes the docs must support. |
| `information-architecture.md` | The CUJ-based IA and nav tree, plus the full content-set map (which page serves which CUJ, with ★ launch markers). |
| `design.md` | The visual rules the docs site and the demo videos both follow: palette, type, capture geometry, composition, and the measurements behind them. |

## How to use this during writing tasks

Before drafting or editing any user-facing documentation:

1. **Identify the relevant persona.** Is this page for Maya (docs engineer), Devin (CI engineer), Sara (schema author), or Theo (contributor hitting a red check)? A page may serve more than one, but there is usually a primary.

2. **Find the matching CUJ in `cujs.md`.** Each persona has 1–3 numbered journeys (M1–M3, D1–D3, S1–S3, T1). Understand the end-to-end outcome the persona needs to reach.

3. **Structure content around that journey, not by document type.** Do not impose a Diátaxis-style tutorial/how-to/explanation/reference split as the organizing principle. Ask: "What does this persona need to know, and in what order, to reach the outcome?" Let the journey sequence the content.

4. **Link into the Reference shelf for lookups.** Detailed flag tables, full config-key lists, and the precedence chain belong in `reference/`. Journey pages explain the path and link into reference for exhaustive detail. They do not duplicate it.

5. **Check the IA map.** `information-architecture.md` lists every planned page, the CUJ it serves, and whether it is a ★ launch priority. If you are adding a new page, record it there.

6. **Frontmatter.** Every page in `docs/src/content/docs/**` must have `title` and `description` in its frontmatter. No exceptions.

7. **Anything visual goes through `design.md`.** A page that adds a screenshot, a diagram, a code-block style, or a demo video is both a design change and a content one. The palette is not decorative. docmeta's own output already assigns meaning to red, green, yellow and cyan. Chrome that reuses one of them makes a reader see a relationship that is not there.

## Verifying technical claims

docmeta docs document a real CLI. Every flag, exit code, output string, and schema rule must match the code, never the writer's assumption.

- **Source files are the contract for behavior** (`src/cli.ts` for flags, `src/core/` for config and schema resolution, `src/extractors/` for formats).
- **The test suite is the contract for *exact emitted strings*.** Type definitions in `src/types.ts` describe the *shape* of output, but they over-promise. An optional field is declared once on the shape, and populated by only some of the paths that produce it. `col` is on every `FieldError`, but only the `html` and `xml` extractors supply one. Even they omit it for a `required` violation. So "the type has `col`" and "this annotation shows a column" are different claims, and only the second is what a reader will see. The same asymmetry runs the other way in SARIF, where the format defines `region.startColumn` and docmeta never emits it. Before documenting concrete output, verify the literal strings against the assertions in `test/*.test.ts`. That covers pretty lines, JSON values, and `github` annotations, and the files to start from are `test/reporters.test.ts`, `test/commands.test.ts`, and `test/cli.integration.test.ts`, among others. The tests encode what the tool actually prints.
- **To capture real sample output**, build once (`npm run build` at the repo root). Then run the built binary against a fixture, rather than hand-writing output. One example is `node dist/cli.js validate test/fixtures/missing-type.md`. Reuse `test/fixtures/` as worked examples so docs and CI stay in lockstep.
