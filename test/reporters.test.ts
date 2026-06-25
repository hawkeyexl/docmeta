import { describe, it, expect } from "vitest";
import {
  renderPretty,
  renderJson,
  renderGithub,
} from "../src/reporters/index.js";
import type { RunSummary, ValidationResult } from "../src/types.js";

const ESC = String.fromCharCode(27);

const results: ValidationResult[] = [
  { file: "ok.md", format: "markdown", ok: true, schemas: ["google:okf:0.1"], errors: [] },
  {
    file: "bad.md",
    format: "markdown",
    ok: false,
    schemas: ["google:okf:0.1"],
    errors: [
      {
        schema: "google:okf:0.1",
        instancePath: "",
        message: "must have required property 'type'",
        line: 1,
      },
      {
        schema: "google:okf:0.1",
        instancePath: "/timestamp",
        message: 'must match format "date-time"',
        line: 9,
      },
    ],
  },
];
const summary: RunSummary = { files: 2, passed: 1, failed: 1, errors: 2 };

describe("reporters", () => {
  it("pretty output shows both files, fields, lines and schema, no ANSI when color off", () => {
    const out = renderPretty(results, summary, { color: false });
    expect(out).toContain("✓ ok.md");
    expect(out).toContain("✗ bad.md");
    expect(out).toContain("(root)");
    expect(out).toContain("/timestamp");
    expect(out).toContain("(line 9)");
    expect(out).toContain("[google:okf:0.1]");
    expect(out).toContain("2 files checked, 1 passed, 1 failed, 2 errors");
    expect(out.includes(ESC)).toBe(false);
  });

  it("pretty output emits ANSI when color on", () => {
    const out = renderPretty(results, summary, { color: true });
    expect(out.includes(ESC)).toBe(true);
  });

  it("pretty quiet mode omits passing files", () => {
    const out = renderPretty(results, summary, { color: false, quiet: true });
    expect(out).not.toContain("ok.md");
    expect(out).toContain("bad.md");
  });

  it("json output is valid and carries schema-tagged errors", () => {
    const parsed = JSON.parse(renderJson(results, summary));
    expect(parsed.summary.failed).toBe(1);
    expect(parsed.results[1].errors[0].schema).toBe("google:okf:0.1");
  });

  it("github output emits ::error workflow commands with file/line/schema", () => {
    const out = renderGithub(results);
    expect(out).toContain("::error file=bad.md,line=1::[google:okf:0.1]");
    expect(out).toContain("line=9");
    expect(out).not.toContain("ok.md");
  });
});
