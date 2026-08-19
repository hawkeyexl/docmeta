/**
 * JUnit XML — what CI systems parse for the "Tests" tab.
 *
 * There is no authoritative JUnit schema; Jenkins, GitLab, CircleCI, and Azure
 * each accept a different superset. This writer sticks to the attributes all of
 * them honor (`name`, `tests`, `failures`, `errors`, `classname`, `type`,
 * `message`) and avoids the contested ones — `time`, which would be meaningless
 * here, `system-out`, and nested suites. That is a compatibility judgement, not
 * a specification.
 *
 * **One `<testcase>` per file, one `<failure>` per violation.** So the tab reads
 * "2 tests, 1 failed" and matches `2 files checked, 1 failed`.
 * Violation-as-testcase would make the test count rise and fall with document
 * quality, which reads as a suite someone broke.
 *
 * Escaping is the one thing a hand-rolled writer gets wrong. Messages carry
 * schema-authored text — a `pattern` regex may hold `<`, `&`, and quotes — and
 * paths can hold `&`. Every attribute value goes through `xmlEscape`; nothing
 * is interpolated raw.
 */
import type { FingerprintContext } from "../core/baseline.js";
import type { ValidationResult } from "../types.js";
import { fieldLabel, ruleIdFor } from "./rule-id.js";

/** Suite and classname. One suite per run; nested suites are not portable. */
const SUITE_NAME = "docmeta";
const CLASS_NAME = "docmeta.validate";

const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Escape every XML metacharacter, and drop the control characters XML 1.0
 * forbids outright.
 *
 * `>` and `'` do not strictly need escaping in every position, but escaping all
 * five unconditionally means no caller has to know which position it is in —
 * which is precisely the reasoning a partial escaper gets wrong. The control
 * character strip is separate: those cannot be represented in XML 1.0 at all,
 * escaped or not, so a stray one makes the whole document unparseable rather
 * than merely mis-rendered. Tab, newline, and carriage return are legal, and
 * kept.
 */
export function xmlEscape(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && ch !== "\t" && ch !== "\n" && ch !== "\r") continue;
    out += XML_ENTITIES[ch] ?? ch;
  }
  return out;
}

const attr = (name: string, value: string): string =>
  ` ${name}="${xmlEscape(value)}"`;

export interface JunitOptions {
  /**
   * The run's path frame, used only to canonicalize a local-file schema ref in
   * `<failure type>`.
   *
   * Without it the attribute carries the ref exactly as the run received it —
   * `./my.schema.json` from the repo root, `../my.schema.json` from a
   * subdirectory, or a machine-absolute path once config discovery has rebased
   * it. SARIF's `ruleId` is already canonical, so a consumer correlating the two
   * for one run would find them disagreeing on the same violation.
   */
  frame?: FingerprintContext;
}

export function renderJunit(
  results: ValidationResult[],
  opts: JunitOptions = {},
): string {
  const tests = results.length;
  const failures = results.filter((r) => r.errors.length > 0).length;

  const counts =
    attr("name", SUITE_NAME) +
    attr("tests", String(tests)) +
    attr("failures", String(failures)) +
    // Every violation is a `<failure>`; `errors` is reserved for a test that
    // could not run, which has no analogue here. Emitted as 0 rather than
    // omitted, because consumers read the attribute and show a blank column
    // without it.
    attr("errors", "0");

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites${counts}>`,
    `  <testsuite${counts}>`,
  ];

  for (const r of results) {
    const open = `    <testcase${attr("name", r.file)}${attr("classname", CLASS_NAME)}`;
    if (r.errors.length === 0) {
      // Self-closing: a passing test has nothing to carry.
      lines.push(`${open}/>`);
      continue;
    }
    lines.push(`${open}>`);
    for (const e of r.errors) {
      const where = e.line != null ? ` (line ${e.line})` : "";
      lines.push(
        `      <failure${attr("type", ruleIdFor(e, opts.frame))}${attr(
          "message",
          `${fieldLabel(e.instancePath)} ${e.message}${where}`,
        )}/>`,
      );
    }
    lines.push("    </testcase>");
  }

  lines.push("  </testsuite>", "</testsuites>");
  return lines.join("\n");
}
