# A pipe at the start of a wrapped line

Workflow commands are only interpreted on stdout, so `cat page.md
| docmeta fill - --as markdown -f github` sends annotations to stderr.
That is prose, not a table, and must not be reported.
