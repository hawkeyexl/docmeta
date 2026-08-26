import { describe, it, expect, afterAll } from "vitest";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runQuery } from "../src/commands/query.js";
import { runValidate } from "../src/commands/validate.js";

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
function ddl(sql: string, cwd: string, write = false) {
  return runQuery({ sql, inputs: ["docs"], cwd, write });
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
