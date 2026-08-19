import { afterEach, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as AjvDraft04Ns from "ajv-draft-04";
import {
  DOMParser,
  type Document as XmlDocument,
  type Element as XmlElement,
} from "@xmldom/xmldom";
import {
  SARIF_NO_GIT_ROOT,
  render,
  renderPretty,
  renderJson,
  renderGithub,
  renderJunit,
  renderSarif,
  type ReportFormat,
} from "../src/reporters/index.js";
import { fingerprint, type FingerprintContext } from "../src/core/baseline.js";
import { runValidate } from "../src/commands/validate.js";
import { makeTempRepo, removeTempRepo } from "./helpers/temp-repo.js";
import type {
  BaselineSummary,
  RunSummary,
  ValidationResult,
} from "../src/types.js";

const ESC = String.fromCharCode(27);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

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

// ---------------------------------------------------------------------------
// The format list is one list now, so `render` can no longer fall through to
// pretty for a value the caller invented.
// ---------------------------------------------------------------------------
describe("reporters: the format list", () => {
  it("rejects a format it does not implement rather than silently rendering pretty", () => {
    expect(() => render("yaml" as ReportFormat, results, summary)).toThrow(
      /Unknown report format/,
    );
  });

  it("routes every documented format to its own renderer", () => {
    expect(render("json", results, summary)).toBe(renderJson(results, summary));
    expect(render("github", results, summary)).toBe(renderGithub(results));
    expect(render("sarif", results, summary)).toBe(renderSarif(results));
    expect(render("junit", results, summary)).toBe(renderJunit(results));
  });
});

// ---------------------------------------------------------------------------
// SARIF
// ---------------------------------------------------------------------------

/** Only the parts of the envelope these tests reach into. */
interface SarifLog {
  version: string;
  runs: {
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: { id: string; shortDescription: { text: string } }[];
      };
    };
    results: {
      ruleId: string;
      level: string;
      message: { text: string };
      partialFingerprints: Record<string, string>;
      locations: {
        physicalLocation: {
          artifactLocation: { uri: string };
          region?: { startLine: number };
        };
      }[];
    }[];
  }[];
}

const parseSarif = (text: string): SarifLog => JSON.parse(text) as SarifLog;
const sarifRun = (text: string): SarifLog["runs"][number] => {
  const run = parseSarif(text).runs[0];
  if (!run) throw new Error("SARIF envelope carried no run");
  return run;
};

// The meta-schema is vendored (test/fixtures/sarif-2.1.0.schema.json) so the
// conformance check never touches the network, and draft-04 is the dialect the
// OASIS TC published it in — stock Ajv 8 refuses to compile it.
type AjvCtor = typeof import("ajv/dist/2020.js").default;
const AjvDraft04 = AjvDraft04Ns.default as unknown as AjvCtor;
const metaSchema = JSON.parse(
  readFileSync(join(repoRoot, "test/fixtures/sarif-2.1.0.schema.json"), "utf8"),
) as Record<string, unknown>;
const validateSarif = new AjvDraft04({
  allErrors: true,
  strict: false,
  // The meta-schema annotates uri/date-time formats this writer never emits;
  // leaving them unregistered would only add log noise to a passing test.
  validateFormats: false,
  logger: false,
}).compile(metaSchema);

/** Assert conformance and say *what* failed when it does not. */
function expectValidSarif(text: string): SarifLog {
  const log = parseSarif(text);
  const ok = validateSarif(log);
  expect(
    ok ? [] : (validateSarif.errors ?? []).map((e) => `${e.instancePath} ${e.message}`),
  ).toEqual([]);
  return log;
}

const parseErrorResults: ValidationResult[] = [
  {
    file: "broken.md",
    format: "markdown",
    ok: false,
    schemas: [],
    errors: [
      {
        schema: "(parse)",
        instancePath: "",
        message: "Invalid YAML frontmatter: unexpected end of stream",
        keyword: "parse",
      },
    ],
  },
  {
    file: "unresolvable.md",
    format: "markdown",
    ok: false,
    schemas: [],
    errors: [
      {
        schema: "(parse)",
        instancePath: "",
        message: 'Unknown schema reference "nope:1".',
        keyword: "schema",
      },
    ],
  },
];

