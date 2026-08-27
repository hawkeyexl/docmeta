import { describe, it, expect } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/core/config.js";
import {
  assertPublishableBuiltinId,
  classifyRef,
  listBuiltins,
} from "../src/core/schema-registry.js";
import { runChecks, type CheckEntry } from "../src/core/checks.js";
import { runValidate } from "../src/commands/validate.js";
import { runQuery } from "../src/commands/query.js";
import { DocmetaError, type ExtractedMetadata } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, "fixtures", "checks");

/** A minimal corpus entry for runChecks, with optional known line positions. */
function entry(
  label: string,
  data: Record<string, unknown>,
  lines: Record<string, number> = {},
): CheckEntry {
  const extracted: ExtractedMetadata = {
    data,
    present: true,
    format: "markdown",
    lineFor: (pointer) => lines[pointer],
  };
  return { label, extracted };
}

describe("checks: config parsing", () => {
  const src = "docmeta.config.yaml";

  it("parses a checks: list of {name, query}", () => {
    const config = parseConfig(
      [
        "checks:",
        "  - name: unique-slugs",
        '    query: "SELECT _path AS path FROM docs"',
      ].join("\n"),
      src,
    );
    expect(config.checks).toEqual([
      { name: "unique-slugs", query: "SELECT _path AS path FROM docs" },
    ]);
  });

  it("rejects a non-list checks:", () => {
    expect(() => parseConfig("checks: nope", src)).toThrow(DocmetaError);
  });

  it("rejects a non-mapping entry", () => {
    expect(() => parseConfig("checks:\n  - just-a-string", src)).toThrow(
      /checks\[0\]/,
    );
  });

  it("rejects an unknown key before the field checks", () => {
    expect(() =>
      parseConfig(
        'checks:\n  - name: a\n    query: "SELECT 1"\n    querry: "typo"',
        src,
      ),
    ).toThrow(/unknown key "querry"/);
  });

  it("refuses a missing name or query by index", () => {
    expect(() => parseConfig('checks:\n  - query: "SELECT 1"', src)).toThrow(
      /checks\[0\]/,
    );
    expect(() => parseConfig("checks:\n  - name: a", src)).toThrow(
      /checks\[0\]/,
    );
  });

  it("enforces the name grammar at parse time", () => {
    for (const bad of [
      "My-Rules",
      "a b",
      "a/b",
      "slugs.json",
      "-lead",
      ".lead",
      "",
    ]) {
      expect(() =>
        parseConfig(
          `checks:\n  - name: ${JSON.stringify(bad)}\n    query: "SELECT 1"`,
          src,
        ),
      ).toThrow(DocmetaError);
    }
  });

  it("rejects two checks sharing one name", () => {
    expect(() =>
      parseConfig(
        [
          "checks:",
          "  - name: dup",
          '    query: "SELECT 1"',
          "  - name: dup",
          '    query: "SELECT 2"',
        ].join("\n"),
        src,
      ),
    ).toThrow(/dup/);
  });

  it("pins classifyRef('check:' + name) as builtin for every accepted name", () => {
    for (const name of ["unique-slugs", "a", "x9", "a.b-c_d", "0start"]) {
      parseConfig(
        `checks:\n  - name: ${JSON.stringify(name)}\n    query: "SELECT 1"`,
        src,
      );
      expect(classifyRef(`check:${name}`).kind).toBe("builtin");
    }
  });
});

describe("checks: builtin-id namespace reservation", () => {
  it("refuses a builtin id whose first segment is check", () => {
    expect(() => {
      assertPublishableBuiltinId("check:slugs:1.0");
    }).toThrow(/check/);
  });

  it("every shipped builtin id stays outside the reserved namespace", () => {
    for (const b of listBuiltins()) {
      expect(() => {
        assertPublishableBuiltinId(b.id);
      }).not.toThrow();
      expect(b.id.split(":")[0]).not.toBe("check");
    }
  });
});

