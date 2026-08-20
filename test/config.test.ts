import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
      ).toThrow(DocmetaError);
      expect(() =>
        parseConfig("fill:\n  confidenceThreshold: -0.1", "x.yaml"),
      ).toThrow(DocmetaError);
    });

    it("rejects a non-finite maxCostUsd", () => {
      // YAML parses 1e999 as Infinity, which a bare range check would accept.
      expect(() =>
        parseConfig("fill:\n  maxCostUsd: 1e999", "x.yaml"),
      ).toThrow(DocmetaError);
    });

    it("rejects a fractional concurrency", () => {
      // Silently truncating a worker count hides the mistake from the user.
      expect(() =>
        parseConfig("fill:\n  concurrency: 2.5", "x.yaml"),
      ).toThrow(/whole number/);
    });

    it("rejects a non-mapping fill block and wrong-typed keys", () => {
      expect(() => parseConfig("fill: nope", "x.yaml")).toThrow(DocmetaError);
      expect(() => parseConfig("fill:\n  provider: 3", "x.yaml")).toThrow(
        DocmetaError,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 0004 — discovery walks up to a project boundary
// ---------------------------------------------------------------------------

/**
 * Every directory at or above `from` that holds a `.git` entry.
 *
 * Used as an explicit precondition in the "no boundary" test: that case is
 * only meaningful when nothing above the temp directory is a repository, and
 * a silent violation would make the test assert the opposite of its name.
 */
function gitAncestors(from: string): string[] {
  const found: string[] = [];
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".git"))) found.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

describe("config discovery walks up (0004)", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  /**
   * Build a throwaway tree. A `.git` **file** cannot be committed inside this
   * repo's own working tree in a form git preserves, so boundary fixtures are
   * built at runtime instead.
   */
  async function tree(spec: Record<string, string>): Promise<string> {
    // realpath: macOS hands back a /var symlink for /private/var, and the walk
    // compares resolved directory strings.
    tmp = await realpath(await mkdtemp(join(tmpdir(), "docmeta-cfg-")));
    for (const [rel, content] of Object.entries(spec)) {
      const p = join(tmp, rel);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content, "utf8");
    }
    return tmp;
  }

  const CONFIG = "schemas:\n  - ./strict.schema.json\n";

  it("finds a config in an ancestor directory", async () => {
    const root = await tree({
      ".git/HEAD": "ref: refs/heads/main\n",
      "docmeta.config.yaml": CONFIG,
      "docs/api/page.md": "---\ntype: guide\n---\n",
    });
    const loaded = await loadConfig(undefined, join(root, "docs", "api"));
    expect(loaded?.config.schemas).toEqual(["./strict.schema.json"]);
    expect(loaded?.dir).toBe(root);
    expect(loaded?.path).toBe(join(root, "docmeta.config.yaml"));
  });

  it("stops at a `.git` directory", async () => {
    const root = await tree({
      "docmeta.config.yaml": CONFIG,
      "inner/.git/HEAD": "ref: refs/heads/main\n",
      "inner/docs/page.md": "---\ntype: guide\n---\n",
    });
    expect(await loadConfig(undefined, join(root, "inner", "docs"))).toBeNull();
  });

  it("stops at a `.git` *file* as well (the worktree case)", async () => {
    // This repo's own worktrees carry `.git` as a regular file holding a
    // `gitdir:` pointer. An isDirectory() boundary check would walk straight
    // past it into the outer checkout.
    const root = await tree({
      "docmeta.config.yaml": CONFIG,
      "inner/.git": "gitdir: /somewhere/else/.git/worktrees/inner\n",
      "inner/docs/page.md": "---\ntype: guide\n---\n",
    });
    expect(await loadConfig(undefined, join(root, "inner", "docs"))).toBeNull();
  });

  it("searches the boundary directory itself, not just below it", async () => {
    const root = await tree({
      ".git": "gitdir: /somewhere/else\n",
      "docmeta.config.yaml": CONFIG,
      "docs/page.md": "---\ntype: guide\n---\n",
    });
    const loaded = await loadConfig(undefined, join(root, "docs"));
    expect(loaded?.dir).toBe(root);
  });

  it("considers only cwd when no ancestor is a repository", async () => {
    const root = await tree({
      "docmeta.config.yaml": CONFIG,
      "docs/page.md": "---\ntype: guide\n---\n",
    });
    // Precondition: a stray repository above the temp directory would make
    // the walk legitimate and invert this assertion.
    expect(gitAncestors(root)).toEqual([]);

    expect(await loadConfig(undefined, join(root, "docs"))).toBeNull();
    // ...while cwd itself is still searched, exactly as before.
    expect((await loadConfig(undefined, root))?.dir).toBe(root);
  });

  it("takes the nearest config: a subdirectory shadows the root", async () => {
    const root = await tree({
      ".git/HEAD": "ref: refs/heads/main\n",
      "docmeta.config.yaml": "schemas:\n  - google:okf:0.1\n",
      "docs/docmeta.config.yaml": "schemas:\n  - diataxis:diataxis:1.0\n",
      "docs/api/page.md": "---\ntype: guide\n---\n",
    });
    const loaded = await loadConfig(undefined, join(root, "docs", "api"));
    // First found wins; ancestor configs are not merged in.
    expect(loaded?.config.schemas).toEqual(["diataxis:diataxis:1.0"]);
    expect(loaded?.dir).toBe(join(root, "docs"));
  });

  it("prefers .yaml over .yml within one directory", async () => {
    const root = await tree({
      ".git/HEAD": "ref: refs/heads/main\n",
      "docmeta.config.yaml": "schemas:\n  - google:okf:0.1\n",
      "docmeta.config.yml": "schemas:\n  - diataxis:diataxis:1.0\n",
      "docs/page.md": "---\ntype: guide\n---\n",
    });
    const loaded = await loadConfig(undefined, join(root, "docs"));
    expect(loaded?.config.schemas).toEqual(["google:okf:0.1"]);
  });

  it("an explicit path still errors when missing, and never walks", async () => {
    const root = await tree({
      ".git/HEAD": "ref: refs/heads/main\n",
      "docmeta.config.yaml": CONFIG,
      "docs/page.md": "---\ntype: guide\n---\n",
    });
    await expect(
      loadConfig(join(root, "docs", "nope.yaml"), join(root, "docs")),
    ).rejects.toThrow(/Config file not found/);
  });

  it("reports the directory of an explicit config path", async () => {
    const loaded = await loadConfig(
      join(here, "fixtures", "docmeta.config.yaml"),
    );
    expect(loaded?.dir).toBe(join(here, "fixtures"));
  });
});

