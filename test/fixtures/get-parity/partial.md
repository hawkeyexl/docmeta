---
# `type` satisfies the default schema set. This fixture is for `get`,
# which never validates — it is "partial" in the field the *test* asks
# for (`owner`, deliberately absent), not in its schema conformance. Left
# invalid it became a standing code-scanning alert from the formats-demo
# workflow, which globs every fixture and is meant to surface only the
# documents that are wrong on purpose.
type: concept
title: Only a title
---

# Only a title
