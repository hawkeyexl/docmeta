---
type: concept
title: Percent-Hostile
description: A document whose only failure carries a percent sign.
resource: https://example.com/docs/percent-hostile
tags:
  - sample
timestamp: 2026-06-25T10:00:00Z
discount: half
---

# Percent-Hostile

`discount` does not match `percent-hostile.schema.json`'s pattern, so the
violation message carries that pattern's `%` into the report. `%` introduces the
escape sequences in a GitHub workflow command, so an unescaped one corrupts the
annotation. The rest of the front matter is valid OKF on purpose: this fixture
exercises the annotation writer, not the default schema set.