describe("config: respectGitignore", () => {
  it("parses a boolean", () => {
    expect(
      parseConfig("respectGitignore: false\n", "docmeta.config.yaml")
        .respectGitignore,
    ).toBe(false);
    expect(
      parseConfig("respectGitignore: true\n", "docmeta.config.yaml")
        .respectGitignore,
    ).toBe(true);
  });

  it("is undefined when absent, so the default stays in one place", () => {
    expect(
      parseConfig("paths: ['a.md']\n", "docmeta.config.yaml").respectGitignore,
    ).toBeUndefined();
  });

  it("rejects a non-boolean", () => {
    // `respectGitignore: "false"` is a truthy string, so accepting it would
    // turn filtering ON for someone who wrote it off.
    expect(() =>
      parseConfig("respectGitignore: 'false'\n", "docmeta.config.yaml"),
    ).toThrow(DocmetaError);
    expect(() =>
      parseConfig("respectGitignore: 'false'\n", "docmeta.config.yaml"),
    ).toThrow(/"respectGitignore" must be a boolean/);
  });
});

describe("config: offline", () => {
  it("parses a boolean", () => {
    expect(parseConfig("offline: true\n", "docmeta.config.yaml").offline).toBe(
      true,
    );
    expect(parseConfig("offline: false\n", "docmeta.config.yaml").offline).toBe(
      false,
    );
  });

  it("is undefined when absent, so the default stays in one place", () => {
    expect(
      parseConfig("paths: ['a.md']\n", "docmeta.config.yaml").offline,
    ).toBeUndefined();
  });

  it("rejects a non-boolean", () => {
    // `offline: "false"` is a truthy string; accepting it would cut a repo off
    // from the network for someone who wrote the setting off.
    expect(() =>
      parseConfig("offline: 'false'\n", "docmeta.config.yaml"),
    ).toThrow(/"offline" must be a boolean/);
  });
});

