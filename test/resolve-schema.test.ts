import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  collectSchemaPins,
  rebaseConfigSchemaRefs,
  resolveSchemaSet,
  resolveSchemaSetWithSource,
  DEFAULT_SCHEMAS,
} from "../src/core/resolve-schema.js";
import { publishedBuiltins } from "../src/core/schema-registry.js";

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

// ---------------------------------------------------------------------------
// 0015 — the trust boundary for document-supplied refs
// ---------------------------------------------------------------------------

const URL_REF = "https://schemas.example.com/house/2.1.json";
const REPO = resolve("/repo");
/** The containment root a command core hands the resolver. */
const ROOT = { dir: REPO, source: "git" } as const;

/** Every mode, spelled the way a config spells it. */
function trust(
  documentRefs: "any" | "local" | "none",
  hosts?: string[],
): { schemaTrust: { documentRefs: "any" | "local" | "none"; hosts?: string[] } } {
  return { schemaTrust: { documentRefs, ...(hosts ? { hosts } : {}) } };
}

describe("schemaTrust · what a document may name", () => {
  it("defaults to `any`: all three ref kinds, exactly as before", () => {
    for (const ref of [URL_REF, "google:okf:0.1", "./in-repo.json"]) {
      expect(
        resolveSchemaSet({
          filePath: "a.md",
          fileSchema: ref,
          fileBase: REPO,
          trustRoot: ROOT,
          config: { schemas: ["x:y:1"] },
        }),
      ).toEqual([ref]);
    }
  });

  it("`local` keeps a built-in id working — the self-describing document", () => {
    // test/fixtures/schema-ref.md is exactly this shape. If `local` broke
    // built-ins it would break the documented pattern for everyone who adopted
    // it, a far larger blast radius than the hole being closed.
    expect(
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: "google:okf:0.1",
        fileBase: REPO,
        trustRoot: ROOT,
        config: { ...trust("local"), schemas: ["x:y:1"] },
      }),
    ).toEqual(["google:okf:0.1"]);
  });

  it("`local` keeps an in-repo file working", () => {
    expect(
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: "./schema/house.json",
        fileBase: REPO,
        trustRoot: ROOT,
        config: { ...trust("local"), schemas: ["x:y:1"] },
      }),
    ).toEqual(["./schema/house.json"]);
  });

  it("`local` refuses a URL, naming the key that refused it", () => {
    expect(() =>
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: URL_REF,
        fileBase: REPO,
        trustRoot: ROOT,
        config: { ...trust("local"), schemas: ["x:y:1"] },
      }),
    ).toThrow(/schemaTrust\.documentRefs/);
  });

  it("`none` ignores the ref, falls through to config, and says so", () => {
    const notices: string[] = [];
    const set = resolveSchemaSet({
      filePath: "a.md",
      fileSchema: URL_REF,
      fileBase: REPO,
      trustRoot: ROOT,
      onNotice: (m) => notices.push(m),
      config: {
        ...trust("none"),
        schemas: ["x:y:1"],
        overrides: [{ files: "a.md", schemas: ["ov:er:1"] }],
      },
    });
    // Falls to the next level down, not straight to config `schemas:`.
    expect(set).toEqual(["ov:er:1"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/a\.md/);
    expect(notices[0]).toMatch(/ignored/);
  });

  it("`none` ignores a built-in and a local path too, not just a URL", () => {
    for (const ref of ["google:okf:0.1", "./schema/house.json"]) {
      expect(
        resolveSchemaSet({
          filePath: "a.md",
          fileSchema: ref,
          fileBase: REPO,
          trustRoot: ROOT,
          config: { ...trust("none"), schemas: ["x:y:1"] },
        }),
      ).toEqual(["x:y:1"]);
    }
  });

  it("`none` with no config at all falls to the built-in default set", () => {
    expect(
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: URL_REF,
        fileBase: REPO,
        trustRoot: ROOT,
        config: trust("none"),
      }),
    ).toEqual([...DEFAULT_SCHEMAS]);
  });

  it("refuses a document URL whose host is not in `hosts`", () => {
    expect(() =>
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: URL_REF,
        fileBase: REPO,
        trustRoot: ROOT,
        config: trust("any", ["schemas.other.example"]),
      }),
    ).toThrow(/schemaTrust\.hosts/);
  });

  it("allows a document URL whose host is listed, case-insensitively and with a port", () => {
    expect(
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: URL_REF,
        fileBase: REPO,
        trustRoot: ROOT,
        config: trust("any", ["Schemas.Example.COM"]),
      }),
    ).toEqual([URL_REF]);
    expect(
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: "http://127.0.0.1:8080/s.json",
        fileBase: REPO,
        trustRoot: ROOT,
        config: trust("any", ["127.0.0.1:8080"]),
      }),
    ).toEqual(["http://127.0.0.1:8080/s.json"]);
  });

  it("does not consult `hosts` under `local` — a URL is refused outright", () => {
    expect(() =>
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: URL_REF,
        fileBase: REPO,
        trustRoot: ROOT,
        config: trust("local", ["schemas.example.com"]),
      }),
    ).toThrow(/documentRefs/);
  });

  // Stress test 5. `--schema` is typed by whoever runs the command, and a
  // person who can pass a flag can also edit the config. Pinned here so a later
  // "consistency" pass does not quietly start filtering it.
  it("never filters --schema or a config ref, in any mode", () => {
    for (const mode of ["any", "local", "none"] as const) {
      expect(
        resolveSchemaSet({
          filePath: "a.md",
          cliSchemas: [URL_REF, "../outside/x.json"],
          fileBase: REPO,
          trustRoot: ROOT,
          config: trust(mode),
        }),
      ).toEqual([URL_REF, "../outside/x.json"]);

      expect(
        resolveSchemaSet({
          filePath: "a.md",
          fileBase: REPO,
          trustRoot: ROOT,
          config: { ...trust(mode), schemas: [URL_REF, "../outside/x.json"] },
        }),
      ).toEqual([URL_REF, "../outside/x.json"]);

      expect(
        resolveSchemaSet({
          filePath: "a.md",
          fileBase: REPO,
          trustRoot: ROOT,
          config: {
            ...trust(mode),
            overrides: [{ files: "a.md", schemas: [URL_REF, "../outside/x.json"] }],
          },
        }),
      ).toEqual([URL_REF, "../outside/x.json"]);
    }
  });
});

