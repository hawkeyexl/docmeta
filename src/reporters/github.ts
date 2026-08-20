/**
 * GitHub Actions workflow-command primitives, shared by every renderer that
 * emits `::error ...::<message>`.
 *
 * Its own module rather than a local function so a second renderer cannot
 * re-derive the rule and get the ordering wrong — the ordering is the part that
 * is easy to miss.
 */

/**
 * Escape a workflow command's **message**.
 *
 * `::error ...::<message>` is a line-oriented protocol: a literal newline ends
 * the command, so an unescaped multi-line message truncates the annotation and
 * spills the rest into the log as plain text. `%` is the escape introducer, so
 * an unescaped one corrupts the message the runner decodes. Ajv quotes a
 * schema's `pattern` regex verbatim, which is where a stray `%` comes from in
 * practice.
 *
 * `%` **must** be replaced first. Doing the newlines first would turn a literal
 * LF into `%0A` and then the `%` pass would rewrite that to `%250A`, so the
 * annotation would display the escape sequence as text instead of a line break.
 *
 * Only these three. GitHub also treats `,` and `:` specially, but in the
 * command's *property* values (`file=`, `line=`), not in the message — encoding
 * them here would show up as `%3A` in the rendered annotation. That is what
 * {@link escapeWorkflowCommandProperty} is for.
 *
 * @see https://docs.github.com/actions/reference/workflow-commands-for-github-actions
 */
export function escapeWorkflowCommandMessage(message: string): string {
  return message
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/**
 * Escape a workflow command's **property value** — the right-hand side of
 * `file=`, `line=`, `col=`.
 *
 * Everything the message needs, plus `,` and `:`. Properties are comma-
 * separated and each is `name:value`-adjacent in the grammar, so an unescaped
 * separator inside a value silently re-partitions the command: a real path like
 * `docs/report,final.md` yields `file=docs/report` and a stray property named
 * `final.md`, and the annotation lands on the wrong file — or nowhere — with no
 * error anywhere.
 *
 * `%` first, for the same reason as the message escaper.
 */
export function escapeWorkflowCommandProperty(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}