const cleanResults: ValidationResult[] = [
  { file: "ok.md", format: "markdown", ok: true, schemas: ["google:okf:0.1"], errors: [] },
];

describe("reporters: sarif", () => {
  it("emits a log that conforms to the SARIF 2.1.0 meta-schema for a failing run", () => {
    const log = expectValidSarif(renderSarif(results));
    expect(log.version).toBe("2.1.0");
    expect(log.runs[0]?.results).toHaveLength(2);
  });

  it("emits a conforming log for a clean run rather than an empty string", () => {
    const text = renderSarif(cleanResults);
    expect(text.length).toBeGreaterThan(0);
    const log = expectValidSarif(text);
    expect(log.runs[0]?.results).toEqual([]);
    expect(log.runs[0]?.tool.driver.rules).toEqual([]);
  });

  it("emits a conforming log for a run whose documents could not be parsed", () => {
    expectValidSarif(renderSarif(parseErrorResults));
  });

  it("names the tool, its version, and where to read about it", () => {
    const driver = sarifRun(renderSarif(results)).tool.driver;
    expect(driver.name).toBe("docmeta");
    expect(driver.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(driver.informationUri).toBe("https://hawkeyexl.github.io/docmeta/");
  });

  it("builds every ruleId from the schema reference and the failing keyword", () => {
    const run = sarifRun(renderSarif(results));
    expect(run.results.map((r) => r.ruleId)).toEqual([
      "google:okf:0.1/required",
      "google:okf:0.1/format",
    ]);
  });

  it("lists each rule that was hit exactly once, and no rule that was not", () => {
    const doubled = [...results, results[1] as ValidationResult];
    const run = sarifRun(renderSarif(doubled));
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual([
      "google:okf:0.1/required",
      "google:okf:0.1/format",
    ]);
  });

  it("gives docmeta's own failures reserved rule ids instead of a garbage one", () => {
    const run = sarifRun(renderSarif(parseErrorResults));
    expect(run.results.map((r) => r.ruleId)).toEqual([
      "docmeta/parse-error",
      "docmeta/schema-error",
    ]);
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual([
      "docmeta/parse-error",
      "docmeta/schema-error",
    ]);
    expect(JSON.stringify(run)).not.toContain("(parse)/");
  });

  it("reports every finding at error level, because docmeta has no severity to map", () => {
    const run = sarifRun(renderSarif([...results, ...parseErrorResults]));
    expect(run.results.every((r) => r.level === "error")).toBe(true);
  });

  it("carries exactly the baseline's fingerprint, so the two identities cannot drift", () => {
    const frame: FingerprintContext = { cwd: repoRoot, base: repoRoot };
    const run = sarifRun(renderSarif(results, { frame }));
    const violation = results[1]?.errors[0];
    if (!violation) throw new Error("fixture lost its violation");
    expect(run.results[0]?.partialFingerprints).toEqual({
      "docmetaViolation/v1": fingerprint(violation, frame),
    });
  });

  it("omits the region entirely when no source line is known", () => {
    const noLine: ValidationResult[] = [
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
          },
        ],
      },
    ];
    const log = expectValidSarif(renderSarif(noLine));
    const location = log.runs[0]?.results[0]?.locations[0]?.physicalLocation;
    expect(location?.artifactLocation.uri).toBe("bad.md");
    expect(location).not.toHaveProperty("region");
  });

  it("never emits a startColumn, which no extractor populates", () => {
    expect(renderSarif(results)).not.toContain("startColumn");
  });

  it("skips the stdin label, which is not a path any consumer can resolve", () => {
    const piped: ValidationResult[] = [
      { ...(results[1] as ValidationResult), file: "<stdin>" },
      results[1] as ValidationResult,
    ];
    const run = sarifRun(renderSarif(piped));
    expect(run.results).toHaveLength(2);
    expect(JSON.stringify(run)).not.toContain("<stdin>");
  });

  it("is never colored, even when the run asked for color", () => {
    const out = render("sarif", results, summary, { color: true });
    expect(out.includes(ESC)).toBe(false);
  });
});

