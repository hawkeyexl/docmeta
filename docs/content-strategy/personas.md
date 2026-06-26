# Personas

Four concrete personas, one per audience. Each writing task should be anchored to the persona(s) it serves. See `cujs.md` for the end-to-end journeys each persona must complete.

---

## Maya — Documentation Engineer (LEAD persona)

Maya owns a 2,000-page docs-as-code repo for a platform product. She is comfortable with Markdown, YAML, Git, and reading a CI config. She is not a JSON Schema expert.

**Goal:** every doc has correct, complete frontmatter so the search index and the content catalog stay trustworthy.

**Pains:**
- Contributors omit required fields like `type`.
- Values are fat-fingered — `date-time` formatted incorrectly, enum values misspelled.
- Metadata drifts as the team grows, but she has no enforcement mechanism — only review fatigue.

**How she uses docmeta:** installs it, writes or adopts a schema, adds a CI step, then mostly operates it hands-off. She returns when the standard needs tightening.

**Why she is the lead persona:** she is the primary adopter. She touches installation, config, schema selection, and CI wiring — every layer of the stack. Her journey (M1) is the anchor.

---

## Devin — Platform / CI Engineer

Devin maintains CI/CD infrastructure for dozens of repos on a mix of GitHub Actions, GitLab CI, Jenkins, and pre-commit. He scripts everything and has high technical proficiency.

**Goal:** drop in a metadata gate that is identical everywhere, cheap to run, and feeds results into existing tooling without custom glue per repo.

**Pains:**
- Per-tool config sprawl: different CI recipe for every linter/checker.
- Needs stable, documented exit codes and machine-readable output (JSON, annotation format) so results flow into dashboards and PR bots without fragile parsing.
- Wants one canonical schema shared across repos rather than copies that drift.

**How he uses docmeta:** installs via CI step, sets flags, plugs exit code into pipeline gate, optionally passes JSON output to a dashboard. Returns when a new CI platform is added or the output format changes.

---

## Sara — Schema Author / Information Architect

Sara defines what the metadata *means*: which fields are required vs. recommended, what value formats are acceptable, and the versioning policy for the standard. She has medium-to-high proficiency and understands data modeling; she is actively learning JSON Schema's finer points.

**Goal:** encode the metadata standard as a JSON Schema, wire it to the right documents, and evolve it safely as requirements change.

**Pains:**
- Dialect confusion: draft-07 vs. 2020-12 differences trip her up.
- Precedence uncertainty: she isn't sure whether `$schema` in a file overrides the config or the other way around.
- Shipping a stricter required field without breaking every existing repo overnight.

**How she uses docmeta:** authors schemas (starting from the OKF built-in or scratch), wires them to directories via config overrides, tests resolution, and manages upgrades with versioned URLs.

---

## Theo — Doc Contributor (high-volume, secondary)

Theo is a developer or technical writer who opened a PR. The docmeta check is red. He has low context on the tool and is not interested in learning it — he wants to fix the one thing blocking his PR.

**Goal:** understand the specific error, find the offending field and line in his file, fix it, confirm locally, and move on.

**Pains:**
- Error messages are terse with no obvious remediation hint.
- He doesn't know which schema fired or why that rule exists.
- He doesn't want to read the full documentation — he wants a targeted answer.

**How he uses docmeta:** follows the error link (or searches) to the fix-it page, maps the error to a field and file location, applies the fix, runs `npx docmeta validate <file>` locally to confirm green, done.
