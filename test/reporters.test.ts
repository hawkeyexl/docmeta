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
  COMMON_FORMATS,
  COMMON_FORMAT_LIST,
  REPORT_FORMAT_LIST,
  SARIF_NO_GIT_ROOT,
  isCommonFormat,
  render,
  renderPretty,
  renderJson,
  renderGithub,
  escapeWorkflowCommandMessage,
  renderJunit,
  renderSarif,
  type ReportFormat,
} from "../src/reporters/index.js";
import { renderGet } from "../src/reporters/get.js";
import {
  FILL_FORMATS,
  FILL_FORMAT_LIST,
  isFillFormat,
  renderFill,
  renderFillGithub,
  renderFillJson,
  renderFillPretty,
  type FillReportFormat,
} from "../src/reporters/fill.js";
import type { GetFileResult } from "../src/commands/get.js";
import type {
  FillFileResult,
  FilledField,
  FillRun,
} from "../src/commands/fill-types.js";
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

describe("sarif: no git repository", () => {
  // Falling back to the fingerprint frame measures URIs against the *config's*
  // directory. For a config outside the tree being validated that yields `../…`
  // for every file, and `artifactUri` drops those — turning "no git repo" into
  // "no findings at all", which is the silent emptiness this reporter exists to
  // avoid. Measure from where the run resolved its inputs instead.
  const outOfTreeConfig = {
    cwd: "/work/proj",
    base: "/work/cfg", // config lives outside the validated tree
    runBase: "/work/proj",
  };
  const one: ValidationResult[] = [
    {
      file: "docs/a.md",
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
      ],
    },
  ];

  it("still emits the finding when there is no repository root", () => {
    const notices: string[] = [];
    const out = JSON.parse(
      renderSarif(one, { frame: outOfTreeConfig, onNotice: (m) => notices.push(m) }),
    ) as { runs: { results: { locations: unknown[] }[] }[] };
    expect(out.runs[0]?.results).toHaveLength(1);
    // And it says the paths are not repository-relative, rather than going quiet.
    expect(notices.join(" ")).toMatch(/git repository/i);
  });

  it("measures the uri from the run base, not the config directory", () => {
    const out = JSON.parse(renderSarif(one, { frame: outOfTreeConfig })) as {
      runs: { results: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[] }[];
    };
    const uri = out.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri;
    expect(uri).toBe("docs/a.md");
    expect(uri?.startsWith("..")).toBe(false);
  });
});

describe("junit: the XML 1.0 Char production", () => {
  // C0 controls are the familiar exclusion; a lone surrogate half and the
  // noncharacters U+FFFE/U+FFFF are equally illegal and equally fatal — the
  // document does not parse at all. All three can sit in a JS string.
  const withChar = (bad: string): ValidationResult[] => [
    {
      file: "a.md",
      format: "markdown",
      ok: false,
      schemas: ["s"],
      errors: [
        {
          schema: "s",
          instancePath: "",
          message: `bad${bad}char`,
          keyword: "pattern",
        },
      ],
    },
  ];

  it("drops a lone surrogate half", () => {
    const out = renderJunit(withChar("\uD800"));
    expect(out).toContain("badchar");
    expect(out).not.toContain("\uD800");
  });

  it("drops the U+FFFE and U+FFFF noncharacters", () => {
    expect(renderJunit(withChar("\uFFFE"))).not.toContain("\uFFFE");
    expect(renderJunit(withChar("\uFFFF"))).not.toContain("\uFFFF");
  });

  it("keeps a well-formed astral character, which is legal", () => {
    // A surrogate *pair* is one code point >= U+10000 and perfectly valid XML.
    const out = renderJunit(withChar("\u{1F600}"));
    expect(out).toContain("\u{1F600}");
  });
});

// ---------------------------------------------------------------------------
// GitHub workflow commands need their message escaped
// ---------------------------------------------------------------------------