describe("schemaTrust · containing a document-supplied local path", () => {
  const PKG = resolve(REPO, "packages", "docs");

  it("refuses a path that escapes the repository, in every mode that honors the ref", () => {
    for (const mode of ["any", "local"] as const) {
      expect(() =>
        resolveSchemaSet({
          filePath: "a.md",
          fileSchema: "../../../../etc/passwd",
          fileBase: PKG,
          trustRoot: ROOT,
          config: trust(mode),
        }),
      ).toThrow(/outside/);
    }
  });

  it("refuses an absolute path outside the repository too", () => {
    expect(() =>
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: resolve("/elsewhere/x.json"),
        fileBase: PKG,
        trustRoot: ROOT,
        config: trust("any"),
      }),
    ).toThrow(/outside/);
  });

  // The reason the boundary is the git root and not the config directory: a
  // monorepo package whose documents reference a schema one level up is still
  // referencing a schema in this project.
  it("allows a sibling package's schema inside the same repository", () => {
    expect(
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: "../shared/house.json",
        fileBase: PKG,
        trustRoot: ROOT,
        config: trust("any"),
      }),
    ).toEqual(["../shared/house.json"]);
  });

  it("says which boundary it applied when there is no git repository", () => {
    let message = "";
    try {
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: "../outside.json",
        fileBase: REPO,
        trustRoot: { dir: REPO, source: "config" },
        config: trust("any"),
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/outside/);
    expect(message).toMatch(/no git repository/i);
    expect(message).toMatch(/config file's own directory/);
  });

  it("does not blame a config file when there is no config file", () => {
    // The `cwd` fallback. A boolean `fromGit` could not tell this apart from
    // the config fallback, so both said "the config's own directory is the
    // boundary" — sending someone with no config file looking for one.
    let message = "";
    try {
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: "../outside.json",
        fileBase: REPO,
        trustRoot: { dir: REPO, source: "cwd" },
        config: trust("any"),
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/no git repository and no config file/i);
    expect(message).toMatch(/directory the command was run from/);
    expect(message).not.toMatch(/config file's own directory/);
  });

  it("names the git root as the repository when there is one", () => {
    let message = "";
    try {
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: "../outside.json",
        fileBase: REPO,
        trustRoot: ROOT,
        config: trust("any"),
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/repository root/i);
    expect(message).not.toMatch(/no git repository/i);
  });

  // The resolver is synchronous and pure; finding a git root is a filesystem
  // walk, so the root is settled once per run by the caller. A caller that
  // supplies none gets no containment — the command cores always do, and
  // test/commands.test.ts proves it end to end.
  it("skips containment when no trustRoot is supplied", () => {
    expect(
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: "../outside.json",
        config: trust("any"),
      }),
    ).toEqual(["../outside.json"]);
  });
});

// ---------------------------------------------------------------------------
// 0009 — a published built-in URL is a built-in in everything but spelling
// ---------------------------------------------------------------------------

