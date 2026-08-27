import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  loadConfig,
  parseConfig,
  schemaTrustRoot,
} from "../src/core/config.js";
import {
  DEFAULT_SCHEMAS,
  resolveSchemaSet,
} from "../src/core/resolve-schema.js";
import { DocmetaError } from "../src/types.js";
import { DOC, makeTempRepo, removeTempRepo } from "./helpers/temp-repo.js";

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

  // The same false-green as a misspelled `intergrity:` inside a `schemas:`
  // entry, one level up: a key the parser does not know was dropped in
  // silence, so `schemaTust:` or `allowEmtpy:` left a config that read as
  // configured and was not.
  it("rejects an unknown top-level key rather than ignoring it", () => {
    expect(() => parseConfig("schemaTust:\n  documentRefs: local\n", "c.yaml")).toThrow(
      /unknown key "schemaTust"/,
    );
    expect(() => parseConfig("allowEmtpy: true\n", "c.yaml")).toThrow(
      /unknown key "allowEmtpy"/,
    );
  });

  it("names the supported top-level keys when it rejects one", () => {
    expect(() => parseConfig("nonsense: 1\n", "c.yaml")).toThrow(
      /Supported keys: .*schemaTrust/,
    );
  });

  it("rejects an unknown key inside schemaCache", () => {
    expect(() => parseConfig("schemaCache:\n  ttlHour: 6\n", "c.yaml")).toThrow(
      /"schemaCache" has unknown key "ttlHour"/,
    );
  });

  it("rejects an unknown key inside fill", () => {
    expect(() => parseConfig("fill:\n  proivder: anthropic\n", "c.yaml")).toThrow(
      /"fill" has unknown key "proivder"/,
    );
  });

  it("rejects an unknown key inside an overrides entry", () => {
    // The section the first pass missed, and the worst case of the three: a
    // misspelling *beside* a correct key was dropped in silence and the run
    // passed, which is the false green this check exists to end.
    expect(() =>
      parseConfig(
        'overrides:\n  - files: "*.md"\n    schemas: [google:okf:0.1]\n    schemass: [x]\n',
        "c.yaml",
      ),
    ).toThrow(/overrides\[0\] has unknown key "schemass"/);
    // And alone, where the old message blamed `schemas` for being absent
    // rather than naming the key that was wrong.
    expect(() =>
      parseConfig(
        'overrides:\n  - files: "*.md"\n    schemass: [google:okf:0.1]\n',
        "c.yaml",
      ),
    ).toThrow(/unknown key "schemass"/);
  });

  it("still accepts every key it documents", () => {
    // The guard is a whitelist, so a key omitted from it would start failing a
    // config that has always been valid. Exercise all of them together.
    const cfg = parseConfig(
      [
        "paths: ['docs/**/*.md']",
        "exclude: ['**/drafts/**']",
        "schemas: ['google:okf:0.1']",
        "overrides:",
        "  - files: 'a/**'",
        "    schemas: ['google:okf:0.1']",
        "baseline: .docmeta-baseline.json",
        "allowEmpty: true",
        "respectGitignore: false",
        "offline: true",
        "schemaCache:",
        "  ttlHours: 6",
        "schemaTrust:",
        "  documentRefs: local",
        "fill:",
        "  provider: anthropic",
      ].join("\n"),
      "c.yaml",
    );
    expect(cfg.baseline).toBe(".docmeta-baseline.json");
    expect(cfg.offline).toBe(true);
    expect(cfg.schemaCache).toEqual({ ttlHours: 6 });
    expect(cfg.schemaTrust).toEqual({ documentRefs: "local" });
    expect(cfg.fill).toEqual({ provider: "anthropic" });
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
          "  maxTurns: 5",
          "  concurrency: 8",
        ].join("\n"),
        "x.yaml",
      );
      expect(cfg.fill).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        confidenceThreshold: 0.9,
        maxTurns: 5,
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

    it("rejects a non-finite maxTurns", () => {
      // YAML parses 1e999 as Infinity, which a bare range check would accept.
      // Assert on the message, not just the type: with the key name wrong this
      // still throws — for "unknown key" — and would pass without testing the
      // range check at all.
      expect(() => parseConfig("fill:\n  maxTurns: 1e999", "x.yaml")).toThrow(
        /"fill.maxTurns" must be a number/,
      );
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

// ---------------------------------------------------------------------------
// 0015 — `schemaTrust:`, the trust boundary for document-supplied refs
// ---------------------------------------------------------------------------

describe("config: schemaTrust", () => {
  it("parses documentRefs and hosts", () => {
    expect(
      parseConfig(
        "schemaTrust:\n  documentRefs: local\n",
        "docmeta.config.yaml",
      ).schemaTrust,
    ).toEqual({ documentRefs: "local" });
    expect(
      parseConfig(
        "schemaTrust:\n  documentRefs: any\n  hosts:\n    - schemas.example.com\n",
        "docmeta.config.yaml",
      ).schemaTrust,
    ).toEqual({ documentRefs: "any", hosts: ["schemas.example.com"] });
  });

  it("accepts every documented mode", () => {
    for (const mode of ["any", "local", "none"]) {
      expect(
        parseConfig(`schemaTrust:\n  documentRefs: ${mode}\n`, "c.yaml")
          .schemaTrust?.documentRefs,
      ).toBe(mode);
    }
  });

  it("is undefined when absent, so the default stays in one place", () => {
    expect(
      parseConfig("paths: ['a.md']\n", "docmeta.config.yaml").schemaTrust,
    ).toBeUndefined();
  });

  it("rejects a non-mapping", () => {
    expect(() => parseConfig("schemaTrust: local\n", "c.yaml")).toThrow(
      /"schemaTrust" must be a mapping/,
    );
  });

  // The failure worth catching: a misspelled nested key would otherwise be
  // dropped in silence, leaving a config that reads as guarded and is not.
  it("rejects an unknown key inside the mapping", () => {
    expect(() =>
      parseConfig("schemaTrust:\n  documentRef: local\n", "c.yaml"),
    ).toThrow(/unknown key "documentRef"/);
    expect(() =>
      parseConfig("schemaTrust:\n  documentRef: local\n", "c.yaml"),
    ).toThrow(/documentRefs, hosts/);
  });

  it("rejects a documentRefs value outside the three modes", () => {
    expect(() =>
      parseConfig("schemaTrust:\n  documentRefs: strict\n", "c.yaml"),
    ).toThrow(/"schemaTrust.documentRefs" must be one of/);
    expect(() =>
      parseConfig("schemaTrust:\n  documentRefs: true\n", "c.yaml"),
    ).toThrow(DocmetaError);
  });

  it("rejects hosts that is not a list of non-empty strings", () => {
    expect(() =>
      parseConfig("schemaTrust:\n  hosts: schemas.example.com\n", "c.yaml"),
    ).toThrow(/"schemaTrust.hosts" must be a list/);
    expect(() =>
      parseConfig("schemaTrust:\n  hosts:\n    - 42\n", "c.yaml"),
    ).toThrow(/"schemaTrust.hosts" must be a list/);
    expect(() =>
      parseConfig("schemaTrust:\n  hosts:\n    - '  '\n", "c.yaml"),
    ).toThrow(DocmetaError);
  });

  it("carries a remedy in the message, not just a rule", () => {
    expect(() =>
      parseConfig("schemaTrust:\n  documentRefs: strict\n", "c.yaml"),
    ).toThrow(/documentRefs: any/);
  });
});

describe("schemaTrustRoot", () => {
  let dir: string | undefined;
  afterEach(() => {
    removeTempRepo(dir);
    dir = undefined;
  });

  it("reports the git root, from anywhere inside it", () => {
    dir = makeTempRepo({ files: { "packages/docs/a.md": DOC } });
    expect(schemaTrustRoot(dir)).toEqual({ dir, source: "git" });
    // The monorepo case: a package deep inside still gets the repository, so a
    // document referencing `../shared/x.json` stays inside the boundary.
    expect(schemaTrustRoot(join(dir, "packages", "docs"))).toEqual({
      dir,
      source: "git",
    });
  });

  it("falls back to the config directory when there is no repository", () => {
    dir = makeTempRepo({ files: { "pkg/a.md": DOC }, init: false });
    const configDir = join(dir, "pkg");
    expect(schemaTrustRoot(dir, configDir)).toEqual({
      dir: configDir,
      source: "config",
    });
  });

  it("falls back to cwd when there is neither a repository nor a config", () => {
    dir = makeTempRepo({ files: { "a.md": DOC }, init: false });
    // `source` distinguishes this from the config fallback above. A boolean
    // could not, and the refusal message told someone with no config file that
    // "the config's own directory is the boundary" — a file that is not there.
    expect(schemaTrustRoot(dir)).toEqual({ dir, source: "cwd" });
  });
});

/**
 * docmeta validating its own docs, guarded.
 *
 * These read the **real** root `docmeta.config.yaml` rather than a fixture, on
 * purpose: the thing under test is that the project dogfoods its own discovery
 * path, and a fixture copy would keep passing after the real file rotted.
 */
describe("the repository's own docmeta.config.yaml", () => {
  const repoRoot = resolve(here, "..");

  it("is what discovery finds from the repo root, and names a schema that is there", async () => {
    const loaded = await loadConfig(undefined, repoRoot);
    expect(loaded?.path).toBe(join(repoRoot, "docmeta.config.yaml"));
    expect(loaded?.dir).toBe(repoRoot);
    expect(loaded?.config.paths).toEqual([
      "docs/src/content/docs/**/*.{md,mdx}",
    ]);

    const ref = loaded?.config.overrides?.[0]?.schemas[0];
    expect(ref).toBe("./docs/doc-frontmatter.schema.json");
    // Resolved the way a config-supplied file ref is: against the config's own
    // directory. The `?? ` guard is not decoration — `resolve(repoRoot, "")` is
    // `repoRoot`, which exists, so a missing ref would otherwise pass.
    expect(existsSync(resolve(repoRoot, ref ?? "<missing>"))).toBe(true);
  });

  it("scopes the docs schema to the docs and leaves everything else on the defaults", async () => {
    // The reason the schema hangs off `overrides:` instead of top-level
    // `schemas:`. A root config is discovered by every docmeta run beneath it,
    // this suite's included, and `schemas:` is the default set for *every*
    // validated file — so spelling it there would judge the fixtures under
    // `test/` against the docs frontmatter contract.
    const config = (await loadConfig(undefined, repoRoot))?.config;
    expect(config?.schemas).toBeUndefined();

    expect(
      resolveSchemaSet({
        filePath: "docs/src/content/docs/index.mdx",
        config,
      }),
      // Two, and both are load-bearing. The local schema is the house rule
      // (title + description, neither of which Starlight itself requires); the
      // built-in is the platform contract the site actually runs on, which
      // checks everything the house schema leaves unconstrained —
      // `sidebar.order`, `template`, a `badge` object's `text`.
    ).toEqual([
      "./docs/doc-frontmatter.schema.json",
      "astro:starlight:0.41",
    ]);
    expect(
      resolveSchemaSet({ filePath: "test/fixtures/valid.md", config }),
    ).toEqual([...DEFAULT_SCHEMAS]);
  });
});

describe("named overrides (0027)", () => {
  const withName = (name: string): string =>
    [
      "overrides:",
      `  - name: ${JSON.stringify(name)}`,
      '    files: "authors/**"',
      "    schemas: [google:okf:0.1]",
      "",
    ].join("\n");

  it("accepts an optional name on an override", () => {
    const cfg = parseConfig(withName("authors"), "docmeta.config.yaml");
    expect(cfg.overrides?.[0]?.name).toBe("authors");
  });

  it("accepts any other string: names are quoted identifiers", () => {
    const cfg = parseConfig(withName("API docs & guides"), "docmeta.config.yaml");
    expect(cfg.overrides?.[0]?.name).toBe("API docs & guides");
  });

  it("leaves name unset when the key is absent", () => {
    const cfg = parseConfig(
      'overrides:\n  - files: "a/**"\n    schemas: [google:okf:0.1]\n',
      "docmeta.config.yaml",
    );
    expect(cfg.overrides?.[0]?.name).toBeUndefined();
  });

  it("refuses a duplicate name", () => {
    const text = [
      "overrides:",
      "  - name: authors",
      '    files: "authors/**"',
      "    schemas: [google:okf:0.1]",
      "  - name: authors",
      '    files: "people/**"',
      "    schemas: [google:okf:0.1]",
      "",
    ].join("\n");
    expect(() => parseConfig(text, "docmeta.config.yaml")).toThrow(
      /overrides\[1\].*"authors"/,
    );
  });

  it("refuses the name docs, in any casing", () => {
    expect(() => parseConfig(withName("docs"), "docmeta.config.yaml")).toThrow(
      /docs/,
    );
    expect(() => parseConfig(withName("Docs"), "docmeta.config.yaml")).toThrow(
      /docs table/i,
    );
  });

  it("refuses an empty or blank name", () => {
    expect(() => parseConfig(withName(""), "docmeta.config.yaml")).toThrow(
      /overrides\[0\].name/,
    );
    expect(() => parseConfig(withName("   "), "docmeta.config.yaml")).toThrow(
      /overrides\[0\].name/,
    );
  });

  it("refuses a non-string name", () => {
    const text =
      'overrides:\n  - name: 3\n    files: "a/**"\n    schemas: [google:okf:0.1]\n';
    expect(() => parseConfig(text, "docmeta.config.yaml")).toThrow(
      /overrides\[0\].name/,
    );
  });

  it("refuses a name starting sqlite_, in any casing", () => {
    expect(() =>
      parseConfig(withName("sqlite_authors"), "docmeta.config.yaml"),
    ).toThrow(/sqlite_/);
    expect(() =>
      parseConfig(withName("SQLite_authors"), "docmeta.config.yaml"),
    ).toThrow(/sqlite_/);
  });

  it("refuses a name on an override with no schemas", () => {
    const text = [
      "overrides:",
      "  - name: authors",
      '    files: "authors/**"',
      "    elements: [article/title]",
      "",
    ].join("\n");
    expect(() => parseConfig(text, "docmeta.config.yaml")).toThrow(
      /never win schema resolution/,
    );
  });

  // SQLite's object namespace is case-insensitive, so "Authors" and "authors"
  // are one view name to the engine — the duplicate guard folds case exactly
  // as the docs/sqlite_ refusals above it do.
  it("refuses duplicate names, case-insensitively", () => {
    const two = (a: string, b: string) =>
      [
        "overrides:",
        `  - name: ${a}`,
        '    files: "authors/**"',
        "    schemas: [google:okf:0.1]",
        `  - name: ${b}`,
        '    files: "docs/**"',
        "    schemas: [google:okf:0.1]",
        "",
      ].join("\n");
    expect(() => parseConfig(two("authors", "authors"), "docmeta.config.yaml")).toThrow(
      /reuses the name/,
    );
    expect(() => parseConfig(two("Authors", "authors"), "docmeta.config.yaml")).toThrow(
      /reuses the name/,
    );
  });
});
