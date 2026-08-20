import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { parseBaseline } from "../src/core/baseline.js";
import { runValidate, type ValidateOptions } from "../src/commands/validate.js";
import { runGet } from "../src/commands/get.js";
import { getSchemasInfo } from "../src/commands/schemas.js";
import { DEFAULT_SCHEMAS } from "../src/core/resolve-schema.js";
import { DocmetaError } from "../src/types.js";
import { startSchemaServer, type SchemaServer } from "./helpers/schema-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const extra = join(here, "fixtures", "extra.schema.json");
/** A page that fails the default schema set on `required: type`. */
const NO_TYPE_PAGE = "---\ntitle: No type\n---\n";
/** A config whose `baseline:` deliberately is not the default path. */
const CUSTOM_BASELINE_CONFIG = [
  "paths:",
  '  - "*.md"',
  "schemas:",
  "  - google:okf:0.1",
  "baseline: recorded.json",
  "",
].join("\n");

/** Escape a string (an ephemeral-port URL) for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function byFile(results: { file: string; ok: boolean }[]) {
  return Object.fromEntries(
    results.map((r) => [r.file.split("/").pop(), r.ok]),
  );
}

describe("runValidate", () => {
  it("validates a glob of markdown against OKF by default", async () => {
    const { results, summary } = await runValidate({
      inputs: ["test/fixtures/*.md"],
      cwd: root,
    });
    const ok = byFile(results);
    expect(ok["valid.md"]).toBe(true);
    expect(ok["schema-ref.md"]).toBe(true);
    // Assert the exact set of failures rather than a bare count, so adding a
    // new *passing* fixture to test/fixtures/ doesn't break this test while a
    // new *failing* one is still surfaced deliberately.
    const failed = results
      .filter((r) => !r.ok)
      .map((r) => r.file.split("/").pop())
      .sort();
    expect(failed).toEqual([
      "bad-timestamp.md",
      "missing-type.md",
      "no-frontmatter.md",
    ]);
    expect(summary.failed).toBe(failed.length);
  });

  it("validates against multiple schemas (a set)", async () => {
    const { results } = await runValidate({
      inputs: ["test/fixtures/valid.md"],
      cliSchemas: ["google:okf:0.1", extra],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.schemas).toEqual(["google:okf:0.1", extra]);
  });

  it("CLI --schema overrides the file's $schema", async () => {
    // missing-type.md has a title but no type; the `extra` schema only needs
    // a title, so overriding with it alone passes.
    const { results } = await runValidate({
      inputs: ["test/fixtures/missing-type.md"],
      cliSchemas: [extra],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
  });

  it("flags a malformed timestamp on the right line", async () => {
    const { results } = await runValidate({
      inputs: ["test/fixtures/bad-timestamp.md"],
      cwd: root,
    });
    const err = results[0]?.errors[0];
    expect(err?.instancePath).toBe("/timestamp");
    expect(err?.line).toBe(4);
  });

  it("handles mdx via the markdown frontmatter logic", async () => {
    const { results } = await runValidate({
      inputs: ["test/fixtures/sample.mdx"],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.format).toBe("mdx");
  });

  it("validates stdin with --as", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntype: note\n---\n# Hi\n",
      cwd: root,
    });
    expect(results[0]?.file).toBe("<stdin>");
    expect(results[0]?.ok).toBe(true);
  });

  it("throws when no inputs and no config", async () => {
    await expect(runValidate({ inputs: [], cwd: root })).rejects.toBeInstanceOf(
      DocmetaError,
    );
  });

  it("fetches a URL $schema from frontmatter and validates against it", async () => {
    const server = await startSchemaServer({
      "/draft07.json": {
        json: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          required: ["type"],
          additionalProperties: true,
        },
      },
    });
    // A throwaway cwd, not `root`: a *successful* remote fetch now persists a
    // cross-run cache entry under the run's `.docmeta/schema-cache/`, and a test
    // must not leave one in this repository.
    const cwd = await mkdtemp(join(tmpdir(), "docmeta-url-schema-"));
    try {
      const url = `${server.url}/draft07.json`;
      const pass = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent: `---\n$schema: ${url}\ntype: note\n---\n# Hi\n`,
        cwd,
      });
      expect(pass.results[0]?.ok).toBe(true);
      expect(pass.results[0]?.schemas).toEqual([url]);

      const fail = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent: `---\n$schema: ${url}\ntitle: no type\n---\n# Hi\n`,
        cwd,
      });
      expect(fail.results[0]?.ok).toBe(false);
      expect(fail.results[0]?.errors[0]?.schema).toBe(url);
      expect(fail.results[0]?.errors[0]?.message).toMatch(/type/);
    } finally {
      await server.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails the run when a schema URL answers 200 with an error envelope", async () => {
    // End to end, this is the false green the payload guard closes: a document
    // that fails its real schema was reported as PASSING, exit 0, because an
    // envelope compiles as a schema with no constraints. The assertion is about
    // the verdict on the document, not just the wording of the error.
    const server = await startSchemaServer({
      "/envelope.json": { json: { error: "not found", requestId: "abc123" } },
    });
    try {
      const url = `${server.url}/envelope.json`;
      const run = runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent: NO_TYPE_PAGE,
        cliSchemas: [url],
        cwd: root,
      });
      // Operational error (exit 2), not a green run.
      await expect(run).rejects.toBeInstanceOf(DocmetaError);
      await expect(run).rejects.toThrow(new RegExp(escapeRe(url)));
    } finally {
      await server.close();
    }
  });

  it("aborts on an unknown --as format", async () => {
    await expect(
      runValidate({
        inputs: ["-"],
        as: "bogus",
        stdinContent: "x",
        cwd: root,
      }),
    ).rejects.toBeInstanceOf(DocmetaError);
  });
});

describe("runGet", () => {
  it("returns requested field values", async () => {
    const results = await runGet({
      fields: ["title", "type"],
      inputs: ["test/fixtures/valid.md"],
      cwd: root,
    });
    expect(results[0]?.values.title).toBe("A Valid Document");
    expect(results[0]?.values.type).toBe("concept");
  });

  it("reads nested fields via dot-notation", async () => {
    const results = await runGet({
      fields: ["author.name", "author.email", "tags.0"],
      inputs: ["test/fixtures/nested/doc.md"],
      cwd: root,
    });
    expect(results[0]?.values["author.name"]).toBe("Jane");
    expect(results[0]?.values["author.email"]).toBe("jane@example.com");
    expect(results[0]?.values["tags.0"]).toBe("intro");
  });

  it("reads nested fields via JSON Pointer", async () => {
    const results = await runGet({
      fields: ["/author/name", "/tags/1"],
      inputs: ["test/fixtures/nested/doc.md"],
      cwd: root,
    });
    expect(results[0]?.values["/author/name"]).toBe("Jane");
    expect(results[0]?.values["/tags/1"]).toBe("setup");
  });

  it("returns the whole object when a parent key is requested", async () => {
    const results = await runGet({
      fields: ["author"],
      inputs: ["test/fixtures/nested/doc.md"],
      cwd: root,
    });
    expect(results[0]?.values.author).toEqual({
      name: "Jane",
      email: "jane@example.com",
    });
  });

  it("returns undefined for a missing nested path", async () => {
    const results = await runGet({
      fields: ["author.phone", "/author/phone", "missing.deep"],
      inputs: ["test/fixtures/nested/doc.md"],
      cwd: root,
    });
    expect(results[0]?.values["author.phone"]).toBeUndefined();
    expect(results[0]?.values["/author/phone"]).toBeUndefined();
    expect(results[0]?.values["missing.deep"]).toBeUndefined();
  });

  it("does not descend into scalars", async () => {
    const results = await runGet({
      fields: ["title.nope"],
      inputs: ["test/fixtures/nested/doc.md"],
      cwd: root,
    });
    expect(results[0]?.values["title.nope"]).toBeUndefined();
  });

  it("addresses a key with a literal dot via JSON Pointer, not dot-notation", async () => {
    const results = await runGet({
      fields: ["/odd.key", "odd.key"],
      inputs: ["test/fixtures/nested/doc.md"],
      cwd: root,
    });
    // The pointer treats `odd.key` as one segment and resolves the key.
    expect(results[0]?.values["/odd.key"]).toBe("dotted");
    // Dot-notation splits it into `odd` -> `key`, which does not exist.
    expect(results[0]?.values["odd.key"]).toBeUndefined();
  });

  it("decodes RFC 6901 escape sequences in JSON Pointer keys", async () => {
    const results = await runGet({
      fields: ["/a~1b", "/a~0b"],
      inputs: ["test/fixtures/nested/doc.md"],
      cwd: root,
    });
    expect(results[0]?.values["/a~1b"]).toBe("slashed"); // ~1 -> "/", key "a/b"
    expect(results[0]?.values["/a~0b"]).toBe("tilded"); // ~0 -> "~", key "a~b"
  });

  it("does not resolve inherited object members", async () => {
    const results = await runGet({
      fields: ["author.toString", "__proto__.polluted", "author.constructor"],
      inputs: ["test/fixtures/nested/doc.md"],
      cwd: root,
    });
    expect(results[0]?.values["author.toString"]).toBeUndefined();
    expect(results[0]?.values["__proto__.polluted"]).toBeUndefined();
    expect(results[0]?.values["author.constructor"]).toBeUndefined();
  });

  it("reads from a glob of paths like validate", async () => {
    const results = await runGet({
      fields: ["type"],
      inputs: ["test/fixtures/*.md"],
      cwd: root,
    });
    expect(results.length).toBeGreaterThan(1);
  });

  it("reads stdin with --as", async () => {
    const results = await runGet({
      fields: ["type"],
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntype: note\n---\n",
      cwd: root,
    });
    expect(results[0]?.file).toBe("<stdin>");
    expect(results[0]?.values.type).toBe("note");
  });

  it("requires --as when reading from stdin", async () => {
    await expect(
      runGet({ fields: ["type"], inputs: ["-"], stdinContent: "x", cwd: root }),
    ).rejects.toBeInstanceOf(DocmetaError);
  });

  it("throws when no inputs and no config (parity with validate)", async () => {
    await expect(
      runGet({ fields: ["type"], inputs: [], cwd: root }),
    ).rejects.toBeInstanceOf(DocmetaError);
  });

  it("falls back to config paths when no inputs are given", async () => {
    const results = await runGet({
      fields: ["type"],
      inputs: [],
      cwd: join(here, "fixtures"),
      configPath: join(here, "fixtures", "docmeta.config.yaml"),
    });
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("getSchemasInfo", () => {
  it("lists OKF and marks markdown, asciidoc, rst, xml and html implemented", () => {
    const info = getSchemasInfo();
    expect(info.builtins.map((b) => b.id)).toContain("google:okf:0.1");
    const md = info.formats.find((f) => f.name === "markdown");
    const adoc = info.formats.find((f) => f.name === "asciidoc");
    const rst = info.formats.find((f) => f.name === "rst");
    const xml = info.formats.find((f) => f.name === "xml");
    const html = info.formats.find((f) => f.name === "html");
    expect(md?.implemented).toBe(true);
    expect(adoc?.implemented).toBe(true);
    expect(rst?.implemented).toBe(true);
    expect(xml?.implemented).toBe(true);
    expect(html?.implemented).toBe(true);
  });
});

describe("an empty input set is not success (0014)", () => {
  const nomatch = "test/fixtures/*.nomatch";

  it("runValidate errors when a glob matches nothing", async () => {
    await expect(
      runValidate({ inputs: [nomatch], cwd: root }),
    ).rejects.toBeInstanceOf(DocmetaError);
  });

  it("names the patterns it tried", async () => {
    await expect(
      runValidate({ inputs: [nomatch], cwd: root }),
    ).rejects.toThrow(/\*\.nomatch/);
  });

  it("runGet errors when a glob matches nothing", async () => {
    await expect(
      runGet({ fields: ["title"], inputs: [nomatch], cwd: root }),
    ).rejects.toBeInstanceOf(DocmetaError);
  });

  it("allowEmpty returns an empty run instead of erroring", async () => {
    const { results, summary } = await runValidate({
      inputs: [nomatch],
      cwd: root,
      allowEmpty: true,
    });
    expect(results).toEqual([]);
    expect(summary.files).toBe(0);
  });

  it("stdin alone is not an empty input set", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntype: guide\n---\n",
      cwd: root,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.file).toBe("<stdin>");
  });

  it("empty stdin content is still one input, not zero", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "",
      cwd: root,
    });
    expect(results).toHaveLength(1);
  });

  it("a named file that does not exist errors even alongside a match", async () => {
    await expect(
      runValidate({
        inputs: ["test/fixtures/valid.md", "test/fixtures/nope.md"],
        cwd: root,
      }),
    ).rejects.toThrow(/nope\.md/);
  });

  it("excluding everything is still an empty input set", async () => {
    await expect(
      runValidate({
        inputs: ["test/fixtures/*.md"],
        exclude: ["test/fixtures/**"],
        cwd: root,
      }),
    ).rejects.toBeInstanceOf(DocmetaError);
  });
});

// ---------------------------------------------------------------------------
// 0004 — the config means the same thing from any directory
// ---------------------------------------------------------------------------

describe("config discovery and resolution base (0004)", () => {
  // Root config pins ./strict.schema.json (requires `owner`); docs/api/page.md
  // satisfies the built-in default set and violates the configured one, so a
  // run that fails to find the config reports a false green.
  const nested = join(here, "fixtures", "nested-config");
  const nestedDocs = join(nested, "docs");
  const nestedConfig = join(nested, "docmeta.config.yaml");

  const ownerError = (results: { errors: { message: string }[] }[]): boolean =>
    results.some((r) => r.errors.some((e) => /'owner'/.test(e.message)));

  // The repo-root control now lives here too. It could not before: `loadSchema`
  // read a local schema ref against `process.cwd()` rather than the core's
  // `cwd`, so the case where a config's directory already *is* the run's `cwd`
  // was only reachable from a child process started in that directory. That is
  // fixed, and this is the assertion that would have caught it.
  it("applies the same config when run from the config's own directory", async () => {
    const { results } = await runValidate({
      inputs: ["docs/api/page.md"],
      cwd: nested,
    });
    expect(ownerError(results)).toBe(true);
    // Still the ref exactly as the config wrote it — the fix resolves at read
    // time rather than rewriting refs, so nothing a baseline recorded moves.
    expect(results[0]?.schemas).toEqual(["./strict.schema.json"]);
  });

  it("applies the same config when run from a subdirectory (defect 1)", async () => {
    const { results, summary } = await runValidate({
      inputs: ["api/page.md"],
      cwd: nestedDocs,
    });
    expect(summary.failed).toBe(1);
    expect(ownerError(results)).toBe(true);
    expect(results[0]?.schemas[0]).toMatch(/strict\.schema\.json$/);
  });

  it("resolves a config-relative schema ref for an out-of-cwd -c (defect 2A)", async () => {
    const { results, summary } = await runValidate({
      inputs: ["api/page.md"],
      cwd: nestedDocs,
      configPath: nestedConfig,
    });
    expect(summary.failed).toBe(1);
    expect(ownerError(results)).toBe(true);
  });

  it("resolves config `paths:` against the config's directory (defect 2B)", async () => {
    const { results } = await runValidate({
      inputs: [],
      cwd: nestedDocs,
      configPath: nestedConfig,
    });
    // The glob is `docs/**/*.md`, written from the config's directory.
    expect(results.map((r) => r.file)).toEqual(["docs/api/page.md"]);
  });

  it("runGet resolves config `paths:` the same way", async () => {
    const results = await runGet({
      fields: ["type"],
      inputs: [],
      cwd: nestedDocs,
      configPath: nestedConfig,
    });
    expect(results.map((r) => r.file)).toEqual(["docs/api/page.md"]);
    expect(results[0]?.values.type).toBe("guide");
  });

  it("noConfig suppresses discovery and restores the built-in defaults", async () => {
    const { results, summary } = await runValidate({
      inputs: ["api/page.md"],
      cwd: nestedDocs,
      noConfig: true,
    });
    expect(summary.failed).toBe(0);
    expect(results[0]?.schemas).toEqual([...DEFAULT_SCHEMAS]);
  });

  it("reports which config a run picked up", async () => {
    const seen: { path: string; dir: string }[] = [];
    await runValidate({
      inputs: ["api/page.md"],
      cwd: nestedDocs,
      onConfigLoaded: (info) => seen.push(info),
    });
    expect(seen).toEqual([{ path: nestedConfig, dir: nested }]);
  });

  it("reports nothing when no config is found", async () => {
    const seen: unknown[] = [];
    await runValidate({
      inputs: ["test/fixtures/valid.md"],
      cwd: root,
      onConfigLoaded: (info) => seen.push(info),
    });
    expect(seen).toEqual([]);
  });

  it("reports nothing when noConfig suppresses a config that exists", async () => {
    // Distinct from the case above: here discovery *would* find one. Asserted
    // at the API level rather than only through the absence of a line in CLI
    // output, so the contract is visible to a library caller.
    const seen: unknown[] = [];
    const { results } = await runValidate({
      inputs: ["api/page.md"],
      cwd: nestedDocs,
      noConfig: true,
      onConfigLoaded: (info) => seen.push(info),
    });
    expect(seen).toEqual([]);
    expect(results[0]?.schemas).toEqual([...DEFAULT_SCHEMAS]);
  });
});

describe("runValidate with a baseline", () => {
  const dir = join(here, "fixtures", "baseline");
  const schema = "test/fixtures/baseline/keywords.schema.json";
  const inputs = ["test/fixtures/baseline/*.md"];
  const rel = (name: string) =>
    relative(root, join(dir, name)).replace(/\\/g, "/");

  const runWith = (over: Partial<ValidateOptions> = {}) =>
    runValidate({ inputs, cliSchemas: [schema], cwd: root, ...over });

  it("fails without a baseline — the fixtures really do violate the schema", async () => {
    // Anchors every assertion below: if this ever passes, the "baseline
    // suppressed it" tests would pass for the wrong reason.
    const { summary } = await runWith();
    expect(summary.failed).toBe(2);
    expect(summary.errors).toBe(3);
  });

  it("suppresses every baselined finding and exits clean", async () => {
    const { results, summary } = await runWith({
      baseline: rel("baseline.json"),
    });
    expect(summary.failed).toBe(0);
    expect(summary.errors).toBe(0);
    expect(summary.baseline).toMatchObject({
      written: false,
      recorded: 3,
      suppressed: 3,
      stale: 0,
    });
    const twoViolations = results.find((r) => r.file.endsWith("two-violations.md"));
    expect(twoViolations?.baselined).toBe(2);
  });

  it("fails on a finding the baseline does not hold, and reports only that one", async () => {
    const { results, summary } = await runWith({
      baseline: rel("baseline-partial.json"),
    });
    expect(summary.failed).toBe(1);
    const failing = results.filter((r) => !r.ok);
    expect(failing.map((r) => r.file.split("/").pop())).toEqual([
      "one-violation.md",
    ]);
    expect(failing[0]?.errors.map((e) => e.keyword)).toEqual(["format"]);
  });

  it("reports a stale entry without failing the run", async () => {
    const { summary } = await runWith({
      baseline: rel("baseline-stale.json"),
    });
    expect(summary.failed).toBe(0);
    expect(summary.baseline).toMatchObject({ recorded: 4, suppressed: 3, stale: 1 });
  });

  it("errors when the named baseline does not exist, naming the remedy", async () => {
    await expect(runWith({ baseline: rel("nope.json") })).rejects.toThrow(
      /--write-baseline/,
    );
  });

  it("--no-baseline suppresses a configured baseline", async () => {
    const configured = join(here, "fixtures", "baseline-config");
    const clean = await runValidate({ inputs: [], cwd: configured });
    expect(clean.summary.failed).toBe(0);

    const raw = await runValidate({ inputs: [], cwd: configured, baseline: false });
    expect(raw.summary.failed).toBe(1);
    expect(raw.summary.baseline).toBeUndefined();
  });

  it("resolves a configured baseline against the config file, not cwd", async () => {
    // Run from the docs/ subdirectory: `.docmeta-baseline.json` sits next to
    // the config one level up. Resolving against cwd would find nothing and
    // report the known violation as new.
    const fromSubdir = await runValidate({
      inputs: [],
      cwd: join(here, "fixtures", "baseline-config", "docs"),
    });
    expect(fromSubdir.summary.failed).toBe(0);
    expect(fromSubdir.summary.baseline).toMatchObject({ suppressed: 1, stale: 0 });
  });
});

describe("runValidate --write-baseline", () => {
  const schema = "test/fixtures/baseline/keywords.schema.json";
  const inputs = ["test/fixtures/baseline/*.md"];
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "docmeta-baseline-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("records every finding, exits clean, and reports the additions", async () => {
    const path = join(tmp, "b.json");
    const { summary } = await runValidate({
      inputs,
      cliSchemas: [schema],
      cwd: root,
      writeBaseline: path,
    });
    expect(summary.failed).toBe(0);
    expect(summary.baseline).toMatchObject({
      written: true,
      recorded: 3,
      added: 3,
      removed: 0,
    });
    const written = parseBaseline(await readFile(path, "utf8"), "b.json");
    expect(Object.keys(written.entries).sort()).toEqual([
      "test/fixtures/baseline/one-violation.md",
      "test/fixtures/baseline/two-violations.md",
    ]);
  });

  it("reports what a narrowed re-record drops — the number that catches the mistake", async () => {
    const path = join(tmp, "b.json");
    await runValidate({ inputs, cliSchemas: [schema], cwd: root, writeBaseline: path });

    // A narrowed glob sees only one of the two failing files, so re-recording
    // silently forgives the other. `removed` is the only thing that says so.
    const narrowed = await runValidate({
      inputs: ["test/fixtures/baseline/one-violation.md"],
      cliSchemas: [schema],
      cwd: root,
      writeBaseline: path,
    });
    expect(narrowed.summary.baseline).toMatchObject({
      recorded: 1,
      added: 0,
      removed: 2,
    });
  });

  it("with the value omitted writes the path the config configured", async () => {
    // Read and write must agree on one file. If a bare --write-baseline always
    // used the built-in default, a repo that configured `baseline:` elsewhere
    // would record into a second file nothing ever reads, and the ratchet would
    // quietly do nothing.
    await writeFile(
      join(tmp, "docmeta.config.yaml"),
      CUSTOM_BASELINE_CONFIG,
      "utf8",
    );
    await writeFile(join(tmp, "page.md"), NO_TYPE_PAGE, "utf8");
    const { summary } = await runValidate({
      inputs: [],
      cwd: tmp,
      configPath: join(tmp, "docmeta.config.yaml"),
      writeBaseline: true,
    });
    expect(summary.baseline).toMatchObject({ written: true, path: "recorded.json" });
    expect(existsSync(join(tmp, "recorded.json"))).toBe(true);
    expect(existsSync(join(tmp, ".docmeta-baseline.json"))).toBe(false);
  });

  it("with the value omitted and no config, falls back to the default path", async () => {
    await writeFile(join(tmp, "page.md"), "---\ntitle: No type\n---\n", "utf8");
    const { summary } = await runValidate({
      inputs: ["page.md"],
      cwd: tmp,
      noConfig: true,
      writeBaseline: true,
    });
    expect(summary.baseline?.path).toBe(".docmeta-baseline.json");
    expect(existsSync(join(tmp, ".docmeta-baseline.json"))).toBe(true);
  });

  it("wins over --baseline, so recording never depends on the old file", async () => {
    const path = join(tmp, "b.json");
    const { summary } = await runValidate({
      inputs,
      cliSchemas: [schema],
      cwd: root,
      baseline: join(tmp, "absent.json"),
      writeBaseline: path,
    });
    expect(summary.baseline?.written).toBe(true);
  });
});

describe("a relative config schema ref, for a library caller", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "docmeta-libref-"));
    await mkdir(join(dir, "schema"), { recursive: true });
    await writeFile(
      join(dir, "docmeta.config.yaml"),
      "schemas:\n  - ./schema/house.json\n",
    );
    await writeFile(
      join(dir, "schema", "house.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["owner"],
      }),
    );
    await writeFile(join(dir, "a.md"), "---\ntitle: no owner\n---\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves against the passed cwd, not the process's", async () => {
    // `rebaseConfigSchemaRefs` leaves refs alone when the config's directory
    // already is the run's `cwd`, which is right — but `loadSchema` then read
    // the relative ref against `process.cwd()`. For the CLI those are the same
    // directory so nothing showed; a library caller passing `cwd` got
    // `Schema file not found`, naming a path that exists.
    //
    // A core test cannot move `process.cwd()`, which is exactly why this case
    // had no coverage: it is only reachable when the two differ.
    expect(resolve(dir)).not.toBe(resolve(process.cwd()));

    const { results } = await runValidate({ inputs: ["a.md"], cwd: dir });
    expect(results[0]?.errors.map((e) => e.message).join()).toMatch(/'owner'/);
  });

  it("keeps the ref string exactly as the config wrote it", async () => {
    // The deciding constraint on the fix. The ref string is what reports name,
    // what `Validator` keys its compile cache on, and what every baseline
    // fingerprint is taken over — so resolving at read time is correct where
    // rewriting the ref to an absolute path would silently move every recorded
    // baseline in every consuming repo.
    const { results } = await runValidate({ inputs: ["a.md"], cwd: dir });
    expect(results[0]?.schemas).toEqual(["./schema/house.json"]);
    expect(results[0]?.errors[0]?.schema).toBe("./schema/house.json");
  });
});
