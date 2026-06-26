# Content strategy

This directory holds the durable content strategy for the docmeta documentation site. It is the reference every writing task should consult before drafting a page.

These files live inside `docs/` but outside `docs/src/content/docs/**`, so they are not published as end-user pages. They are internal working documents for agents and contributors.

## Files

| File | Contents |
|---|---|
| `audiences.md` | The four target audiences and why each matters. |
| `personas.md` | Full profiles for Maya, Devin, Sara, and Theo. |
| `cujs.md` | Critical User Journeys per persona — the end-to-end outcomes the docs must support. |
| `information-architecture.md` | The CUJ-based IA and nav tree, plus the full content-set map (which page serves which CUJ, with ★ launch markers). |

## How to use this during writing tasks

Before drafting or editing any user-facing documentation:

1. **Identify the relevant persona.** Is this page for Maya (docs engineer), Devin (CI engineer), Sara (schema author), or Theo (contributor hitting a red check)? A page may serve more than one, but there is usually a primary.

2. **Find the matching CUJ in `cujs.md`.** Each persona has 1–3 numbered journeys (M1–M3, D1–D3, S1–S3, T1). Understand the end-to-end outcome the persona needs to reach.

3. **Structure content around that journey, not by document type.** Do not impose a Diátaxis-style tutorial/how-to/explanation/reference split as the organizing principle. Ask: "What does this persona need to know, and in what order, to reach the outcome?" Let the journey sequence the content.

4. **Link into the Reference shelf for lookups.** Detailed flag tables, full config-key lists, and the precedence chain belong in `reference/`. Journey pages explain the path and link into reference for exhaustive detail — they do not duplicate it.

5. **Check the IA map.** `information-architecture.md` lists every planned page, the CUJ it serves, and whether it is a ★ launch priority. If you are adding a new page, record it there.

6. **Frontmatter.** Every page in `docs/src/content/docs/**` must have `title` and `description` in its frontmatter. No exceptions.

## Verifying technical claims

docmeta docs document a real CLI, so every flag, exit code, output string, and schema rule must match the code — never the writer's assumption.

- **Source files are the contract for behavior** (`src/cli.ts` for flags, `src/core/` for config and schema resolution, `src/extractors/` for formats).
- **The test suite is the contract for *exact emitted strings*.** Type definitions in `src/types.ts` describe the *shape* of output, but they over-promise: a field can be declared and never populated (e.g. `col` is part of the error shape but no extractor sets it today). Before documenting concrete output — pretty lines, JSON values, `github` annotations — verify the literal strings against the assertions in `test/*.test.ts` (e.g. `test/reporters.test.ts`, `test/commands.test.ts`, `test/cli.integration.test.ts`). The tests encode what the tool actually prints.
- **To capture real sample output**, build once (`npm run build` at the repo root) and run the built binary against a fixture (e.g. `node dist/cli.js validate test/fixtures/missing-type.md`), rather than hand-writing output. Reuse `test/fixtures/` as worked examples so docs and CI stay in lockstep.
