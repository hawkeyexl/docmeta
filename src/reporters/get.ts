/**
 * Reporter for `get`.
 *
 * `render()` in ./index.ts is keyed to ValidationResult/RunSummary, so `get`
 * gets its own renderer, exactly as `fill` does. It lived inline in
 * `src/cli.ts` until `--quiet` arrived and made the question "who decides what
 * is printed?" answerable in two places at once.
 *
 * `--quiet` is a **reporter** concern, not a core one. `GetOptions` /
 * `GetFileResult` are public API, and a programmatic caller handed a silently
 * filtered array cannot tell a filtered run from an empty one — so `runGet`
 * returns every file it read, and the filtering happens here, where it only
 * affects text a person is reading.
 */
import type { GetFileResult } from "../commands/get.js";
import { palette } from "./color.js";

export interface GetReportOptions {
  color?: boolean;
  /** In pretty output, omit files where every requested field is unset. */
  quiet?: boolean;
}

/** `(unset)` for a missing field; JSON for anything that is not a string. */
export function stringifyValue(value: unknown): string {
  if (value === undefined) return "(unset)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * One `<file>: <field>=<value>` line per requested field per file.
 *
 * `quiet` hides a file only when **every** requested field is unset. A file
 * where one field resolved and another did not is still printed, `(unset)`
 * included: the flag hides files, never values, so `--quiet` can never be the
 * reason a value the user asked for went missing.
 */
export function renderGet(
  results: GetFileResult[],
  fields: string[],
  opts: GetReportOptions = {},
): string {
  const c = palette(opts.color ?? false);
  const lines: string[] = [];
  for (const r of results) {
    // Checked before `quiet`, deliberately. An unparseable file resolves no
    // values, so the quiet rule below would hide the one file the reader most
    // needs to see — and `--quiet` must never be the reason a missing value
    // goes unexplained, which is the same rule that keeps it hiding files
    // rather than values.
    if (r.error !== undefined) {
      lines.push(`${c.dim(`${r.file}:`)} ${c.red(`(parse) ${r.error}`)}`);
      continue;
    }
    if (opts.quiet && fields.every((f) => r.values[f] === undefined)) continue;
    for (const f of fields) {
      lines.push(`${c.dim(`${r.file}:`)} ${f}=${stringifyValue(r.values[f])}`);
    }
  }
  return lines.join("\n");
}
