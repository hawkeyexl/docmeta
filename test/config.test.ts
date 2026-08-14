import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadConfig, parseConfig } from "../src/core/config.js";
import { resetWarnings } from "../src/core/warn.js";
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

describe("meta overlay", () => {
  it("replaces paths wholesale", () => {
    const cfg = parseConfig(
      [
        "paths:",
        "  - shared/**/*.md",
        "meta:",
        "  paths:",
        "    - own/**/*.md",
      ].join("\n"),
      "moose.config.yaml",
    );
    expect(cfg.paths).toEqual(["own/**/*.md"]);
  });

  it("replaces schemas and overrides wholesale", () => {
    const cfg = parseConfig(
      [
        "schemas:",
        "  - google:okf:0.1",
        "meta:",
        "  schemas:",
        "    - diataxis:diataxis:1.0",
        "  overrides:",
        "    - files: 'a/**/*.md'",
        "      schemas:",
        "        - tgdp:templates:1.0",
      ].join("\n"),
      "moose.config.yaml",
    );
    expect(cfg.schemas).toEqual(["diataxis:diataxis:1.0"]);
    expect(cfg.overrides?.[0]?.schemas).toEqual(["tgdp:templates:1.0"]);
  });

  it("concatenates exclude onto the family base", () => {
    const cfg = parseConfig(
      [
        "exclude:",
        "  - '**/drafts/**'",
        "meta:",
        "  exclude:",
        "    - '**/api/**'",
      ].join("\n"),
      "moose.config.yaml",
    );
    expect(cfg.exclude).toEqual(["**/drafts/**", "**/api/**"]);
  });

  it("merges fill key-by-key, so a base key survives an overlay that omits it", () => {
    const cfg = parseConfig(
      [
        "fill:",
        "  provider: anthropic",
        "  concurrency: 4",
        "meta:",
        "  fill:",
        "    confidenceThreshold: 0.9",
        "    concurrency: 8",
      ].join("\n"),
      "moose.config.yaml",
    );
    expect(cfg.fill).toEqual({
      provider: "anthropic",
      confidenceThreshold: 0.9,
      concurrency: 8,
    });
  });

  it("treats an empty meta block as absent", () => {
    const cfg = parseConfig("paths:\n  - a.md\nmeta:", "moose.config.yaml");
    expect(cfg.paths).toEqual(["a.md"]);
  });

  it("rejects a non-mapping meta block", () => {
    expect(() => parseConfig("meta: nope", "moose.config.yaml")).toThrow(
      MooseMetaError,
    );
  });

  it("labels errors inside the overlay with a meta. prefix", () => {
    expect(() =>
      parseConfig("meta:\n  fill:\n    concurrency: 2.5", "moose.config.yaml"),
    ).toThrow(/meta\.fill\.concurrency/);
  });

  it("parses a config with no meta key exactly as before", () => {
    const cfg = parseConfig(
      "paths:\n  - a.md\nexclude:\n  - b.md",
      "moose-meta.config.yaml",
    );
    expect(cfg.paths).toEqual(["a.md"]);
    expect(cfg.exclude).toEqual(["b.md"]);
  });

  it("unwraps meta from an explicit path regardless of the file's name", async () => {
    // Shape-driven, not filename-driven: this fixture is deliberately not named
    // moose.config.yaml, and the overlay must still apply.
    const loaded = await loadConfig(join(here, "fixtures", "family-config.yaml"));
    expect(loaded?.config.schemas).toEqual(["diataxis:diataxis:1.0"]);
    expect(loaded?.config.paths).toEqual(["docs/**/*.md"]);
  });
});

