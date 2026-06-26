import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runValidate } from "../src/commands/validate.js";
import { runGet } from "../src/commands/get.js";
import { getSchemasInfo } from "../src/commands/schemas.js";
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
    expect(ok["missing-type.md"]).toBe(false);
    expect(ok["bad-timestamp.md"]).toBe(false);
    expect(ok["no-frontmatter.md"]).toBe(false);
    expect(summary.failed).toBe(3);
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