describe("config: schemaCache", () => {
  it("parses ttlHours", () => {
    expect(
      parseConfig("schemaCache:\n  ttlHours: 6\n", "docmeta.config.yaml")
        .schemaCache,
    ).toEqual({ ttlHours: 6 });
  });

  it("accepts 0, which disables the cache", () => {
    expect(
      parseConfig("schemaCache:\n  ttlHours: 0\n", "docmeta.config.yaml")
        .schemaCache,
    ).toEqual({ ttlHours: 0 });
  });

  it("accepts a fractional TTL", () => {
    // Unlike `fill.concurrency`, a fraction of an hour is meaningful.
    expect(
      parseConfig("schemaCache:\n  ttlHours: 0.5\n", "docmeta.config.yaml")
        .schemaCache,
    ).toEqual({ ttlHours: 0.5 });
  });

  it("rejects a non-mapping", () => {
    expect(() =>
      parseConfig("schemaCache: 24\n", "docmeta.config.yaml"),
    ).toThrow(/"schemaCache" must be a mapping/);
  });

  it("rejects a non-number", () => {
    expect(() =>
      parseConfig("schemaCache:\n  ttlHours: '24'\n", "docmeta.config.yaml"),
    ).toThrow(DocmetaError);
  });

  it("rejects a negative TTL", () => {
    // Negative would make every entry stale forever — a cache that silently
    // does nothing, which is exactly the failure the key exists to avoid.
    expect(() =>
      parseConfig("schemaCache:\n  ttlHours: -1\n", "docmeta.config.yaml"),
    ).toThrow(/"schemaCache.ttlHours" must be a number/);
  });

  it("rejects a non-finite TTL", () => {
    // YAML's `1e999` parses to Infinity, and a bare range check would accept it.
    expect(() =>
      parseConfig("schemaCache:\n  ttlHours: 1e999\n", "docmeta.config.yaml"),
    ).toThrow(DocmetaError);
  });

  it("is undefined when absent, so the default stays in one place", () => {
    expect(
      parseConfig("paths: ['a.md']\n", "docmeta.config.yaml").schemaCache,
    ).toBeUndefined();
  });
});

describe("schemaCache.ttlHours upper bound", () => {
  // `Number.isFinite(1e308)` is true, so the finiteness check alone lets it
  // through — and `1e308 * 3_600_000` overflows to Infinity, so `elapsed >=
  // Infinity` is never true and every entry is served forever. A cache that
  // silently stops expiring is the opposite of what a TTL is for.
  it("rejects a finite value large enough to overflow the millisecond product", () => {
    expect(() =>
      parseConfig("schemaCache:\n  ttlHours: 1e308\n", "c.yaml"),
    ).toThrow(DocmetaError);
    expect(() =>
      parseConfig("schemaCache:\n  ttlHours: 1e308\n", "c.yaml"),
    ).toThrow(/between 0 and/);
  });

  it("accepts a year and rejects just past it", () => {
    expect(
      parseConfig("schemaCache:\n  ttlHours: 8760\n", "c.yaml").schemaCache
        ?.ttlHours,
    ).toBe(8760);
    expect(() =>
      parseConfig("schemaCache:\n  ttlHours: 8761\n", "c.yaml"),
    ).toThrow(DocmetaError);
  });
});

// ---------------------------------------------------------------------------
// 0008 — `schemas:` entries widen to `string | { ref, source?, integrity? }`
// ---------------------------------------------------------------------------

const PIN = `sha256-${"a".repeat(64)}`;