// The 0004-class bug: a uri that does not resolve against the repository root
// makes an upload succeed with zero alerts, silently.
describe("reporters: sarif paths are repository-root-relative", () => {
  let repo: string | undefined;

  afterEach(() => {
    removeTempRepo(repo);
    repo = undefined;
  });

  const uriOf = (text: string): string | undefined =>
    sarifRun(text).results[0]?.locations[0]?.physicalLocation.artifactLocation.uri;

  const BAD = "---\ntitle: No type here\n---\n\n# t\n";

  it("yields the same uri from the repository root and from a subdirectory", async () => {
    repo = makeTempRepo({ files: { "docs/api.md": BAD } });
    const fromRoot = await runValidate({
      inputs: ["docs/api.md"],
      cwd: repo,
      noConfig: true,
      cliSchemas: ["google:okf:0.1"],
    });
    const fromSub = await runValidate({
      inputs: ["api.md"],
      cwd: join(repo, "docs"),
      noConfig: true,
      cliSchemas: ["google:okf:0.1"],
    });

    expect(fromRoot.results[0]?.file).toBe("docs/api.md");
    expect(fromSub.results[0]?.file).toBe("api.md");
    expect(uriOf(renderSarif(fromRoot.results, { frame: fromRoot.frame }))).toBe(
      "docs/api.md",
    );
    expect(uriOf(renderSarif(fromSub.results, { frame: fromSub.frame }))).toBe(
      "docs/api.md",
    );
  });

  // Dropping is the only truthful option — GitHub cannot resolve the path
  // either — but a silent drop is the very failure this reporter guards against.
  it("drops a finding that lies outside the repository, and says so", () => {
    repo = makeTempRepo({ files: { "docs/api.md": BAD } });
    const frame: FingerprintContext = { cwd: repo, base: repo, runBase: repo };
    const outside: ValidationResult[] = [
      { ...(results[1] as ValidationResult), file: "../elsewhere/x.md" },
    ];
    const notices: string[] = [];
    const text = renderSarif(outside, {
      frame,
      onNotice: (m) => notices.push(m),
    });
    expect(sarifRun(text).results).toEqual([]);
    expect(notices.some((m) => m.includes("outside the repository"))).toBe(true);
  });

  it("says so on stderr when there is no repository to rebase onto", async () => {
    repo = makeTempRepo({ files: { "docs/api.md": BAD }, init: false });
    const run = await runValidate({
      inputs: ["api.md"],
      cwd: join(repo, "docs"),
      noConfig: true,
      cliSchemas: ["google:okf:0.1"],
    });
    const notices: string[] = [];
    const text = renderSarif(run.results, {
      frame: run.frame,
      onNotice: (m) => notices.push(m),
    });
    expect(notices).toEqual([SARIF_NO_GIT_ROOT]);
    expect(uriOf(text)).toBe("api.md");
  });
});

// ---------------------------------------------------------------------------
// JUnit
// ---------------------------------------------------------------------------

/** Parse strictly: xmldom throws on a fatal error and reports the rest here. */
function parseXml(xml: string): XmlDocument {
  const problems: string[] = [];
  const doc = new DOMParser({
    onError: (level, message) => problems.push(`${level}: ${message}`),
  }).parseFromString(xml, "text/xml");
  expect(problems).toEqual([]);
  return doc;
}

const attr = (el: XmlElement | null | undefined, name: string): string | null =>
  el ? el.getAttribute(name) : null;

