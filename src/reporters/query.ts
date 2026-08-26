/**
 * Reporter for `query`.
 *
 * Same split as `get`: `runQuery` returns every row, and presentation —
 * alignment, the row count, the `--check` verdict — happens here, where it
 * only affects text a person is reading. `json` output never passes through
 * this module; the CLI prints the bare row array, mirroring `get`'s bare
 * array, and the exit code (not the envelope) carries the `--check` verdict.
 */
import type { QueryRun } from "../commands/query.js";
import { palette } from "./color.js";
import { stringifyValue } from "./get.js";

export interface QueryReportOptions {
  color?: boolean;
  /** `--check`: append a ✓/✗ verdict line instead of the plain row count. */
  check?: boolean;
}

/** SQL NULL prints as `(null)`; everything else as `get` prints values. */
function cell(value: unknown): string {
  return value === null ? "(null)" : stringifyValue(value);
}

/**
 * An aligned table (header + rows) and a trailing count line. The last column
 * is never padded, so no line carries trailing spaces.
 */
export function renderQuery(
  run: QueryRun,
  opts: QueryReportOptions = {},
): string {
  const c = palette(opts.color ?? false);
  const lines: string[] = [];
  if (run.rows.length > 0) {
    const widths = run.columns.map((col) =>
      Math.max(col.length, ...run.rows.map((r) => cell(r[col]).length)),
    );
    const pad = (text: string, i: number): string =>
      i === run.columns.length - 1 ? text : text.padEnd(widths[i] ?? 0);
    lines.push(run.columns.map((col, i) => c.bold(pad(col, i))).join("  "));
    for (const row of run.rows) {
      lines.push(run.columns.map((col, i) => pad(cell(row[col]), i)).join("  "));
    }
  }
  const n = run.rows.length;
  const count = `${n} row${n === 1 ? "" : "s"}`;
  lines.push(
    opts.check
      ? n > 0
        ? c.red(`✗ ${count} — check failed`)
        : c.green(`✓ ${count}`)
      : c.dim(count),
  );
  return lines.join("\n");
}