describe("schemaTrust · a published built-in URL (0009)", () => {
  const PUBLISHED = publishedBuiltins().map((b) => b.url);

  it("is allowed under `local`, which otherwise refuses every URL", () => {
    // It names no host that anyone can answer for: `loadSchema` serves it from
    // the bundle without a request. Refusing it would make the *advertised*
    // spelling of a built-in unusable in the safest mode, which is the one
    // repos are steered towards.
    for (const url of PUBLISHED) {
      expect(
        resolveSchemaSet({
          filePath: "a.md",
          fileSchema: url,
          fileBase: REPO,
          trustRoot: ROOT,
          config: { ...trust("local"), schemas: ["x:y:1"] },
        }),
        url,
      ).toEqual([url]);
    }
  });

  it("is allowed under `any` with a hosts list that omits the docs host", () => {
    // The second refusal, and the one an exemption placed inside the url branch
    // would fix on its own while leaving `local` broken.
    for (const url of PUBLISHED) {
      expect(
        resolveSchemaSet({
          filePath: "a.md",
          fileSchema: url,
          fileBase: REPO,
          trustRoot: ROOT,
          config: trust("any", ["schemas.example.com"]),
        }),
        url,
      ).toEqual([url]);
    }
  });

  it("does not exempt a neighbouring URL on the same host", () => {
    // The exemption is a table lookup, not a host or prefix rule: a URL on
    // hawkeyexl.github.io that is not a published built-in is fetched over the
    // network like any other, so it stays subject to both checks.
    const neighbour = "https://hawkeyexl.github.io/docmeta/schemas/okf/9.9.json";
    expect(() =>
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: neighbour,
        fileBase: REPO,
        trustRoot: ROOT,
        config: trust("local"),
      }),
    ).toThrow(/documentRefs/);
    expect(() =>
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: neighbour,
        fileBase: REPO,
        trustRoot: ROOT,
        config: trust("any", ["schemas.example.com"]),
      }),
    ).toThrow(/schemaTrust\.hosts/);
  });

  it("is still dropped by `none`, like every other document-supplied ref", () => {
    // `none` is not a trust judgement about the ref; it says the config decides
    // the schema set. A built-in id is dropped there too.
    expect(
      resolveSchemaSet({
        filePath: "a.md",
        fileSchema: PUBLISHED[0] ?? "",
        fileBase: REPO,
        trustRoot: ROOT,
        config: { ...trust("none"), schemas: ["x:y:1"] },
      }),
    ).toEqual(["x:y:1"]);
  });
});

describe("resolveSchemaSetWithSource: the winning override's identity (0027)", () => {
  const config = {
    schemas: ["x:y:1"],
    overrides: [
      { files: "notes/**", schemas: ["a:b:1"] },
      { files: "articles/**", schemas: ["doc-detective:1.0"] },
    ],
  };

  it("carries the index of the override that won", () => {
    const resolved = resolveSchemaSetWithSource({
      filePath: "articles/a.md",
      config,
    });
    expect(resolved.source).toBe("override");
    expect(resolved.overrideIndex).toBe(1);
  });

  it("carries no index when another level won", () => {
    const resolved = resolveSchemaSetWithSource({
      filePath: "books/b.md",
      config,
    });
    expect(resolved.source).toBe("config");
    expect(resolved.overrideIndex).toBeUndefined();
  });
});

describe("an override may carry a list of globs", () => {
  const config = {
    schemas: ["google:okf:0.1"],
    overrides: [
      {
        files: [".claude/skills/*/SKILL.md", ".claude/agents/*.md"],
        schemas: ["agentskills:skill:1.0"],
      },
    ],
  };

  it("wins for a file matching the first glob", () => {
    expect(
      resolveSchemaSet({ filePath: ".claude/skills/demo/SKILL.md", config }),
    ).toEqual(["agentskills:skill:1.0"]);
  });

  // The case a single string cannot express without brace gymnastics: two
  // unrelated directory shapes sharing one schema set.
  it("wins for a file matching a later glob", () => {
    expect(
      resolveSchemaSet({ filePath: ".claude/agents/reviewer.md", config }),
    ).toEqual(["agentskills:skill:1.0"]);
  });

  it("falls through for a file matching none of them", () => {
    expect(resolveSchemaSet({ filePath: "docs/guide.md", config })).toEqual([
      "google:okf:0.1",
    ]);
  });

  it("reports the winning override's index, as the single form does", () => {
    const got = resolveSchemaSetWithSource({
      filePath: ".claude/agents/reviewer.md",
      config,
    });
    expect(got.source).toBe("override");
    expect(got.overrideIndex).toBe(0);
  });
});
