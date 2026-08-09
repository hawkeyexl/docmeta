import { describe, it, expect } from "vitest";
import {
  resolveSchemaSet,
  DEFAULT_SCHEMAS,
} from "../src/core/resolve-schema.js";

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

  it("falls back to the built-in default set", () => {
    const set = resolveSchemaSet({ filePath: "x.md" });
    expect(set).toEqual(["google:okf:0.1", "passo-uno:seven-action:1.0"]);
  });

  it("hands back a fresh array a caller can mutate safely", () => {
    // DEFAULT_SCHEMAS is exported, so a consumer editing a resolved set must
    // not be able to poison the default for every later call in the process.
    const set = resolveSchemaSet({ filePath: "x.md" });
    set.push("mutated:by:caller");
    expect(resolveSchemaSet({ filePath: "y.md" })).toEqual([
      "google:okf:0.1",
      "passo-uno:seven-action:1.0",
    ]);
  });

  it("freezes the exported default set", () => {
    expect(Object.isFrozen(DEFAULT_SCHEMAS)).toBe(true);
    expect(() => (DEFAULT_SCHEMAS as string[]).push("nope")).toThrow(TypeError);
  });

  it("throws on a malformed $schema value", () => {
    expect(() =>
      resolveSchemaSet({ filePath: "x.md", fileSchema: 42 }),
    ).toThrow();
  });
});
