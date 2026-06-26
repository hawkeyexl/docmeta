# Target audiences

docmeta serves four distinct audiences. The **lead audience** drives the primary IA track and gets the deepest coverage; secondary audiences have dedicated tracks but are scoped to what they actually need from the tool.

## 1. Docs-as-code teams (lead)

Own a docs repo and its frontmatter conventions. They want those conventions enforced automatically so downstream systems — search indexes, catalogs, site nav, knowledge graphs — don't break on bad metadata.

This is the lead audience because they are the ones adopting docmeta as part of their workflow, configuring it, writing schemas, and living with the CI gate every day. Everything else serves them or intersects with them.

## 2. Platform / CI engineers

Own pipelines across many repos. They want a low-maintenance metadata gate that works on whatever CI system they run and emits machine-readable results they can pipe into existing tooling.

They don't author docs and don't own the metadata standard — they install and plumb the gate. Their questions are about exit codes, output formats, and minimizing per-repo config.

## 3. Schema authors / information architects

Own the *metadata standard itself* — what fields are required, what formats values must use, the versioning policy. They want to encode that standard as JSON Schema and evolve it without breaking everyone downstream.

This audience may overlap with docs-as-code teams (often the same person in a small org) but has a distinct job: they define correctness, not enforcement.

## 4. Doc contributors (high-volume, secondary)

Developers or writers who opened a PR and hit a red metadata check. They did not configure docmeta and don't need to understand it deeply — they need to decode one error, find the field, fix it, and move on.

This is the highest-traffic audience by page visits because every contributor who trips a check lands on the fix-it page. It is secondary in terms of depth: one targeted page (T1) serves the entire journey.
