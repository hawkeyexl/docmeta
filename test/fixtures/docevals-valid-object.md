---
type: how-to
title: Installation
evals:
  suite: how-to
  skip: false
  evals:
    - no-future-promises
    - use: fresh-enough
      severity: error
      type: capability
    - name: install-command-accuracy
      assertion: The documented install command is `npm i -g doc-detective`.
      type: regression
      grader: llm
      evidence: Code blocks and prerequisites list
      examples:
        pass: Shows the current install command.
        fail: Shows a deprecated command.
    - name: has-examples-heading
      assertion: The page includes an Examples heading.
      grader: command
      command: ["node", "docevals/check.mjs", "{file}"]
      successExitCodes: [0]
      generated:
        assertionHash: 07d185732a48ace07056e847b0fadd72fa35f830f7b793f2790db1a59182fd7a
---

Body content.
