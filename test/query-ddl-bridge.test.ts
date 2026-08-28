/**
 * Proposal 0028 — the DDL type bridge: formats as column types, enums as
 * `CHECK (col IN (…))`. Each stress test in the proposal is pinned here.
 */
import { describe, it, expect, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDefaultsMatchDeclaredTypes,
  runQuery,
  type QueryChange,
} from "../src/commands/query.js";
import { runValidate } from "../src/commands/validate.js";
import { renderQuery } from "../src/reporters/query.js";
import { loadSqlite } from "../src/core/projection.js";

const here = dirname(fileURLToPath(import.meta.url));
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** Throwaway copy of the bridge fixture; its own config governs the run. */
function copy(): string {
  const d = mkdtempSync(join(tmpdir(), "docmeta-ddl-bridge-"));
  cpSync(resolve(here, "fixtures", "ddl-bridge"), d, { recursive: true });
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
const propsOf = (d: string): Record<string, unknown> =>
  houseOf(d).properties as Record<string, unknown>;
const schemaAddOf = (run: { changes?: QueryChange[] }) =>
  run.changes?.find((c) => "schema" in c && c.op === "add");

describe("0028 probes — the engine facts the design rests on", () => {
  it("table_info hides a CHECK; the catalog appends the def verbatim", async () => {
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE docs ("_path" TEXT PRIMARY KEY, "title" TEXT)`);
      db.exec(`INSERT INTO docs VALUES ('a.md', 'A')`);
      const before = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'docs'",
          )
          .all() as { sql: string }[]
      )[0]?.sql;
      const def = "status TEXT CHECK (status IN ('draft','review','final'))";
      db.exec(`ALTER TABLE docs ADD COLUMN ${def}`);
      const after = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'docs'",
          )
          .all() as { sql: string }[]
      )[0]?.sql;
      // Stress 2: docmeta's own text plus the verbatim appended def.
      expect(before?.endsWith(")")).toBe(true);
      expect(after).toBe(`${before?.slice(0, -1) ?? ""}, ${def})`);
      // Stress 1: table_info reports no constraint at all — yet the engine
      // enforces it, so the catalog consult is the only channel.
      const status = (
        db.prepare("PRAGMA table_info(docs)").all() as Record<string, unknown>[]
      ).find((r) => r.name === "status");
      expect(status).toMatchObject({ type: "TEXT", notnull: 0 });
      expect(Object.keys(status ?? {})).not.toContain("check");
      expect(() => {
        db.exec("UPDATE docs SET status = 'nope'");
      }).toThrow(/CHECK constraint/);
    } finally {
      db.close();
    }
  });
});

describe("formats ride declared column types (0028)", () => {
  it("DATE maps to {type: string, format: date} and backfills green", async () => {
    const d = copy();
    const run = await ddl(
      "ALTER TABLE docs ADD COLUMN reviewed_on DATE NOT NULL DEFAULT '2026-08-26'",
      d,
      true,
    );
    expect(schemaAddOf(run)).toMatchObject({
      key: "reviewed_on",
      type: "string",
      format: "date",
      required: true,
    });
    expect(propsOf(d).reviewed_on).toEqual({ type: "string", format: "date" });
    expect(houseOf(d).required).toContain("reviewed_on");
    expect(readFileSync(join(d, "docs", "one.md"), "utf8")).toContain(
      "reviewed_on: 2026-08-26",
    );
    const v = await runValidate({ inputs: ["docs"], cwd: d });
    expect(v.summary.failed).toBe(0);
  });

  it("refuses a DEFAULT the mapped format rejects (stress 4)", async () => {
    const d = copy();
    const before = readFileSync(join(d, "schemas", "house.json"), "utf8");
    await expect(
      ddl("ALTER TABLE docs ADD COLUMN published DATE DEFAULT 'yesterday'", d, true),
    ).rejects.toThrow(/DEFAULT/);
    expect(readFileSync(join(d, "schemas", "house.json"), "utf8")).toBe(before);
  });

  it("format names run before the affinity regexes: json-pointer, not integer (stress 3)", async () => {
    const d = copy();
    const run = await ddl('ALTER TABLE docs ADD COLUMN anchor "json-pointer"', d);
    expect(schemaAddOf(run)).toMatchObject({
      key: "anchor",
      type: "string",
      format: "json-pointer",
    });
  });

  it("DATETIME and TIMESTAMP alias to date-time; the pair is closed", async () => {
    const d = copy();
    for (const spelling of ["DATETIME", "TIMESTAMP"]) {
      const run = await ddl(
        `ALTER TABLE docs ADD COLUMN touched ${spelling}`,
        d,
      );
      expect(schemaAddOf(run)).toMatchObject({
        key: "touched",
        type: "string",
        format: "date-time",
      });
    }
    // A near-miss maps to nothing: the preview shows it unconstrained.
    const miss = await ddl('ALTER TABLE docs ADD COLUMN due "DUE-DATE"', d);
    const add = schemaAddOf(miss);
    expect(add).toBeDefined();
    expect(add).not.toHaveProperty("type");
    expect(add).not.toHaveProperty("format");
  });

  it("quoted \"date-time\" survives the whole unit path (stress 6)", async () => {
    const d = copy();
    await ddl(
      `ALTER TABLE docs ADD COLUMN updated "date-time" NOT NULL DEFAULT '2026-08-26T12:00:00Z'`,
      d,
      true,
    );
    expect(propsOf(d).updated).toEqual({ type: "string", format: "date-time" });
    const v = await runValidate({ inputs: ["docs"], cwd: d });
    expect(v.summary.failed).toBe(0);
  });

  it("BOOLEAN backfills real booleans to files, and they restore as booleans", async () => {
    const d = copy();
    const run = await ddl(
      "ALTER TABLE docs ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false",
      d,
      true,
    );
    expect(schemaAddOf(run)).toMatchObject({
      key: "archived",
      type: "boolean",
      required: true,
    });
    expect(propsOf(d).archived).toEqual({ type: "boolean" });
    // Real booleans in the files — not the projection's 1/0 encoding.
    expect(readFileSync(join(d, "docs", "one.md"), "utf8")).toContain(
      "archived: false",
    );
    const v = await runValidate({ inputs: ["docs"], cwd: d });
    expect(v.summary.failed).toBe(0);
    // Restored as booleans: the re-read corpus binds them 0/1 again.
    const read = await runQuery({
      sql: "SELECT count(*) AS n FROM docs WHERE archived = 0",
      inputs: ["docs"],
      cwd: d,
      dryRun: true,
    });
    expect(read.rows).toEqual([{ n: 2 }]);
  });

  it("BOOL is the alias; a non-0/1/true/false DEFAULT refuses", async () => {
    const d = copy();
    const run = await ddl("ALTER TABLE docs ADD COLUMN flagged BOOL", d);
    expect(schemaAddOf(run)).toMatchObject({ key: "flagged", type: "boolean" });
    await expect(
      ddl("ALTER TABLE docs ADD COLUMN flagged BOOL DEFAULT 'yes'", d, true),
    ).rejects.toThrow(/boolean/);
    // The reconciliation accepts the SQL keywords, not their text spellings:
    // DEFAULT 'true' stores the string 'true', which is not a boolean.
    await expect(
      ddl("ALTER TABLE docs ADD COLUMN flagged BOOL DEFAULT 'true'", d, true),
    ).rejects.toThrow(/boolean/);
  });

  it("the format DEFAULT guard does not depend on a broad type riding along", () => {
    // mapDeclaredType always pairs format with type today, but SchemaOp
    // declares them independent — a format-only add op must still refuse a
    // DEFAULT the format rejects, not slip past a type-gated guard.
    expect(() => {
      assertDefaultsMatchDeclaredTypes(
        [{ op: "add", key: "published", format: "date" }],
        [{ file: "docs/one.md", key: "published", to: "yesterday" }],
      );
    }).toThrow(/format date/);
    // And the well-formed value still passes.
    expect(() => {
      assertDefaultsMatchDeclaredTypes(
        [{ op: "add", key: "published", format: "date" }],
        [{ file: "docs/one.md", key: "published", to: "2026-08-26" }],
      );
    }).not.toThrow();
  });
});

describe("enums are CHECK (col IN (…)) (0028)", () => {
  it("a string IN list becomes enum on the property", async () => {
    const d = copy();
    const run = await ddl(
      "ALTER TABLE docs ADD COLUMN severity TEXT CHECK (severity IN ('low','high'))",
      d,
      true,
    );
    expect(schemaAddOf(run)).toMatchObject({
      key: "severity",
      type: "string",
      enum: ["low", "high"],
    });
    // No DEFAULT, so the schema edit is the only change.
    expect(run.changes?.length).toBe(1);
    expect(propsOf(d).severity).toEqual({
      type: "string",
      enum: ["low", "high"],
    });
  });

  it("a bracket identifier containing a paren parses (bracket-aware scan)", async () => {
    // `[mo)od]` is a legal SQLite bracket identifier; the `)` inside it must
    // not close the CHECK's paren early. This exercises matchingParenEnd's
    // bracket-awareness through the catalog path.
    const d = copy();
    const run = await ddl(
      "ALTER TABLE docs ADD COLUMN [mo)od] TEXT CHECK ([mo)od] IN ('x','y'))",
      d,
    );
    expect(schemaAddOf(run)).toMatchObject({
      key: "mo)od",
      type: "string",
      enum: ["x", "y"],
    });
  });

  it("a comment inside the CHECK parens refuses loudly, never miscounts", async () => {
    // Every comment position inside the parens hits the strict one-shape
    // walks before depth could matter, so the designed outcome is the named
    // refusal — not a paren miscount surfacing as a shape error on clean
    // input, and not a silently dropped constraint. matchingParenEnd itself
    // is comment-aware for family consistency; this pins the contract.
    const d = copy();
    await expect(
      ddl(
        "ALTER TABLE docs ADD COLUMN phase TEXT CHECK (phase IN ('a','b') /* (decoy */)",
        d,
      ),
    ).rejects.toThrow(/one shape/);
  });

  it("a CHECK spelled inside a comment does not confuse the parse", async () => {
    // SQLite stores an ADD COLUMN's definition verbatim, comments included —
    // the scan must skip the comment's decoy CHECK rather than count two
    // constraints and trip the one-shape refusal.
    const d = copy();
    const run = await ddl(
      "ALTER TABLE docs ADD COLUMN stage TEXT /* CHECK (stage IN ('nope')) */ CHECK (stage IN ('a','b'))",
      d,
    );
    expect(schemaAddOf(run)).toMatchObject({
      key: "stage",
      type: "string",
      enum: ["a", "b"],
    });
  });

  it("a numeric IN list with INTEGER maps consistently (stress 7)", async () => {
    const d = copy();
    await ddl(
      "ALTER TABLE docs ADD COLUMN priority INTEGER CHECK (priority IN (1,2,3))",
      d,
      true,
    );
    expect(propsOf(d).priority).toEqual({ type: "integer", enum: [1, 2, 3] });
  });

  it("refuses a mixed-type IN list, naming the two supported shapes", async () => {
    const d = copy();
    await expect(
      ddl(
        "ALTER TABLE docs ADD COLUMN sev TEXT CHECK (sev IN ('draft', 1))",
        d,
        true,
      ),
    ).rejects.toThrow(/all strings or all numbers/);
  });

  it("refuses literals whose JSON type disagrees with the declared type", async () => {
    const d = copy();
    await expect(
      ddl(
        "ALTER TABLE docs ADD COLUMN sev INTEGER CHECK (sev IN ('low','high'))",
        d,
        true,
      ),
    ).rejects.toThrow(/declared type/);
  });

  it("refuses a CHECK naming a different column", async () => {
    const d = copy();
    // The literals satisfy the existing rows, so the engine accepts the ADD
    // and the refusal below is docmeta's own, not SQLite's.
    await expect(
      ddl(
        "ALTER TABLE docs ADD COLUMN sev TEXT CHECK (title IN ('One','Two'))",
        d,
        true,
      ),
    ).rejects.toThrow(/CHECK \(sev IN/);
  });

  it("refuses any other CHECK, naming the shape and the hand edit", async () => {
    const d = copy();
    const err = await ddl(
      "ALTER TABLE docs ADD COLUMN sev TEXT CHECK (length(sev) > 2)",
      d,
      true,
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("CHECK (sev IN");
    expect((err as Error).message).toMatch(/hand|edit the schema/i);
  });

  it("the engine itself refuses a DEFAULT violating the CHECK, as a sane error", async () => {
    const d = copy();
    for (const notNull of ["", " NOT NULL"]) {
      const err = await ddl(
        `ALTER TABLE docs ADD COLUMN sev TEXT${notNull} DEFAULT 'bogus' CHECK (sev IN ('low','high'))`,
        d,
        true,
      ).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/CHECK constraint/);
      expect((err as Error).name).not.toBe("TypeError");
    }
  });

  it("RENAME carries the whole hand-written property — enum included (stress 5)", async () => {
    const d = copy();
    await ddl("ALTER TABLE docs RENAME COLUMN status TO stage", d, true);
    const props = propsOf(d);
    expect(props.stage).toEqual({
      type: "string",
      enum: ["draft", "review", "final"],
      description: "Hand-written; a rename must carry this whole object.",
    });
    expect(props.status).toBeUndefined();
    expect(readFileSync(join(d, "docs", "one.md"), "utf8")).toContain(
      "stage: draft",
    );
  });

  it("DROP never consults the catalog text", async () => {
    const d = copy();
    await ddl("ALTER TABLE docs DROP COLUMN status", d, true);
    expect(propsOf(d).status).toBeUndefined();
    expect(readFileSync(join(d, "docs", "one.md"), "utf8")).not.toContain(
      "status:",
    );
  });
});

describe("the preview names the resulting property (0028)", () => {
  it("renderQuery spells out format and enum on a schema add", () => {
    const changes = [
      {
        file: "schemas/house.json",
        schema: true,
        op: "add",
        key: "reviewed_on",
        type: "string",
        format: "date",
        required: true,
        written: false,
      },
      {
        file: "schemas/house.json",
        schema: true,
        op: "add",
        key: "priority",
        type: "integer",
        enum: [1, 2, 3],
        written: false,
      },
      {
        file: "schemas/house.json",
        schema: true,
        op: "add",
        key: "severity",
        type: "string",
        enum: ["low", "high"],
        written: false,
      },
    ] as QueryChange[];
    const text = renderQuery(
      { columns: [], rows: [], changes },
      { dryRun: true },
    );
    expect(text).toContain("+ reviewed_on (string, format date, required)");
    expect(text).toContain("+ priority (integer, enum [1, 2, 3])");
    // Members render as the schema spells them: "1" and 1 must not collide.
    expect(text).toContain('+ severity (string, enum ["low", "high"])');
  });
});
