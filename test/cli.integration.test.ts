import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync, execSync, spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
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

/**
 * A `spawnSync` result, with the types Node actually produces.
 *
 * `@types/node` promises `stdout: string` once `encoding` is set. Node really
 * hands back `null` for both streams whenever the *spawn itself* failed — no
 * interpreter on PATH, a signal kill — and every `?? ""` below depends on that.
 * Something has to say so, or a type-aware reader takes those guards for dead
 * code and strips them.
 *
 * A function rather than an annotated `const`: TypeScript narrows an annotated
 * `const` straight back to its initializer's type, so the annotation buys
 * nothing at the use site.
 */
interface SpawnText {
  stdout: string | null;
  stderr: string | null;
  status: number | null;
}
function spawnText(result: SpawnSyncReturns<string>): SpawnText {
  return result;
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
    // Frontmatter supplies no column, so none is invented for it.
    expect(r.stdout).not.toContain("col=");
  });

  it("annotates an html meta tag at its content= column", () => {
    // `<meta name="timestamp" content="last Tuesday">` is line 6; `content`
    // starts at column 28, so the caret lands on the failing value's attribute
    // rather than on `<meta`.
    const r = run(["validate", "test/fixtures/bad-timestamp.html", "-f", "github"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      "::error file=test/fixtures/bad-timestamp.html,line=6,col=28::",
    );
  });

  it("annotates an xml attribute at its value column", () => {
    // `timestamp="last Tuesday"` is line 4; xmldom reports the opening quote
    // of the value, column 21.
    const r = run(["validate", "test/fixtures/bad-timestamp.xml", "-f", "github"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      "::error file=test/fixtures/bad-timestamp.xml,line=4,col=21::",
    );
  });

  it("omits col for a required violation, which points at no token", () => {
    const r = run(["validate", "test/fixtures/missing-type.html", "-f", "github"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("must have required property 'type'");
    expect(r.stdout).not.toContain("col=");
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

  // `--no-config` spells out the second half of the name. `run` stands at the
  // repo root, which carries a `docmeta.config.yaml` of its own, so without the
  // flag this would fall back to that config's `paths:` and check the docs.
  it("exits 2 when get is given no paths and no config", () => {
    const r = run(["get", "type", "--no-config"]);
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
      "--max-turns",
      "--chunk-chars",
      "--local",
      "--concurrency",
      "--fields",
    ]) {
      expect(r.stdout).toContain(flag);
    }
  });

  it("--local refuses a hosted provider, naming it", () => {
    const r = run(["fill", "x.md", "--local", "--provider", "openai"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--local cannot use "openai"/);
    expect(r.stderr).toMatch(/hosted/);
  });

  it("--local refuses claude-cli, whose inference is not local", () => {
    // The case that matters: the binary runs here, the inference does not, and
    // it sits third in the detection order — so it is exactly what --local
    // would otherwise pick up while appearing to work.
    const r = run(["fill", "x.md", "--local", "--provider", "claude-cli"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--local cannot use "claude-cli"/);
    expect(r.stderr).toMatch(/its inference does not/);
  });

  it("--local ignores a stray key rather than detecting and then refusing", () => {
    // With OPENAI_API_KEY set, plain `fill` auto-selects openai. Under --local
    // detection must not run at all: announcing `auto-selected "openai"` and
    // refusing on the next line reads as though the key had been used.
    const r = run(["fill", "no-such-file.md", "--local"], undefined, {
      OPENAI_API_KEY: "sk-fake",
    });
    expect(r.stderr).not.toMatch(/auto-selected "openai"/);
    expect(r.stderr).not.toMatch(/--local cannot use/);
  });

  it("--local accepts llama-cpp", () => {
    // Not a network call: it fails on the missing file, having cleared the
    // provider check, which is what this pins.
    const r = run(["fill", "no-such-file.md", "--local", "--provider", "llama-cpp"]);
    expect(r.stderr).not.toMatch(/--local cannot use/);
  });

  it("exits 2 when given no paths and no config", () => {
    const r = run(["fill", "--no-config"]);
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

  // `nonsense`, not `github`: `fill` gained `github` under 0005 §3. `sarif` and
  // `junit` are still refused, and that pair has its own case with the rest of
  // the parity work.
  it("exits 2 on an unknown --format", () => {
    const r = run(["fill", "test/fixtures/valid.md", "-f", "nonsense"]);
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
    expect(formats.find((f) => f.name === "html")?.writable).toBe(true);
    expect(formats.find((f) => f.name === "xml")?.writable).toBe(true);
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
    const r = spawnText(spawnSync("node", [bin, ...args], { cwd, encoding: "utf8" }));
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
    const r = spawnText(spawnSync("node", [bin, ...args], { cwd, encoding: "utf8" }));
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
    const r = spawnText(spawnSync("node", [bin, ...args], { cwd, encoding: "utf8" }));
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
            stdout,
            stderr,
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

  it("--offline validates a document whose $schema is a published URL", () => {
    // Proposal 0009 stress test 1, end to end. `classifyRef` calls this a URL,
    // so without the alias the run would try to fetch docmeta's own built-in —
    // and fail outright under --offline with nothing in the cache.
    const r = run([
      "validate",
      "test/fixtures/published-url-schema.md",
      "--offline",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 passed");
    // Nothing was fetched, so nothing was cached.
    expect(existsSync(join(root, ".docmeta", "schema-cache"))).toBe(false);
  });

  it("still applies the schema a published URL names, offline", () => {
    // The pass above would also be produced by an alias that resolved to
    // something permissive. `-s` with the URL against a document missing `type`
    // has to fail on OKF's own rule.
    const r = run([
      "validate",
      "test/fixtures/missing-type.md",
      "-s",
      "https://hawkeyexl.github.io/docmeta/schemas/okf/0.1.json",
      "--offline",
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/type/);
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

// ---------------------------------------------------------------------------
// 0008 — `schemas vendor`, end to end against the built binary
// ---------------------------------------------------------------------------

describe("docmeta CLI: schemas vendor (built bin)", () => {
  let repo: string | undefined;

  /**
   * Async, not `spawnSync`: the schema server lives in this process, so a
   * synchronous child would block the event loop waiting for a reply that
   * cannot be sent until it exits.
   */
  const runInAsync = (args: string[], cwd: string): Promise<Run> =>
    new Promise((done) => {
      execFile(
        "node",
        [bin, ...args],
        { cwd, encoding: "utf8" },
        (err, stdout, stderr) => {
          done({
            stdout,
            stderr,
            status: err ? ((err as { code?: number }).code ?? 1) : 0,
          });
        },
      );
    });

  /** A schema that actually rejects something, so a false green is visible. */
  const HOUSE = [
    "{",
    '  "$schema": "https://json-schema.org/draft/2020-12/schema",',
    '  "type": "object",',
    '  "required": ["owner"]',
    "}",
    "",
  ].join("\n");

  const OK = "---\ntitle: t\nowner: docs\n---\n\n# t\n";
  const MISSING_OWNER = "---\ntitle: t\n---\n\n# t\n";

  afterEach(() => {
    removeTempRepo(repo);
    repo = undefined;
  });

  it("survives the host disappearing, and fails loudly when the copy changes", async () => {
    const server = await startSchemaServer({ "/house/2.1.json": { body: HOUSE } });
    repo = makeTempRepo({ files: { "ok.md": OK, "bad.md": MISSING_OWNER } });
    const url = `${server.url}/house/2.1.json`;

    const vendored = await runInAsync(["schemas", "vendor", url], repo);
    expect(vendored.status).toBe(0);
    expect(vendored.stdout).toContain("schema/2.1.json");
    expect(vendored.stdout).toMatch(/integrity\s+sha256-[0-9a-f]{64}/);

    // The host is now gone for good — this is the D2 failure the whole
    // proposal exists to survive.
    await server.close();

    const checked = await runInAsync(["validate", "*.md"], repo);
    // Exit 1, not 2: the schema resolved fine and one document is genuinely
    // non-conformant. A 2 here would mean the copy was not being used.
    expect(checked.status).toBe(1);
    expect(checked.stdout).toContain("./schema/2.1.json");
    expect(checked.stdout).toContain("1 passed, 1 failed");

    // Now break the vendored copy. It must not degrade to "whatever is on
    // disk"; a contract that cannot be trusted stops the run.
    writeFileSync(join(repo, "schema", "2.1.json"), '{"type":"object"}\n', "utf8");
    const tampered = await runInAsync(["validate", "*.md"], repo);
    expect(tampered.status).toBe(2);
    expect(tampered.stderr).toMatch(/does not match its recorded integrity/);
    expect(tampered.stderr).toContain(url);
  });

  it("refuses a gitignored target and leaves the tree untouched", async () => {
    const server = await startSchemaServer({ "/g.json": { body: HOUSE } });
    repo = makeTempRepo({ files: { ".gitignore": ".docmeta/\n" } });
    const r = await runInAsync(
      ["schemas", "vendor", `${server.url}/g.json`, "--dir", ".docmeta/schemas"],
      repo,
    );
    await server.close();

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ignored/i);
    expect(existsSync(join(repo, ".docmeta"))).toBe(false);
    expect(existsSync(join(repo, "docmeta.config.yaml"))).toBe(false);
  });

  it("converts a bare-URL config into a vendored one", async () => {
    const server = await startSchemaServer({ "/house/2.1.json": { body: HOUSE } });
    const url = `${server.url}/house/2.1.json`;
    repo = makeTempRepo({
      files: {
        "ok.md": OK,
        "docmeta.config.yaml": `paths:\n  - "*.md"\nschemas:\n  - ${url}\n`,
      },
    });
    const r = await runInAsync(["schemas", "vendor", url], repo);
    await server.close();

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("reference updated");
    const config = readFileSync(join(repo, "docmeta.config.yaml"), "utf8");
    // The URL is provenance now, not a live dependency.
    expect(config).toContain("ref: ./schema/2.1.json");
    expect(config.match(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")))
      .toHaveLength(1);
    expect((await runInAsync(["validate"], repo)).status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 0005 § 4 — usage errors exit 2, and the terminating success paths still exit 0
// ---------------------------------------------------------------------------

/**
 * `run()` reports `stderr: ""` whenever the child exits 0, because
 * `execFileSync` returns stdout alone. Half of these cases are about a *passing*
 * run (`--help`, `-V`), and all of them assert on stderr, so they need the
 * spawnSync form.
 */
describe("usage errors exit 2 (0005 §4)", () => {
  const runSync = (args: string[]): Run => {
    const r = spawnText(
      spawnSync("node", [bin, ...args], { cwd: root, encoding: "utf8" }),
    );
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      status: r.status ?? 1,
    };
  };

  /**
   * Per subcommand, not just on the program. Commander copies `_exitCallback`
   * **by value** in `copyInheritedSettings` when `.command()` runs, so an
   * `exitOverride()` installed after the subcommands exist leaves every one of
   * them calling `process.exit(1)` while the program-level case passes.
   */
  it.each([
    ["program", ["--nope"]],
    ["validate", ["validate", "--nope"]],
    ["get", ["get", "--nope"]],
    ["fill", ["fill", "--nope"]],
    ["schemas", ["schemas", "--nope"]],
    ["schemas infer", ["schemas", "infer", "--nope"]],
  ])("an unknown option on %s exits 2", (_name, args) => {
    const r = runSync(args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown option");
  });

  it("an unknown command exits 2", () => {
    const r = runSync(["nosuchcommand"]);
    expect(r.status).toBe(2);
  });

  // `schemas vendor <url>`, not `get`: `get`'s field list became `[fields]`
  // under 0005 §1, so commander no longer rejects a bare `get` — the CLI's own
  // guard does, and it is covered with the rest of that rule.
  it("a missing required argument exits 2", () => {
    const r = runSync(["schemas", "vendor"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/missing required argument/i);
  });

  /**
   * `fail()` is for DocmetaError and genuine crashes. Routing a CommanderError
   * through it would append `docmeta: Unexpected error: error: unknown option
   * '--nope'` under a message commander already printed.
   */
  it("does not report a usage error as an unexpected error", () => {
    const r = runSync(["validate", "--nope"]);
    expect(r.stderr).not.toContain("Unexpected error");
  });

  it("keeps the after-error hint short instead of dumping full help", () => {
    const r = runSync(["validate", "--nope"]);
    expect(r.stderr).toContain("(add --help for usage)");
    expect(r.stderr).not.toContain("Examples:");
  });

  it.each([
    ["--help", ["--help"]],
    ["-V", ["-V"]],
    ["--version", ["--version"]],
    ["validate --help", ["validate", "--help"]],
    ["get --help", ["get", "--help"]],
    ["fill --help", ["fill", "--help"]],
    ["schemas --help", ["schemas", "--help"]],
    ["schemas infer --help", ["schemas", "infer", "--help"]],
    // A third success code: commander.help, distinct from
    // commander.helpDisplayed and commander.version. Matching on `exitCode`
    // rather than a hand-written list of code strings is what covers it.
    ["help get", ["help", "get"]],
  ])("%s still exits 0 and prints to stdout", (_name, args) => {
    const r = runSync(args);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stderr).toBe("");
  });
});

// ---------------------------------------------------------------------------
// `schemas -f` is a closed set, like every other command's --format
// ---------------------------------------------------------------------------

describe("schemas rejects an unsupported --format", () => {
  it("exits 2 and names the accepted values", () => {
    const r = run(["schemas", "-f", "nonsense"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('docmeta: Unknown --format "nonsense"');
    expect(r.stderr).toContain("pretty or json");
    // Nothing on stdout: a rejected format must not fall through to a report
    // in some other one.
    expect(r.stdout).toBe("");
  });

  it("does not report it as an unexpected error", () => {
    const r = run(["schemas", "-f", "nonsense"]);
    expect(r.stderr).not.toContain("Unexpected error");
  });

  // `github` is the one that actually bit: it is a real docmeta format, just
  // not one `schemas` can produce, so it read as accepted and printed pretty.
  it("rejects a real format that this command cannot produce", () => {
    const r = run(["schemas", "-f", "github"]);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain("google:okf:0.1");
  });

  it("still accepts json", () => {
    const r = run(["schemas", "-f", "json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty("builtins");
  });

  it("still accepts pretty", () => {
    const r = run(["schemas", "-f", "pretty"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Built-in schemas:");
  });
});

// ---------------------------------------------------------------------------
// A `%` in a violation message must not corrupt the annotation it lands in
// ---------------------------------------------------------------------------

describe("github annotations escape the message", () => {
  it("escapes a % an Ajv pattern message carried through", () => {
    const r = run([
      "validate",
      "test/fixtures/percent-hostile.md",
      "-s",
      "./test/fixtures/percent-hostile.schema.json",
      "-f",
      "github",
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('must match pattern "^[0-9]+%25$"');
    // One annotation, one line: nothing was truncated at the escape.
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 0005 § 1 — `--fields` on `get`, with the positional kept as a fallback
// ---------------------------------------------------------------------------

/**
 * One rule, stated once: **if `--fields` is present, every positional is a
 * path**; otherwise the first positional is the field list, exactly as before.
 *
 * The table is the proposal's probe table, run against the built binary rather
 * than against a commander prototype — the prototype shows what commander
 * binds, not what the action handler does with it, and that is the half that
 * was wrong.
 */
describe("get: --fields, positional kept as a fallback (0005 §1)", () => {
  const A = "test/fixtures/get-parity/docs/a.md";
  const B = "test/fixtures/get-parity/more/b.md";

  interface GetJson {
    file: string;
    present: boolean;
    values: Record<string, unknown>;
  }
  const parse = (r: Run): GetJson[] => JSON.parse(r.stdout) as GetJson[];
  const files = (r: Run): string[] =>
    parse(r).map((x) => x.file.replace(/\\/g, "/"));
  const requested = (r: Run): string[] => {
    // `values` omits an unset field in JSON, so the *requested* set is read
    // from a file where every field resolves.
    const first = parse(r)[0];
    return first ? Object.keys(first.values).sort() : [];
  };

  it("binds the first positional to the field list when --fields is absent", () => {
    const r = run(["get", "title", A, "-f", "json"]);
    expect(r.status).toBe(0);
    expect(requested(r)).toEqual(["title"]);
    expect(files(r)).toEqual([A]);
  });

  it("keeps every later positional a path, including directories", () => {
    const r = run([
      "get",
      "title,type",
      "test/fixtures/get-parity/docs/",
      "test/fixtures/get-parity/more/",
      "-f",
      "json",
    ]);
    expect(r.status).toBe(0);
    expect(requested(r)).toEqual(["title", "type"]);
    expect(files(r).sort()).toEqual([A, B]);
  });

  it("--fields makes the first positional a path", () => {
    const r = run(["get", "--fields", "title", A, "-f", "json"]);
    expect(r.status).toBe(0);
    expect(requested(r)).toEqual(["title"]);
    expect(files(r)).toEqual([A]);
  });

  it("--fields keeps every positional a path", () => {
    const r = run(["get", "--fields", "title", A, B, "-f", "json"]);
    expect(r.status).toBe(0);
    expect(files(r).sort()).toEqual([A, B]);
  });

  it("--fields=value is accepted, and the positional is still a path", () => {
    const r = run(["get", "--fields=title", A, "-f", "json"]);
    expect(r.status).toBe(0);
    expect(requested(r)).toEqual(["title"]);
    expect(files(r)).toEqual([A]);
  });

  it("--fields with no positional falls back to config paths:", () => {
    const repo = makeTempRepo({
      files: {
        "docmeta.config.yaml": 'paths:\n  - "*.md"\n',
        "one.md": "---\ntitle: from config\n---\n\n# one\n",
      },
      init: false,
    });
    try {
      const r = spawnText(
        spawnSync("node", [bin, "get", "--fields", "title", "-f", "json"], {
          cwd: repo,
          encoding: "utf8",
        }),
      );
      expect(r.status).toBe(0);
      const parsed = JSON.parse(r.stdout ?? "") as GetJson[];
      expect(parsed.map((x) => x.values.title)).toEqual(["from config"]);
    } finally {
      removeTempRepo(repo);
    }
  });

  it("--fields still leaves - reading stdin", () => {
    const r = run(
      ["get", "--fields", "type", "-", "--as", "markdown", "-f", "json"],
      "---\ntype: note\n---\n",
    );
    expect(r.status).toBe(0);
    expect(parse(r)[0]?.values.type).toBe("note");
  });
});

// ---------------------------------------------------------------------------
// 0005 § 2 — "that's a path, not a field list"
// ---------------------------------------------------------------------------

describe("get names the real mistake when a path lands in [fields] (0005 §2)", () => {
  const A = "test/fixtures/get-parity/docs/a.md";
  const B = "test/fixtures/get-parity/more/b.md";
  const LOOKS = "looks like a path, not a field list";
  // spawnSync, because `run()` reports stderr as "" on a passing run and two of
  // these assert on stderr while expecting exit 0.
  const runIn = (args: string[], cwd: string): Run => {
    const r = spawnText(spawnSync("node", [bin, ...args], { cwd, encoding: "utf8" }));
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      status: r.status ?? 1,
    };
  };

  it("fires on a sole positional that is a file path", () => {
    const r = run(["get", A]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(LOOKS);
    // The old message blamed the *paths*, which were never the problem.
    expect(r.stderr).not.toContain("No files to read");
  });

  it("fires with paths following it, too", () => {
    // The guard is on the field-list argument, not on "there is exactly one
    // positional" — otherwise `get a.md b.md` silently reports `a.md=(unset)`.
    const r = run(["get", A, B]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(LOOKS);
    expect(r.stdout).not.toContain("(unset)");
  });

  it("fires on a bare directory name, which has no dot or separator", () => {
    const r = run(["get", "docs"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(LOOKS);
  });

  it("fires on a glob", () => {
    const r = run(["get", "test/fixtures/*.md"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(LOOKS);
  });

  it("does not fire on a bare field name that also names a real path", () => {
    // Field names collide with directory names constantly — `tags`, `docs`,
    // `type`, `content`. `existsSync` alone refused this legal invocation and
    // suggested `docmeta get title tags`, which is nonsense. A shapeless token
    // is a path only when nothing else was offered as one.
    const cwd = join(root, "test", "fixtures", "get-parity");
    const r = runIn(["get", "tags", "docs/a.md", "-f", "json"], cwd);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain(LOOKS);
  });

  it("still fires on that same name when it stands alone", () => {
    // The other half: with no path following, a bare name that is really there
    // is the forgotten-field-list case the guard exists for.
    const cwd = join(root, "test", "fixtures", "get-parity");
    const r = runIn(["get", "tags"], cwd);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(LOOKS);
  });

  it("refuses a bare `-` in the field slot instead of naming a field `-`", () => {
    // `-` is stdin, never a field. Treated as one, it printed `-=(unset)` for
    // every file in the config's `paths:` and exited 0 — the piped document
    // never read, the run looking entirely successful.
    const cwd = join(root, "test", "fixtures", "get-parity");
    const r = runIn(["get", "-", "--as", "markdown"], cwd);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Specify at least one field");
    expect(r.stdout).not.toContain("-=(unset)");
  });

  it("does not fire on a real field list", () => {
    const r = run(["get", "title,type", A, "-f", "json"]);
    expect(r.status).toBe(0);
  });

  it("does not fire on a JSON Pointer field, which carries slashes", () => {
    const r = run([
      "get",
      "/author/email",
      "test/fixtures/nested/doc.md",
      "-f",
      "json",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("jane@example.com");
  });

  it("does not fire on a mixed list holding a pointer", () => {
    const r = run([
      "get",
      "author.name,/author/email",
      "test/fixtures/nested/doc.md",
      "-f",
      "json",
    ]);
    expect(r.status).toBe(0);
  });

  it("bare `get` is an operational error, not a run over `undefined`", () => {
    // `[fields]` is optional now, so commander no longer rejects this. Without
    // its own guard the CLI would print `undefined=(unset)` per file, exit 0,
    // and read as a successful extraction of a field nobody asked for.
    const r = run(["get"]);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain("undefined");
    expect(r.stderr).toMatch(/field/i);
  });
});

// ---------------------------------------------------------------------------
// 0005 § 2/3 — `-q/--quiet` on `get` and `fill`, `-f github` on `fill`
// ---------------------------------------------------------------------------

describe("get --quiet (0005 §2)", () => {
  // `--no-config` on both runs, because the assertion is that quiet stdout is
  // *empty*. The repo root's own config would otherwise put `Using
  // docmeta.config.yaml (.)` there — a true statement about the run, but not a
  // file, and it would turn this into a test about the notice.
  it("hides a file where every requested field is unset", () => {
    const args = ["get", "title", "test/fixtures/no-frontmatter.md", "--no-config"];
    const noisy = run(args);
    expect(noisy.status).toBe(0);
    expect(noisy.stdout).toContain("title=(unset)");

    const quiet = run([...args, "-q"]);
    expect(quiet.status).toBe(0);
    expect(quiet.stdout.trim()).toBe("");
  });

  it("still prints a file where one requested field is set", () => {
    const r = run([
      "get",
      "title,owner",
      "test/fixtures/get-parity/partial.md",
      "--quiet",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("title=Only a title");
    // Quiet hides files, never values: the unset one still shows.
    expect(r.stdout).toContain("owner=(unset)");
  });

  it("has no effect on json", () => {
    const r = run([
      "get",
      "title",
      "test/fixtures/no-frontmatter.md",
      "-q",
      "-f",
      "json",
    ]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveLength(1);
  });
});

/**
 * `--provider mock --dry-run --no-cache` on every run that actually reaches
 * `fill`: with `auto`, a machine with no key detects `llama-cpp` and starts
 * downloading multi-gigabyte weights.
 */
describe("fill accepts -q and -f github (0005 §3)", () => {
  const MOCK = ["--provider", "mock", "--dry-run", "--no-cache"];

  it("accepts --quiet", () => {
    const r = run(["fill", "test/fixtures/valid.md", ...MOCK, "--quiet"]);
    expect(r.status).toBe(0);
  }, 60000);

  it("accepts -f github", () => {
    const r = run(["fill", "test/fixtures/valid.md", ...MOCK, "-f", "github"]);
    expect(r.status).toBe(0);
  }, 60000);

  it("still rejects sarif and junit", () => {
    for (const format of ["sarif", "junit"]) {
      const r = run(["fill", "test/fixtures/valid.md", ...MOCK, "-f", format]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("Unknown --format");
    }
  }, 60000);

  /**
   * With `-`, the filled document owns stdout and the report goes to stderr,
   * where GitHub never reads `::error`. An annotation nobody can see is exactly
   * the false green this proposal set exists to remove, so the request is
   * refused rather than silently degraded.
   */
  it("refuses -f github with stdin, rather than annotating into stderr", () => {
    const r = run(
      ["fill", "-", "--as", "markdown", "-f", "github", ...MOCK],
      "---\ntype: note\n---\n",
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/stdin/i);
  }, 60000);
});

// ---------------------------------------------------------------------------
// 0015 — the trust boundary for document-supplied schemas, end to end
// ---------------------------------------------------------------------------

describe("docmeta CLI: schemaTrust (built bin)", () => {
  let repo: string | undefined;

  /**
   * `execFile`, not `spawnSync`: the schema server lives in *this* process, so
   * a synchronous child would block the event loop waiting for a reply that
   * cannot be sent until it exits.
   */
  const runInAsync = (args: string[], cwd: string): Promise<Run> =>
    new Promise((done) => {
      execFile("node", [bin, ...args], { cwd, encoding: "utf8" }, (err, stdout, stderr) => {
        done({
          stdout,
          stderr,
          status: err ? ((err as { code?: number }).code ?? 1) : 0,
        });
      });
    });

  afterEach(() => {
    removeTempRepo(repo);
    repo = undefined;
  });

  it("reproduces the Problem, then closes it with documentRefs: local", async () => {
    const server = await startSchemaServer({
      // A schema that constrains nothing, so every document passes it.
      "/permissive.json": { json: { type: "object" } },
    });
    try {
      const url = `${server.url}/permissive.json`;
      repo = makeTempRepo({
        files: {
          "docmeta.config.yaml": "schemas:\n  - google:okf:0.1\n",
          "contributed.md": `---\ntitle: Contributed page\n$schema: ${url}\n---\n`,
          "honest.md": "---\ntitle: Honest page\n---\n",
        },
      });

      // Default: the contributor who opted out passes; the document playing by
      // the config's rules is the one that fails. This is the documented
      // feature, and it must keep working.
      const before = await runInAsync(["validate", "*.md"], repo);
      expect(before.status).toBe(1);
      expect(before.stdout).toContain("✓ contributed.md");
      expect(before.stdout).toContain("✗ honest.md");

      writeFileSync(
        join(repo, "docmeta.config.yaml"),
        "schemas:\n  - google:okf:0.1\nschemaTrust:\n  documentRefs: local\n",
        "utf8",
      );

      const after = await runInAsync(["validate", "*.md"], repo);
      // Exit 1, not 2. A refusal is ONE FAILING FILE annotated on the offending
      // document, not an aborted run — which is what puts it on the pull
      // request rather than in a stack trace.
      expect(after.status).toBe(1);
      expect(after.stdout).toContain("✗ contributed.md");
      expect(after.stdout).toContain("2 files checked, 0 passed, 2 failed");
      expect(after.stdout).toContain("schemaTrust.documentRefs");
      // The honest document's verdict is unchanged: still the config's schema.
      expect(after.stdout).toContain("required property 'type'");
    } finally {
      await server.close();
    }
  }, 60000);

  it("annotates the refusal on the document in --format github", async () => {
    const server = await startSchemaServer({
      "/permissive.json": { json: { type: "object" } },
    });
    try {
      repo = makeTempRepo({
        files: {
          "docmeta.config.yaml":
            "schemas:\n  - google:okf:0.1\nschemaTrust:\n  documentRefs: local\n",
          "contributed.md": `---\ntitle: t\n$schema: ${server.url}/permissive.json\n---\n`,
        },
      });
      const r = await runInAsync(["validate", "*.md", "-f", "github"], repo);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/^::error file=contributed\.md/m);
    } finally {
      await server.close();
    }
  }, 60000);

  it("lets `local` keep a published built-in URL, which reaches nothing (0009)", () => {
    // The docs advertise these URLs, so refusing them in the strictest mode
    // would make docmeta's own recommended spelling unusable there. They are
    // served from the bundle — no host answers for them — so `local` has no
    // reason to refuse, and neither does a `hosts` allowlist that omits the
    // docs site.
    repo = makeTempRepo({
      files: {
        "docmeta.config.yaml":
          "schemas:\n  - diataxis:diataxis:1.0\nschemaTrust:\n  documentRefs: local\n  hosts:\n    - schemas.example.com\n",
        "page.md":
          "---\ntitle: t\ntype: guide\n$schema: https://hawkeyexl.github.io/docmeta/schemas/okf/0.1.json\n---\n",
      },
    });
    const r = spawnSync("node", [bin, "validate", "*.md", "--offline"], {
      cwd: repo,
      encoding: "utf8",
    });
    // Exit 0: the document's own URL won, and OKF accepts `type: guide`. Under
    // the config's diataxis schema `guide` is not a member, so a pass here also
    // proves the document's ref was honored rather than dropped.
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 passed");
  });
});

// ---------------------------------------------------------------------------
// `docmeta schemas infer` (0010)
// ---------------------------------------------------------------------------

describe("schemas infer end to end", () => {
  const fixtures = "test/fixtures/infer";

  it("prints the coverage report and exits 0 — it reports, it does not judge", () => {
    const r = run(["schemas", "infer", fixtures, "--no-config"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("8 files scanned");
    // The frontmatter-free file gets its own line rather than a quieter
    // denominator: it is the surprise the retrofit page warns about.
    expect(r.stdout).toContain("1 with no metadata block");
    expect(r.stdout).toMatch(/title\s+87\.5%/);
    expect(r.stdout).toMatch(/lastReviewed\s+12\.5%/);
    // The 4-versus-1 split reads as a data error, with a location.
    expect(r.stdout).toContain("string ×4, number ×1");
    expect(r.stdout).toMatch(/type-outlier\.md:4/);
  });

  /**
   * The regression guard for a real false green: `schemas` declares its own
   * `-f`, and commander binds a parent's option wherever it appears in the
   * argv, so `schemas infer -f json` set the *parent's* format and the run
   * answered in `pretty` with exit 0 — a request docmeta can honor, served in a
   * format nobody asked for.
   */
  it("honors -f json written after the subcommand", () => {
    const r = run(["schemas", "infer", fixtures, "--no-config", "-f", "json"]);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout) as {
      filesScanned: number;
      filesWithoutMetadata: number;
      draft: Record<string, unknown>;
    };
    expect(report.filesScanned).toBe(8);
    expect(report.filesWithoutMetadata).toBe(1);
    expect(report.draft).not.toHaveProperty("required");
  });

  it("rejects an unsupported --format rather than falling through to pretty", () => {
    const r = run(["schemas", "infer", fixtures, "-f", "github"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unknown --format "github"');
    expect(r.stdout).toBe("");
  });

  it("writes a draft with --out, then refuses to overwrite it", () => {
    const repo = makeTempRepo({
      files: { "docs/a.md": DOC, "docs/b.md": DOC },
    });
    try {
      const first = run(
        ["schemas", "infer", "docs", "--no-config", "--out", "./draft.json"],
        undefined,
        undefined,
        repo,
      );
      expect(first.status).toBe(0);
      expect(first.stdout).toContain("draft.json");
      const draft = JSON.parse(
        readFileSync(join(repo, "draft.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(draft).not.toHaveProperty("required");
      expect(draft.properties).toHaveProperty("title");

      const again = run(
        ["schemas", "infer", "docs", "--no-config", "--out", "./draft.json"],
        undefined,
        undefined,
        repo,
      );
      expect(again.status).toBe(2);
      expect(again.stderr).toMatch(/already exists/);
      // Byte-identical: the refusal happened before anything was written.
      expect(
        JSON.parse(readFileSync(join(repo, "draft.json"), "utf8")),
      ).toEqual(draft);
    } finally {
      removeTempRepo(repo);
    }
  });

  it("--min-coverage must be a percentage", () => {
    const r = run(["schemas", "infer", fixtures, "--min-coverage", "150"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--min-coverage");
  });
});