/**
 * `::error ...::<message>` is a line-oriented protocol. A literal newline ends
 * the command, and `%` introduces the escape sequences, so an unescaped message
 * either truncates the annotation or corrupts it. An Ajv `pattern` message
 * quotes the schema's regex verbatim, which is where the `%` comes from in
 * practice.
 */
describe("reporters: github message escaping", () => {
  const withMessage = (message: string): ValidationResult[] => [
    {
      file: "bad.md",
      format: "markdown",
      ok: false,
      schemas: ["house:1.0"],
      errors: [
        {
          schema: "house:1.0",
          instancePath: "/slug",
          message,
          keyword: "pattern",
          line: 3,
        },
      ],
    },
  ];

  it("escapes the file property, which is comma-separated", () => {
    // The message escaper deliberately leaves `,` and `:` alone, because they
    // are only special in a *property* value. `file=` is a property value: an
    // unescaped comma re-partitions the command, so `file=a,b.md` parses as
    // `file=a` plus a stray property and the annotation lands nowhere.
    const [first] = withMessage("anything");
    const out = renderGithub([
      { ...(first as ValidationResult), file: "a,b.md" },
    ]);
    expect(out).toContain("file=a%2Cb.md");
    expect(out).not.toContain("file=a,b.md");
  });

  it("escapes % in the message", () => {
    const out = renderGithub(withMessage('must match pattern "^%[a-z]+$"'));
    expect(out).toContain('must match pattern "^%25[a-z]+$"');
    expect(out).not.toContain('"^%[');
  });

  it("escapes CR and LF so the annotation is not truncated", () => {
    const out = renderGithub(withMessage("first\r\nsecond\nthird"));
    expect(out).toContain("first%0D%0Asecond%0Athird");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("escapes % before the newlines, so nothing is double-escaped", () => {
    // Escaping CR/LF first would turn the literal LF into "%0A" and then the
    // % pass would rewrite it to "%250A" -- an annotation showing the escape
    // sequence as text.
    const out = renderGithub(withMessage("50% off\nline two"));
    expect(out).toContain("50%25 off%0Aline two");
    expect(out).not.toContain("%250A");
  });

  it("leaves a message with none of them unchanged", () => {
    const out = renderGithub(withMessage("must have required property 'type'"));
    expect(out).toBe(
      "::error file=bad.md,line=3::[house:1.0] /slug must have required property 'type'",
    );
  });

  /**
   * Exported because a follow-up adds a `github` renderer for `fill`, which
   * must escape identically rather than re-derive the rule and get the
   * ordering wrong.
   */
  it("exposes the escaping as a reusable helper", () => {
    expect(escapeWorkflowCommandMessage("100%\r\n")).toBe("100%25%0D%0A");
    expect(escapeWorkflowCommandMessage("plain")).toBe("plain");
  });
});

// ---------------------------------------------------------------------------
// `get` renders behind a reporter, like every other command (0005 §2)
// ---------------------------------------------------------------------------

describe("reporters: get", () => {
  const getResults: GetFileResult[] = [
    {
      file: "both.md",
      present: true,
      values: { title: "A title", owner: "docs-team" },
    },
    // One set, one unset: the case `--quiet` must NOT hide.
    { file: "partial.md", present: true, values: { title: "Only a title" } },
    { file: "neither.md", present: false, values: {} },
  ];
  const fields = ["title", "owner"];

  it("prints one file:field=value line per requested field", () => {
    const out = renderGet(getResults, fields, { color: false });
    expect(out.split("\n")).toEqual([
      "both.md: title=A title",
      "both.md: owner=docs-team",
      "partial.md: title=Only a title",
      "partial.md: owner=(unset)",
      "neither.md: title=(unset)",
      "neither.md: owner=(unset)",
    ]);
  });

  it("renders a non-string value as JSON, and no ANSI when color is off", () => {
    const out = renderGet(
      [{ file: "x.md", present: true, values: { tags: ["a", "b"] } }],
      ["tags"],
      { color: false },
    );
    expect(out).toBe('x.md: tags=["a","b"]');
    expect(out).not.toContain(ESC);
  });

  it("quiet hides a file where every requested field is unset", () => {
    const out = renderGet(getResults, fields, { color: false, quiet: true });
    expect(out).not.toContain("neither.md");
  });

  it("quiet never hides a value: a partially set file still prints", () => {
    const out = renderGet(getResults, fields, { color: false, quiet: true });
    expect(out).toContain("partial.md: title=Only a title");
    expect(out).toContain("partial.md: owner=(unset)");
  });
});

// ---------------------------------------------------------------------------
// `fill`: --quiet, and the github reporter (0005 §2, §3)
// ---------------------------------------------------------------------------

describe("reporters: fill", () => {
  const field = (over: Partial<FilledField>): FilledField => ({
    field: "/title",
    required: false,
    confidence: 0.9,
    reasoning: "because",
    written: true,
    ...over,
  });

  const results: FillFileResult[] = [
    {
      file: "written.md",
      format: "markdown",
      schemas: ["house:1.0"],
      changed: true,
      fields: [field({ field: "/title", value: "A title" })],
    },
    {
      // Nothing written, and nothing required left undone: the only file
      // `--quiet` may drop.
      file: "optional-skip.md",
      format: "markdown",
      schemas: ["house:1.0"],
      changed: false,
      fields: [
        field({
          field: "/description",
          required: false,
          written: false,
          confidence: 0.4,
          skipReason: "low-confidence",
        }),
      ],
    },
    {
      // A required field left unfilled is what drives exit 1 — hiding it would
      // hide the reason for the run's own failure.
      file: "required-skip.md",
      format: "markdown",
      schemas: ["house:1.0"],
      changed: false,
      fields: [
        field({
          field: "/type",
          required: true,
          written: false,
          confidence: 0.3,
          skipReason: "low-confidence",
        }),
      ],
    },
    {
      file: "broken.md",
      format: "markdown",
      schemas: [],
      changed: false,
      fields: [],
      error: "Invalid YAML frontmatter",
    },
  ];

  const run: FillRun = {
    results,
    summary: {
      files: 4,
      changed: 1,
      written: 1,
      skipped: 2,
      requiredSkipped: 1,
      errors: 1,
      costUsd: 0,
      cached: 0,
    },
    threshold: 0.7,
    dryRun: true,
    provider: "mock",
    model: "mock-1",
    budgetExhausted: false,
  };

  it("pretty prints every file when quiet is off", () => {
    const out = renderFillPretty(run, { color: false });
    for (const f of ["written.md", "optional-skip.md", "required-skip.md", "broken.md"]) {
      expect(out).toContain(f);
    }
  });

  it("quiet drops only the file with nothing written and nothing required left", () => {
    const out = renderFillPretty(run, { color: false, quiet: true });
    expect(out).not.toContain("optional-skip.md");
    expect(out).toContain("written.md");
  });

  it("quiet keeps a file whose required field could not be filled", () => {
    // renderFillPretty already skips files with zero proposals, so "drop files
    // with no proposals" would be a no-op; the only files left to drop are the
    // ones that carry the failure. This is the assertion that pins that.
    const out = renderFillPretty(run, { color: false, quiet: true });
    expect(out).toContain("required-skip.md");
    expect(out).toContain("/type");
  });

  it("quiet keeps a file that errored", () => {
    const out = renderFillPretty(run, { color: false, quiet: true });
    expect(out).toContain("broken.md");
    expect(out).toContain("Invalid YAML frontmatter");
  });

  it("quiet still prints the summary and the required-skip warning", () => {
    const out = renderFillPretty(run, { color: false, quiet: true });
    expect(out).toContain("1 required field could not be filled confidently");
    expect(out).toContain("Threshold 0.7");
  });

  it("github annotates required-and-unfilled fields, not optional ones", () => {
    const out = renderFillGithub(run);
    const required = out
      .split("\n")
      .filter((l) => l.includes("required-skip.md"));
    expect(required).toHaveLength(1);
    expect(required[0]).toContain("::error file=required-skip.md::");
    expect(required[0]).toContain("/type");
    // A skipped *optional* property is a normal outcome that does not fail the
    // run, so annotating it would make every run look broken.
    expect(out).not.toContain("optional-skip.md");
    expect(out).not.toContain("written.md");
  });

  it("github annotates a file-level error, which also drives exit 1", () => {
    // `summary.errors` fails the run exactly as a required skip does. Emitting
    // nothing for it left a red build with a clean Files tab — the same "fails
    // with nothing to point at" shape this work exists to remove.
    const broken = renderFillGithub(run)
      .split("\n")
      .filter((l) => l.includes("broken.md"));
    expect(broken).toHaveLength(1);
    expect(broken[0]).toContain("::error file=broken.md::");
    expect(broken[0]).toContain("Invalid YAML frontmatter");
  });

  it("github escapes the file property, which is comma-separated", () => {
    // A comma in a path re-partitions the command: `file=docs/report,final.md`
    // parses as `file=docs/report` plus a stray property, so the annotation
    // lands on the wrong file — with no error anywhere.
    const odd: FillRun = {
      ...run,
      results: [{ ...(results[2] as FillFileResult), file: "a,b.md" }],
    };
    const out = renderFillGithub(odd);
    expect(out).toContain("file=a%2Cb.md");
    expect(out).not.toContain("file=a,b.md");
  });

  it("github carries no line=, because a proposal has no location", () => {
    // FilledField has no line/col (unlike a ValidationResult error), so the
    // annotation names the file only and GitHub anchors it to line 1.
    expect(renderFillGithub(run)).not.toContain("line=");
  });

  it("github says nothing when every required field was filled", () => {
    const clean: FillRun = {
      ...run,
      results: [results[0] as FillFileResult],
      summary: { ...run.summary, requiredSkipped: 0, errors: 0 },
    };
    expect(renderFillGithub(clean)).toBe("");
  });

  it("github escapes the message it assembles", () => {
    const hostile: FillRun = {
      ...run,
      results: [
        {
          file: "pct.md",
          format: "markdown",
          schemas: ["house:1.0"],
          changed: false,
          fields: [
            field({
              field: "/100%\nrate",
              required: true,
              written: false,
              confidence: 0.1,
              skipReason: "low-confidence",
            }),
          ],
        },
      ],
    };
    const out = renderFillGithub(hostile);
    expect(out).toContain("/100%25%0Arate");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("routes every fill format to its own renderer, and rejects the rest", () => {
    expect(renderFill("json", run)).toBe(renderFillJson(run));
    expect(renderFill("github", run)).toBe(renderFillGithub(run));
    expect(renderFill("pretty", run, { color: false })).toBe(
      renderFillPretty(run, { color: false }),
    );
    expect(() => renderFill("sarif" as FillReportFormat, run)).toThrow(
      /Unknown report format/,
    );
  });

  it("states its format list once", () => {
    expect([...FILL_FORMATS]).toEqual(["pretty", "json", "github"]);
    expect(isFillFormat("github")).toBe(true);
    expect(isFillFormat("sarif")).toBe(false);
    expect(FILL_FORMAT_LIST).toBe("pretty, json, or github");
  });
});

// ---------------------------------------------------------------------------
// The formats every command produces, stated once (0005 §5)
// ---------------------------------------------------------------------------

describe("reporters: the common format pair", () => {
  it("is pretty and json, with a list that reads as a sentence", () => {
    expect([...COMMON_FORMATS]).toEqual(["pretty", "json"]);
    expect(isCommonFormat("json")).toBe(true);
    expect(isCommonFormat("github")).toBe(false);
    // Two values take "a or b", not "a, or b" — the message has said
    // "Use pretty or json." since before the list was shared.
    expect(COMMON_FORMAT_LIST).toBe("pretty or json");
  });

  it("leaves the five-value validate list reading as it always did", () => {
    expect(REPORT_FORMAT_LIST).toBe("pretty, json, github, sarif, or junit");
  });
});
