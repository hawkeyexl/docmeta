import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runValidate } from "../src/commands/validate.js";
import { runGet } from "../src/commands/get.js";
import { getSchemasInfo } from "../src/commands/schemas.js";
import { DEFAULT_SCHEMAS } from "../src/core/resolve-schema.js";
import { DocmetaError } from "../src/types.js";
import { startSchemaServer, type SchemaServer } from "./helpers/schema-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const extra = join(here, "fixtures", "extra.schema.json");

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
    try {
      const url = `${server.url}/draft07.json`;
      const pass = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent: `---\n$schema: ${url}\ntype: note\n---\n# Hi\n`,
        cwd: root,
      });
      expect(pass.results[0]?.ok).toBe(true);
      expect(pass.results[0]?.schemas).toEqual([url]);

      const fail = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent: `---\n$schema: ${url}\ntitle: no type\n---\n# Hi\n`,
        cwd: root,
      });
      expect(fail.results[0]?.ok).toBe(false);
      expect(fail.results[0]?.errors[0]?.schema).toBe(url);
      expect(fail.results[0]?.errors[0]?.message).toMatch(/type/);
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

  // The matching "run from the repo root" control lives in
  // cli.integration.test.ts, not here: `loadSchema` reads a local schema ref
  // relative to `process.cwd()` rather than the core's `cwd`, so a run whose
  // config directory already *is* its `cwd` can only be exercised honestly by
  // a child process actually started in that directory.

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
});