describe("schemas: the object form (0008)", () => {
  it("still accepts a plain list of strings", () => {
    const cfg = parseConfig("schemas:\n  - google:okf:0.1\n", "c.yaml");
    expect(cfg.schemas).toEqual(["google:okf:0.1"]);
  });

  it("accepts a mapping with ref, source, and integrity", () => {
    const cfg = parseConfig(
      [
        "schemas:",
        "  - ref: ./schema/house.json",
        "    source: https://schemas.example.com/house/2.1.json",
        `    integrity: "${PIN}"`,
      ].join("\n"),
      "c.yaml",
    );
    expect(cfg.schemas).toEqual([
      {
        ref: "./schema/house.json",
        source: "https://schemas.example.com/house/2.1.json",
        integrity: PIN,
      },
    ]);
  });

  it("accepts strings and mappings side by side", () => {
    const cfg = parseConfig(
      [
        "schemas:",
        "  - google:okf:0.1",
        "  - ref: ./schema/house.json",
      ].join("\n"),
      "c.yaml",
    );
    expect(cfg.schemas).toEqual([
      "google:okf:0.1",
      { ref: "./schema/house.json" },
    ]);
  });

  it("rejects a mapping with no ref", () => {
    expect(() =>
      parseConfig("schemas:\n  - source: https://e.com/s.json\n", "c.yaml"),
    ).toThrow(/schemas\[0\]\.ref/);
  });

  it("rejects an empty ref", () => {
    expect(() => parseConfig('schemas:\n  - ref: "  "\n', "c.yaml")).toThrow(
      DocmetaError,
    );
  });

  // A typo'd key that is silently ignored is the worst outcome available here:
  // `intergrity:` would leave the schema unpinned while the config reads as if
  // it were pinned.
  it("rejects an unknown key rather than ignoring it", () => {
    expect(() =>
      parseConfig(
        `schemas:\n  - ref: ./s.json\n    intergrity: "${PIN}"\n`,
        "c.yaml",
      ),
    ).toThrow(/intergrity/);
  });

  it("rejects an integrity that is not sha256-<64 hex>", () => {
    for (const bad of ["nonsense", "sha256-zz", "sha512-" + "a".repeat(128)]) {
      expect(() =>
        parseConfig(`schemas:\n  - ref: ./s.json\n    integrity: "${bad}"\n`, "c.yaml"),
      ).toThrow(/integrity/);
    }
  });

  // An integrity pin is verified against bytes on disk. Accepting one on a
  // built-in id or a URL would record a pin nothing can check — a config that
  // reads as pinned and is not.
  it("rejects integrity on a reference that is not a local file", () => {
    expect(() =>
      parseConfig(
        `schemas:\n  - ref: https://e.com/s.json\n    integrity: "${PIN}"\n`,
        "c.yaml",
      ),
    ).toThrow(/integrity/);
    expect(() =>
      parseConfig(
        `schemas:\n  - ref: google:okf:0.1\n    integrity: "${PIN}"\n`,
        "c.yaml",
      ),
    ).toThrow(/integrity/);
  });

  it("rejects a non-string source", () => {
    expect(() =>
      parseConfig("schemas:\n  - ref: ./s.json\n    source: 42\n", "c.yaml"),
    ).toThrow(/source/);
  });

  it("rejects a list entry that is neither a string nor a mapping", () => {
    expect(() => parseConfig("schemas:\n  - [a, b]\n", "c.yaml")).toThrow(
      DocmetaError,
    );
    expect(() => parseConfig("schemas:\n  - 42\n", "c.yaml")).toThrow(
      DocmetaError,
    );
  });

  // `asStringList` is shared with paths, exclude, and overrides[].schemas.
  // Widening it in place would have widened all four.
  it("does not widen paths, exclude, or overrides[].schemas", () => {
    expect(() => parseConfig("paths:\n  - ref: ./x.md\n", "c.yaml")).toThrow(
      DocmetaError,
    );
    expect(() => parseConfig("exclude:\n  - ref: ./x.md\n", "c.yaml")).toThrow(
      DocmetaError,
    );
    expect(() =>
      parseConfig(
        "overrides:\n  - files: '**/*.md'\n    schemas:\n      - ref: ./s.json\n",
        "c.yaml",
      ),
    ).toThrow(DocmetaError);
  });
});
