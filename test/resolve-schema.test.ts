import { describe, it, expect } from "vitest";
import { resolveSchemaSet } from "../src/core/resolve-schema.js";

describe("resolveSchemaSet", () => {
  it("CLI override wins over everything", () => {
    const set = resolveSchemaSet({
      filePath: "articles/a.md",
      fileSchema: "doc-detective:1.0",
      cliSchemas: ["google:okf:0.1"],
      config: { schemas: ["x:y:1"] },
    });
    expect(set).toEqual(["google:okf:0.1"]);
  });

  it("uses $schema string when no override", () => {
    const set = resolveSchemaSet({
      filePath: "a.md",
      fileSchema: "doc-detective:1.0",
    });
    expect(set).toEqual(["doc-detective:1.0"]);
  });

  it("uses $schema list when no override", () => {
    const set = resolveSchemaSet({
      filePath: "a.md",
      fileSchema: ["google:okf:0.1", "doc-detective:1.0"],
    });
    expect(set).toEqual(["google:okf:0.1", "doc-detective:1.0"]);
  });

  it("falls back to a matching config override", () => {
    const set = resolveSchemaSet({
      filePath: "articles/a.md",
      config: {
        schemas: ["google:okf:0.1"],
        overrides: [
          { files: "articles/**/*.md", schemas: ["doc-detective:1.0"] },
        ],
      },
    });
    expect(set).toEqual(["doc-detective:1.0"]);
  });

  it("falls back to config default schemas", () => {
    const set = resolveSchemaSet({
      filePath: "books/b.md",
      config: {
        schemas: ["google:okf:0.1"],
        overrides: [
          { files: "articles/**/*.md", schemas: ["doc-detective:1.0"] },
        ],
      },
    });
    expect(set).toEqual(["google:okf:0.1"]);
  });

  it("falls back to the built-in default", () => {
    const set = resolveSchemaSet({ filePath: "x.md" });
    expect(set).toEqual(["google:okf:0.1"]);
  });

  it("throws on a malformed $schema value", () => {
    expect(() =>
      resolveSchemaSet({ filePath: "x.md", fileSchema: 42 }),
    ).toThrow();
  });
});