describe("config discovery", () => {
  let dir: string;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "moose-meta-config-"));
    resetWarnings();
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    stderr.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string): Promise<void> =>
    writeFile(join(dir, name), body);
  const warnings = (): string => stderr.mock.calls.map((c: unknown[]) => String(c[0])).join("");

  it("discovers moose-meta.config.yaml", async () => {
    await write("moose-meta.config.yaml", "schemas:\n  - a:b:1");
    expect((await loadConfig(undefined, dir))?.config.schemas).toEqual(["a:b:1"]);
  });

  it("discovers moose.config.yaml and applies its meta block", async () => {
    await write(
      "moose.config.yaml",
      "paths:\n  - x.md\nmeta:\n  schemas:\n    - a:b:1",
    );
    const loaded = await loadConfig(undefined, dir);
    expect(loaded?.config.schemas).toEqual(["a:b:1"]);
    expect(loaded?.config.paths).toEqual(["x.md"]);
  });

  it("applies a moose.config.yaml with no meta key, without falling through", async () => {
    await write("moose.config.yaml", "paths:\n  - x.md");
    await write("docmeta.config.yaml", "paths:\n  - old.md");
    expect((await loadConfig(undefined, dir))?.config.paths).toEqual(["x.md"]);
  });

  it("still discovers the deprecated docmeta.config.yaml", async () => {
    await write("docmeta.config.yaml", "schemas:\n  - a:b:1");
    expect((await loadConfig(undefined, dir))?.config.schemas).toEqual(["a:b:1"]);
  });

  it("resolves .yml variants", async () => {
    await write("moose.config.yml", "schemas:\n  - a:b:1");
    expect((await loadConfig(undefined, dir))?.config.schemas).toEqual(["a:b:1"]);
  });

  it("prefers the dedicated file over the family file", async () => {
    await write("moose-meta.config.yaml", "schemas:\n  - own:1");
    await write("moose.config.yaml", "meta:\n  schemas:\n    - family:1");
    expect((await loadConfig(undefined, dir))?.config.schemas).toEqual(["own:1"]);
  });

  it("prefers the family file over the deprecated name", async () => {
    await write("moose.config.yaml", "meta:\n  schemas:\n    - family:1");
    await write("docmeta.config.yaml", "schemas:\n  - old:1");
    expect((await loadConfig(undefined, dir))?.config.schemas).toEqual(["family:1"]);
  });

  it("prefers .yaml over .yml for the same name", async () => {
    await write("moose.config.yaml", "schemas:\n  - yaml:1");
    await write("moose.config.yml", "schemas:\n  - yml:1");
    expect((await loadConfig(undefined, dir))?.config.schemas).toEqual(["yaml:1"]);
  });

  it("returns null when nothing is found", async () => {
    expect(await loadConfig(undefined, dir)).toBeNull();
  });

  it("throws on a malformed discovered config instead of falling through", async () => {
    // Regression: parseConfig used to run inside the try whose catch means "not
    // found", so a typo silently fell through to the next candidate.
    await write("moose.config.yaml", "schemas: not-a-list");
    await write("docmeta.config.yaml", "schemas:\n  - fallback:1");
    await expect(loadConfig(undefined, dir)).rejects.toBeInstanceOf(MooseMetaError);
  });

  describe("warnings", () => {
    it("warns when the deprecated name is discovered", async () => {
      await write("docmeta.config.yaml", "paths:\n  - a.md");
      await loadConfig(undefined, dir);
      expect(warnings()).toContain("moose-meta:");
      expect(warnings()).toContain("docmeta.config.yaml");
    });

    it("warns only once across repeated loads in one process", async () => {
      await write("docmeta.config.yaml", "paths:\n  - a.md");
      await loadConfig(undefined, dir);
      await loadConfig(undefined, dir);
      const hits = stderr.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((m: string) => m.includes("deprecated config file name"));
      expect(hits).toHaveLength(1);
    });

    it("does not warn for the new names", async () => {
      await write("moose-meta.config.yaml", "paths:\n  - a.md");
      await loadConfig(undefined, dir);
      expect(warnings()).not.toContain("deprecated");
    });

    it("does not warn for an explicit path, even one named docmeta.config.yaml", async () => {
      await write("docmeta.config.yaml", "paths:\n  - a.md");
      await loadConfig(join(dir, "docmeta.config.yaml"));
      expect(warnings()).not.toContain("deprecated");
    });

    it("names the winner and the ignored file when candidates shadow", async () => {
      await write("moose-meta.config.yaml", "paths:\n  - a.md");
      await write("moose.config.yaml", "paths:\n  - b.md");
      await loadConfig(undefined, dir);
      expect(warnings()).toContain("moose-meta.config.yaml");
      expect(warnings()).toContain("moose.config.yaml");
    });
  });
});
