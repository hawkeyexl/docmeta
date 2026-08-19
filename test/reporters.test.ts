import { describe, it, expect } from "vitest";
import {
  renderPretty,
  renderJson,
  renderGithub,
} from "../src/reporters/index.js";
import type {
  BaselineSummary,
  RunSummary,
  ValidationResult,
} from "../src/types.js";

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
        keyword: "required",
        subject: "type",
        line: 1,
      },
      {
        schema: "google:okf:0.1",
        instancePath: "/timestamp",
        message: 'must match format "date-time"',
        keyword: "format",
        subject: "date-time",
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

  it("json output carries the machine identity of every violation", () => {
    const parsed = JSON.parse(renderJson(results, summary));
    expect(parsed.results[1].errors[0]).toMatchObject({
      keyword: "required",
      subject: "type",
    });
    expect(parsed.results[1].errors[1]).toMatchObject({
      keyword: "format",
      subject: "date-time",
    });
  });
});

describe("reporters with a baseline", () => {
  const baselined: ValidationResult[] = [
    {
      file: "docs/api/legacy.md",
      format: "markdown",
      ok: true,
      schemas: ["google:okf:0.1"],
      errors: [],
      baselined: 2,
    },
  ];
  const read: BaselineSummary = {
    path: ".docmeta-baseline.json",
    written: false,
    recorded: 3,
    suppressed: 2,
    stale: 1,
  };
  const clean: RunSummary = {
    files: 1,
    passed: 1,
    failed: 0,
    errors: 0,
    baseline: read,
  };

  it("marks how many findings a file's baseline forgave", () => {
    const out = renderPretty(baselined, clean, { color: false });
    expect(out).toContain("✓ docs/api/legacy.md  (2 baselined)");
  });

  it("keeps the debt visible in the summary and names the prune", () => {
    const out = renderPretty(baselined, clean, { color: false });
    expect(out).toContain("1 file checked, 1 passed, 0 failed, 0 errors");
    expect(out).toContain(
      "3 baselined findings, 1 no longer occurs — run --write-baseline to prune",
    );
  });

  it("drops the stale clause when nothing is prunable", () => {
    const out = renderPretty(baselined, {
      ...clean,
      baseline: { ...read, stale: 0, suppressed: 3 },
    }, { color: false });
    expect(out).toContain("3 baselined findings");
    expect(out).not.toContain("no longer");
  });

  it("still reports the baseline count in quiet mode, where the files are hidden", () => {
    const out = renderPretty(baselined, clean, { color: false, quiet: true });
    expect(out).not.toContain("legacy.md");
    expect(out).toContain("3 baselined findings");
  });

  it("reports a write in both directions, so an over-broad re-record is visible", () => {
    const out = renderPretty([], {
      files: 14,
      passed: 14,
      failed: 0,
      errors: 0,
      baseline: {
        path: ".docmeta-baseline.json",
        written: true,
        recorded: 14,
        suppressed: 14,
        stale: 0,
        added: 2,
        removed: 12,
      },
    }, { color: false });
    expect(out).toContain("Baseline written to .docmeta-baseline.json");
    expect(out).toContain("14 findings recorded (+2 new, -12 no longer occur)");
  });
});

// Files .gitignore took away are named, not silently missing from the count.
describe("reporters: the .gitignore skip count", () => {
  it("names it on the pretty summary line", () => {
    const out = renderPretty(results, { ...summary, gitignoreSkipped: 3 }, {
      color: false,
    });
    expect(out).toContain(
      "2 files checked, 1 passed, 1 failed, 2 errors, 3 skipped by .gitignore",
    );
  });

  it("says nothing when nothing was skipped", () => {
    const out = renderPretty(results, summary, { color: false });
    expect(out).not.toContain("skipped by .gitignore");
  });

  it("carries it in json", () => {
    const parsed = JSON.parse(
      renderJson(results, { ...summary, gitignoreSkipped: 3 }),
    ) as { summary: { gitignoreSkipped?: number } };
    expect(parsed.summary.gitignoreSkipped).toBe(3);
  });
});
