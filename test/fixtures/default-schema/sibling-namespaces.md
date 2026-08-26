---
title: A page carrying every sibling tool's namespace
description: The evals, kg, and metadata blocks belong to other tools and pass untouched.
type: how-to
eval-suite: docs-page
evals:
  - id: install-command-present
    assertion: The page shows the current install command.
kg:
  label: Installation
  type: task
metadata:
  evals:
    - id: read-before-edit
      assertion: The session read the page before editing it.
---

Body.
