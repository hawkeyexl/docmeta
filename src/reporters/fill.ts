/**
 * Reporter for `fill`.
 *
 * `render()` in ./index.ts is keyed to ValidationResult/RunSummary, so `fill`
 * gets its own renderer rather than a fourth branch there. The colour palette is
 * shared, so NO_COLOR and TTY behaviour stay identical across commands.
 *
 * The report always states the threshold and names the fields that fell below
 * it. A skipped field that is invisible is indistinguishable from a field the
 * model never considered, and the difference matters to whoever has to fill it
 * in by hand.
 */
import type { FillRun } from "../commands/fill-types.js";
import { palette } from "./color.js";

export type FillReportFormat = "pretty" | "json";

export function renderFillJson(run: FillRun): string {
  return JSON.stringify(run, null, 2);
}

const score = (n: number): string => n.toFixed(2);

export function renderFillPretty(
  run: FillRun,
  opts: { color?: boolean } = {},
): string {
  const c = palette(opts.color ?? false);
  const lines: string[] = [];

  for (const result of run.results) {
    if (result.error != null) {
      lines.push(`${c.red("✗")} ${result.file}`);
      lines.push(`    ${result.error}`);
      continue;
    }
    if (result.fields.length === 0) continue;

    const written = result.fields.filter((f) => f.written);
    const low = result.fields.filter((f) => f.skipReason === "low-confidence");
    const other = result.fields.filter(
      (f) => !f.written && f.skipReason !== "low-confidence",
    );

    const mark = written.length > 0 ? c.green("✓") : c.dim("·");
    lines.push(`${mark} ${result.file}`);
    for (const f of written) {
      lines.push(
        `    ${c.cyan(f.field)}  ${formatValue(f.value)}  ${c.dim(score(f.confidence))}`,
      );
    }
    if (low.length > 0) {
      lines.push(
        c.dim(
          `    below ${run.threshold}: ${low
            .map((f) => `${f.field} ${score(f.confidence)}`)
            .join(", ")}`,
        ),
      );
    }
    for (const f of other) {
      lines.push(c.dim(`    ${f.skipReason ?? "skipped"}: ${f.field}`));
    }
  }

  const { summary } = run;
  const verb = run.dryRun ? "would be written" : "written";
  const parts = [
    `Threshold ${run.threshold}`,
    `${summary.files} file${summary.files === 1 ? "" : "s"}`,
    `${summary.written} field${summary.written === 1 ? "" : "s"} ${verb}`,
    `${summary.skipped} skipped`,
  ];
  if (summary.errors > 0) parts.push(`${summary.errors} errored`);
  if (summary.cached > 0) parts.push(`${summary.cached} cached`);
  // claude-cli reports no token usage, so a $0.00 there means "unknown", not
  // "free" — say nothing rather than imply a verified zero.
  if (summary.costUsd > 0) parts.push(`$${summary.costUsd.toFixed(4)}`);

  if (lines.length > 0) lines.push("");
  const footer = parts.join(" · ");
  lines.push(summary.requiredSkipped > 0 ? c.yellow(footer) : footer);

  if (summary.requiredSkipped > 0) {
    lines.push(
      c.yellow(
        `${summary.requiredSkipped} required field${summary.requiredSkipped === 1 ? "" : "s"} could not be filled confidently — fill ${summary.requiredSkipped === 1 ? "it" : "them"} in by hand.`,
      ),
    );
  }
  if (run.budgetExhausted) {
    lines.push(c.yellow("Cost budget reached; some files were not processed."));
  }

  return lines.join("\n");
}

/** Named to avoid shadowing `renderFill`'s `format` parameter. */
function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

export function renderFill(
  format: FillReportFormat,
  run: FillRun,
  opts: { color?: boolean } = {},
): string {
  return format === "json" ? renderFillJson(run) : renderFillPretty(run, opts);
}
