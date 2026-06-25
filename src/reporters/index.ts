/**
 * Reporters render validation results to a string. The command layer writes
 * the result to stdout; diagnostics go to stderr separately.
 */
import type { RunSummary, ValidationResult } from "../types.js";
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

export function renderPretty(
  results: ValidationResult[],
  summary: RunSummary,
  opts: ReportOptions = {},
): string {
  const c = palette(opts.color ?? false);
  const lines: string[] = [];

  for (const r of results) {
    if (r.ok) {
      if (!opts.quiet) lines.push(`${c.green("✓")} ${r.file}`);
      continue;
    }
    lines.push(`${c.red("✗")} ${r.file}`);
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
