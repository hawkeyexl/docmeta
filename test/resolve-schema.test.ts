import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  collectSchemaPins,
  rebaseConfigSchemaRefs,
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

// ---------------------------------------------------------------------------
// 0008 — the mapping form of a `schemas:` entry
// ---------------------------------------------------------------------------

const PIN = `sha256-${"b".repeat(64)}`;

describe("mapping-form schema entries (0008)", () => {
  it("resolves to the ref string, so reports and baselines are unchanged", () => {
    const set = resolveSchemaSet({
      filePath: "a.md",
      config: {
        schemas: [
          { ref: "./schema/house.json", source: "https://e.example/h.json", integrity: PIN },
          "google:okf:0.1",
        ],
      },
    });
    expect(set).toEqual(["./schema/house.json", "google:okf:0.1"]);
  });

  it("collects pins keyed on the ref, skipping entries that carry none", () => {
    const pins = collectSchemaPins({
      schemas: [
        "google:okf:0.1",
        { ref: "./bare.json" },
        { ref: "./pinned.json", integrity: PIN },
        { ref: "./sourced.json", source: "https://e.example/s.json" },
      ],
    });
    expect([...pins.keys()]).toEqual(["./pinned.json", "./sourced.json"]);
    expect(pins.get("./pinned.json")).toEqual({ integrity: PIN });
    expect(pins.get("./sourced.json")).toEqual({
      source: "https://e.example/s.json",
    });
  });

  it("collects nothing from a string-only config", () => {
    expect(collectSchemaPins({ schemas: ["google:okf:0.1"] }).size).toBe(0);
    expect(collectSchemaPins(null).size).toBe(0);
  });

  // The pin map is keyed on the ref `loadSchema` will be handed, so rebasing
  // has to move both or the pin silently stops applying.
  it("rebases the mapping form's ref, and a source that is a local path", () => {
    const configDir = resolve("/repo");
    const rebased = rebaseConfigSchemaRefs(
      {
        schemas: [
          { ref: "./schema/house.json", source: "../vendor/house.json", integrity: PIN },
          { ref: "./plain.json", source: "https://e.example/h.json" },
          "google:okf:0.1",
        ],
      },
      configDir,
      resolve("/elsewhere"),
    );
    expect(rebased.schemas?.[0]).toEqual({
      ref: resolve(configDir, "schema/house.json"),
      source: resolve(configDir, "../vendor/house.json"),
      integrity: PIN,
    });
    // A URL source has no base to rebase against and must pass through.
    expect(rebased.schemas?.[1]).toEqual({
      ref: resolve(configDir, "plain.json"),
      source: "https://e.example/h.json",
    });
    expect(rebased.schemas?.[2]).toBe("google:okf:0.1");

    const pins = collectSchemaPins(rebased);
    expect(pins.has(resolve(configDir, "schema/house.json"))).toBe(true);
  });
});
