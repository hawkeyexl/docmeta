---
type: concept
title: Broken evals
evals:
  evals:
    - name: Bad_Name
      assertion: Name violates the kebab-case pattern.
    - name: llm-without-assertion
      grader: llm
    - name: unknown-field
      assertion: Carries a field the schema forbids.
      surprise: true
---

Body content.