describe("reporters: junit", () => {
  it("counts one test per file, not one per violation, so the tab matches the summary", () => {
    const doc = parseXml(renderJunit(results));
    const suites = doc.documentElement;
    expect(suites?.nodeName).toBe("testsuites");
    expect(attr(suites, "tests")).toBe("2");
    expect(attr(suites, "failures")).toBe("1");
    expect(attr(suites, "errors")).toBe("0");

    const cases = doc.getElementsByTagName("testcase");
    expect(cases.length).toBe(2);
    expect(attr(cases[0], "name")).toBe("ok.md");
    expect(attr(cases[0], "classname")).toBe("docmeta.validate");
    expect(attr(cases[1], "name")).toBe("bad.md");
    expect(doc.getElementsByTagName("failure").length).toBe(2);
  });

  it("types each failure with the same rule id sarif uses", () => {
    const doc = parseXml(renderJunit(results));
    const failures = doc.getElementsByTagName("failure");
    expect(attr(failures[0], "type")).toBe("google:okf:0.1/required");
    expect(attr(failures[1], "type")).toBe("google:okf:0.1/format");
    expect(attr(failures[0], "message")).toBe(
      "(root) must have required property 'type' (line 1)",
    );
  });

  it("uses only attributes Jenkins, GitLab, and Azure all honor", () => {
    const xml = renderJunit(results);
    expect(xml).not.toContain("time=");
    expect(xml).not.toContain("system-out");
  });

  it("emits a full envelope for a clean run rather than an empty string", () => {
    const xml = renderJunit(cleanResults);
    expect(xml.length).toBeGreaterThan(0);
    const doc = parseXml(xml);
    expect(attr(doc.documentElement, "failures")).toBe("0");
    expect(doc.getElementsByTagName("failure").length).toBe(0);
  });

  it("is never colored, even when the run asked for color", () => {
    const out = render("junit", results, summary, { color: true });
    expect(out.includes(ESC)).toBe(false);
  });
});

// Escaping is the likeliest bug in a hand-rolled writer: schema-authored text
// reaches the report verbatim, and a `pattern` regex may hold any of `& < > " '`.
describe("reporters: junit escaping", () => {
  it("escapes every metacharacter a schema pattern can put in a message", async () => {
    const run = await runValidate({
      inputs: ["test/fixtures/xml-hostile.md"],
      cwd: repoRoot,
      noConfig: true,
      cliSchemas: ["./test/fixtures/xml-hostile.schema.json"],
    });
    const message = run.results[0]?.errors[0]?.message;
    expect(message).toContain("<");
    expect(message).toContain("&");
    expect(message).toContain('"');

    const xml = renderJunit(run.results);
    // Nothing may leave the writer as a bare `&` or `<`.
    expect(xml).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
    expect(xml).toContain("&lt;a href=&quot;x&quot;&gt;&amp;amp;&lt;/a&gt;");

    const doc = parseXml(xml);
    const failure = doc.getElementsByTagName("failure")[0];
    expect(attr(failure, "message")).toContain(message);
  });

  it("escapes a file path holding an ampersand", () => {
    const amp: ValidationResult[] = [
      { ...(results[1] as ValidationResult), file: "docs/a&b/<x>.md" },
    ];
    const xml = renderJunit(amp);
    expect(xml).toContain('name="docs/a&amp;b/&lt;x&gt;.md"');
    expect(xml).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
    const doc = parseXml(xml);
    expect(attr(doc.getElementsByTagName("testcase")[0], "name")).toBe(
      "docs/a&b/<x>.md",
    );
  });
});

describe("junit and sarif agree on rule identity", () => {
  // A consumer correlating a SARIF `ruleId` with a JUnit `<failure type>` for
  // the same run must see the same string. Built-in ids are stable either way;
  // a *local file* schema ref is the case that diverges, because the canonical
  // form is measured against the config directory while the raw ref is relative
  // to wherever the command was run.
  const frame = {
    cwd: "/repo/docs",
    base: "/repo",
    runBase: "/repo/docs",
  };
  const localRefResults: ValidationResult[] = [
    {
      file: "a.md",
      format: "markdown",
      ok: false,
      schemas: ["../my.schema.json"],
      errors: [
        {
          schema: "../my.schema.json",
          instancePath: "",
          message: "must have required property 'owner'",
          keyword: "required",
          subject: "owner",
          line: 1,
        },
      ],
    },
  ];

  it("uses the canonical schema ref in the JUnit failure type", () => {
    const out = renderJunit(localRefResults, { frame });
    expect(out).toContain('type="my.schema.json/required"');
    expect(out).not.toContain('type="../my.schema.json/required"');
  });

  it("produces the same identity as the SARIF ruleId", () => {
    const junit = renderJunit(localRefResults, { frame });
    const sarif = JSON.parse(renderSarif(localRefResults, { frame })) as {
      runs: { results: { ruleId: string }[] }[];
    };
    const ruleId = sarif.runs[0]?.results[0]?.ruleId ?? "";
    expect(ruleId).toBe("my.schema.json/required");
    expect(junit).toContain(`type="${ruleId}"`);
  });
});
