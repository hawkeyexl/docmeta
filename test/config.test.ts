import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, parseConfig } from "../src/core/config.js";
import { MooseMetaError } from "../src/types.js";

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
      "moose-meta.config.yaml",
    );
    expect(cfg.paths).toEqual(["books/**/*.md"]);
    expect(cfg.exclude).toEqual(["**/drafts/**"]);
    expect(cfg.schemas).toEqual(["google:okf:0.1"]);
    expect(cfg.overrides?.[0]?.files).toBe("articles/**/*.md");
    expect(cfg.overrides?.[0]?.schemas).toContain("doc-detective:1.0");
  });

  it("treats an empty config as all-undefined", () => {
    const cfg = parseConfig("", "moose-meta.config.yaml");
    expect(cfg.paths).toBeUndefined();
    expect(cfg.schemas).toBeUndefined();
  });

  it("rejects a malformed schemas field", () => {
    expect(() => parseConfig("schemas: not-a-list", "x.yaml")).toThrow(
      MooseMetaError,
    );
  });

  it("loads the fixture config from disk", async () => {
    const loaded = await loadConfig(join(here, "fixtures", "moose-meta.config.yaml"));
    expect(loaded?.config.schemas).toEqual(["google:okf:0.1"]);
  });

  it("errors when an explicit config path is missing", async () => {
    await expect(loadConfig(join(here, "fixtures", "nope.yaml"))).rejects.toBeInstanceOf(
      MooseMetaError,
    );
  });

  describe("fill", () => {
    it("parses the fill block", () => {
      const cfg = parseConfig(
        [
          "fill:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-5",
          "  confidenceThreshold: 0.9",
          "  maxCostUsd: 5",
          "  concurrency: 8",
        ].join("\n"),
        "x.yaml",
      );
      expect(cfg.fill).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        confidenceThreshold: 0.9,
        maxCostUsd: 5,
        concurrency: 8,
      });
    });

    it("leaves fill undefined when absent", () => {
      expect(parseConfig("paths:\n  - x.md", "x.yaml").fill).toBeUndefined();
    });

    it("rejects a confidence threshold outside 0-1", () => {
      expect(() =>
        parseConfig("fill:\n  confidenceThreshold: 1.5", "x.yaml"),
      ).toThrow(MooseMetaError);
      expect(() =>
        parseConfig("fill:\n  confidenceThreshold: -0.1", "x.yaml"),
      ).toThrow(MooseMetaError);
    });

    it("rejects a non-finite maxCostUsd", () => {
      // YAML parses 1e999 as Infinity, which a bare range check would accept.
      expect(() =>
        parseConfig("fill:\n  maxCostUsd: 1e999", "x.yaml"),
      ).toThrow(MooseMetaError);
    });

    it("rejects a fractional concurrency", () => {
      // Silently truncating a worker count hides the mistake from the user.
      expect(() =>
        parseConfig("fill:\n  concurrency: 2.5", "x.yaml"),
      ).toThrow(/whole number/);
    });

    it("rejects a non-mapping fill block and wrong-typed keys", () => {
      expect(() => parseConfig("fill: nope", "x.yaml")).toThrow(MooseMetaError);
      expect(() => parseConfig("fill:\n  provider: 3", "x.yaml")).toThrow(
        MooseMetaError,
      );
    });
  });
});
