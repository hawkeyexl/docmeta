---
title: [unclosed
description: the flow sequence above is never closed
---

# Unparseable

The frontmatter here is not valid YAML. `validate` reports it as a per-file
`(parse)` finding; `get` used to abort the whole run with an "Unexpected
error" that never said which file was at fault.
