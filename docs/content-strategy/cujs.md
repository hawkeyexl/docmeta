# Critical User Journeys (CUJs)

A CUJ is a complete, end-to-end outcome a persona must be able to reach using docmeta and its documentation. The CUJs are the organizing principle for the IA: each top-level nav section maps to one persona's set of journeys, and every page is justified by the CUJ it serves.

See `information-architecture.md` for the page-level content set and which pages carry each CUJ.

---

## Maya — Docs Engineer

### M1 · Stand up metadata validation for my repo

Maya needs to go from zero to a working CI gate: evaluate whether docmeta fits her use case, install it, validate one file and read the output, add a config file and a schema, and land a passing CI step.

This is the anchor CUJ. It is the first thing the lead persona does, and it threads through install, config, schema, and CI in a single coherent journey.

### M2 · Tighten the standard without breaking the build

Maya wants to add a new required field (or make an existing optional field required) without immediately failing every existing doc that doesn't have it yet. She needs to: add the field in an incremental way, understand how to stage the rollout across a large repo, and ratchet up strictness over time.

### M3 · Apply different rules to different areas

Maya's repo has heterogeneous content: `/api` docs need a `type: api-reference` field; `/guides` have different required fields. She needs to assign different schemas to different directory subtrees via config overrides, understand glob precedence, and handle a file that matches multiple schemas.

---

## Devin — Platform / CI Engineer

### D1 · Add the gate to our CI platform

Devin needs working recipes for every CI system his org uses: GitHub Actions, GitLab CI, Jenkins, and pre-commit. He also needs the exit-code contract documented precisely (0/1/2) and to understand the `--format github` inline annotation output for PR review.

### D2 · Govern one schema across many repos

Devin wants a single canonical schema stored in a central repo and referenced by URL from every consuming repo. He needs to understand: how docmeta fetches remote `$schema` URIs, the 10-second fetch timeout, per-run caching behavior, and how to version the URL so consumers pin a stable release.

### D3 · Feed results into our tooling

Devin needs programmatic access to validation output: `--format json` for machine-readable results, the `get` command to extract metadata values from files in scripts, and the TypeScript API for teams building tools on top of docmeta.

---

## Sara — Schema Author

### S1 · Define our metadata standard as a schema

Sara needs to encode her metadata standard as a JSON Schema: define required vs. recommended fields, specify value formats (`uri`, `date-time`, enum), and understand what the built-in OKF schema already provides so she can start from it or deviate deliberately.

### S2 · Wire schemas to the right documents

Sara needs to understand how docmeta resolves which schema(s) apply to any given file. The full precedence chain: CLI `--schema` flag → file `$schema` field → config `overrides` → config `schemas` → built-in default. She also needs to know the three ref kinds: builtin, file path, and URL.

### S3 · Version and evolve the schema safely

Sara needs to ship a stricter version of the schema without immediately breaking CI in every consuming repo. She needs to understand: JSON Schema dialects (2020-12 through draft-04), docmeta's dialect detection, the versioning policy, and a migration path for consumers.

---

## Theo — Contributor

### T1 · Fix a failing metadata check fast

Theo lands on the docs via a red CI check or a search. He needs: a clear map from error message to the specific field or line in his file, remediation steps for the most common failures (missing `type`, bad `date-time` format, schema not found, parse error), a way to validate locally before re-pushing, and confirmation that the fix worked.

This is the highest-traffic page in the docs. Every contributor who hits a failing check arrives here. It is cross-cutting — the same page serves regardless of which persona configured docmeta.
