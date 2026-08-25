---
name: commit
description: Create a git commit from the staged changes. Use when the user asks to commit.
when_to_use: When the user says "commit this" or asks for a conventional-commit message.
argument-hint: "[scope]"
arguments: scope subject
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash(git add *) Bash(git commit *)
disallowed-tools:
  - AskUserQuestion
model: inherit
effort: high
context: fork
agent: general-purpose
background: false
paths:
  - "src/**"
  - "test/**"
shell: bash
license: Apache-2.0
compatibility: Designed for Claude Code (or similar products)
metadata:
  catalog-tier: 2
---

Body.
