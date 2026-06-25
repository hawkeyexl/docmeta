import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, parseConfig } from "../src/core/config.js";
import { DocmetaError } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("config", () => {
  it("parses a lightweight YAML config", () => {
    const cfg = parseConfig(
      [
        "paths:",
        "  - 'books/**/*.md'",
        "exclude:",
        "  - '**/drafts/**'",
        "schemas:",
        "  - google:okf:0.1",
        "overrides:",
        "  - files: 'articles/**/*.md'",
        "    schemas:",
        "      - google:okf:0.1",
        "      - doc-detective:1.0",
      ].join("\n"),
      "docmeta.config.yaml",
    );
    expect(cfg.paths).toEqual(["books/**/*.md"]);
    expect(cfg.exclude).toEqual(["**/drafts/**"]);
    expect(cfg.schemas).toEqual(["google:okf:0.1"]);
    expect(cfg.overrides?.[0]?.files).toBe("articles/**/*.md");
    expect(cfg.overrides?.[0]?.schemas).toContain("doc-detective:1.0");
  });

  it("treats an empty config as all-undefined", () => {
    const cfg = parseConfig("", "docmeta.config.yaml");
    expect(cfg.paths).toBeUndefined();
    expect(cfg.schemas).toBeUndefined();
  });

  it("rejects a malformed schemas field", () => {
    expect(() => parseConfig("schemas: not-a-list", "x.yaml")).toThrow(
      DocmetaError,
    );
  });

  it("loads the fixture config from disk", async () => {
    const loaded = await loadConfig(join(here, "fixtures", "docmeta.config.yaml"));
    expect(loaded?.config.schemas).toEqual(["google:okf:0.1"]);
  });

  it("errors when an explicit config path is missing", async () => {
    await expect(loadConfig(join(here, "fixtures", "nope.yaml"))).rejects.toBeInstanceOf(
      DocmetaError,
    );
  });
});
