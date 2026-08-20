import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync, execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DOC, makeTempRepo, removeTempRepo } from "./helpers/temp-repo.js";
import { startSchemaServer } from "./helpers/schema-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const bin = resolve(root, "dist", "cli.js");

/**
 * An empty inference runtime prefix, for the tests that need the local binding
 * to be UNAVAILABLE.
 *
 * `node-llama-cpp` is not a docmeta dependency, so it is missing from
 * node_modules — but the library also looks in its own prefix under the home
 * directory, and anything that has ever run a local model populates that.
 * Running the doc-detective suite does, and it turned these assertions inside
 * out: runs that should have failed started succeeding. Pointing the prefix
 * somewhere empty makes absence a property of the test, not of the machine.
 */
const noRuntimeDir = mkdtempSync(join(tmpdir(), "docmeta-no-runtime-"));

interface Run {
  stdout: string;
  stderr: string;
  status: number;
}

function run(
  args: string[],
  input?: string,
  env?: Record<string, string>,
  cwd: string = root,
): Run {
  try {
    const stdout = execFileSync("node", [bin, ...args], {
      cwd,
      encoding: "utf8",
      input,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      status: err.status ?? 1,
    };
  }
}

describe("docmeta CLI (built bin)", () => {
  beforeAll(() => {
    if (!existsSync(bin)) execSync("npm run build", { cwd: root, stdio: "ignore" });
  }, 180000);

  it("exits 0 on a valid file", () => {
    const r = run(["validate", "test/fixtures/valid.md"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("✓");
  });

  it("exits 1 on a validation failure", () => {
    const r = run(["validate", "test/fixtures/missing-type.md"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("required property 'type'");
  });

  it("exits 2 on an unsupported file type", () => {
    const r = run(["validate", "test/fixtures/extra.schema.json"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Unsupported file type");
  });

  it("emits GitHub annotations", () => {
    const r = run(["validate", "test/fixtures/bad-timestamp.md", "-f", "github"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error file=test/fixtures/bad-timestamp.md");
  });

  it("lists built-in schemas", () => {
    const r = run(["schemas"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("google:okf:0.1");
    expect(r.stdout).toContain("diataxis:diataxis:1.0");
    expect(r.stdout).toContain("passo-uno:seven-action:1.0");
    expect(r.stdout).toContain("tgdp:templates:1.0");
    expect(r.stdout).toContain("docusaurus:docs:3.10");
    expect(r.stdout).toContain("docusaurus:blog:3.10");
    expect(r.stdout).toContain("docusaurus:pages:3.10");
  });

  it("reports every built-in in --format json", () => {
    const r = run(["schemas", "-f", "json"]);
    expect(r.status).toBe(0);
    const ids = JSON.parse(r.stdout).builtins.map((b: { id: string }) => b.id);
    expect(ids).toEqual([
      "google:okf:0.1",
      "diataxis:diataxis:1.0",
      "passo-uno:seven-action:1.0",
      "tgdp:templates:1.0",
      "docusaurus:docs:3.10",
      "docusaurus:blog:3.10",
      "docusaurus:pages:3.10",
    ]);
  });

  it("fails an out-of-vocabulary TGDP type, naming the schema", () => {
    const r = run([
      "validate",
      "test/fixtures/taxonomy/tgdp-bad-type.md",
      "-s",
      "tgdp:templates:1.0",
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("tgdp:templates:1.0");
  });

  it("fails an out-of-vocabulary Diataxis type, naming the schema", () => {
    const r = run([
      "validate",
      "test/fixtures/taxonomy/diataxis-bad-type.md",
      "-s",
      "diataxis:diataxis:1.0",
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("diataxis:diataxis:1.0");
  });

  it("passes a document carrying both a type and an action", () => {
    const r = run([
      "validate",
      "test/fixtures/taxonomy/composed-how-to-practice.md",
      "-s",
      "diataxis:diataxis:1.0",
      "-s",
      "passo-uno:seven-action:1.0",
    ]);
    expect(r.status).toBe(0);
  });

  it("leaves a pre-existing document passing on the bare default set", () => {
    // schema-ref.md has `type: guide` and no `action`; adding Seven-Action to
    // the default set must not fail it.
    const r = run(["validate", "test/fixtures/schema-ref.md"]);
    expect(r.status).toBe(0);
  });

  it("validates piped stdin with --as", () => {
    const r = run(["validate", "-", "--as", "markdown"], "---\ntype: note\n---\n");
    expect(r.status).toBe(0);
  });

  it("gets fields from positional paths (parallel to validate)", () => {
    const r = run(["get", "title,type", "test/fixtures/valid.md", "-f", "json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed[0].values.type).toBe("concept");
    expect(parsed[0].values.title).toBe("A Valid Document");
  });

  it("gets nested fields via dot-notation and JSON Pointer", () => {
    const r = run([
      "get",
      "author.name,/author/email,tags.0",
      "test/fixtures/nested/doc.md",
      "-f",
      "json",
    ]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed[0].values["author.name"]).toBe("Jane");
    expect(parsed[0].values["/author/email"]).toBe("jane@example.com");
    expect(parsed[0].values["tags.0"]).toBe("intro");
  });

  it("gets fields from piped stdin with --as", () => {
    const r = run(
      ["get", "type", "-", "--as", "markdown", "-f", "json"],
      "---\ntype: note\n---\n",
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)[0].values.type).toBe("note");
  });

  it("exits 2 when get is given no paths and no config", () => {
    const r = run(["get", "type"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("No files");
  });
});

// Exit 0 means "every file passed". With no files there is no verdict, so
// reporting success turns a broken glob or a moved directory into a
// permanently green gate that checks nothing.
describe("cli empty and unmatched inputs", () => {
  it("exits 2 when a glob matches no files", () => {
    const r = run(["validate", "test/fixtures/*.nomatch"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("No files matched");
  });

  it("returns to 0 on an unmatched glob with --allow-empty", () => {
    const r = run(["validate", "test/fixtures/*.nomatch", "--allow-empty"]);
    expect(r.status).toBe(0);
  });

  it("exits 2 on a named file that does not exist, naming it", () => {
    const r = run(["validate", "test/fixtures/typo.md"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("test/fixtures/typo.md");
  });

  it("exits 2 on a directory that does not exist", () => {
    const r = run(["validate", "no-such-dir/"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no-such-dir");
  });

  it("exits 2 on a misspelled subcommand, suggesting the real one", () => {
    // `validate` is the default command, so `valdiate` parses as a *path*.
    // The missing-literal rule already makes this exit 2; the suggestion is
    // what turns `File not found: "valdiate"` into an actionable message.
    const r = run(["valdiate", "test/fixtures/"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Did you mean "validate"');
  });

  it("still validates a real path given to the default command", () => {
    // The guard must not fire on anything that is actually a path — otherwise
    // `docmeta docs/` stops working.
    const r = run(["test/fixtures/valid.md"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 passed");
  });

  it("exits 2 when get matches no files", () => {
    const r = run(["get", "title", "test/fixtures/*.nomatch"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("No files matched");
  });

  // `fill` pulls in the inference package, so even a fast-failing run costs
  // seconds of module loading. Matches the 60s the other fill cases use.
  it("exits 2 when fill matches no files", () => {
    const r = run(["fill", "test/fixtures/*.nomatch"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("No files matched");
  }, 60000);

  it("keeps stdin working: one input, zero files, still a verdict", () => {
    const r = run(["validate", "-", "--as", "markdown"], "---\ntype: note\n---\n");
    expect(r.status).toBe(0);
  });
});

// `fill` reaches an LLM provider, so the integration tests cover only the
// argument surface and the failure paths that never get that far. The gate
// itself is exercised hermetically in test/fill.test.ts against a MockProvider.
describe("cli fill", () => {
  it("documents its flags in --help", () => {
    const r = run(["fill", "--help"]);
    expect(r.status).toBe(0);
    for (const flag of [
      "--confidence",
      "--dry-run",
      "--provider",
      "--model",
      "--no-cache",
      "--max-cost-usd",
      "--concurrency",
      "--fields",
    ]) {
      expect(r.stdout).toContain(flag);
    }
  });

  it("exits 2 when given no paths and no config", () => {
    const r = run(["fill"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("No files");
  });

  it("exits 2 on a non-numeric --confidence", () => {
    const r = run(["fill", "test/fixtures/valid.md", "--confidence", "abc"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--confidence");
  });

  it("exits 2 on an out-of-range --confidence", () => {
    const r = run(["fill", "test/fixtures/valid.md", "--confidence", "1.5"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("between 0 and 1");
  });

  it("names auto as the default provider in --help", () => {
    const r = run(["fill", "--help"]);
    expect(r.stdout).toContain("auto");
  });

  it("exits 2 on an unknown provider, before reaching a provider", () => {
    // Cheap, and it must not depend on inference happening: construction is
    // lazy, so a typo on a fully cached run would otherwise exit 0.
    const r = run(["fill", "test/fixtures/valid.md", "--provider", "antropic"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("antropic");
    expect(r.stderr).toContain("auto");
  });

  it("exits 2 on --model without --provider", () => {
    // A model name does not say which provider owns it. Carried into a detected
    // provider it 404'd mid-run; this fails before any file is read.
    const r = run([
      "fill",
      "test/fixtures/valid.md",
      "--model",
      "gpt-4o-mini",
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--provider");
  });

  it("defaults to auto and detects a provider when none is named", () => {
    // Proven by making detection pick something a hardcoded default would not:
    // with only an OpenAI key present, `openai` can only be the result of
    // actually detecting. Asserting "anthropic" instead would pass just as well
    // against the old hardcoded default, and asserting on the library's
    // "auto-selected" log text would stop meaning anything the moment it is
    // rephrased upstream.
    //
    // A path matching no files resolves identity but never calls a provider, so
    // this needs no network and no key that works. A named file that does not
    // exist is otherwise an error, hence --allow-empty: the point here is
    // provider identity, not the input set.
    const r = run(
      [
        "fill",
        "test/fixtures/does-not-exist.md",
        "--allow-empty",
        "--dry-run",
        "--no-cache",
        "-f",
        "json",
      ],
      undefined,
      { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "x" },
    );
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.provider).toBe("openai");
    expect(report.summary.files).toBe(0);
  }, 60000);

  it("runs llama-cpp when it is named, reporting the concrete model", () => {
    // Naming a concrete model — a catalog alias like this one, or an `hf:` URI —
    // skips the hardware probe, so this resolves with no native binding
    // installed. The opt-out is what keeps a test from turning into a
    // multi-gigabyte install. The alias is the one the docs and CI name, so this
    // covers the reference the project actually ships. Note a tier *selector*
    // (`fast`) would not work here: resolving one probes the machine.
    const r = run(
      [
        "fill",
        "test/fixtures/valid.md",
        "--provider",
        "llama-cpp",
        "--model",
        "granite-4.1-3b-q2",
        "--dry-run",
        "--no-cache",
        "-f",
        "json",
      ],
      undefined,
      { INFERENCE_NO_AUTO_INSTALL: "1", INFERENCE_RUNTIME_DIR: noRuntimeDir },
    );

    const report = JSON.parse(r.stdout);
    expect(report.provider).toBe("llama-cpp");
    expect(report.model).toBe(
      "granite-4.1-3b-q2",
    );
    // Absent runtime is a per-file failure, not an operational one.
    expect(r.status).toBe(1);
    expect(report.results[0].error).toMatch(/node-llama-cpp/);
  }, 60000);

  it("exits 2 when llama-cpp needs a runtime probe it cannot make", () => {
    // Without --model, llama-cpp uses the `auto` selector, and sizing a tier
    // needs the binding. That is setup, not a per-file problem.
    const r = run(
      ["fill", "test/fixtures/valid.md", "--provider", "llama-cpp", "--dry-run"],
      undefined,
      { INFERENCE_NO_AUTO_INSTALL: "1", INFERENCE_RUNTIME_DIR: noRuntimeDir },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("node-llama-cpp");
  }, 60000);

  it("constructs the provider detection resolved, not the selector", () => {
    // Regression: `makeProvider` kept receiving the literal "auto" after
    // detection had already resolved it, so every real run that needed
    // inference died on the synchronous guard. Every unit test injects a
    // provider, which skips construction entirely — only an end-to-end run
    // reaches it.
    //
    // Hermetic despite naming a real provider: port 1 refuses immediately, so
    // the call fails locally without leaving the machine.
    const r = run(
      ["fill", "test/fixtures/valid.md", "--dry-run", "--no-cache", "-f", "json"],
      undefined,
      { ANTHROPIC_API_KEY: "x", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" },
    );

    // A per-file failure (exit 1), not an operational one (exit 2).
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain("No provider specified");
    const report = JSON.parse(r.stdout);
    expect(report.provider).toBe("anthropic");
    // Deliberately not pinned to a model name: that is the library's default and
    // will change when a newer Sonnet ships, breaking this with no change here.
    // What the regression actually leaked was the literal selector.
    expect(report.model).not.toBe("auto");
    expect(typeof report.model).toBe("string");
    expect(report.model.length).toBeGreaterThan(0);
  }, 60000);

  it("exits 2 on an unknown --format", () => {
    const r = run(["fill", "test/fixtures/valid.md", "-f", "github"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Unknown --format");
  });

  it("exits 2 on an unknown provider before contacting anything", () => {
    const r = run([
      "fill",
      "test/fixtures/missing-type.md",
      "--provider",
      "nonsense",
      "--no-cache",
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/provider/i);
  });

  it("reports formats as writable or read-only", () => {
    const r = run(["schemas", "-f", "json"]);
    expect(r.status).toBe(0);
    const formats = JSON.parse(r.stdout).formats as {
      name: string;
      writable: boolean;
    }[];
    expect(formats.find((f) => f.name === "markdown")?.writable).toBe(true);
    expect(formats.find((f) => f.name === "html")?.writable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 0004 — the config means the same thing from any directory
// ---------------------------------------------------------------------------

describe("config discovery walks up (0004)", () => {
  let sandbox: string;

  const STRICT = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["type", "owner"],
    properties: { type: { type: "string" }, owner: { type: "string" } },
  });
  // Satisfies the built-in default set; violates the configured one.
  const PAGE = "---\ntype: guide\ntitle: Hi\n---\n\n# Hi\n";

  function write(rel: string, content: string): void {
    const p = join(sandbox, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf8");
  }

  beforeEach(() => {
    // A `.git` **file** cannot be committed inside this repo's tree in a form
    // git preserves, so the boundary fixtures are built here instead.
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), "docmeta-0004-")));
    write(".git/HEAD", "ref: refs/heads/main\n");
    write("docmeta.config.yaml", 'schemas:\n  - "./strict.schema.json"\n');
    write("c2.yaml", 'paths:\n  - "docs/**/*.md"\n');
    write("strict.schema.json", STRICT);
    write("docs/api/page.md", PAGE);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("gives the same verdict from the repo root and from a subdirectory", () => {
    const fromRoot = run(["validate", "docs/**/*.md"], undefined, undefined, sandbox);
    const fromDocs = run(
      ["validate", "api/*.md"],
      undefined,
      undefined,
      join(sandbox, "docs"),
    );
    expect(fromRoot.status).toBe(1);
    expect(fromRoot.stdout).toContain("required property 'owner'");
    // Defect 1: this used to exit 0 against the built-in defaults.
    expect(fromDocs.status).toBe(1);
    expect(fromDocs.stdout).toContain("required property 'owner'");
  });

  it("--no-config opts out of the discovered config", () => {
    const r = run(
      ["validate", "api/*.md", "--no-config"],
      undefined,
      undefined,
      join(sandbox, "docs"),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("Using docmeta.config.yaml");
  });

  it("loads a config-relative schema ref through -c (defect 2A)", () => {
    const r = run(
      ["validate", "api/page.md", "-c", "../docmeta.config.yaml"],
      undefined,
      undefined,
      join(sandbox, "docs"),
    );
    // Used to exit 2 with `Schema file not found: "./strict.schema.json"`.
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("required property 'owner'");
  });

  it("resolves config `paths:` against the config's directory (defect 2B)", () => {
    const r = run(
      ["validate", "-c", "../c2.yaml"],
      undefined,
      undefined,
      join(sandbox, "docs"),
    );
    // Used to resolve zero files (silently exit 0 before 0014, exit 2 after).
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 file checked");
    expect(r.stdout).toContain("docs/api/page.md");
  });

  it("names the config it picked up, on stdout for pretty output", () => {
    const r = run(
      ["validate", "api/*.md"],
      undefined,
      undefined,
      join(sandbox, "docs"),
    );
    expect(r.stdout).toContain("Using docmeta.config.yaml (..)");
  });

  it("keeps machine-readable output clean by sending the notice to stderr", () => {
    const r = run(
      ["validate", "api/*.md", "-f", "json"],
      undefined,
      undefined,
      join(sandbox, "docs"),
    );
    expect(r.stderr).toContain("Using docmeta.config.yaml (..)");
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it("stops at a `.git` file, so a worktree cannot inherit the outer config", () => {
    write("wt/.git", `gitdir: ${join(sandbox, ".git", "worktrees", "wt")}\n`);
    write("wt/docs/page.md", PAGE);
    const r = run(["validate", "docs/*.md"], undefined, undefined, join(sandbox, "wt"));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("Using docmeta.config.yaml");
  });
});

describe("docmeta CLI baseline flags (built bin)", () => {
  let dir: string;

  const write = (rel: string, content: string): void => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  const here = (args: string[], cwd = dir) => run(args, undefined, undefined, cwd);

  const CONFIG = 'paths:\n  - "docs/**/*.md"\nschemas:\n  - google:okf:0.1\n';

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "docmeta-baseline-cli-")));
    // Config discovery walks up only as far as a project boundary, so the
    // scratch project needs one for the run-from-a-subdirectory case.
    write(".git", "gitdir: nowhere\n");
    write("docmeta.config.yaml", CONFIG);
    write("docs/legacy.md", "---\ntitle: No type here\n---\n");
    write("docs/clean.md", "---\ntype: concept\n---\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails before a baseline exists — the anchor for everything below", () => {
    const r = here(["validate"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("required property 'type'");
  });

  it("--write-baseline with the value omitted uses the default path", () => {
    // The omitted-value form: commander must reach for the option's preset
    // rather than handing the core a bare `true`.
    const r = here(["validate", "--write-baseline"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Baseline written to .docmeta-baseline.json");
    expect(r.stdout).toContain("1 finding recorded (+1 new, -0 no longer occur)");
    expect(existsSync(join(dir, ".docmeta-baseline.json"))).toBe(true);
  });

  it("--baseline with the value omitted reads that same default path", () => {
    here(["validate", "--write-baseline"]);
    const r = here(["validate", "--baseline"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 baselined finding");
    expect(r.stdout).toContain("(1 baselined)");
  });

  it("--baseline takes an explicit path", () => {
    here(["validate", "--write-baseline", "custom.json"]);
    expect(existsSync(join(dir, "custom.json"))).toBe(true);
    expect(here(["validate", "--baseline", "custom.json"]).status).toBe(0);
  });

  it("fails on a new violation and names only that one", () => {
    here(["validate", "--write-baseline"]);
    write("docs/fresh.md", "---\ntitle: Also missing its type\n---\n");
    const r = here(["validate", "--baseline"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("fresh.md");
    expect(r.stdout).toContain("✗ docs/fresh.md");
    expect(r.stdout).toContain("✓ docs/legacy.md");
  });

  it("reports a fixed violation as stale without failing", () => {
    here(["validate", "--write-baseline"]);
    write("docs/legacy.md", "---\ntype: concept\ntitle: Fixed\n---\n");
    const r = here(["validate", "--baseline"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "1 baselined finding, 1 no longer occurs — run --write-baseline to prune",
    );
  });

  it("a configured `baseline:` implies --baseline on every run", () => {
    here(["validate", "--write-baseline"]);
    write("docmeta.config.yaml", `${CONFIG}baseline: .docmeta-baseline.json\n`);
    const r = here(["validate"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 baselined finding");
  });

  it("--no-baseline ignores a configured baseline for one run", () => {
    here(["validate", "--write-baseline"]);
    write("docmeta.config.yaml", `${CONFIG}baseline: .docmeta-baseline.json\n`);
    const r = here(["validate", "--no-baseline"]);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("baselined finding");
  });

  it("resolves a configured baseline against the config file, not the cwd", () => {
    here(["validate", "--write-baseline"]);
    write("docmeta.config.yaml", `${CONFIG}baseline: .docmeta-baseline.json\n`);
    const r = here(["validate"], join(dir, "docs"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 baselined finding");
  });

  it("--write-baseline with the value omitted honours a configured path", () => {
    // No preset on --write-baseline: bare means "the file the config names",
    // so a repo whose baseline lives elsewhere cannot record into a second file
    // that nothing ever reads.
    mkdirSync(join(dir, ".meta"), { recursive: true });
    write("docmeta.config.yaml", `${CONFIG}baseline: .meta/base.json\n`);
    const r = here(["validate", "--write-baseline"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Baseline written to .meta/base.json");
    expect(existsSync(join(dir, ".meta", "base.json"))).toBe(true);
    expect(existsSync(join(dir, ".docmeta-baseline.json"))).toBe(false);
    // And the very next run reads that same file back.
    expect(here(["validate"]).status).toBe(0);
  });

  it("exits 2 naming the remedy when the baseline is missing", () => {
    const r = here(["validate", "--baseline", "absent.json"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--write-baseline");
  });

  it("carries the baseline into JSON output for machine consumers", () => {
    here(["validate", "--write-baseline"]);
    const r = here(["validate", "--baseline", "-f", "json"]);
    const parsed = JSON.parse(r.stdout) as {
      summary: { baseline?: { recorded: number; stale: number } };
      results: { file: string; baselined?: number }[];
    };
    expect(parsed.summary.baseline).toMatchObject({ recorded: 1, stale: 0 });
    expect(parsed.results.find((x) => x.file.endsWith("legacy.md"))?.baselined).toBe(1);
  });
});

describe("docmeta CLI baseline portability across working directories (built bin)", () => {
  // The fixture config points at a LOCAL FILE schema (`./strict.schema.json`),
  // which 0004 rebases to an absolute path whenever the config directory is not
  // the working directory. Run through the real binary so `process.cwd()` moves
  // with the run, which is the only way to exercise the config-dir case.
  const project = resolve(root, "test", "fixtures", "baseline-refs");

  it("forgives the recorded finding from the config directory", () => {
    const r = run(["validate"], undefined, undefined, project);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 baselined finding");
  });

  it("forgives it from a subdirectory too, where the ref arrives absolute", () => {
    const r = run(["validate"], undefined, undefined, join(project, "docs"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 baselined finding");
  });

  it("records byte-identical baselines from both directories", () => {
    // Stronger than "both pass": a re-record from either place must produce the
    // same file, so the committed baseline is not churned by where CI stands.
    const out = realpathSync(mkdtempSync(join(tmpdir(), "docmeta-refs-")));
    try {
      const a = join(out, "root.json");
      const b = join(out, "subdir.json");
      run(["validate", "--write-baseline", a], undefined, undefined, project);
      run(
        ["validate", "--write-baseline", b],
        undefined,
        undefined,
        join(project, "docs"),
      );
      expect(readFileSync(b, "utf8")).toBe(readFileSync(a, "utf8"));
      // And that shared value is the one the committed fixture baseline holds,
      // so the canonical ref really is `strict.schema.json` rather than either
      // machine-specific absolute path.
      expect(readFileSync(a, "utf8")).toContain("75c4810568b9d102");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("keys entries by a path that is stable across working directories", () => {
    // Canonicalizing the schema ref (above) is not enough on its own: entries
    // are keyed by file, and the label is relative to whatever the run resolved
    // against. Recorded from the root a page is `docs/legacy.md`; addressed from
    // `docs/` it is `legacy.md`, so the lookup misses entirely and every
    // baselined finding reads as new. The ref never even gets compared.
    const out = realpathSync(mkdtempSync(join(tmpdir(), "docmeta-keys-")));
    try {
      const b = join(out, "keys.json");
      run(["validate", "--write-baseline", b], undefined, undefined, project);
      const keys = Object.keys(
        JSON.parse(readFileSync(b, "utf8")).entries as Record<string, string[]>,
      );
      // Relative to the config, not to wherever the command happened to run.
      expect(keys).toEqual(["docs/legacy.md"]);

      // And the same baseline forgives when the files are addressed from inside
      // `docs/`, where the labels are bare filenames.
      const sub = run(
        ["validate", "*.md", "--baseline", b],
        undefined,
        undefined,
        join(project, "docs"),
      );
      expect(sub.status).toBe(0);
      expect(sub.stdout).toContain("1 baselined finding");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("finds the default baseline from a subdirectory", () => {
    // The cases above all pass an explicit path, which is rightly relative to
    // where the user is standing. The *implied* default is a different thing: a
    // project artifact that belongs beside the config, exactly like a configured
    // `baseline:` value. Resolving it against cwd instead means `cd docs` breaks
    // the ratchet — the subdirectory workflow 0004 exists to make work — or, if
    // one is later written there, gives the project a second baseline nothing
    // reads.
    const fromRoot = run(["validate", "--baseline"], undefined, undefined, project);
    expect(fromRoot.status).toBe(0);

    const fromSubdir = run(
      ["validate", "--baseline"],
      undefined,
      undefined,
      join(project, "docs"),
    );
    expect(fromSubdir.status).toBe(0);
    expect(fromSubdir.stderr).not.toContain("not found");
  });
});

describe("docmeta CLI violation identity (built bin)", () => {
  it("emits keyword and subject in JSON output", () => {
    const r = run(["validate", "test/fixtures/missing-type.md", "-f", "json"]);
    const parsed = JSON.parse(r.stdout) as {
      results: { errors: { keyword: string; subject?: string }[] }[];
    };
    const errors = parsed.results[0]?.errors ?? [];
    expect(errors[0]).toMatchObject({ keyword: "required", subject: "type" });
  });

  it("tags an unreadable metadata block as a parse failure, keeping the (parse) label", () => {
    const r = run(["validate", "test/fixtures/dd/malformed-yaml.md", "-f", "json"]);
    const parsed = JSON.parse(r.stdout) as {
      results: { errors: { schema: string; keyword: string }[] }[];
    };
    // The `(parse)` literal is what documented machine consumers match on, so
    // the new `keyword` sits alongside it rather than replacing it.
    expect(parsed.results[0]?.errors[0]).toMatchObject({
      schema: "(parse)",
      keyword: "parse",
    });
  });
});

/**
 * `.gitignore`-aware discovery, end to end.
 *
 * Each repo is built at runtime (see test/helpers/temp-repo.ts for why a
 * gitignored fixture cannot be committed), and validated against a permissive
 * schema so the exit code reports the *discovery*, not the documents.
 */
describe("docmeta CLI: .gitignore-aware discovery", () => {
  let repo: string | undefined;

  afterEach(() => {
    removeTempRepo(repo);
    repo = undefined;
  });

  /**
   * `run()` cannot see stderr on a successful exit: `execFileSync` returns
   * only stdout, and the child's stderr goes straight to the parent. Two tests
   * here are precisely about a diagnostic on an exit-0 run, and asserting
   * `stderr === ""` against a helper that always reports "" would prove
   * nothing at all.
   */
  const runIn = (args: string[], cwd: string): Run => {
    const r = spawnSync("node", [bin, ...args], { cwd, encoding: "utf8" });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      status: r.status ?? 1,
    };
  };

  const PERMISSIVE = `${JSON.stringify({ type: "object" })}\n`;
  const tree = (): Record<string, string> => ({
    ".gitignore": "build/\n",
    "permissive.schema.json": PERMISSIVE,
    "build/generated.md": DOC,
    "docs/real.md": DOC,
  });
  const withSchema = (...args: string[]): string[] => [
    ...args,
    "-s",
    "./permissive.schema.json",
  ];

  it("skips a gitignored file, and says how many it skipped", () => {
    repo = makeTempRepo({ files: tree() });
    const r = runIn(withSchema("validate", "**/*.md"), repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("docs/real.md");
    expect(r.stdout).not.toContain("build/generated.md");
    expect(r.stdout).toContain("1 file checked");
    expect(r.stdout).toContain("1 skipped by .gitignore");
  });

  it("--no-gitignore checks them again, and reports no skips", () => {
    repo = makeTempRepo({ files: tree() });
    const r = runIn(withSchema("validate", "**/*.md", "--no-gitignore"), repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("build/generated.md");
    expect(r.stdout).toContain("2 files checked");
    expect(r.stdout).not.toContain("skipped by .gitignore");
  });

  it("respectGitignore: false in config checks them again", () => {
    repo = makeTempRepo({
      files: { ...tree(), "docmeta.config.yaml": "respectGitignore: false\n" },
    });
    const r = runIn(withSchema("validate", "**/*.md"), repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2 files checked");
  });

  it("carries the count in the json summary", () => {
    repo = makeTempRepo({ files: tree() });
    const r = runIn(withSchema("validate", "**/*.md", "-f", "json"), repo);
    const parsed = JSON.parse(r.stdout) as {
      summary: { files: number; gitignoreSkipped?: number };
    };
    expect(parsed.summary).toMatchObject({ files: 1, gitignoreSkipped: 1 });
  });

  it("omits the count from the json summary when nothing was skipped", () => {
    repo = makeTempRepo({ files: tree() });
    const r = runIn(withSchema("validate", "docs/real.md", "-f", "json"), repo);
    const parsed = JSON.parse(r.stdout) as { summary: Record<string, unknown> };
    expect(parsed.summary).not.toHaveProperty("gitignoreSkipped");
  });

  it("still validates a gitignored file the user named outright", () => {
    repo = makeTempRepo({ files: tree() });
    const r = runIn(withSchema("validate", "build/generated.md"), repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("build/generated.md");
    expect(r.stdout).toContain("1 file checked");
  });

  it("get honors .gitignore too", () => {
    repo = makeTempRepo({ files: tree() });
    const r = runIn(["get", "title", "**/*.md"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("docs/real.md");
    expect(r.stdout).not.toContain("build/generated.md");
  });

  it("fill honors .gitignore too", () => {
    // The third command sharing the input model, so the three cannot drift.
    // `--dry-run` keeps this away from any provider: filtering happens during
    // target resolution, long before a proposal would be requested, so the file
    // list is observable without inference running.
    repo = makeTempRepo({ files: tree() });
    const r = runIn(
      withSchema("fill", "**/*.md", "--dry-run", "--no-cache", "-f", "json"),
      repo,
    );
    const parsed = JSON.parse(r.stdout) as {
      results: { file: string }[];
    };
    const seen = parsed.results.map((x) => x.file);
    expect(seen).toContain("docs/real.md");
    expect(seen).not.toContain("build/generated.md");
    // 60s like the other `fill` cases: it pulls in the inference package and
    // resolves a provider identity, which costs seconds on a cold run even
    // though `--dry-run` means no proposal is ever requested. A warm run
    // finishes well inside the 5s default, so the shortfall only shows on CI.
  }, 60000);

  it("names .gitignore when it is why nothing matched", () => {
    repo = makeTempRepo({
      files: {
        ".gitignore": "build/\n",
        "permissive.schema.json": PERMISSIVE,
        "build/generated.md": DOC,
      },
    });
    const r = runIn(withSchema("validate", "**/*.md"), repo);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(".gitignore skipped 1");
  });

  it("says nothing about git outside a repository", () => {
    repo = makeTempRepo({ init: false, files: tree() });
    const r = runIn(withSchema("validate", "**/*.md"), repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2 files checked");
    expect(r.stderr).toBe("");
  });

  it("says so outside a repository when config asked for filtering explicitly", () => {
    repo = makeTempRepo({
      init: false,
      files: { ...tree(), "docmeta.config.yaml": "respectGitignore: true\n" },
    });
    const r = runIn(withSchema("validate", "**/*.md"), repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2 files checked");
    expect(r.stderr).toContain("git could not answer");
  });
});

// The two standard formats (0003). What unit tests cannot show is the CLI's
// side of the contract: the clean-run envelope, and stdout staying parseable.
describe("docmeta CLI: sarif and junit output (built bin)", () => {
  let repo: string | undefined;

  afterEach(() => {
    removeTempRepo(repo);
    repo = undefined;
  });

  /** stderr is invisible to `run()` on a zero exit; these tests need both. */
  const runIn = (args: string[], cwd: string): Run => {
    const r = spawnSync("node", [bin, ...args], { cwd, encoding: "utf8" });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      status: r.status ?? 1,
    };
  };

  it("emits parseable SARIF for a failing run and still exits 1", () => {
    const r = run(["validate", "test/fixtures/missing-type.md", "-f", "sarif"]);
    expect(r.status).toBe(1);
    const log = JSON.parse(r.stdout) as {
      version: string;
      runs: {
        tool: { driver: { name: string } };
        results: {
          ruleId: string;
          locations: {
            physicalLocation: { artifactLocation: { uri: string } };
          }[];
        }[];
      }[];
    };
    expect(log.version).toBe("2.1.0");
    expect(log.runs[0]?.tool.driver.name).toBe("docmeta");
    expect(log.runs[0]?.results[0]?.ruleId).toContain("/required");
    expect(
      log.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation
        .uri,
    ).toBe("test/fixtures/missing-type.md");
  });

  it("emits a full SARIF envelope on a clean run rather than nothing at all", () => {
    const r = run(["validate", "test/fixtures/valid.md", "-f", "sarif"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
    const log = JSON.parse(r.stdout) as { runs: { results: unknown[] }[] };
    expect(log.runs[0]?.results).toEqual([]);
  });

  it("emits JUnit XML whose counts match the pretty summary", () => {
    const r = run([
      "validate",
      "test/fixtures/valid.md",
      "test/fixtures/missing-type.md",
      "-f",
      "junit",
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('<testsuites name="docmeta" tests="2" failures="1"');
    expect(r.stdout).toContain('<testcase name="test/fixtures/valid.md"');
    expect(r.stdout).toContain("<failure ");
  });

  it("emits a full JUnit envelope on a clean run rather than nothing at all", () => {
    const r = run(["validate", "test/fixtures/valid.md", "-f", "junit"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('failures="0"');
    expect(r.stdout).not.toContain("<failure");
  });

  it("keeps the config notice off stdout so SARIF stays parseable", () => {
    const r = runIn(
      ["validate", "-f", "sarif"],
      resolve(root, "test/fixtures/nested-config"),
    );
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stdout).not.toContain("Using docmeta.config");
  });

  it("says on stderr when SARIF paths could not be rebased onto a repository root", () => {
    repo = makeTempRepo({
      init: false,
      files: {
        "permissive.schema.json": `${JSON.stringify({
          type: "object",
          required: ["nope"],
        })}\n`,
        "docs/real.md": DOC,
      },
    });
    const r = runIn(
      ["validate", "docs/real.md", "-f", "sarif", "-s", "./permissive.schema.json"],
      repo,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("repository-root-relative");
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it("names every accepted format when --format is wrong", () => {
    const r = run(["validate", "test/fixtures/valid.md", "-f", "toml"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Unknown --format");
    expect(r.stderr).toContain("pretty, json, github, sarif, or junit");
  });
});

describe("docmeta CLI: --offline and the cross-run schema cache (built bin)", () => {
  let repo: string | undefined;

  const runIn = (args: string[], cwd: string): Run => {
    const r = spawnSync("node", [bin, ...args], { cwd, encoding: "utf8" });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      status: r.status ?? 1,
    };
  };

  /**
   * The async runner, for the tests backed by `startSchemaServer`.
   *
   * `spawnSync` blocks this process's event loop, and the schema server lives
   * *in* this process — so a synchronous child would sit waiting for a reply
   * that cannot be sent until it exits, and every request would time out.
   */
  const runInAsync = (args: string[], cwd: string): Promise<Run> =>
    new Promise((done) => {
      execFile(
        "node",
        [bin, ...args],
        { cwd, encoding: "utf8" },
        (err, stdout, stderr) => {
          done({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            status: err ? ((err as { code?: number }).code ?? 1) : 0,
          });
        },
      );
    });

  afterEach(() => {
    removeTempRepo(repo);
    repo = undefined;
  });

  it("--offline validates against the default built-in schema set", () => {
    // Built-ins are bundled JSON imports, so nothing about them touches the
    // network. Asserted explicitly so nobody later "optimizes" a built-in into
    // a URL fetch and breaks every air-gapped build at once.
    const r = run(["validate", "test/fixtures/valid.md", "--offline"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 passed");
    // And no cache directory was created for a run that fetched nothing.
    expect(existsSync(join(root, ".docmeta", "schema-cache"))).toBe(false);
  });

  it("--offline reads a local schema file", () => {
    const r = run([
      "validate",
      "test/fixtures/valid.md",
      "-s",
      "./test/fixtures/extra.schema.json",
      "--offline",
    ]);
    expect(r.status).toBe(0);
  });

  it("--offline is accepted by get", () => {
    const r = run(["get", "type", "test/fixtures/valid.md", "--offline"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("type=");
  });

  it("--offline is accepted by fill", () => {
    const r = run(["fill", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--offline");
  });

  it("--offline fails on an uncached URL, naming it, without a request", () => {
    repo = makeTempRepo({ files: { "doc.md": DOC } });
    // A closed loopback port: reaching the network at all would produce the
    // *fetch* error instead, which is what tells the two paths apart.
    const url = "https://127.0.0.1:1/house.json";
    const offline = runIn(
      ["validate", "doc.md", "-s", url, "--offline", "--no-config"],
      repo,
    );
    expect(offline.status).toBe(2);
    expect(offline.stderr).toContain(url);
    expect(offline.stderr).toMatch(/offline/i);
    expect(offline.stderr).not.toMatch(/Failed to fetch/);

    const online = runIn(
      ["validate", "doc.md", "-s", url, "--no-config"],
      repo,
    );
    expect(online.status).toBe(2);
    expect(online.stderr).toMatch(/Failed to fetch/);
  });

  it("serves a schema from the disk cache after the host is gone", async () => {
    // The whole point of the cross-run cache, end to end: fetch once, take the
    // server away, and the next process still validates.
    const server = await startSchemaServer({
      "/house.json": { json: { type: "object", required: ["title"] } },
    });
    repo = makeTempRepo({ files: { "doc.md": DOC } });
    const url = `${server.url}/house.json`;

    const first = await runInAsync(
      ["validate", "doc.md", "-s", url, "--no-config"],
      repo,
    );
    expect(first.status).toBe(0);
    expect(server.hits("/house.json")).toBe(1);
    expect(existsSync(join(repo, ".docmeta", "schema-cache"))).toBe(true);

    await server.close();

    const second = await runInAsync(
      ["validate", "doc.md", "-s", url, "--no-config"],
      repo,
    );
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("1 passed");

    // The control, and the reason this test proves anything: a *different*
    // checkout has no cache, so the same command against the same dead host
    // fails. Without it, a pass above could mean the server never really shut
    // down.
    const cold = makeTempRepo({ files: { "doc.md": DOC } });
    try {
      const r = await runInAsync(
        ["validate", "doc.md", "-s", url, "--no-config"],
        cold,
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/Failed to fetch/);
    } finally {
      removeTempRepo(cold);
    }
  });

  it("schemaCache.ttlHours: 0 turns the disk cache off", async () => {
    const server = await startSchemaServer({
      "/off.json": { json: { type: "object" } },
    });
    repo = makeTempRepo({
      files: {
        "doc.md": DOC,
        "docmeta.config.yaml": "schemaCache:\n  ttlHours: 0\n",
      },
    });
    const url = `${server.url}/off.json`;
    expect((await runInAsync(["validate", "doc.md", "-s", url], repo)).status).toBe(
      0,
    );
    expect(existsSync(join(repo, ".docmeta", "schema-cache"))).toBe(false);

    await server.close();
    // Nothing was recorded, so the next run has nowhere to fall back to.
    const second = await runInAsync(["validate", "doc.md", "-s", url], repo);
    expect(second.status).toBe(2);
    expect(second.stderr).toMatch(/Failed to fetch/);
  });

  it("offline: true in config needs no flag", async () => {
    const server = await startSchemaServer({
      "/cfg.json": { json: { type: "object" } },
    });
    repo = makeTempRepo({
      files: { "doc.md": DOC, "docmeta.config.yaml": "offline: true\n" },
    });
    const url = `${server.url}/cfg.json`;
    const r = await runInAsync(["validate", "doc.md", "-s", url], repo);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/offline/i);
    expect(server.hits("/cfg.json")).toBe(0);
    await server.close();
  });
});