describe("runChecks: rows are findings", () => {
  const entries = [
    entry("docs/a.md", { title: "Alpha", slug: "intro" }, { slug: 3 }),
    entry("docs/b.md", { title: "Beta", slug: "intro" }, { slug: 4 }),
    entry("docs/c.md", { title: "Gamma", slug: "solo" }, { slug: 3 }),
  ];

  it("maps path/key/message/line columns onto FieldErrors", async () => {
    const findings = await runChecks(
      [
        {
          name: "unique-slugs",
          query: `SELECT _path AS path, 'slug' AS key,
                    'duplicate slug ' || slug AS message,
                    lineFor(_path, 'slug') AS line
                  FROM docs
                  WHERE slug IN
                    (SELECT slug FROM docs GROUP BY slug HAVING count(*) > 1)`,
        },
      ],
      entries,
    );
    expect([...findings.keys()].sort()).toEqual(["docs/a.md", "docs/b.md"]);
    expect(findings.get("docs/a.md")).toEqual([
      {
        schema: "check:unique-slugs",
        keyword: "check",
        instancePath: "/slug",
        message: "duplicate slug intro",
        line: 3,
      },
    ]);
    expect(findings.get("docs/b.md")?.[0]?.line).toBe(4);
  });

  it("synthesizes the message as col=value pairs when the column is absent", async () => {
    const findings = await runChecks(
      [
        {
          name: "dups",
          query: `SELECT _path AS path, slug, 2 AS n FROM docs
                  WHERE _path = 'docs/a.md'`,
        },
      ],
      entries,
    );
    const err = findings.get("docs/a.md")?.[0];
    expect(err?.message).toBe("slug=intro, n=2");
    expect(err?.instancePath).toBe("");
    expect(err?.line).toBeUndefined();
  });

  it("omits NULL cells from the synthesized message", async () => {
    const findings = await runChecks(
      [
        {
          name: "sparse",
          query: `SELECT _path AS path, slug, NULL AS extra FROM docs
                  WHERE _path = 'docs/a.md'`,
        },
        {
          name: "all-null",
          query: `SELECT 'docs/b.md' AS path, NULL AS only`,
        },
      ],
      entries,
    );
    // A NULL cell says nothing, so it never renders as a literal "null" …
    expect(findings.get("docs/a.md")?.[0]?.message).toBe("slug=intro");
    // … and when every remaining cell is NULL, the generic fallback stands.
    expect(findings.get("docs/b.md")?.[0]?.message).toBe("check matched");
  });

  it("lineFor returns NULL for an unknown path or an unplaceable key", async () => {
    const findings = await runChecks(
      [
        {
          name: "probe",
          query: `SELECT 'docs/a.md' AS path,
                    lineFor('nowhere.md', 'slug') AS line,
                    'x' AS message`,
        },
      ],
      entries,
    );
    expect(findings.get("docs/a.md")?.[0]?.line).toBeUndefined();
  });

  it("refuses a result without a path column, naming the convention", async () => {
    await expect(
      runChecks([{ name: "bad", query: "SELECT slug FROM docs" }], entries),
    ).rejects.toThrow(/path/);
  });

  it("refuses a row whose path the run did not load", async () => {
    await expect(
      runChecks(
        [{ name: "stray", query: "SELECT 'ghost.md' AS path" }],
        entries,
      ),
    ).rejects.toThrow(/stray/);
  });

  it("refuses a check whose SQL does not prepare, naming the check", async () => {
    await expect(
      runChecks([{ name: "broken", query: "SELEC nope" }], entries),
    ).rejects.toThrow(/broken/);
  });
});

describe("validate runs configured checks", () => {
  it("reports check findings and counts them in the summary", async () => {
    const { results, summary } = await runValidate({ inputs: [], cwd: corpus });
    expect(summary.failed).toBe(2);
    const flagged = results.filter((r) =>
      r.errors.some((e) => e.schema === "check:unique-slugs"),
    );
    expect(flagged.map((r) => r.file).sort()).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);
    const err = flagged[0]?.errors[0];
    expect(err?.keyword).toBe("check");
    expect(err?.instancePath).toBe("/slug");
    expect(err?.line).toBe(3);
  });

  it("skips checks on a scoped run, with one notice", async () => {
    const notices: string[] = [];
    const { summary } = await runValidate({
      inputs: ["docs"],
      cwd: corpus,
      onNotice: (m) => notices.push(m),
    });
    expect(summary.failed).toBe(0);
    expect(
      notices.filter((n) => n.includes("corpus checks skipped")),
    ).toHaveLength(1);
  });

  it("--exclude and --no-gitignore also disqualify the run", async () => {
    for (const scoped of [
      { exclude: ["drafts/**"] },
      { respectGitignore: false },
      { exts: [".md"] },
    ]) {
      const notices: string[] = [];
      const { summary } = await runValidate({
        inputs: [],
        cwd: corpus,
        onNotice: (m) => notices.push(m),
        ...scoped,
      });
      expect(summary.failed).toBe(0);
      expect(
        notices.some((n) => n.includes("corpus checks skipped")),
      ).toBe(true);
    }
  });

  it("--no-checks opts out without a notice", async () => {
    const notices: string[] = [];
    const { summary } = await runValidate({
      inputs: [],
      cwd: corpus,
      checks: false,
      onNotice: (m) => notices.push(m),
    });
    expect(summary.failed).toBe(0);
    expect(notices.some((n) => n.includes("corpus checks"))).toBe(false);
  });

  it("check findings baseline like any other finding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docmeta-checks-"));
    try {
      cpSync(corpus, dir, { recursive: true });
      const recorded = await runValidate({
        inputs: [],
        cwd: dir,
        writeBaseline: true,
      });
      expect(recorded.summary.failed).toBe(0);
      expect(recorded.summary.baseline?.recorded).toBe(2);

      const compared = await runValidate({
        inputs: [],
        cwd: dir,
        baseline: true,
      });
      expect(compared.summary.failed).toBe(0);
      expect(compared.summary.baseline?.suppressed).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("query carries the fingerprint frame", () => {
  it("returns a frame alongside the rows", async () => {
    const run = await runQuery({
      sql: "SELECT _path FROM docs",
      inputs: ["docs"],
      cwd: corpus,
      noConfig: true,
    });
    expect(run.frame).toBeDefined();
    expect(run.frame?.cwd).toBe(corpus);
  });
});
