/**
 * Reporter for `query`.
 *
 * Same split as `get`: `runQuery` returns every row, and presentation —
 * alignment, the row count, the `--check` verdict — happens here, where it
 * only affects text a person is reading. `json` output never passes through
 * this module; the CLI prints the bare row array, mirroring `get`'s bare
 * array, and the exit code (not the envelope) carries the `--check` verdict.
 */
import type { QueryChange, QueryRun } from "../commands/query.js";
import { palette, type Colors } from "./color.js";
import { stringifyValue } from "./get.js";

export interface QueryReportOptions {
  color?: boolean;
  /** `--check`: append a ✓/✗ verdict line instead of the plain count. */
  check?: boolean;
  /** `--write`: the changes were applied, not previewed. */
  write?: boolean;
}

/** SQL NULL prints as `(null)`; everything else as `get` prints values. */
function cell(value: unknown): string {
  return value === null ? "(null)" : stringifyValue(value);
}

/**
 * An aligned table (header + rows) and a trailing count line. The last column
 * is never padded, so no line carries trailing spaces. A metadata edit
 * renders as its per-file diff instead of a row table (0022).
 */
export function renderQuery(
  run: QueryRun,
  opts: QueryReportOptions = {},
): string {
  const c = palette(opts.color ?? false);
  if (run.changes) return renderChanges(run.changes, c, opts);
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

/**
 * `<file>: <key>: <from> -> <to>` per changed cell, then the verdict: what
 * was written, what a preview would write, or the ✓/✗ of a `--check` drift
 * gate. `from` is `(unset)` when the file had no value for the key.
 */
function renderChanges(
  changes: QueryChange[],
  c: Colors,
  opts: QueryReportOptions,
): string {
  const lines = changes.map((ch) => {
    if ("config" in ch) {
      return `${c.dim(`config ${ch.file}:`)} ${ch.key}: ${cellFrom(ch.from)} -> ${cell(ch.to)}`;
    }
    if ("schema" in ch) {
      const fork = ch.forkedFrom ? ` ${c.dim(`(forked from ${ch.forkedFrom})`)}` : "";
      if (ch.op === "rename") {
        return `${c.dim(`schema ${ch.file}:`)} ${ch.key} -> ${ch.renamedTo ?? ch.key}${fork}`;
      }
      if (ch.op === "drop") {
        return `${c.dim(`schema ${ch.file}:`)} - ${ch.key}${fork}`;
      }
      const detail = [ch.type, ch.required ? "required" : undefined]
        .filter(Boolean)
        .join(", ");
      return `${c.dim(`schema ${ch.file}:`)} + ${ch.key}${detail ? ` (${detail})` : ""}${fork}`;
    }
    if ("cleared" in ch) {
      return `${c.dim(`${ch.file}:`)} (frontmatter removed: ${Object.keys(ch.from).join(", ")})`;
    }
    if ("created" in ch) {
      const kv = Object.entries(ch.to)
        .map(([k, v]) => `${k}=${cell(v)}`)
        .join(", ");
      return `${c.dim(`${ch.file}:`)} (created: ${kv})`;
    }
    if ("renamed" in ch) {
      return `${c.dim(`${ch.file} ->`)} ${ch.renamed} ${c.dim("(moved)")}`;
    }
    if ("renamedFrom" in ch) {
      return `${c.dim(`${ch.file}:`)} ${ch.renamedFrom} -> ${ch.key} ${c.dim("(key renamed)")}`;
    }
    if ("deleted" in ch) {
      return `${c.dim(`${ch.file}:`)} ${ch.key}: ${cellFrom(ch.from)} -> (deleted)`;
    }
    return `${c.dim(`${ch.file}:`)} ${ch.key}: ${cellFrom(ch.from)} -> ${cell(ch.to)}`;
  });
  const n = changes.length;
  const files = new Set(changes.map((ch) => ch.file)).size;
  const count = `${n} change${n === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"}`;
  if (opts.write) {
    lines.push(n > 0 ? c.green(`✓ ${count} — written`) : c.dim("0 changes"));
  } else if (opts.check) {
    lines.push(
      n > 0 ? c.red(`✗ ${count} — check failed`) : c.green("✓ 0 changes"),
    );
  } else {
    lines.push(
      n > 0
        ? `${count} — ${c.dim("dry run; pass --write to apply")}`
        : c.dim("0 changes"),
    );
  }
  return lines.join("\n");
}

/** A preview's `from`: `(unset)` only for a key the file never had. */
function cellFrom(value: unknown): string {
  return value === undefined ? "(unset)" : cell(value);
}
