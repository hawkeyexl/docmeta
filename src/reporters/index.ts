/**
 * Reporters render validation results to a string. The command layer writes
 * the result to stdout; diagnostics go to stderr separately.
 */
import type {
  BaselineSummary,
  RunSummary,
  ValidationResult,
} from "../types.js";
import { palette } from "./color.js";

export type ReportFormat = "pretty" | "json" | "github";

export interface ReportOptions {
  color?: boolean;
  /** In pretty output, omit passing files. */
  quiet?: boolean;
}

function fieldLabel(instancePath: string): string {
  return instancePath === "" ? "(root)" : instancePath;
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The baseline's line in the summary.
 *
 * A baseline is amnesty, and amnesty that goes quiet becomes permanent — so the
 * count is printed on **every** run, including the one where nothing was
 * forgiven, rather than only when something changes. The stale clause is what
 * makes a rename diagnosable: without it the user sees a wall of "new" findings
 * with no hint that the fix is a re-record.
 */
function baselineLines(b: BaselineSummary): string[] {
  if (b.written) {
    const added = b.added ?? 0;
    const removed = b.removed ?? 0;
    return [
      `Baseline written to ${b.path}`,
      `  ${plural(b.recorded, "finding", "findings")} recorded (+${added} new, -${removed} ${
        removed === 1 ? "no longer occurs" : "no longer occur"
      })`,
    ];
  }
  const head = plural(b.recorded, "baselined finding", "baselined findings");
  if (b.stale === 0) return [head];
  const stale = b.stale === 1 ? "1 no longer occurs" : `${b.stale} no longer occur`;
  return [`${head}, ${stale} — run --write-baseline to prune`];
}

export function renderPretty(
  results: ValidationResult[],
  summary: RunSummary,
  opts: ReportOptions = {},
): string {
  const c = palette(opts.color ?? false);
  const lines: string[] = [];

  for (const r of results) {
    // What the baseline forgave here, so a passing file still shows its debt.
    const forgiven =
      r.baselined != null && r.baselined > 0
        ? c.dim(`  (${r.baselined} baselined)`)
        : "";
    if (r.ok) {
      if (!opts.quiet) lines.push(`${c.green("✓")} ${r.file}${forgiven}`);
      continue;
    }
    lines.push(`${c.red("✗")} ${r.file}${forgiven}`);
    for (const e of r.errors) {
      const loc = e.line != null ? c.dim(`  (line ${e.line})`) : "";
      lines.push(
        `    ${c.cyan(fieldLabel(e.instancePath))}  ${e.message}${loc}  ${c.dim(
          `[${e.schema}]`,
        )}`,
      );
    }
  }

  const summaryText = `${summary.files} file${summary.files === 1 ? "" : "s"} checked, ${summary.passed} passed, ${summary.failed} failed, ${summary.errors} error${summary.errors === 1 ? "" : "s"}`;
  if (lines.length > 0) lines.push("");
  lines.push(summary.failed > 0 ? c.red(summaryText) : c.green(summaryText));
  if (summary.baseline) {
    for (const l of baselineLines(summary.baseline)) lines.push(c.dim(l));
  }
  return lines.join("\n");
}

export function renderJson(
  results: ValidationResult[],
  summary: RunSummary,
): string {
  return JSON.stringify({ summary, results }, null, 2);
}

export function renderGithub(results: ValidationResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    for (const e of r.errors) {
      const params = [`file=${r.file}`];
      if (e.line != null) params.push(`line=${e.line}`);
      if (e.col != null) params.push(`col=${e.col}`);
      const msg = `[${e.schema}] ${fieldLabel(e.instancePath)} ${e.message}`;
      lines.push(`::error ${params.join(",")}::${msg}`);
    }
  }
  return lines.join("\n");
}

export function render(
  format: ReportFormat,
  results: ValidationResult[],
  summary: RunSummary,
  opts: ReportOptions = {},
): string {
  switch (format) {
    case "json":
      return renderJson(results, summary);
    case "github":
      return renderGithub(results);
    case "pretty":
    default:
      return renderPretty(results, summary, opts);
  }
}
