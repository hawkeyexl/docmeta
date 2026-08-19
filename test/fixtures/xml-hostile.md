---
type: concept
title: XML-Hostile
description: A document whose only failure carries XML metacharacters.
resource: https://example.com/docs/xml-hostile
tags:
  - sample
timestamp: 2026-06-25T10:00:00Z
tag: plain
---

# XML-Hostile

`tag` does not match `xml-hostile.schema.json`'s pattern, so the violation
message carries that pattern's `<`, `&`, and `"` into the report. The rest of
the front matter is valid OKF on purpose: this fixture exercises the XML writer,
not the default schema set.
