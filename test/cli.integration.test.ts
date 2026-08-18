import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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
