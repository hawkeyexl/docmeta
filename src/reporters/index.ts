/**
 * Reporters render validation results to a string. The command layer writes
 * the result to stdout; diagnostics go to stderr separately.
 */
import {
  DocmetaError,
  type BaselineSummary,
  type RunSummary,
  type ValidationResult,
} from "../types.js";
import type { FingerprintContext } from "../core/baseline.js";
import { palette } from "./color.js";
import { fieldLabel } from "./rule-id.js";
import { renderSarif, type SarifOptions } from "./sarif.js";
import { renderJunit } from "./junit.js";
import {
  escapeWorkflowCommandMessage,
  escapeWorkflowCommandProperty,
} from "./github.js";

export { renderSarif, SARIF_NO_GIT_ROOT } from "./sarif.js";
export type { SarifOptions } from "./sarif.js";
export { renderJunit, xmlEscape } from "./junit.js";
export {
  escapeWorkflowCommandMessage,
  escapeWorkflowCommandProperty,
} from "./github.js";
export {
  PARSE_ERROR_RULE,
  SCHEMA_ERROR_RULE,
  ruleIdFor,
} from "./rule-id.js";

/**
 * Every value `--format` accepts, in the order help and error messages list
 * them.
 *
 * The list is stated **once**. It used to live in five unlinked places — this
 * union, a separate `Set<string>` in the CLI, the error message, the option
 * description, and the docs — and the `Set` was not tied to the union at all,
 * so widening the union alone type-checked and still rejected the new value at
 * runtime. Deriving the union from the array makes that drift impossible.
 */
export const REPORT_FORMATS = [
  "pretty",
  "json",
  "github",
  "sarif",
  "junit",
] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

/**
 * A format list as a sentence fragment: `"pretty or json"`,
 * `"pretty, json, or github"`.
 *
 * The two-value case is why this is a function rather than one `join`. A pair
 * takes no comma before "or", and `get` and `schemas` have said "Use pretty or
 * json." since long before the list was shared — a mechanical
 * `map(...).join(", ")` would have quietly reworded every one of those messages
 * to "pretty, or json".
 */
export function formatList(formats: readonly string[]): string {
  // Destructured and guarded rather than indexed. `noUncheckedIndexedAccess`
  // types `formats[0]` as `string | undefined` however the length was checked,
  // so the interpolation below would happily print "undefined" — these two
  // guards say what `length < 2` said, in a form the compiler can carry.
  const [first, second] = formats;
  if (first === undefined) return "";
  if (second === undefined) return first;
  // Still needed, and not redundant however it reads: a defined `second` proves
  // there are *at least* two, not exactly two. Three or more falls through to
  // the comma-joined form below.
  if (formats.length === 2) return `${first} or ${second}`;
  return formats
    .map((format, i) => (i === formats.length - 1 ? `or ${format}` : format))
    .join(", ");
}

/** `"pretty, json, github, sarif, or junit"`, for messages and help text. */
export const REPORT_FORMAT_LIST = formatList(REPORT_FORMATS);

export function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * The formats **every** command produces.
 *
 * `get` and `schemas` accept exactly these two, and each used to spell the pair
 * out inline in `src/cli.ts` as `format !== "pretty" && format !== "json"` with
 * a hand-written "Use pretty or json." beside it — the same stringly-typed
 * drift this module's `REPORT_FORMATS` comment describes, reproduced three more
 * times. Stated once, the guard and the message cannot disagree.
 */
export const COMMON_FORMATS = ["pretty", "json"] as const;

export type CommonFormat = (typeof COMMON_FORMATS)[number];

/** `"pretty or json"`, for messages and help text. */
export const COMMON_FORMAT_LIST = formatList(COMMON_FORMATS);

export function isCommonFormat(value: string): value is CommonFormat {
  return (COMMON_FORMATS as readonly string[]).includes(value);
}

/**
 * Formats something other than a person reads.
 *
 * These own stdout completely: a diagnostic printed alongside them (which
 * config governed the run, say) would corrupt the parse. Colored escape codes
 * would too, which is why the same predicate answers both questions.
 */
export const MACHINE_FORMATS: ReadonlySet<ReportFormat> = new Set<ReportFormat>(
  ["json", "github", "sarif", "junit"],
);

export const isMachineFormat = (format: ReportFormat): boolean =>
  MACHINE_FORMATS.has(format);

/**
 * Formats whose output may legitimately be empty.
 *
 * `github` prints one annotation per finding, so a clean run has nothing to
 * say. Every other format has an **envelope** that must arrive even when it
 * holds nothing: a zero-byte SARIF file makes `upload-sarif` fail outright, and
 * a zero-byte JUnit file reads as a lost report rather than a passing one. So
 * emptiness is a property of the format, not of the text — which is what the
 * CLI's old bare `if (text.length > 0)` guard got wrong.
 */
export const OMITTED_WHEN_CLEAN: ReadonlySet<ReportFormat> =
  new Set<ReportFormat>(["github"]);

export interface ReportOptions extends SarifOptions {
  color?: boolean;
  /** In pretty output, omit passing files. */
  quiet?: boolean;
}

export type { FingerprintContext };

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

  // Files `.gitignore` took away are named on the summary line, not left to be
  // inferred from a count that quietly shrank. A gate getting quieter without
  // being asked is the dangerous direction of change; this is what makes it
  // auditable. Omitted at zero, which is every run in a clean repo.
  const skipped =
    summary.gitignoreSkipped != null && summary.gitignoreSkipped > 0
      ? `, ${summary.gitignoreSkipped} skipped by .gitignore`
      : "";
  const summaryText = `${summary.files} file${summary.files === 1 ? "" : "s"} checked, ${summary.passed} passed, ${summary.failed} failed, ${summary.errors} error${summary.errors === 1 ? "" : "s"}${skipped}`;
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
      const params = [`file=${escapeWorkflowCommandProperty(r.file)}`];
      if (e.line != null) params.push(`line=${e.line}`);
      if (e.col != null) params.push(`col=${e.col}`);
      // Escaped as one string, after assembly: the schema id and the field
      // label are as capable of carrying a `%` as the message is.
      const msg = escapeWorkflowCommandMessage(
        `[${e.schema}] ${fieldLabel(e.instancePath)} ${e.message}`,
      );
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
    case "sarif":
      return renderSarif(results, opts);
    case "junit":
      return renderJunit(results, opts);
    case "pretty":
      return renderPretty(results, summary, opts);
    default: {
      // Exhaustive: adding a format to `REPORT_FORMATS` without a case here is
      // a compile error. The throw is for the runtime half — `render` is public
      // API, and before this existed a caller passing "sarif" fell through to
      // `pretty` and got a human report where it asked for a machine one.
      const unreachable: never = format;
      throw new DocmetaError(
        `Unknown report format ${JSON.stringify(unreachable)}. Use ${REPORT_FORMAT_LIST}.`,
      );
    }
  }
}
