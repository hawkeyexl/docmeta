import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { parseBaseline } from "../src/core/baseline.js";
import { runValidate, type ValidateOptions } from "../src/commands/validate.js";
import { runGet } from "../src/commands/get.js";
import { runFill } from "../src/commands/fill.js";
import { MockProvider } from "@hawkeyexl/inference";
import {
  getSchemasInfo,
  runInferSchema,
  runVendorSchema,
  vendorFileName,
  type InferKeyReport,
  type InferResult,
} from "../src/commands/schemas.js";
import { DEFAULT_SCHEMAS } from "../src/core/resolve-schema.js";
import { parseConfig } from "../src/core/config.js";
import { makeTempRepo, removeTempRepo } from "./helpers/temp-repo.js";
import { DocmetaError } from "../src/types.js";
import {
  startSchemaServer,
  type SchemaServer,
} from "./helpers/schema-server.js";

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

  it("accepts a native TOML date against a string/date-time field", async () => {
    // `timestamp = 2026-06-25T10:00:00Z` is idiomatic TOML — unquoted, so it
    // parses to a date object rather than a string. OKF types `timestamp` as
    // `"type": "string"`, so without normalization the correct spelling is the
    // one that fails and the quoted spelling is the one that passes.
    const { results } = await runValidate({
      inputs: ["test/fixtures/toml-native-date.md"],
      cwd: root,
    });
    expect(results[0]?.errors).toEqual([]);
    expect(results[0]?.ok).toBe(true);
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

  // `noConfig` states the condition the test is about. It used to hold by
  // accident, because the repo happened to carry no config; the root has one of
  // its own now, so standing there is no longer a way to say "and no config".
  it("throws when no inputs and no config", async () => {
    await expect(
      runValidate({ inputs: [], cwd: root, noConfig: true }),
    ).rejects.toBeInstanceOf(DocmetaError);
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

  it("addresses a key with a literal dot by either spelling", async () => {
    const results = await runGet({
      fields: ["/odd.key", "odd.key"],
      inputs: ["test/fixtures/nested/doc.md"],
      cwd: root,
    });
    // The pointer treats `odd.key` as one segment and resolves the key.
    expect(results[0]?.values["/odd.key"]).toBe("dotted");
    // Dot-notation splits it into `odd` -> `key` first. That misses, and the
    // literal key is then tried as a fallback.
    //
    // This used to assert `undefined`, on the rule that a dotted key has one
    // unambiguous spelling. Element-derived metadata retired that rule by
    // making dotted keys ordinary rather than odd — `article.title`,
    // `prolog.author`, `ms.date` — at which point the old behavior meant the
    // natural spelling returned an *empty result* rather than an error, for
    // the majority of keys in a structured document. A silent wrong answer is
    // worse than a second spelling.
    expect(results[0]?.values["odd.key"]).toBe("dotted");
  });

  it("still lets descent win over the literal key where it resolves", async () => {
    // The fallback fires only where the old behavior gave up, so a genuine
    // nested object answers exactly as it always has.
    const results = await runGet({
      fields: ["author.name"],
      inputs: ["test/fixtures/nested/doc.md"],
      cwd: root,
    });
    expect(results[0]?.values["author.name"]).toBeDefined();
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
      runGet({ fields: ["type"], inputs: [], cwd: root, noConfig: true }),
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

  // A document whose frontmatter will not parse is a document-level fact, not
  // an operational one, so it is recorded per file and the run continues —
  // the same call `validate` wraps into a `(parse)` finding. It used to reject
  // the whole promise, which meant one bad file hid every other file's values.
  it("records a parse failure per file instead of aborting the run", async () => {
    const results = await runGet({
      fields: ["title"],
      inputs: ["test/fixtures/get-parse-error"],
      cwd: root,
    });
    expect(results.length).toBe(3);
    const readable = results.find((r) => r.file.endsWith("readable.md"));
    expect(readable?.values.title).toBe("Readable");
    expect(readable?.error).toBeUndefined();
    expect(results.filter((r) => r.error !== undefined).length).toBe(2);
  });

  it("carries the reason and leaves the values unresolved", async () => {
    const results = await runGet({
      fields: ["title"],
      inputs: ["test/fixtures/get-parse-error/unparseable.md"],
      cwd: root,
    });
    expect(results[0]?.error).toMatch(/Invalid YAML frontmatter/);
    expect(results[0]?.present).toBe(false);
    expect(results[0]?.values.title).toBeUndefined();
  });

  // The second reproducer: the fences parse, but to a scalar rather than a
  // mapping. It fails at a different point from `unparseable.md`, and both
  // have to land in the same channel.
  it("treats a non-object frontmatter root as a parse failure too", async () => {
    const results = await runGet({
      fields: ["title"],
      inputs: ["test/fixtures/get-parse-error/toml-fences.md"],
      cwd: root,
    });
    expect(results[0]?.error).toMatch(/root must be an object/);
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
    await expect(runValidate({ inputs: [nomatch], cwd: root })).rejects.toThrow(
      /\*\.nomatch/,
    );
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
    // A temp directory rather than the repo root. The root carries a
    // `docmeta.config.yaml` of its own now, so standing there is no longer a
    // place where discovery comes up empty — and swapping in `noConfig: true`
    // would test suppression instead, which is the next case down. A directory
    // outside any repository is the real thing: with no `.git` above it,
    // `searchPath` considers only `cwd`.
    const bare = await mkdtemp(join(tmpdir(), "docmeta-no-config-"));
    try {
      await writeFile(join(bare, "page.md"), "---\ntype: note\n---\n", "utf8");
      const seen: unknown[] = [];
      await runValidate({
        inputs: ["page.md"],
        cwd: bare,
        onConfigLoaded: (info) => seen.push(info),
      });
      expect(seen).toEqual([]);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
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
    const twoViolations = results.find((r) =>
      r.file.endsWith("two-violations.md"),
    );
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
    expect(summary.baseline).toMatchObject({
      recorded: 4,
      suppressed: 3,
      stale: 1,
    });
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

    const raw = await runValidate({
      inputs: [],
      cwd: configured,
      baseline: false,
    });
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
    expect(fromSubdir.summary.baseline).toMatchObject({
      suppressed: 1,
      stale: 0,
    });
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
    await runValidate({
      inputs,
      cliSchemas: [schema],
      cwd: root,
      writeBaseline: path,
    });

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
    expect(summary.baseline).toMatchObject({
      written: true,
      path: "recorded.json",
    });
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

// ---------------------------------------------------------------------------

/**
 * Await a call that must reject, and hand back the error.
 *
 * A bare `.catch(e => e)` types as `Result | Error`, and — worse — a call that
 * unexpectedly *succeeds* then fails on a missing `.message` rather than on the
 * thing that actually went wrong.
 */
const failure = (p: Promise<unknown>): Promise<Error> =>
  p.then(
    () => {
      throw new Error("expected the call to fail, but it resolved");
    },
    (e: unknown) => e as Error,
  );

// 0008 — `docmeta schemas vendor`
// ---------------------------------------------------------------------------

/** A real, minimal schema, served byte-for-byte so the pin is checkable. */
const VENDORED = [
  "{",
  '  "$schema": "https://json-schema.org/draft/2020-12/schema",',
  '  "type": "object",',
  '  "required": ["type"]',
  "}",
  "",
].join("\n");

describe("vendorFileName", () => {
  it("survives a path segment with a malformed percent-escape", () => {
    // `new URL` accepts `%zz` — the WHATWG parser does not validate escapes,
    // it carries them through — so the URL reaches `decodeURIComponent`,
    // which throws `URIError`. That escaped as an unhandled exception and a
    // stack trace rather than the exit-2 `DocmetaError` every other bad-input
    // path produces.
    //
    // Decoding is a nicety here: the result is sanitized to
    // `[A-Za-z0-9._-]` anyway, so an undecodable segment can simply be used
    // as written rather than failing the command.
    expect(() => vendorFileName("https://x.example/%zz.json")).not.toThrow();
    expect(vendorFileName("https://x.example/%zz.json")).toMatch(/\.json$/);
    // The decodable case still decodes, so the fallback has not replaced it.
    expect(vendorFileName("https://x.example/house%20style.json")).toBe(
      "house-style.json",
    );
  });
});

describe("runVendorSchema (0008)", () => {
  let dir: string;
  let server: SchemaServer;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "docmeta-vendor-")));
    server = await startSchemaServer({
      "/house/2.1.json": { body: VENDORED },
      // A different schema whose URL ends in the same segment, so it vendors to
      // the same default filename. See the source-collision test below.
      "/rival/2.1.json": { body: VENDORED.replace('"type"', '"owner"') },
      "/envelope.json": { json: { error: "not found" } },
    });
  });
  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const url = (): string => `${server.url}/house/2.1.json`;

  it("says so when it replaces an entry vendored from a different URL", async () => {
    // Two hosts serving different schemas whose URLs end in the same segment
    // both default to `./schema/2.1.json`. The second vendor matches the first
    // on `ref`, so it counts as a replacement — which clears the "already
    // exists and is not ours" guard and overwrites the first host's bytes and
    // pin. The command is doing what it was asked, but silently swapping the
    // meaning of a pinned entry is not something to discover from a diff.
    await runVendorSchema({ url: url(), cwd: dir });
    const notices: string[] = [];
    const result = await runVendorSchema({
      url: `${server.url}/rival/2.1.json`,
      cwd: dir,
      onNotice: (m) => notices.push(m),
    });

    expect(result.replaced).toBe(true);
    const said = notices.join(" ");
    expect(said).toContain(`${server.url}/house/2.1.json`);
    expect(said).toContain(`${server.url}/rival/2.1.json`);
    // A plain re-vendor of the same URL must stay quiet, or the notice is noise
    // on the command's most common path.
    const quiet: string[] = [];
    await runVendorSchema({
      url: `${server.url}/rival/2.1.json`,
      cwd: dir,
      onNotice: (m) => quiet.push(m),
    });
    expect(quiet.join(" ")).not.toContain("was vendored from");
  });

  it("downloads the schema, records the pin, and creates a config", async () => {
    const result = await runVendorSchema({ url: url(), cwd: dir });

    expect(result.file).toBe("schema/2.1.json");
    expect(result.configCreated).toBe(true);
    // Byte-for-byte: the pin is over what the server sent, so any reformatting
    // here would make the recorded integrity unverifiable.
    expect(await readFile(join(dir, "schema", "2.1.json"), "utf8")).toBe(
      VENDORED,
    );
    expect(result.integrity).toMatch(/^sha256-[0-9a-f]{64}$/);

    const written = await readFile(join(dir, "docmeta.config.yaml"), "utf8");
    expect(written).toContain("ref: ./schema/2.1.json");
    expect(written).toContain(`source: ${url()}`);
    expect(written).toContain(result.integrity);
  });

  // The end-to-end pair — vendor, kill the host, still validate; then corrupt
  // the copy and fail loudly — lives in `cli.integration.test.ts`. It needs a
  // real working directory, and `loadSchema` resolves a *relative* file ref
  // against `process.cwd()`, which a core test cannot move.

  it("replaces a bare-URL entry rather than appending beside it", async () => {
    await writeFile(
      join(dir, "docmeta.config.yaml"),
      [
        "# keep me",
        "paths:",
        '  - "*.md"',
        "schemas:",
        `  - ${url()}`,
        "",
      ].join("\n"),
    );
    const result = await runVendorSchema({ url: url(), cwd: dir });
    expect(result.replaced).toBe(true);
    expect(result.configCreated).toBe(false);

    const written = await readFile(join(dir, "docmeta.config.yaml"), "utf8");
    expect(written).toContain("# keep me");
    expect(written).toContain("*.md");
    // The URL survives only as `source:`, never as a second live reference.
    expect(written.match(new RegExp(escapeRe(url()), "g"))).toHaveLength(1);
    const cfg = parseConfig(written, "docmeta.config.yaml");
    expect(cfg.schemas).toEqual([
      { ref: "./schema/2.1.json", source: url(), integrity: result.integrity },
    ]);
  });

  it("updates in place when the same URL is vendored twice", async () => {
    await runVendorSchema({ url: url(), cwd: dir });
    const again = await runVendorSchema({ url: url(), cwd: dir });
    expect(again.replaced).toBe(true);
    expect(again.unchanged).toBe(true);
    const cfg = parseConfig(
      await readFile(join(dir, "docmeta.config.yaml"), "utf8"),
      "docmeta.config.yaml",
    );
    expect(cfg.schemas).toHaveLength(1);
  });

  it("appends beside unrelated entries", async () => {
    await writeFile(
      join(dir, "docmeta.config.yaml"),
      ["schemas:", "  - google:okf:0.1", ""].join("\n"),
    );
    await runVendorSchema({ url: url(), cwd: dir });
    const cfg = parseConfig(
      await readFile(join(dir, "docmeta.config.yaml"), "utf8"),
      "docmeta.config.yaml",
    );
    expect(cfg.schemas).toHaveLength(2);
    expect(cfg.schemas?.[0]).toBe("google:okf:0.1");
  });

  // The highest-value guard in the command: a vendored schema git ignores
  // works locally and is simply absent in CI.
  it("refuses to write into a gitignored directory, and writes nothing", async () => {
    const repo = makeTempRepo({ files: { ".gitignore": "vendor/\n" } });
    try {
      const err = await failure(
        runVendorSchema({
          url: url(),
          dir: "./vendor",
          cwd: repo,
        }),
      );
      expect(err).toBeInstanceOf(DocmetaError);
      expect(err.message).toMatch(/ignored/i);
      expect(err.message).toContain("vendor");
      expect(err.message).toContain(".gitignore");
      expect(existsSync(join(repo, "vendor"))).toBe(false);
      expect(existsSync(join(repo, "docmeta.config.yaml"))).toBe(false);
    } finally {
      removeTempRepo(repo);
    }
  });

  it("refuses when a file pattern ignores the vendored file itself", async () => {
    const repo = makeTempRepo({ files: { ".gitignore": "*.json\n" } });
    try {
      const err = await failure(runVendorSchema({ url: url(), cwd: repo }));
      expect(err).toBeInstanceOf(DocmetaError);
      expect(err.message).toMatch(/ignored/i);
      expect(err.message).toContain("schema/2.1.json");
    } finally {
      removeTempRepo(repo);
    }
  });

  it("proceeds with a notice when git cannot answer at all", async () => {
    // A plain directory with no repository: the check cannot run, and refusing
    // every non-repository would make the command unusable in a tarball.
    const notices: string[] = [];
    await runVendorSchema({
      url: url(),
      cwd: dir,
      onNotice: (m) => notices.push(m),
    });
    expect(notices.join("\n")).toMatch(/gitignore/i);
    expect(existsSync(join(dir, "schema", "2.1.json"))).toBe(true);
  });

  it("refuses to clobber an unrelated file already at the target path", async () => {
    await mkdir(join(dir, "schema"), { recursive: true });
    await writeFile(join(dir, "schema", "2.1.json"), '{"type":"string"}\n');
    const err = await failure(runVendorSchema({ url: url(), cwd: dir }));
    expect(err).toBeInstanceOf(DocmetaError);
    expect(err.message).toMatch(/already exists/);
    expect(await readFile(join(dir, "schema", "2.1.json"), "utf8")).toBe(
      '{"type":"string"}\n',
    );
  });

  it("rejects a reference that is not an http(s) URL", async () => {
    for (const bad of ["./local.json", "google:okf:0.1"]) {
      const err = await failure(runVendorSchema({ url: bad, cwd: dir }));
      expect(err).toBeInstanceOf(DocmetaError);
      expect(err.message).toMatch(/http/);
    }
  });

  // Vendoring an error envelope would commit a contract that passes every
  // document — the exact false green PR 1 closed, made permanent.
  it("refuses to vendor a payload that is not a schema", async () => {
    const err = await failure(
      runVendorSchema({
        url: `${server.url}/envelope.json`,
        cwd: dir,
      }),
    );
    expect(err).toBeInstanceOf(DocmetaError);
    expect(err.message).toMatch(/does not look like a JSON Schema/);
    expect(existsSync(join(dir, "schema"))).toBe(false);
  });

  it("errors when an explicit config path does not exist", async () => {
    const err = await failure(
      runVendorSchema({
        url: url(),
        cwd: dir,
        configPath: "nope.yaml",
      }),
    );
    expect(err).toBeInstanceOf(DocmetaError);
    expect(err.message).toMatch(/nope\.yaml/);
  });

  it("records a ref relative to the config, not to the working directory", async () => {
    // The config governs a subdirectory run, so its ref has to be meaningful
    // from where the config sits.
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(
      join(dir, "docmeta.config.yaml"),
      "schemas:\n  - google:okf:0.1\n",
    );
    await runVendorSchema({
      url: url(),
      cwd: join(dir, "docs"),
      configPath: join("..", "docmeta.config.yaml"),
    });
    const cfg = parseConfig(
      await readFile(join(dir, "docmeta.config.yaml"), "utf8"),
      "docmeta.config.yaml",
    );
    const entry = cfg.schemas?.[1];
    expect(typeof entry === "object" && entry.ref).toBe(
      "./docs/schema/2.1.json",
    );
  });
  // A config can name the same schema twice — the bare URL from before
  // vendoring, and a hand-written local ref. Replacing only the first would
  // leave the list disagreeing with itself about whether it is pinned.
  it("collapses every entry that names the same schema", async () => {
    await writeFile(
      join(dir, "docmeta.config.yaml"),
      [
        "schemas:",
        `  - ${url()}`,
        "  - google:okf:0.1",
        "  - ref: ./schema/2.1.json",
        "",
      ].join("\n"),
    );
    await runVendorSchema({ url: url(), cwd: dir });
    const cfg = parseConfig(
      await readFile(join(dir, "docmeta.config.yaml"), "utf8"),
      "docmeta.config.yaml",
    );
    expect(cfg.schemas).toHaveLength(2);
    expect(cfg.schemas?.[1]).toBe("google:okf:0.1");
  });

  it("keeps a config that is nothing but comments", async () => {
    await writeFile(join(dir, "docmeta.config.yaml"), "# why this exists\n");
    await runVendorSchema({ url: url(), cwd: dir });
    const written = await readFile(join(dir, "docmeta.config.yaml"), "utf8");
    expect(written).toContain("# why this exists");
    expect(parseConfig(written, "docmeta.config.yaml").schemas).toHaveLength(1);
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
        // `properties` as well as `required`, because `fill` proposes against a
        // property's own subschema and has nothing to offer without one. The
        // validate cases below turn on `required` alone and are unaffected.
        properties: { owner: { type: "string" } },
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

  it("resolves the same ref for runFill, which loads schemas on its own path", async () => {
    // `fill` does not go through `Validator` for everything: it calls
    // `loadSchema` directly to collect a schema's property subschemas, so it
    // gets its own `fileBase` and needs its own proof that the wiring is
    // there. The code path is the same one `runValidate` exercises above,
    // which is the point — the two hand `schemaLoadOptions` the same `cwd`,
    // and a regression in either call site is invisible from the other.
    //
    // `/owner` is a candidate only because the config's schema was read and
    // its `required` was seen. A ref that failed to resolve throws
    // `Schema file not found` outright, and one that resolved to nothing would
    // leave no candidate to propose against — so the field appearing at all
    // is what proves the path.
    const { results } = await runFill({
      inputs: ["a.md"],
      cwd: dir,
      cache: false,
      inferenceProvider: new MockProvider([
        {
          json: {
            owner: { value: "Docs", confidence: 0.9, reasoning: "stated" },
          },
        },
      ]),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.fields.map((f) => f.field)).toContain("/owner");
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

// ---------------------------------------------------------------------------
// 0015 — the trust boundary for document-supplied schemas
// ---------------------------------------------------------------------------

/** A schema that constrains nothing, so every document passes it. */
const PERMISSIVE = { type: "object" };
/** Fails the config's `google:okf:0.1` on `required: type`. */
const HONEST_DOC = "---\ntitle: Honest page\n---\n";

describe("0015 · a document opting out of the repo's standard", () => {
  let server: SchemaServer | undefined;
  let dir: string | undefined;

  /**
   * `dir`, or a failure that names the cause.
   *
   * The suite clears it after every test on purpose, so it really can be
   * `undefined` here — a bare `dir!` would turn "the repo was never built" into
   * whatever confusing thing `runValidate` does with an empty cwd.
   */
  const repo = (): string => {
    if (dir === undefined) throw new Error("the temp repo was never built");
    return dir;
  };

  afterEach(async () => {
    await server?.close();
    server = undefined;
    removeTempRepo(dir);
    dir = undefined;
  });

  /**
   * The Problem section of 0015, reproduced end to end.
   *
   * Both halves matter and neither is redundant. The *contributed* file passing
   * is the hole; the *honest* file failing beside it is what makes it an
   * inversion rather than a loose check. A test that asserted only the new
   * refusal would pass just as happily against code that never had the bug.
   */
  const buildRepo = async (trust: string): Promise<string> => {
    const s = await startSchemaServer({ "/permissive.json": { json: PERMISSIVE } });
    server = s;
    const url = `${s.url}/permissive.json`;
    dir = makeTempRepo({
      files: {
        "docmeta.config.yaml": `schemas:\n  - google:okf:0.1\n${trust}`,
        "contributed.md": `---\ntitle: Contributed page\n$schema: ${url}\n---\n`,
        "honest.md": HONEST_DOC,
      },
    });
    return url;
  };

  it("passes by default — the documented feature, and the hole", async () => {
    await buildRepo("");
    const { results } = await runValidate({ inputs: ["*.md"], cwd: repo() });
    // The contributor who opted out is the one who passes; the document
    // playing by the config's rules is the one that fails.
    expect(byFile(results)).toEqual({ "contributed.md": true, "honest.md": false });
  });

  it("does not let one document take the whole run down", async () => {
    // A document may point `$schema` at any file in the repository — that is
    // the feature. If that file will not load, the failure belongs to *that
    // document*, exactly like the refusals above.
    //
    // It used to escape as an operational error: exit 2, the run aborted, and
    // nothing reported about any file at all. So a contributor who could no
    // longer sneak a document past the gate could still take the gate down, by
    // naming any non-JSON file in the repo — a README would do.
    dir = makeTempRepo({
      files: {
        "docmeta.config.yaml": "schemas:\n  - google:okf:0.1\n",
        "notes.txt": "not json at all\n",
        "saboteur.md": "---\ntitle: Saboteur\n$schema: ./notes.txt\n---\n",
        "honest.md": HONEST_DOC,
      },
    });
    const { results } = await runValidate({ inputs: ["*.md"], cwd: dir });

    // Both files were reported. Before, neither was.
    expect(results).toHaveLength(2);
    const bad = results.find((r) => r.file.endsWith("saboteur.md"));
    expect(bad?.errors[0]?.keyword).toBe("schema");
    expect(bad?.errors[0]?.message).toMatch(/not valid JSON/);
    // And the bytes still do not come along for the ride.
    expect(bad?.errors[0]?.message).not.toMatch(/not json at all/);

    const honest = results.find((r) => r.file.endsWith("honest.md"));
    expect(honest?.schemas).toEqual(["google:okf:0.1"]);
    expect(honest?.errors[0]?.keyword).toBe("required");
  });

  it("still aborts when the config names a schema that will not load", async () => {
    // The other side, and the reason this is scoped to document-supplied refs:
    // a broken schema the *operator* configured is not one document's problem,
    // it invalidates every file in the run. That must stay operational.
    dir = makeTempRepo({
      files: {
        "docmeta.config.yaml": "schemas:\n  - ./notes.txt\n",
        "notes.txt": "not json at all\n",
        "honest.md": HONEST_DOC,
      },
    });
    await expect(
      runValidate({ inputs: ["*.md"], cwd: dir }),
    ).rejects.toBeInstanceOf(DocmetaError);
  });

  it("flips under `schemaTrust.documentRefs: local`", async () => {
    const url = await buildRepo("schemaTrust:\n  documentRefs: local\n");
    const { results } = await runValidate({ inputs: ["*.md"], cwd: repo() });
    expect(byFile(results)).toEqual({ "contributed.md": false, "honest.md": false });

    const refused = results.find((r) => r.file.endsWith("contributed.md"));
    // One failing FILE, annotated on the offending document — not an aborted
    // run. `runValidate` catches the resolver's throw and files it as a
    // per-file `schema` finding, which is what puts the annotation on the
    // pull request instead of in a stack trace.
    expect(refused?.errors[0]?.keyword).toBe("schema");
    expect(refused?.errors[0]?.message).toMatch(new RegExp(escapeRe(url)));
    expect(refused?.errors[0]?.message).toMatch(/documentRefs/);
    // The honest file is untouched: still judged by the config's schema.
    const honest = results.find((r) => r.file.endsWith("honest.md"));
    expect(honest?.schemas).toEqual(["google:okf:0.1"]);
    expect(honest?.errors[0]?.keyword).toBe("required");
  });

  it("under `none`, ignores the ref and says so rather than silently dropping it", async () => {
    const url = await buildRepo("schemaTrust:\n  documentRefs: none\n");
    const notices: string[] = [];
    const { results } = await runValidate({
      inputs: ["*.md"],
      cwd: repo(),
      onNotice: (m) => notices.push(m),
    });
    // Config decides for both files, so both are judged by google:okf:0.1.
    expect(byFile(results)).toEqual({ "contributed.md": false, "honest.md": false });
    const contributed = results.find((r) => r.file.endsWith("contributed.md"));
    expect(contributed?.schemas).toEqual(["google:okf:0.1"]);
    // Ignoring input without saying so is the failure mode this whole proposal
    // set exists to remove.
    expect(notices.join("\n")).toMatch(/contributed\.md/);
    expect(notices.join("\n")).toMatch(new RegExp(escapeRe(url)));
    expect(notices.join("\n")).toMatch(/ignored/);
  });

  it("honors an allowlisted host, and refuses one that is not listed", async () => {
    const s = await startSchemaServer({ "/permissive.json": { json: PERMISSIVE } });
    server = s;
    const url = `${s.url}/permissive.json`;
    dir = makeTempRepo({
      files: {
        "docmeta.config.yaml":
          "schemas:\n  - google:okf:0.1\nschemaTrust:\n  documentRefs: any\n  hosts:\n    - 127.0.0.1\n",
        "contributed.md": `---\ntitle: Contributed page\n$schema: ${url}\n---\n`,
        "elsewhere.md": `---\ntitle: Elsewhere\n$schema: https://schemas.invalid/permissive.json\n---\n`,
      },
    });
    const { results } = await runValidate({ inputs: ["*.md"], cwd: dir });
    expect(byFile(results)).toEqual({ "contributed.md": true, "elsewhere.md": false });
    const refused = results.find((r) => r.file.endsWith("elsewhere.md"));
    expect(refused?.errors[0]?.keyword).toBe("schema");
    expect(refused?.errors[0]?.message).toMatch(/schemas\.invalid/);
    expect(refused?.errors[0]?.message).toMatch(/schemaTrust\.hosts/);
  });
});

describe("0015 · Ajv does not chase a $ref out of a fetched schema", () => {
  // Stress test 6, and the assumption the whole design rests on. Guarding at
  // docmeta's own resolver is only sufficient because Ajv never resolves a
  // remote `$ref` itself: `loadSchema` is not wired into Ajv's `loadSchema`
  // option and `compileAsync` is never called, so a remote `$ref` is a hard
  // MissingRefError at compile time rather than a second, unguarded fetch.
  // If that ever changes, an allowlisted schema could pull in anything.
  it("fails to compile rather than fetching the reference", async () => {
    const server = await startSchemaServer({
      "/chains.json": {
        json: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: { title: { $ref: "https://schemas.invalid/deep.json" } },
        },
      },
    });
    const cwd = await mkdtemp(join(tmpdir(), "docmeta-ajv-ref-"));
    try {
      const url = `${server.url}/chains.json`;
      const { results } = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent: `---\n$schema: ${url}\ntitle: t\n---\n`,
        cwd,
      });
      // Reported against the document that named it, not thrown: the schema
      // came from the document, so the failure is that document's. What this
      // test is really pinning is the *reason* it failed.
      const err = results[0]?.errors[0];
      expect(err?.keyword).toBe("schema");
      expect(err?.message).toMatch(/failed to compile/);
      expect(err?.message).toMatch(/resolve reference/);
      // The fetch that mattered happened once, for the schema itself. Nothing
      // went looking for the reference it names.
      expect(server.hits("/chains.json")).toBe(1);
    } finally {
      await server.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("0015 · a document-supplied path reaching out of the repository", () => {
  let outer: string | undefined;
  let inner: string | undefined;

  /** `inner`, or a failure that names the cause. See `repo()` above. */
  const project = (): string => {
    if (inner === undefined) throw new Error("the project was never built");
    return inner;
  };

  /**
   * A project with a file **outside** it, and no git repository anywhere above
   * — so the boundary is the config's directory and the reach is one `../`.
   * The same reach with a git root above resolves to the repository instead,
   * which is the monorepo case `test/resolve-schema.test.ts` pins.
   */
  const build = async (trust: string): Promise<void> => {
    outer = await realpath(await mkdtemp(join(tmpdir(), "docmeta-outside-")));
    inner = join(outer, "project");
    await mkdir(inner);
    await writeFile(
      join(outer, "outside.schema.json"),
      JSON.stringify({ type: "object" }),
      "utf8",
    );
    await writeFile(
      join(inner, "docmeta.config.yaml"),
      `schemas:\n  - google:okf:0.1\n${trust}`,
      "utf8",
    );
    await writeFile(
      join(inner, "reaching.md"),
      "---\ntitle: Reaching page\n$schema: ../outside.schema.json\n---\n",
      "utf8",
    );
  };

  afterEach(async () => {
    if (outer) await rm(outer, { recursive: true, force: true });
    outer = undefined;
    inner = undefined;
  });

  it("is refused, and the refusal names the boundary it applied", async () => {
    await build("");
    const { results } = await runValidate({ inputs: ["*.md"], cwd: project() });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.errors[0]?.keyword).toBe("schema");
    expect(results[0]?.errors[0]?.message).toMatch(/outside/);
    // No git repository above a temp directory, so the fallback boundary
    // applies — and the message has to say which one, or an operator cannot
    // tell "outside the repo" from "outside where I happen to be standing".
    expect(results[0]?.errors[0]?.message).toMatch(/no git repository/i);
  });

  it("leaves a config-supplied path outside the project alone", async () => {
    // Stress test 5's other half: an operator wrote this one, and reaching a
    // schema kept beside the project is a real setup, not an attack.
    await build("");
    await writeFile(
      join(project(), "docmeta.config.yaml"),
      "schemas:\n  - ../outside.schema.json\n",
      "utf8",
    );
    await writeFile(join(project(), "plain.md"), "---\ntitle: Plain\n---\n", "utf8");
    const { results } = await runValidate({ inputs: ["plain.md"], cwd: project() });
    expect(results[0]?.ok).toBe(true);
    // Spelled as the config wrote it: the config sits in the run's own
    // directory, so nothing is rebased, and nothing is contained either.
    expect(results[0]?.schemas).toEqual(["../outside.schema.json"]);
  });
});

// ---------------------------------------------------------------------------
// 0010 — `docmeta schemas infer`
// ---------------------------------------------------------------------------

/** The committed docset with a hand-checkable key distribution. */
const INFER_FIXTURES = join(here, "fixtures", "infer");

/** Write a throwaway docset and return its directory. */
async function makeDocset(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "docmeta-infer-")));
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }),
  );
  return dir;
}

/** Frontmatter from a plain object, so generated docsets stay one line each. */
function doc(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${body}\n---\n\n# Page\n`;
}

function keyNamed(result: InferResult, key: string): InferKeyReport {
  const found = result.keys.find((k) => k.key === key);
  if (!found) throw new Error(`no key "${key}" in the report`);
  return found;
}

describe("runInferSchema coverage report (0010)", () => {
  it("reports coverage per key against a known distribution", async () => {
    const r = await runInferSchema({
      inputs: ["."],
      cwd: INFER_FIXTURES,
      noConfig: true,
    });
    expect(r.filesScanned).toBe(8);
    // 7 of 8 carry title and type; 5 carry owner; 2 carry tags; 1 lastReviewed.
    expect(keyNamed(r, "title").coverage).toBeCloseTo(87.5, 5);
    expect(keyNamed(r, "type").coverage).toBeCloseTo(87.5, 5);
    expect(keyNamed(r, "owner").coverage).toBeCloseTo(62.5, 5);
    expect(keyNamed(r, "tags").coverage).toBeCloseTo(25, 5);
    expect(keyNamed(r, "lastReviewed").coverage).toBeCloseTo(12.5, 5);
    expect(keyNamed(r, "owner").present).toBe(5);
  });

  it("counts files with no metadata block separately, not as a lower denominator", async () => {
    const r = await runInferSchema({
      inputs: ["."],
      cwd: INFER_FIXTURES,
      noConfig: true,
    });
    // The exact surprise retrofit.mdx warns about: these pass a
    // require-nothing schema and fail the moment any key becomes required.
    expect(r.filesWithoutMetadata).toBe(1);
    // The denominator is every file scanned, so the frontmatter-free one drags
    // coverage down rather than vanishing from the arithmetic.
    expect(keyNamed(r, "title").present).toBe(7);
    expect(keyNamed(r, "title").coverage).toBeCloseTo((7 / 8) * 100, 5);
  });

  it("keeps only top-level keys — `author.name` is a schema-authoring detail", async () => {
    const dir = await makeDocset({
      "a.md": "---\ntype: guide\nauthor:\n  name: Ada\n---\n",
    });
    try {
      const r = await runInferSchema({ inputs: ["."], cwd: dir, noConfig: true });
      expect(r.keys.map((k) => k.key).sort()).toEqual(["author", "type"]);
      expect(keyNamed(r, "author").dominantType).toBe("object");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("hides keys below --min-coverage and says how many it hid", async () => {
    const r = await runInferSchema({
      inputs: ["."],
      cwd: INFER_FIXTURES,
      noConfig: true,
      minCoverage: 50,
    });
    expect(r.keys.map((k) => k.key).sort()).toEqual(["owner", "title", "type"]);
    expect(r.hiddenByMinCoverage).toBe(2);
  });

  it("accepts `-` for input-model parity, yielding a one-file report", async () => {
    const r = await runInferSchema({
      inputs: ["-"],
      as: "markdown",
      cwd: INFER_FIXTURES,
      noConfig: true,
      stdinContent: "---\ntype: guide\ntitle: Piped\n---\n",
    });
    expect(r.filesScanned).toBe(1);
    expect(keyNamed(r, "title").coverage).toBe(100);
  });

  it("errors when there are no inputs and no config", async () => {
    const dir = await makeDocset({ "a.md": doc({ type: "guide" }) });
    try {
      const err = await failure(
        runInferSchema({ inputs: [], cwd: dir, noConfig: true }),
      );
      expect(err).toBeInstanceOf(DocmetaError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `infer` takes the same `[paths...]` as `validate`, `get`, `query` and `fill`,
 * so it needs their two escape hatches for the same reasons: 0014 makes an
 * empty scan an operational error, and `.gitignore` filtering is the one filter
 * nobody wrote on the command line.
 */
describe("schemas infer: --allow-empty and --no-gitignore (command parity)", () => {
  const nomatch = "test/fixtures/*.nomatch";
  const PARITY = join(here, "fixtures", "infer-parity");

  /** The committed pair, laid out as a repo whose `build/` is gitignored. */
  async function parityRepo(config?: string): Promise<string> {
    const [tracked, generated] = await Promise.all([
      readFile(join(PARITY, "tracked.md"), "utf8"),
      readFile(join(PARITY, "generated.md"), "utf8"),
    ]);
    return makeTempRepo({
      files: {
        ".gitignore": "build/\n",
        "docs/tracked.md": tracked,
        "build/generated.md": generated,
        ...(config ? { "docmeta.config.yaml": config } : {}),
      },
    });
  }

  let repo: string | undefined;
  afterEach(() => {
    removeTempRepo(repo);
    repo = undefined;
  });

  it("errors when the input set resolves to zero files", async () => {
    const err = await failure(
      runInferSchema({ inputs: [nomatch], cwd: root, noConfig: true }),
    );
    expect(err).toBeInstanceOf(DocmetaError);
    expect(err.message).toMatch(/--allow-empty/);
  });

  it("allowEmpty reports an empty scan instead of erroring", async () => {
    const r = await runInferSchema({
      inputs: [nomatch],
      cwd: root,
      noConfig: true,
      allowEmpty: true,
    });
    expect(r.filesScanned).toBe(0);
    expect(r.keys).toEqual([]);
    expect(r.draft.properties).toEqual({});
  });

  it("config allowEmpty: true governs when the option is absent", async () => {
    repo = await parityRepo("allowEmpty: true\n");
    const r = await runInferSchema({ inputs: ["*.nomatch"], cwd: repo });
    expect(r.filesScanned).toBe(0);
  });

  it("skips a gitignored file by default, and says how many", async () => {
    repo = await parityRepo();
    const r = await runInferSchema({
      inputs: ["**/*.md"],
      cwd: repo,
      noConfig: true,
    });
    expect(r.filesScanned).toBe(1);
    expect(r.gitignoreSkipped).toBe(1);
    expect(r.keys.map((k) => k.key)).not.toContain("generatedBy");
  });

  it("respectGitignore: false scans them again", async () => {
    repo = await parityRepo();
    const r = await runInferSchema({
      inputs: ["**/*.md"],
      cwd: repo,
      noConfig: true,
      respectGitignore: false,
    });
    expect(r.filesScanned).toBe(2);
    expect(r.gitignoreSkipped).toBe(0);
    // The ignored file's own key is the proof it was actually scanned.
    expect(r.keys.map((k) => k.key)).toContain("generatedBy");
  });

  it("the option overrides config respectGitignore: true", async () => {
    repo = await parityRepo("respectGitignore: true\n");
    const r = await runInferSchema({
      inputs: ["**/*.md"],
      cwd: repo,
      respectGitignore: false,
    });
    expect(r.filesScanned).toBe(2);
  });
});

describe("the inferred draft never requires anything (0010 stress test 1)", () => {
  it("emits no `required` even where every key is at 100% coverage", async () => {
    const dir = await makeDocset({
      "a.md": doc({ type: "guide", title: "A" }),
      "b.md": doc({ type: "guide", title: "B" }),
      "c.md": doc({ type: "reference", title: "C" }),
    });
    try {
      const r = await runInferSchema({ inputs: ["."], cwd: dir, noConfig: true });
      expect(keyNamed(r, "title").coverage).toBe(100);
      expect(keyNamed(r, "type").coverage).toBe(100);
      // Not `[]` either: an empty `required` is still the tool speaking about
      // policy, and the rule is that it never does. Walked rather than
      // substring-matched, so a `required` nested under `properties` — the
      // spelling a future subschema would use — cannot slip past.
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        if (node !== null && typeof node === "object") {
          expect(Object.keys(node)).not.toContain("required");
          for (const value of Object.values(node)) walk(value);
        }
      };
      walk(r.draft);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("constrains only what was observed: the type, and minLength on non-empty strings", async () => {
    const r = await runInferSchema({
      inputs: ["."],
      cwd: INFER_FIXTURES,
      noConfig: true,
    });
    const props = r.draft.properties as Record<string, unknown>;
    expect(props.title).toEqual({ type: "string", minLength: 1 });
    expect(props.tags).toEqual({ type: "array" });
    expect(r.draft.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
  });

  it("omits minLength when an empty string really was observed", async () => {
    const dir = await makeDocset({
      "a.md": '---\ntype: guide\nsummary: ""\n---\n',
      "b.md": doc({ type: "guide", summary: "real" }),
    });
    try {
      const r = await runInferSchema({ inputs: ["."], cwd: dir, noConfig: true });
      const props = r.draft.properties as Record<string, unknown>;
      expect(props.summary).toEqual({ type: "string" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("dominant type, not a union (0010 stress test 3)", () => {
  let dir: string | undefined;

  // Writing 904 files has blown the default 10s hook budget on a cold
  // Windows CI runner; the count is the point of the test, so the budget
  // moves rather than the corpus shrinking.
  beforeEach(async () => {
    const files: Record<string, string> = {};
    // 900 files where `owner` is a string, 4 where someone wrote a number.
    for (let i = 0; i < 900; i++) {
      files[`s${i}.md`] = doc({ type: "guide", owner: "docs-team" });
    }
    for (let i = 0; i < 4; i++) {
      files[`n${i}.md`] = doc({ type: "guide", owner: "7" });
    }
    dir = await makeDocset(files);
  }, 60_000);
  afterEach(async () => {
    // `dir` stays undefined when the hook itself failed; there is nothing to
    // sweep then, and rm(undefined) would bury the real error in a TypeError.
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reports the distribution with counts and emits the dominant type alone", async () => {
    const r = await runInferSchema({ inputs: ["."], cwd: dir, noConfig: true });
    const owner = keyNamed(r, "owner");
    expect(owner.types).toEqual([
      { type: "string", count: 900 },
      { type: "number", count: 4 },
    ]);
    expect(owner.dominantType).toBe("string");
    const props = r.draft.properties as Record<string, { type?: unknown }>;
    // A union would encode the typo as policy — stress test 1, one level down.
    expect(props.owner?.type).toBe("string");
  });

  it("names each outlier with its file and line, so it reads as a data error", async () => {
    const r = await runInferSchema({ inputs: ["."], cwd: dir, noConfig: true });
    const owner = keyNamed(r, "owner");
    expect(owner.outliers).toHaveLength(4);
    for (const o of owner.outliers) {
      expect(o.file).toMatch(/^n\d\.md$/);
      expect(o.type).toBe("number");
      // `owner:` is the third line: `---`, `type:`, `owner:`.
      expect(o.line).toBe(3);
    }
  });
});

describe("enum candidates need both thresholds (0010 stress test 4)", () => {
  const withTypes = (
    count: number,
    distinct: number,
  ): Record<string, string> => {
    const files: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      files[`p${i}.md`] = doc({ type: `kind-${i % distinct}` });
    }
    return files;
  };

  it("proposes an enum at 7 distinct values in a large docset", async () => {
    const dir = await makeDocset(withTypes(140, 7));
    try {
      const r = await runInferSchema({ inputs: ["."], cwd: dir, noConfig: true });
      const type = keyNamed(r, "type");
      expect(type.distinct).toBe(7);
      expect(type.enumValues).toHaveLength(7);
      const props = r.draft.properties as Record<string, { enum?: unknown[] }>;
      expect(props.type?.enum).toHaveLength(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("proposes none at 30 distinct values in a 30-file docset", async () => {
    const dir = await makeDocset(withTypes(30, 30));
    try {
      const r = await runInferSchema({ inputs: ["."], cwd: dir, noConfig: true });
      const type = keyNamed(r, "type");
      expect(type.distinct).toBe(30);
      expect(type.enumValues).toBeUndefined();
      const props = r.draft.properties as Record<string, { enum?: unknown[] }>;
      expect(props.type?.enum).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("samples the dominant type, not whichever value repeats most", async () => {
    // Ranked across every type, a clustered outlier beats unique dominant
    // values on count. 50 distinct string titles and three files writing
    // `title: 42` made `42` the sample, so the row reported `string ×50,
    // number ×3` and then offered a number as the representative value — three
    // lines above naming those same three files as the outliers.
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      files[`s${i}.md`] = doc({ type: "concept", title: `Unique title ${i}` });
    }
    for (let i = 0; i < 3; i++) {
      files[`n${i}.md`] = doc({ type: "concept", title: "42" });
    }
    const dir = await makeDocset(files);
    try {
      const r = await runInferSchema({ inputs: ["."], cwd: dir, noConfig: true });
      const title = keyNamed(r, "title");
      expect(title.dominantType).toBe("string");
      expect(title.outlierCount).toBe(3);
      expect(typeof title.sample).toBe("string");
      expect(title.sample).not.toBe(42);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("proposes none for a rare key whose every value is distinct", async () => {
    // The ratio is measured against the files carrying the key, not against the
    // corpus. Against the corpus this passed both thresholds — 5 distinct is
    // under the absolute cap, and 5 is under 5% of 100 files — so a key used
    // five times with five different values, which is what free text looks
    // like, got an enum of exactly those five. The sixth value anyone wrote
    // would then be rejected by a schema generated from their own docset.
    const files: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      files[`f${i}.md`] =
        i < 5
          ? doc({ type: "concept", owner: `person-${i}` })
          : doc({ type: "concept" });
    }
    const dir = await makeDocset(files);
    try {
      const r = await runInferSchema({ inputs: ["."], cwd: dir, noConfig: true });
      const owner = keyNamed(r, "owner");
      expect(owner.present).toBe(5);
      expect(owner.distinct).toBe(5);
      expect(owner.enumValues).toBeUndefined();
      const props = r.draft.properties as Record<string, { enum?: unknown[] }>;
      expect(props.owner?.enum).toBeUndefined();
      // The control: `type` repeats across every file, so it is a vocabulary.
      expect(props.type?.enum).toEqual(["concept"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("proposes none at 7 distinct values in a 10-file docset — the ratio half", async () => {
    // The absolute count alone would accept this. 7 distinct across 10 files is
    // not a vocabulary; it is prose that happens to repeat.
    const dir = await makeDocset(withTypes(10, 7));
    try {
      const r = await runInferSchema({ inputs: ["."], cwd: dir, noConfig: true });
      expect(keyNamed(r, "type").distinct).toBe(7);
      expect(keyNamed(r, "type").enumValues).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("schemas infer --out guards the draft it writes (0010)", () => {
  it("refuses to overwrite an existing file, and writes nothing", async () => {
    const dir = await makeDocset({
      "a.md": doc({ type: "guide", title: "A" }),
      "draft.json": '{"mine":true}\n',
    });
    try {
      const err = await failure(
        runInferSchema({
          inputs: ["*.md"],
          cwd: dir,
          noConfig: true,
          out: "draft.json",
        }),
      );
      expect(err).toBeInstanceOf(DocmetaError);
      expect(err.message).toMatch(/already exists/i);
      expect(await readFile(join(dir, "draft.json"), "utf8")).toBe(
        '{"mine":true}\n',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a gitignored target, and writes nothing", async () => {
    // A generated schema you cannot commit validates locally and is absent in
    // CI — the same argument `vendor` makes about a vendored one.
    const repo = makeTempRepo({
      files: {
        ".gitignore": "generated/\n",
        "a.md": doc({ type: "guide", title: "A" }),
      },
    });
    try {
      const err = await failure(
        runInferSchema({
          inputs: ["*.md"],
          cwd: repo,
          noConfig: true,
          out: "./generated/draft.json",
        }),
      );
      expect(err).toBeInstanceOf(DocmetaError);
      expect(err.message).toMatch(/ignored/i);
      expect(err.message).toContain("generated");
      expect(existsSync(join(repo, "generated"))).toBe(false);
    } finally {
      removeTempRepo(repo);
    }
  });

  it("writes a parseable draft and reports where it landed", async () => {
    const dir = await makeDocset({ "a.md": doc({ type: "guide", title: "A" }) });
    try {
      const r = await runInferSchema({
        inputs: ["*.md"],
        cwd: dir,
        noConfig: true,
        out: "./schemas/draft.json",
      });
      expect(r.out).toBe("schemas/draft.json");
      const written: unknown = JSON.parse(
        await readFile(join(dir, "schemas", "draft.json"), "utf8"),
      );
      expect(written).toEqual(r.draft);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("schemas infer is offline by design (0010 stress test 2)", () => {
  let realFetch: typeof globalThis.fetch;
  let attempted: string[];

  // `infer` counts keys that are already structured; it resolves no schema and
  // needs no provider. Failing the test on *any* request makes "no network" the
  // assertion rather than a property of today's construction.
  beforeEach(() => {
    realFetch = globalThis.fetch;
    attempted = [];
    globalThis.fetch = (input: Parameters<typeof fetch>[0]) => {
      // Not `String(input)`. `fetch` takes a string, a `URL`, **or** a
      // `Request`, and a `Request` has no useful `toString` — it records as
      // "[object Request]", so the assertion below would be about a placeholder
      // rather than about the address something tried to reach.
      attempted.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      return Promise.reject(new Error("the network is not available here"));
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("never reaches the network, even for a document naming a remote $schema", async () => {
    const dir = await makeDocset({
      "a.md":
        "---\ntype: guide\n$schema: https://schemas.example.com/house/2.1.json\n---\n",
    });
    try {
      const r = await runInferSchema({ inputs: ["."], cwd: dir, noConfig: true });
      expect(r.filesScanned).toBe(1);
      expect(attempted).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * `offline` is part of the surface for the same reason it is on `get` and
   * `query`: one flag set across the commands. Asserted as "the report is
   * byte-identical either way" rather than "it was accepted", so a future
   * implementation that quietly gave it behavior here would fail.
   */
  it("accepts `offline` and changes nothing — there is no request to suppress", async () => {
    const dir = await makeDocset({
      "a.md": doc({ type: "guide", title: "A" }),
      "b.md": doc({ type: "reference" }),
    });
    try {
      const plain = await runInferSchema({
        inputs: ["."],
        cwd: dir,
        noConfig: true,
      });
      const offline = await runInferSchema({
        inputs: ["."],
        cwd: dir,
        noConfig: true,
        offline: true,
      });
      expect(offline).toEqual(plain);
      expect(attempted).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
