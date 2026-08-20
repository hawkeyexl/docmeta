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
import { DocmetaError } from "../types.js";
import type { FillRun } from "../commands/fill-types.js";
import { palette } from "./color.js";
import { escapeWorkflowCommandMessage } from "./github.js";
import { formatList } from "./index.js";

/**
 * Every value `fill -f` accepts, in the order help and error messages list
 * them. Derived union, one statement of the list — the same rule
 * `REPORT_FORMATS` documents at length in ./index.ts, which this file used to
 * break by spelling `"pretty" | "json"` out a second time.
 *
 * `sarif` and `junit` are deliberately absent: they describe *findings in
 * files*, and a skipped optional property is a proposal with a confidence
 * score, not a finding. See 0003 § stress test 8.
 */
export const FILL_FORMATS = ["pretty", "json", "github"] as const;

export type FillReportFormat = (typeof FILL_FORMATS)[number];

/** `"pretty, json, or github"`, for messages and help text. */
export const FILL_FORMAT_LIST = formatList(FILL_FORMATS);

export function isFillFormat(value: string): value is FillReportFormat {
  return (FILL_FORMATS as readonly string[]).includes(value);
}

export interface FillReportOptions {
  color?: boolean;
  /**
   * In pretty output, omit files with nothing to report.
   *
   * "Nothing" is narrow on purpose — see `renderFillPretty`.
   */
  quiet?: boolean;
}

export function renderFillJson(run: FillRun): string {
  return JSON.stringify(run, null, 2);
}

const score = (n: number): string => n.toFixed(2);

export function renderFillPretty(
  run: FillRun,
  opts: FillReportOptions = {},
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
    // What `--quiet` may hide, and it is a short list. "Files with no
    // proposals" would be a no-op — the guard above already drops those — so
    // the only files left to drop are the ones with nothing *written*, and
    // those are precisely the files carrying a required skip, which is what
    // makes the run exit 1. Hiding them would hide the reason for the failure,
    // so a required skip (like an error, handled above) always prints.
    const requiredSkipped = result.fields.some((f) => f.required && !f.written);
    if (opts.quiet && written.length === 0 && !requiredSkipped) continue;
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
    // Which provider ran decides what the proposals and the cost mean, and
    // under `auto` it is not something the user chose — so say it rather than
    // making them pass -f json to find out.
    `${run.provider}/${run.model}`,
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

/**
 * GitHub Actions annotations for the work `fill` could **not** do.
 *
 * One `::error` per property the schema requires that was not filled — the same
 * set that drives `fill`'s exit code 1. Optional skips stay silent, matching
 * the exit-code rule: a skipped optional property is a normal outcome, and
 * annotating it would make every run look broken.
 *
 * No `line=`. A `FilledField` carries no location — unlike a validation error,
 * a proposal is about a property that is *missing* from the document, so there
 * is nothing to point at. GitHub anchors a file-only annotation to line 1.
 *
 * The escaping is `escapeWorkflowCommandMessage`, shared with `validate`'s
 * renderer rather than re-derived: the `%`-before-newline ordering is the part
 * that is easy to get wrong.
 */
export function renderFillGithub(run: FillRun): string {
  const lines: string[] = [];
  for (const result of run.results) {
    for (const f of result.fields) {
      if (!f.required || f.written) continue;
      const why =
        f.skipReason === "low-confidence"
          ? `confidence ${score(f.confidence)} is below the ${run.threshold} threshold`
          : (f.skipReason ?? "skipped");
      const msg = escapeWorkflowCommandMessage(
        `[fill] ${f.field} is required and was not filled (${why})`,
      );
      lines.push(`::error file=${result.file}::${msg}`);
    }
  }
  return lines.join("\n");
}

export function renderFill(
  format: FillReportFormat,
  run: FillRun,
  opts: FillReportOptions = {},
): string {
  switch (format) {
    case "json":
      return renderFillJson(run);
    case "github":
      return renderFillGithub(run);
    case "pretty":
      return renderFillPretty(run, opts);
    default: {
      // Exhaustive, like `render()`: adding a format to `FILL_FORMATS` without
      // a case here is a compile error, and the throw covers the runtime half —
      // `renderFill` is public API, and a caller asking for a machine format
      // must not be handed a human report instead.
      const unreachable: never = format;
      throw new DocmetaError(
        `Unknown report format ${JSON.stringify(unreachable)}. Use ${FILL_FORMAT_LIST}.`,
      );
    }
  }
}
