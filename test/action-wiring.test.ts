/**
 * The Action's input→argv wiring.
 *
 * This is the only part of `action.yml` nothing else can check. Whether docmeta
 * exits 1 on a bad file is already covered twice — `formats-demo.yml` runs the
 * built CLI over `test/fixtures/**` expecting findings, and `ci.yml` runs
 * `--format github` over the docs — so a smoke test asserting that would buy
 * nothing. What no other test can see is whether `paths:` lands as a positional,
 * whether a two-line `schema:` becomes two `-s` flags, and whether `args:`
 * survives verbatim.
 *
 * The script under test is extracted from `action.yml` itself rather than
 * copied, so the test cannot pass against a version of the wiring that is no
 * longer shipped.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The `run:` block of the composite step, dedented to a runnable script. */
function actionScript(): string {
  const yaml = readFileSync(join(repoRoot, "action.yml"), "utf8");
  const marker = "      run: |\n";
  const body = yaml.slice(yaml.indexOf(marker) + marker.length);
  return body
    .split("\n")
    .map((line) => (line.startsWith("        ") ? line.slice(8) : line))
    .join("\n");
}

const hasBash = (() => {
  try {
    execFileSync("bash", ["-c", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Run the action's script with a stub `npx` that reports the argv it received. */
function argvFor(env: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "docmeta-action-"));
  mkdirSync(join(dir, "bin"));
  const stub = join(dir, "bin", "npx");
  writeFileSync(stub, '#!/bin/sh\necho "ARGV: $*"\nexit 0\n', "utf8");
  chmodSync(stub, 0o755);
  writeFileSync(join(dir, "run.sh"), actionScript(), "utf8");

  const out = execFileSync("bash", [join(dir, "run.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      GITHUB_OUTPUT: join(dir, "out"),
      DOCMETA_PATHS: "",
      DOCMETA_SCHEMA: "",
      DOCMETA_CONFIG: "",
      DOCMETA_FORMAT: "",
      DOCMETA_VERSION: "4",
      DOCMETA_ARGS: "",
      ...env,
    },
  });
  const line = out.split("\n").find((l) => l.startsWith("ARGV:"));
  if (line === undefined) throw new Error(`no ARGV line in:\n${out}`);
  return line.slice("ARGV:".length).trim();
}

describe.skipIf(!hasBash)("action.yml input wiring", () => {
  it("passes a glob through literally, without shell expansion", () => {
    // The first version of this action expanded it. Bash word-splitting also
    // globs, so `docs/**/*.md` arrived as several hundred resolved paths — the
    // runner's view of the tree substituted for docmeta's own expansion, which
    // applies extension filtering and gitignore rules the shell knows nothing
    // about. Caught here, not by review.
    const argv = argvFor({ DOCMETA_PATHS: "docs/**/*.md" });
    expect(argv).toContain("validate docs/**/*.md");
    expect(argv).not.toContain(".mdx");
  });

  it("still splits several paths on whitespace", () => {
    // `set -f` must disable globbing without disabling word-splitting.
    expect(argvFor({ DOCMETA_PATHS: "docs/ README.md" })).toContain(
      "validate docs/ README.md",
    );
  });

  it("expands a multi-line schema input into one -s per ref", () => {
    const argv = argvFor({ DOCMETA_SCHEMA: "google:okf:0.1\n./local.schema.json" });
    expect(argv).toContain("-s google:okf:0.1");
    expect(argv).toContain("-s ./local.schema.json");
  });

  it("ignores blank lines in the schema input", () => {
    // A YAML block scalar routinely ends with a trailing newline; turning that
    // into a bare `-s` would make docmeta fail on an empty ref.
    const argv = argvFor({ DOCMETA_SCHEMA: "google:okf:0.1\n\n" });
    expect(argv.match(/-s/g) ?? []).toHaveLength(1);
  });

  it("maps config and format to their flags", () => {
    const argv = argvFor({
      DOCMETA_CONFIG: "docmeta.config.yaml",
      DOCMETA_FORMAT: "sarif",
    });
    expect(argv).toContain("-c docmeta.config.yaml");
    expect(argv).toContain("--format sarif");
  });

  it("appends args verbatim, last", () => {
    const argv = argvFor({
      DOCMETA_PATHS: "docs/",
      DOCMETA_ARGS: "--allow-empty --no-gitignore",
    });
    expect(argv.endsWith("--allow-empty --no-gitignore")).toBe(true);
  });

  it("honours the version input, so the smoke test can point at a local build", () => {
    expect(argvFor({ DOCMETA_VERSION: "./docmeta-4.0.0.tgz" })).toContain(
      "docmeta@./docmeta-4.0.0.tgz",
    );
  });

  it("omits every flag whose input is empty", () => {
    // The failure this prevents: `-c ""` or `--format ""`, which the CLI
    // rejects with exit 2 — an action that breaks when an optional input is
    // simply not set.
    const argv = argvFor({ DOCMETA_PATHS: "docs/" });
    expect(argv).not.toContain('-c ""');
    expect(argv).not.toMatch(/--format\s*$/);
  });
});
