import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const bin = resolve(root, "dist", "cli.js");

interface Run {
  stdout: string;
  stderr: string;
  status: number;
}

function run(args: string[], input?: string): Run {
  try {
    const stdout = execFileSync("node", [bin, ...args], {
      cwd: root,
      encoding: "utf8",
      input,
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
