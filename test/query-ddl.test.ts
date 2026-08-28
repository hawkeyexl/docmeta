import { describe, it, expect, afterAll } from "vitest";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runQuery } from "../src/commands/query.js";
import { runValidate } from "../src/commands/validate.js";
import { integrityOf } from "../src/core/integrity.js";
import { publishedBuiltins } from "../src/core/schema-registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/**
 * Throwaway copies of the DDL fixtures. Config discovery in a temp dir walks
 * only the cwd (no `.git` boundary above it), so the copied
 * `docmeta.config.yaml` governs the run exactly as in a real repo.
 */
function copy(fixture: string): string {
  const d = mkdtempSync(join(tmpdir(), "docmeta-ddl-"));
  cpSync(resolve(here, "fixtures", fixture), d, { recursive: true });
  temps.push(d);
  return d;
}
// `apply` keeps every call site's meaning across the 0025 default flip.
function ddl(sql: string, cwd: string, apply = false) {
  return runQuery({ sql, inputs: ["docs"], cwd, dryRun: !apply });
}
const houseOf = (d: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(d, "schemas", "house.json"), "utf8")) as Record<
    string,
    unknown
  >;

describe("runQuery DDL — the schema is the table (0024)", () => {
  it("ALTER ADD edits the local schema in place, preview first", async () => {
    const d = copy("query-ddl");
    const before = readFileSync(join(d, "schemas", "house.json"), "utf8");
    const preview = await ddl("ALTER TABLE docs ADD COLUMN reviewed TEXT", d);
    expect(preview.changes?.length).toBe(1);
    expect(preview.changes?.[0]).toMatchObject({
      file: "schemas/house.json",
      schema: true,
      op: "add",
      key: "reviewed",
      type: "string",
      written: false,
    });
    expect(readFileSync(join(d, "schemas", "house.json"), "utf8")).toBe(before);

    await ddl("ALTER TABLE docs ADD COLUMN reviewed TEXT", d, true);
    const schema = houseOf(d);
    expect((schema.properties as Record<string, unknown>).reviewed).toEqual({
      type: "string",
    });
    expect(schema.required).toEqual(["title"]);
    expect(schema.$id).toBe("test:house:1.0");
  });

  it("the ratchet: ADD NOT NULL DEFAULT requires and backfills in one write", async () => {
    const d = copy("query-ddl");
    const run = await ddl(
      "ALTER TABLE docs ADD COLUMN reviewed TEXT NOT NULL DEFAULT 'pending'",
      d,
      true,
    );
    // One schema change, listed first, then the two file backfills.
    expect(run.changes?.length).toBe(3);
    expect(run.changes?.[0]).toMatchObject({
      schema: true,
      op: "add",
      key: "reviewed",
      required: true,
      written: true,
    });
    const schema = houseOf(d);
    expect(schema.required).toContain("reviewed");
    expect(readFileSync(join(d, "docs", "one.md"), "utf8")).toContain(
      "reviewed: pending",
    );
    // The migrated corpus validates green against the mutated schema.
    const v = await runValidate({ inputs: ["docs"], cwd: d });
    expect(v.summary.failed).toBe(0);
  });

  it("DROP COLUMN removes the property, its required entry, and the key", async () => {
    const d = copy("query-ddl");
    await ddl("ALTER TABLE docs DROP COLUMN title", d, true);
    const schema = houseOf(d);
    expect((schema.properties as Record<string, unknown>).title).toBeUndefined();
    expect(schema.required ?? []).not.toContain("title");
    expect(readFileSync(join(d, "docs", "one.md"), "utf8")).not.toContain(
      "title:",
    );
  });

  it("RENAME COLUMN moves the subschema intact", async () => {
    const d = copy("query-ddl");
    await ddl("ALTER TABLE docs RENAME COLUMN tags TO topics", d, true);
    const schema = houseOf(d);
    const props = schema.properties as Record<string, unknown>;
    expect(props.topics).toEqual({ type: "array", items: { type: "string" } });
    expect(props.tags).toBeUndefined();
    expect(readFileSync(join(d, "docs", "one.md"), "utf8")).toContain("topics:");
  });

  it("a builtin forks: local copy, config repointed, $schema cells updated", async () => {
    const d = copy("query-ddl-builtin");
    const run = await ddl("ALTER TABLE docs ADD COLUMN reviewed TEXT", d, true);
    expect(
      run.changes?.some((c) => "schema" in c && c.forkedFrom === "google:okf:0.1"),
    ).toBe(true);
    const forkPath = join(d, "schemas", "okf-0.1.local.json");
    expect(existsSync(forkPath)).toBe(true);
    const fork = JSON.parse(readFileSync(forkPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(fork.$id).toBe("google:okf:0.1+local");
    expect(
      (fork.properties as Record<string, unknown>).reviewed,
    ).toEqual({ type: "string" });
    const cfg = readFileSync(join(d, "docmeta.config.yaml"), "utf8");
    expect(cfg).toContain("./schemas/okf-0.1.local.json");
    expect(cfg).toContain("# Pinned to a builtin on purpose.");
    expect(cfg).not.toContain("- google:okf:0.1");
    // The document that pinned the builtin by $schema is repointed too.
    expect(readFileSync(join(d, "docs", "page.md"), "utf8")).toContain(
      "$schema: ./schemas/okf-0.1.local.json",
    );
  });

  it("refuses the default set without a config, and a split schema set", async () => {
    // No config: the set is the built-in default — nothing DDL may edit.
    const plain = copy("query");
    await expect(
      runQuery({
        sql: "ALTER TABLE docs ADD COLUMN x TEXT",
        inputs: ["docs"],
        cwd: plain,
        noConfig: true,
      }),
    ).rejects.toThrow(/schema|config/i);

    // A split set: an override sends two.md to a different schema list.
    const split = copy("query-ddl");
    appendFileSync(
      join(split, "docmeta.config.yaml"),
      'overrides:\n  - files: "docs/two.md"\n    schemas:\n      - google:okf:0.1\n',
    );
    await expect(
      ddl("ALTER TABLE docs ADD COLUMN x TEXT", split),
    ).rejects.toThrow(/one schema set|split/i);
  });
});

describe("runQuery DDL — -s names the contract (0030)", () => {
  const ddlS = (
    sql: string,
    cwd: string,
    schemas: string[],
    apply = false,
  ) => runQuery({ sql, inputs: ["docs"], cwd, dryRun: !apply, schemas });

  it("refuses -s on a statement that runs no DDL, naming the flag's meaning", async () => {
    const d = copy("query-schema-flag");
    // "produced no schema-evolving effects", not "ran no DDL": CREATE INDEX
    // into a --db export IS DDL, just none the planner maps to a schema
    // (review finding 4b).
    await expect(
      ddlS("SELECT _path FROM docs", d, ["./schemas/house.json"]),
    ).rejects.toThrow(
      /-s names the schema set DDL evolves.*produced no schema-evolving effects.*Nothing was applied/,
    );
  });

  it("tells the truth about the --db residue in the -s refusal", async () => {
    // With --db the export target is created before the statement runs, so
    // "nothing was applied" would be a lie — the refusal names what
    // persists (review finding 4a).
    const d = copy("query-schema-flag");
    const dbPath = join(d, "out.db");
    await expect(
      runQuery({
        sql: "SELECT _path FROM docs",
        inputs: ["docs"],
        cwd: d,
        db: dbPath,
        schemas: ["./schemas/house.json"],
      }),
    ).rejects.toThrow(/--db export was still written/);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("the core refuses schemas and params on an export-only run — the API seam", async () => {
    // The CLI gates catch the flag spellings, but a library caller passing
    // `schemas` (or `params`) with no SQL hit runSql's empty-SQL early
    // return and was silently ignored (review finding 5).
    const d = copy("query-schema-flag");
    await expect(
      runQuery({
        sql: "",
        inputs: ["docs"],
        cwd: d,
        db: join(d, "a.db"),
        schemas: ["./schemas/house.json"],
      }),
    ).rejects.toThrow(/runs no statement/);
    await expect(
      runQuery({
        sql: "",
        inputs: ["docs"],
        cwd: d,
        db: join(d, "b.db"),
        params: { x: 1 },
      }),
    ).rejects.toThrow(/references none/);
  });

  it("states the true zero-files rationale under -s", async () => {
    // The resolved-set wording ("the schema it edits is the one the corpus
    // resolves") is stale when -s named the set (review finding 9).
    const d = copy("query-schema-flag");
    await expect(
      runQuery({
        sql: "ALTER TABLE docs ADD COLUMN x TEXT",
        inputs: ["nope/**/*.md"],
        cwd: d,
        allowEmpty: true,
        schemas: ["./schemas/house.json"],
      }),
    ).rejects.toThrow(/backfill.*matched none/);
  });

  it("refuses -s on DML before anything applies — the files stay untouched", async () => {
    const d = copy("query-schema-flag");
    const before = readFileSync(join(d, "docs", "one.md"), "utf8");
    await expect(
      ddlS(
        "UPDATE docs SET title = 'MUTATED'",
        d,
        ["./schemas/house.json"],
        true,
      ),
    ).rejects.toThrow(/produced no schema-evolving effects/);
    // The half that matters: the refusal fired on the plan side of the
    // all-or-nothing line, not after the UPDATE landed (0030 § stress 1).
    expect(readFileSync(join(d, "docs", "one.md"), "utf8")).toBe(before);
  });

  it("ADD refuses on a two-schema set without -s, and evolves exactly the named one with it", async () => {
    const d = copy("query-schema-flag");
    await expect(
      ddl("ALTER TABLE docs ADD COLUMN reviewed TEXT", d, true),
    ).rejects.toThrow(/pass -s/);

    const extraBefore = readFileSync(join(d, "schemas", "extra.json"), "utf8");
    await ddlS(
      "ALTER TABLE docs ADD COLUMN reviewed TEXT",
      d,
      ["./schemas/house.json"],
      true,
    );
    const house = houseOf(d);
    expect((house.properties as Record<string, unknown>).reviewed).toEqual({
      type: "string",
    });
    expect(readFileSync(join(d, "schemas", "extra.json"), "utf8")).toBe(
      extraBefore,
    );
  });

  it("keeps every in-set guard: DROP with shared declarers still refuses (stress 14)", async () => {
    const d = copy("query-schema-flag");
    writeFileSync(
      join(d, "schemas", "strict.json"),
      '{\n  "required": ["title"]\n}\n',
    );
    await expect(
      ddlS(
        "ALTER TABLE docs DROP COLUMN title",
        d,
        ["./schemas/house.json", "./schemas/strict.json"],
        true,
      ),
    ).rejects.toThrow(/constrained by 2 schemas/);
  });

  it("refuses to fork a builtin nothing in the corpus would resolve — no orphans", async () => {
    // Nothing here — no config entry, no in-file $schema — names the
    // builtin, so after the run nothing would validate against the fork:
    // validate keeps resolving the un-evolved contract while the statement
    // reports success. Refused instead (review of #139, finding 1; this
    // revises the fork-with-config-untouched behavior first pinned here).
    const d = copy("query-schema-flag");
    await expect(
      runQuery({
        sql: "ALTER TABLE docs ADD COLUMN reviewed TEXT",
        inputs: ["docs"],
        cwd: d,
        schemas: ["google:okf:0.1"],
      }),
    ).rejects.toThrow(/orphan/);
    expect(existsSync(join(d, "schemas", "okf-0.1.local.json"))).toBe(false);
  });

  it("repoints the config entry naming a cli-forked builtin, raw-id spelling", async () => {
    // THE bricking repro: config carries [house.json, google:okf:0.1],
    // -s names the builtin alone. The fork must repoint the entry that
    // names the builtin — whole-set equality can never hold here, since the
    // -s set is by definition not the config's set.
    const d = copy("query-schema-flag");
    writeFileSync(
      join(d, "docmeta.config.yaml"),
      'paths:\n  - "docs/**/*.md"\nschemas:\n  - ./schemas/house.json\n  - google:okf:0.1\n',
    );
    writeFileSync(
      join(d, "docs", "one.md"),
      "---\ntitle: One\ntype: concept\n---\n\nBody one.\n",
    );
    writeFileSync(
      join(d, "docs", "two.md"),
      "---\ntitle: Two\ntype: concept\n---\n\nBody two.\n",
    );
    const run = await runQuery({
      sql: "ALTER TABLE docs ADD COLUMN reviewed TEXT",
      inputs: ["docs"],
      cwd: d,
      schemas: ["google:okf:0.1"],
    });
    expect(
      run.changes?.some(
        (c) => "schema" in c && c.forkedFrom === "google:okf:0.1",
      ),
    ).toBe(true);
    const cfg = readFileSync(join(d, "docmeta.config.yaml"), "utf8");
    expect(cfg).toContain("./schemas/okf-0.1.local.json");
    expect(cfg).not.toContain("google:okf:0.1");
    expect(cfg).toContain("./schemas/house.json");
    // The evolved contract is the one validate now resolves.
    const v = await runValidate({ inputs: ["docs"], cwd: d });
    expect(v.summary.failed).toBe(0);
  });

  it("repoints a config entry spelling the builtin as its published URL", async () => {
    const okf = publishedBuiltins().find((b) => b.id === "google:okf:0.1");
    expect(okf).toBeDefined();
    if (!okf) return;
    const d = copy("query-schema-flag");
    writeFileSync(
      join(d, "docmeta.config.yaml"),
      `paths:\n  - "docs/**/*.md"\nschemas:\n  - ./schemas/house.json\n  - ${okf.url}\n`,
    );
    await runQuery({
      sql: "ALTER TABLE docs ADD COLUMN reviewed TEXT",
      inputs: ["docs"],
      cwd: d,
      schemas: ["google:okf:0.1"],
    });
    const cfg = readFileSync(join(d, "docmeta.config.yaml"), "utf8");
    expect(cfg).toContain("./schemas/okf-0.1.local.json");
    expect(cfg).not.toContain(okf.url);
  });

  it("an in-file $schema naming the builtin is repointed and averts the orphan refusal", async () => {
    const d = copy("query-schema-flag");
    writeFileSync(
      join(d, "docs", "two.md"),
      "---\n$schema: google:okf:0.1\ntitle: Two\ntype: concept\n---\n\nBody two.\n",
    );
    await runQuery({
      sql: "ALTER TABLE docs ADD COLUMN reviewed TEXT",
      inputs: ["docs"],
      cwd: d,
      schemas: ["google:okf:0.1"],
    });
    expect(existsSync(join(d, "schemas", "okf-0.1.local.json"))).toBe(true);
    expect(readFileSync(join(d, "docs", "two.md"), "utf8")).toContain(
      "./schemas/okf-0.1.local.json",
    );
  });

  it("dedupes -s file refs by resolved path, not spelling", async () => {
    // `./schemas/house.json` and `schemas/house.json` name one file; loading
    // it as two members made ADD refuse naming one file twice and DROP hand
    // out the unfollowable "evolve them separately" (review finding 3).
    const d = copy("query-ddl");
    await ddlS(
      "ALTER TABLE docs ADD COLUMN reviewed TEXT",
      d,
      ["./schemas/house.json", "schemas/house.json"],
      true,
    );
    expect((houseOf(d).properties as Record<string, unknown>).reviewed).toEqual(
      { type: "string" },
    );
  });

  it("finds and refreshes an integrity pin whatever the -s spelling", async () => {
    // The pin map keys carry the config's spelling; a -s ref typed without
    // the ./ must still hit it, or the stale pin bricks the NEXT run
    // (review finding 2).
    const d = copy("query-ddl");
    const pin = integrityOf(readFileSync(join(d, "schemas", "house.json")));
    writeFileSync(
      join(d, "docmeta.config.yaml"),
      `paths:\n  - "docs/**/*.md"\nschemas:\n  - ref: ./schemas/house.json\n    integrity: ${pin}\n`,
    );
    const run = await ddlS(
      "ALTER TABLE docs ADD COLUMN reviewed TEXT",
      d,
      ["schemas/house.json"],
      true,
    );
    expect(
      run.changes?.some((c) => "config" in c && c.key === "integrity"),
    ).toBe(true);
    const cfg = readFileSync(join(d, "docmeta.config.yaml"), "utf8");
    expect(cfg).not.toContain(pin);
    expect(cfg).toContain(
      integrityOf(readFileSync(join(d, "schemas", "house.json"))),
    );
    const v = await runValidate({ inputs: ["docs"], cwd: d });
    expect(v.summary.failed).toBe(0);
  });

  it("ADD refuses when the set names several builtins and no local file, in either order", async () => {
    // fileMembers[0] ?? builtinMembers[0] silently picked by flag order
    // (review finding 6) — the ambiguity refusal must mirror the
    // several-local-files one instead.
    const d = copy("query-schema-flag");
    for (const order of [
      ["google:okf:0.1", "passo-uno:seven-action:1.0"],
      ["passo-uno:seven-action:1.0", "google:okf:0.1"],
    ]) {
      await expect(
        runQuery({
          sql: "ALTER TABLE docs ADD COLUMN reviewed TEXT",
          inputs: ["docs"],
          cwd: d,
          dryRun: true,
          schemas: order,
        }),
      ).rejects.toThrow(/2 built-ins .*which one to fork/);
    }
  });

  it("a URL ref via -s refuses with the vendor-first remedy", async () => {
    const d = copy("query-schema-flag");
    await expect(
      ddlS("ALTER TABLE docs ADD COLUMN x TEXT", d, [
        "https://example.com/x.json",
      ]),
    ).rejects.toThrow(/vendor it first/i);
  });

  it("a split corpus proceeds under -s, and the refusal without it names the remedy", async () => {
    const split = copy("query-ddl");
    appendFileSync(
      join(split, "docmeta.config.yaml"),
      'overrides:\n  - files: "docs/two.md"\n    schemas:\n      - google:okf:0.1\n',
    );
    await expect(
      ddl("ALTER TABLE docs ADD COLUMN x TEXT", split),
    ).rejects.toThrow(/pass -s/);

    await ddlS(
      "ALTER TABLE docs ADD COLUMN reviewed TEXT",
      split,
      ["./schemas/house.json"],
      true,
    );
    expect(
      (houseOf(split).properties as Record<string, unknown>).reviewed,
    ).toEqual({ type: "string" });
  });
});

describe("runQuery DDL — targeting, containment, and the config edit", () => {
  it("refuses a document $schema outside the repository as a write target", async () => {
    const root = mkdtempSync(join(tmpdir(), "docmeta-ddl-"));
    temps.push(root);
    const repo = join(root, "repo");
    cpSync(resolve(here, "fixtures", "query-ddl"), repo, { recursive: true });
    const outside = join(root, "outside.json");
    const outsideBody = '{\n  "properties": { "title": {} }\n}\n';
    writeFileSync(outside, outsideBody);
    writeFileSync(
      join(repo, "docs", "one.md"),
      "---\n$schema: ../outside.json\ntitle: One\n---\n\nBody one.\n",
    );
    await expect(
      runQuery({
        sql: "ALTER TABLE docs DROP COLUMN title",
        inputs: ["docs/one.md"],
        cwd: repo,
      }),
    ).rejects.toThrow(/outside/);
    expect(readFileSync(outside, "utf8")).toBe(outsideBody);
  });

  it("repoints the governing config even when it is spelled .yml", async () => {
    const d = copy("query-ddl-builtin");
    renameSync(
      join(d, "docmeta.config.yaml"),
      join(d, "docmeta.config.yml"),
    );
    await ddl("ALTER TABLE docs ADD COLUMN reviewed TEXT", d, true);
    const cfg = readFileSync(join(d, "docmeta.config.yml"), "utf8");
    expect(cfg).toContain("./schemas/okf-0.1.local.json");
    expect(cfg).toContain("# Pinned to a builtin on purpose.");
  });

  it("edits the -c config, never a bystander docmeta.config.yaml", async () => {
    const d = copy("query-ddl-builtin");
    renameSync(join(d, "docmeta.config.yaml"), join(d, "custom.yaml"));
    const decoy = "# Decoy that does not govern this run.\nschemas:\n  - google:okf:0.1\n";
    writeFileSync(join(d, "docmeta.config.yaml"), decoy);
    await runQuery({
      sql: "ALTER TABLE docs ADD COLUMN reviewed TEXT",
      inputs: ["docs"],
      cwd: d,
      configPath: join(d, "custom.yaml"),

    });
    expect(readFileSync(join(d, "custom.yaml"), "utf8")).toContain(
      "./schemas/okf-0.1.local.json",
    );
    expect(readFileSync(join(d, "docmeta.config.yaml"), "utf8")).toBe(decoy);
  });

  it("repoints a mapping-form schemas: entry, comments intact", async () => {
    const d = copy("query-ddl-builtin");
    writeFileSync(
      join(d, "docmeta.config.yaml"),
      '# Pinned to a builtin on purpose.\npaths:\n  - "docs/**/*.md"\nschemas:\n  - ref: google:okf:0.1\n',
    );
    await ddl("ALTER TABLE docs ADD COLUMN reviewed TEXT", d, true);
    const cfg = readFileSync(join(d, "docmeta.config.yaml"), "utf8");
    expect(cfg).toContain("ref: ./schemas/okf-0.1.local.json");
    expect(cfg).toContain("# Pinned to a builtin on purpose.");
    expect(cfg).not.toContain("google:okf:0.1\n");
  });

  it("repoints the list spelling of a document $schema", async () => {
    const d = copy("query-ddl-builtin");
    writeFileSync(
      join(d, "docs", "page.md"),
      "---\n$schema: [google:okf:0.1]\ntype: concept\ntitle: Page\n---\n\nBody.\n",
    );
    await ddl("ALTER TABLE docs ADD COLUMN reviewed TEXT", d, true);
    expect(readFileSync(join(d, "docs", "page.md"), "utf8")).toContain(
      "./schemas/okf-0.1.local.json",
    );
  });

  it("discloses the config edit as a change, and a preview leaves it alone", async () => {
    const d = copy("query-ddl-builtin");
    const before = readFileSync(join(d, "docmeta.config.yaml"), "utf8");
    const preview = await ddl("ALTER TABLE docs ADD COLUMN reviewed TEXT", d);
    expect(
      preview.changes?.some(
        (c) => "config" in c && c.key === "schemas" && !c.written,
      ),
    ).toBe(true);
    expect(readFileSync(join(d, "docmeta.config.yaml"), "utf8")).toBe(before);
  });

  it("forks a published-builtin URL as the builtin it aliases", async () => {
    const okf = publishedBuiltins().find((b) => b.id === "google:okf:0.1");
    expect(okf).toBeDefined();
    if (!okf) return;
    const d = copy("query-ddl-builtin");
    writeFileSync(
      join(d, "docmeta.config.yaml"),
      `paths:\n  - "docs/**/*.md"\nschemas:\n  - ${okf.url}\n`,
    );
    const run = await runQuery({
      sql: "ALTER TABLE docs ADD COLUMN reviewed TEXT",
      inputs: ["docs/other.md"],
      cwd: d,

    });
    expect(
      run.changes?.some(
        (c) => "schema" in c && c.forkedFrom === "google:okf:0.1",
      ),
    ).toBe(true);
    expect(readFileSync(join(d, "docmeta.config.yaml"), "utf8")).toContain(
      "./schemas/okf-0.1.local.json",
    );
  });

  it("refuses ALTER ADD onto a property the schema already declares", async () => {
    const d = copy("query-ddl");
    const schemaPath = join(d, "schemas", "house.json");
    const withSummary = readFileSync(schemaPath, "utf8").replace(
      '"title": { "type": "string" },',
      '"title": { "type": "string" },\n    "summary": { "type": "string", "maxLength": 200 },',
    );
    writeFileSync(schemaPath, withSummary);
    await expect(
      ddl("ALTER TABLE docs ADD COLUMN summary TEXT", d, true),
    ).rejects.toThrow(/already declared/);
    expect(readFileSync(schemaPath, "utf8")).toBe(withSummary);
  });

  it("verifies and refreshes an integrity pin on an in-place edit", async () => {
    const d = copy("query-ddl");
    const pin = integrityOf(readFileSync(join(d, "schemas", "house.json")));
    writeFileSync(
      join(d, "docmeta.config.yaml"),
      `paths:\n  - "docs/**/*.md"\nschemas:\n  - ref: ./schemas/house.json\n    integrity: ${pin}\n`,
    );
    const run = await ddl("ALTER TABLE docs ADD COLUMN reviewed TEXT", d, true);
    expect(
      run.changes?.some((c) => "config" in c && c.key === "integrity"),
    ).toBe(true);
    const cfg = readFileSync(join(d, "docmeta.config.yaml"), "utf8");
    expect(cfg).not.toContain(pin);
    expect(cfg).toContain(
      integrityOf(readFileSync(join(d, "schemas", "house.json"))),
    );
    const v = await runValidate({ inputs: ["docs"], cwd: d });
    expect(v.summary.failed).toBe(0);
  });

  it("refuses to overwrite an existing file with a fork", async () => {
    const d = copy("query-ddl-builtin");
    mkdirSync(join(d, "schemas"), { recursive: true });
    writeFileSync(join(d, "schemas", "okf-0.1.local.json"), "{}\n");
    await expect(
      ddl("ALTER TABLE docs ADD COLUMN reviewed TEXT", d, true),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses a URL schema with the vendor-first remedy", async () => {
    const d = copy("query-ddl");
    writeFileSync(
      join(d, "docmeta.config.yaml"),
      'paths:\n  - "docs/**/*.md"\nschemas:\n  - https://example.com/x.json\n',
    );
    await expect(
      ddl("ALTER TABLE docs ADD COLUMN x TEXT", d),
    ).rejects.toThrow(/vendor it first/i);
  });

  it("refuses DROP of a key no schema in the set declares", async () => {
    const d = copy("query-ddl");
    appendFileSync(join(d, "docs", "one.md"), "");
    writeFileSync(
      join(d, "docs", "one.md"),
      "---\ntitle: One\nstray: 1\n---\n\nBody one.\n",
    );
    await expect(
      ddl("ALTER TABLE docs DROP COLUMN stray", d, true),
    ).rejects.toThrow(/declares "stray"/);
  });

  it("names both schemas when ADD cannot pick one, and the -s remedy", async () => {
    const d = copy("query-ddl");
    writeFileSync(join(d, "schemas", "extra.json"), "{\n  \"type\": \"object\"\n}\n");
    writeFileSync(
      join(d, "docmeta.config.yaml"),
      'paths:\n  - "docs/**/*.md"\nschemas:\n  - ./schemas/house.json\n  - ./schemas/extra.json\n',
    );
    const err = await ddl("ALTER TABLE docs ADD COLUMN x TEXT", d).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("house.json");
    expect(message).toContain("extra.json");
    // Until 0030 this pinned the absence of a phantom --schema flag; the
    // flag exists now, so the refusal must name it as the direct remedy.
    expect(message).toContain("pass -s");
  });

  it("treats a reordered $schema list as the same set, not a split", async () => {
    const d = copy("query-ddl");
    writeFileSync(join(d, "schemas", "extra.json"), '{\n  "type": "object"\n}\n');
    writeFileSync(
      join(d, "docmeta.config.yaml"),
      'paths:\n  - "docs/**/*.md"\nschemas:\n  - ./schemas/house.json\n  - ./schemas/extra.json\n',
    );
    // two.md spells the identical set in the opposite order.
    writeFileSync(
      join(d, "docs", "two.md"),
      '---\n$schema: ["./schemas/extra.json", "./schemas/house.json"]\ntitle: Two\n---\n\nBody two.\n',
    );
    await ddl("ALTER TABLE docs DROP COLUMN title", d, true);
    const schema = houseOf(d);
    expect((schema.properties as Record<string, unknown>).title).toBeUndefined();
  });

  it("refuses DROP when a sibling schema still requires the key", async () => {
    const d = copy("query-ddl");
    writeFileSync(
      join(d, "schemas", "strict.json"),
      '{\n  "required": ["title"]\n}\n',
    );
    writeFileSync(
      join(d, "docmeta.config.yaml"),
      'paths:\n  - "docs/**/*.md"\nschemas:\n  - ./schemas/house.json\n  - ./schemas/strict.json\n',
    );
    await expect(
      ddl("ALTER TABLE docs DROP COLUMN title", d, true),
    ).rejects.toThrow(/constrained by 2 schemas/);
  });

  it("RENAME carries an explicit null instead of destroying it", async () => {
    const d = copy("query-ddl");
    writeFileSync(
      join(d, "docs", "two.md"),
      "---\ntitle: Two\ntags: null\n---\n\nBody two.\n",
    );
    await ddl("ALTER TABLE docs RENAME COLUMN tags TO topics", d, true);
    const two = readFileSync(join(d, "docs", "two.md"), "utf8");
    expect(two).toContain("topics: null");
    expect(two).not.toContain("tags:");
    expect(readFileSync(join(d, "docs", "one.md"), "utf8")).toContain(
      "topics:",
    );
  });

  it("refuses RENAME onto a key the set already declares", async () => {
    const d = copy("query-ddl");
    const schemaPath = join(d, "schemas", "house.json");
    writeFileSync(
      schemaPath,
      readFileSync(schemaPath, "utf8").replace(
        '"title": { "type": "string" },',
        '"title": { "type": "string" },\n    "topics": { "type": "array" },',
      ),
    );
    await expect(
      ddl("ALTER TABLE docs RENAME COLUMN tags TO topics", d, true),
    ).rejects.toThrow(/already declared/);
  });

  it("renames a required-only key faithfully: required moves, no phantom property", async () => {
    const d = copy("query-ddl");
    const schemaPath = join(d, "schemas", "house.json");
    // `legacy` is required but never declared — legal JSON Schema, odd shape.
    writeFileSync(
      schemaPath,
      readFileSync(schemaPath, "utf8").replace(
        '"required": ["title"]',
        '"required": ["title", "legacy"]',
      ),
    );
    writeFileSync(
      join(d, "docs", "one.md"),
      "---\ntitle: One\nlegacy: keepme\n---\n\nBody one.\n",
    );
    writeFileSync(
      join(d, "docs", "two.md"),
      "---\ntitle: Two\nlegacy: also\n---\n\nBody two.\n",
    );
    await ddl("ALTER TABLE docs RENAME COLUMN legacy TO heritage", d, true);
    const schema = houseOf(d);
    expect(schema.required).toEqual(["title", "heritage"]);
    // Faithful: the half-declared shape renames as-is, no fabricated {}.
    expect(
      (schema.properties as Record<string, unknown>).heritage,
    ).toBeUndefined();
    expect(readFileSync(join(d, "docs", "one.md"), "utf8")).toContain(
      "heritage: keepme",
    );
  });

  it("refuses a DEFAULT the declared type cannot hold", async () => {
    const d = copy("query-ddl");
    await expect(
      ddl(
        "ALTER TABLE docs ADD COLUMN priority INTEGER NOT NULL DEFAULT 'high'",
        d,
        true,
      ),
    ).rejects.toThrow(/DEFAULT/);
  });

  it("says so when the run matched no files, instead of blaming the config", async () => {
    const d = copy("query-ddl");
    await expect(
      runQuery({
        sql: "ALTER TABLE docs ADD COLUMN x TEXT",
        inputs: ["nope/**/*.md"],
        cwd: d,
        allowEmpty: true,
      }),
    ).rejects.toThrow(/matched no files/);
  });
});
