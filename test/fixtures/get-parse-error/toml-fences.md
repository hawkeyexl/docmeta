---
title = "TOML between YAML fences"
type = "concept"
---

# TOML between fences

Legal Markdoc, illegal here. The fences parse as YAML, and the result is a
scalar rather than a mapping — so this fails at a different point from
`unparseable.md`, which does not parse at all.
