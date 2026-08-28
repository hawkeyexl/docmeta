---
name: db-reader
description: Runs read-only database queries. Use proactively when a question needs data rather than code.
model: sonnet
tools: Read, Grep, Bash(psql *)
disallowedTools:
  - Write
  - Edit
color: cyan
effort: high
permissionMode: acceptEdits
maxTurns: 10
skills:
  - sql-conventions
  - error-handling-patterns
mcpServers:
  - github
  - playwright:
      type: stdio
      command: npx
      args: ["-y", "@playwright/mcp@latest"]
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-readonly-query.sh"
memory: project
background: true
isolation: worktree
initialPrompt: Summarise the schema of the reporting database.
observer: code-reviewer
observerMessage: Flag any statement that writes.
---

You are a read-only database specialist.
