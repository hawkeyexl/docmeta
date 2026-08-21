/**
 * Reporter for `schemas infer`.
 *
 * The report **is** the product of this command, so the columns are chosen to
 * answer exactly one question each (0010 stress test 1):
 *
 * - **coverage** — require it now (~100%), require it behind a
 *   `--write-baseline` ratchet (middling), or do not require it at all (low
 *   single digits: one team's convention, not a standard).
 * - **types** — a distribution with counts, so a `string ×900, number ×4` split
 *   reads as four data errors rather than as a union worth encoding.
 * - **sample** — what the values actually look like, which is what tells you
 *   whether the key means what its name suggests.
 *
 * Files with no metadata block are on their own line rather than folded into a
 * denominator: they pass a require-nothing schema and fail the moment any key
 * becomes required, which is the surprise the report exists to prevent.
 */
import type { InferKeyReport, InferResult } from "../commands/schemas.js";
import { palette } from "./color.js";

export interface InferReportOptions {
  color?: boolean;
}

/** Outliers listed inline before the report defers to the count. */
const OUTLIERS_SHOWN = 5;

/** Enum values listed in the sample column before it elides the rest. */
const ENUM_SHOWN = 3;

const SAMPLE_WIDTH = 46;

/** Thousands separators, pinned to one locale so output is machine-stable. */
function count(n: number): string {
  return n.toLocaleString("en-US");
}

function percent(n: number): string {
  return `${n.toFixed(1)}%`;
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** `"Getting started"` — JSON spelling, so a string is visibly a string. */
export function sampleCell(key: InferKeyReport): string {
  if (key.enumValues) {
    const shown = key.enumValues
      .slice(0, ENUM_SHOWN)
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
    if (key.enumValues.length > ENUM_SHOWN) shown.push("…");
    return truncate(shown.join(" | "), SAMPLE_WIDTH);
  }
  if (key.sample === undefined) return "";
  return truncate(JSON.stringify(key.sample) ?? "", SAMPLE_WIDTH);
}

/** `string`, `string (date)`, `string (7 enum)`, or `string ×900, number ×4`. */
export function typesCell(key: InferKeyReport): string {
  if (key.types.length > 1) {
    return key.types.map((t) => `${t.type} ×${count(t.count)}`).join(", ");
  }
  if (key.enumValues) return `${key.dominantType} (${key.enumValues.length} enum)`;
  if (key.format) return `${key.dominantType} (${key.format})`;
  return key.dominantType;
}

export function renderInfer(
  result: InferResult,
  opts: InferReportOptions = {},
): string {
  const c = palette(opts.color ?? false);
  const lines: string[] = [];

  const headline = [
    `${count(result.filesScanned)} file${result.filesScanned === 1 ? "" : "s"} scanned`,
  ];
  headline.push(
    `${count(result.filesWithoutMetadata)} with no metadata block`,
  );
  if (result.unreadable.length > 0) {
    headline.push(`${count(result.unreadable.length)} unreadable`);
  }
  lines.push(headline.join(c.dim(" · ")));

  if (result.keys.length === 0) {
    lines.push("", c.dim("No metadata keys found."));
    return lines.join("\n");
  }

  const rows = result.keys.map((k) => ({
    key: k.key,
    coverage: percent(k.coverage),
    types: typesCell(k),
    sample: sampleCell(k),
  }));
  const width = (pick: (r: (typeof rows)[number]) => string, head: string) =>
    Math.max(head.length, ...rows.map((r) => pick(r).length));
  const wKey = width((r) => r.key, "key");
  const wCov = width((r) => r.coverage, "coverage");
  const wTypes = width((r) => r.types, "types");

  lines.push(
    "",
    c.dim(
      `${"key".padEnd(wKey)}  ${"coverage".padStart(wCov)}  ${"types".padEnd(wTypes)}  sample`,
    ),
  );
  for (const r of rows) {
    lines.push(
      `${c.cyan(r.key.padEnd(wKey))}  ${r.coverage.padStart(wCov)}  ${r.types.padEnd(wTypes)}  ${c.dim(r.sample)}`,
    );
  }

  if (result.hiddenByMinCoverage > 0) {
    lines.push(
      "",
      c.dim(
        `${count(result.hiddenByMinCoverage)} key(s) below --min-coverage are not shown.`,
      ),
    );
  }

  const withOutliers = result.keys.filter((k) => k.outlierCount > 0);
  if (withOutliers.length > 0) {
    lines.push(
      "",
      c.bold("Type outliers — these are data errors, not a union:"),
    );
    for (const k of withOutliers) {
      for (const o of k.outliers.slice(0, OUTLIERS_SHOWN)) {
        const at = o.line === undefined ? o.file : `${o.file}:${o.line}`;
        lines.push(`  ${k.key}  ${at}  ${o.type} (expected ${k.dominantType})`);
      }
      const rest = k.outlierCount - Math.min(k.outliers.length, OUTLIERS_SHOWN);
      if (rest > 0) lines.push(c.dim(`  ${k.key}  …and ${count(rest)} more`));
    }
  }

  for (const u of result.unreadable) {
    lines.push("", `${c.yellow("!")} ${u.file}: ${u.message}`);
  }

  if (result.out !== undefined) {
    const properties = Object.keys(
      (result.draft.properties ?? {}) as Record<string, unknown>,
    ).length;
    lines.push(
      "",
      `Wrote a draft schema to ${c.cyan(result.out)} — ${count(properties)} propert${properties === 1 ? "y" : "ies"}, nothing required.`,
      c.dim(
        "Nothing is required on purpose: what your docset contains is not the same as what your standard should demand. Promote a key with `validate --write-baseline` behind it.",
      ),
    );
  }

  return lines.join("\n");
}
