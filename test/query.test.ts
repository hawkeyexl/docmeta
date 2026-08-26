import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runQuery, type QueryOptions } from "../src/commands/query.js";
import { renderQuery } from "../src/reporters/query.js";
import { resolveQueryInputs } from "../src/cli.js";
import { DocmetaError } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, "fixtures", "query");

/**
 * All cases run over `test/fixtures/query/`: four pages under `docs/` (one
 * with no frontmatter, one carrying a duplicate slug, a dangling author, and
 * two odd keys) and two author pages under `authors/`. `noConfig` keeps the
 * repo's own docmeta.config.yaml out of these runs.
 */
function q(sql: string, extra: Partial<QueryOptions> = {}) {
  return runQuery({
    sql,
    inputs: ["docs", "authors"],
    cwd: corpus,
    noConfig: true,
    ...extra,
  });
}

describe("runQuery", () => {
  it("selects metadata columns across the corpus in path order", async () => {
    const run = await q(
      "SELECT _path, title FROM docs WHERE _present = 1 ORDER BY _path",
    );
    expect(run.rows).toEqual([
      { _path: "authors/ada.md", title: "Ada Lovelace" },
      { _path: "authors/grace.md", title: "Grace Hopper" },
      { _path: "docs/alpha.md", title: "Alpha" },
      { _path: "docs/beta.md", title: "Beta" },
      { _path: "docs/gamma.md", title: "Gamma" },
    ]);
  });

  it("lists files with no metadata via _present = 0", async () => {
    const run = await q("SELECT _path FROM docs WHERE _present = 0");
    expect(run.rows).toEqual([{ _path: "docs/plain.md" }]);
  });

  it("joins: finds an author: no author page exists for", async () => {
    const run = await q(
      `SELECT d._path, d.author FROM docs d
       LEFT JOIN docs a ON a._path GLOB 'authors/*' AND a.slug = d.author
       WHERE d.author IS NOT NULL AND a._path IS NULL`,
    );
    expect(run.rows).toEqual([{ _path: "docs/gamma.md", author: "ghost" }]);
  });

  it("aggregates: finds duplicate slugs", async () => {
    const run = await q(
      `SELECT slug, count(*) n FROM docs
       WHERE slug IS NOT NULL GROUP BY slug HAVING n > 1`,
    );
    expect(run.rows).toEqual([{ slug: "alpha", n: 2 }]);
  });

  it("unnests array values with json_each", async () => {
    const run = await q(
      `SELECT t.value tag, count(*) n FROM docs, json_each(docs.tags) t
       GROUP BY tag ORDER BY n DESC, tag`,
    );
    expect(run.rows).toEqual([
      { tag: "guide", n: 2 },
      { tag: "api", n: 1 },
      { tag: "intro", n: 1 },
    ]);
  });

  it("stores booleans as 1/0, absent keys as NULL", async () => {
    const yes = await q("SELECT _path FROM docs WHERE draft = 1");
    expect(yes.rows).toEqual([{ _path: "docs/beta.md" }]);
    // gamma has no draft key at all, so `draft = 0` must not match it.
    const no = await q("SELECT _path FROM docs WHERE draft = 0");
    expect(no.rows).toEqual([{ _path: "docs/alpha.md" }]);
  });

  it("lifts odd key names as quoted identifiers", async () => {
    const run = await q(
      `SELECT "sidebar position" sp FROM docs WHERE _path = 'docs/gamma.md'`,
    );
    expect(run.rows).toEqual([{ sp: 3 }]);
  });

  it("reserves the system columns; a colliding key stays in _data", async () => {
    const run = await q(
      `SELECT _path p, _data ->> '$._path' sneaky
       FROM docs WHERE _path = 'docs/gamma.md'`,
    );
    expect(run.rows).toEqual([{ p: "docs/gamma.md", sneaky: "sneaky" }]);
  });

  it("reports column names even when no row matches", async () => {
    const run = await q("SELECT _path, title FROM docs WHERE 1 = 0");
    expect(run.rows).toEqual([]);
    expect(run.columns).toEqual(["_path", "title"]);
  });

  it("reads stdin as one more input, labeled <stdin>", async () => {
    const run = await q("SELECT title FROM docs WHERE _path = '<stdin>'", {
      inputs: ["docs", "-"],
      stdinContent: "---\ntitle: Piped\n---\nBody.\n",
      as: "markdown",
    });
    expect(run.rows).toEqual([{ title: "Piped" }]);
  });

  it("rejects SQL that cannot be prepared as an operational error", async () => {
    await expect(q("SELECT nope FROM missing")).rejects.toThrow(DocmetaError);
  });

  it("refuses to let user SQL write", async () => {
    await expect(q("DROP TABLE docs")).rejects.toThrow(DocmetaError);
    await expect(
      q("INSERT INTO docs (_path) VALUES ('x')"),
    ).rejects.toThrow(/readonly|read-only/i);
  });

  it("refuses a second statement instead of silently dropping it", async () => {
    // node:sqlite's prepare() compiles the first statement and ignores the
    // rest, which would run `SELECT 1` and quietly skip the DROP — a request
    // half-honored with exit 0. Refusing is the only honest answer.
    await expect(q("SELECT 1; DROP TABLE docs")).rejects.toThrow(
      /single SQL statement/,
    );
    // A trailing semicolon alone is fine — it terminates, it does not chain.
    const run = await q("SELECT count(*) n FROM docs;");
    expect(run.rows).toEqual([{ n: 6 }]);
  });

  it("requires SQL", async () => {
    await expect(q("   ")).rejects.toThrow(/SQL/);
  });

  it("errors on no inputs and no config", async () => {
    await expect(
      runQuery({ sql: "SELECT 1", inputs: [], cwd: corpus, noConfig: true }),
    ).rejects.toThrow(/No files to read/);
  });
});

describe("runQuery --db", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "docmeta-query-db-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a reopenable database, with SQL optional", async () => {
    const path = join(tmp, "out.db");
    const run = await q("", { db: path });
    expect(run.rows).toEqual([]);
    expect(run.db).toEqual({ path, files: 6, columns: 4 + 7 });
    expect(existsSync(path)).toBe(true);
    // Reopen the artifact with a fresh connection: the table must be there.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) n FROM docs").get()).toEqual({
        n: 6,
      });
      expect(
        db.prepare("SELECT title FROM docs WHERE _path = 'docs/beta.md'").get(),
      ).toEqual({ title: "Beta" });
    } finally {
      db.close();
    }
  });

  it("runs the SQL and writes the database in one go", async () => {
    const path = join(tmp, "both.db");
    const run = await q("SELECT count(*) n FROM docs", { db: path });
    expect(run.rows).toEqual([{ n: 6 }]);
    expect(run.db?.files).toBe(6);
    expect(existsSync(path)).toBe(true);
  });

  it("creates the export's parent directories", async () => {
    // .docmeta/query.db on a fresh checkout is the real-world case: SQLite
    // creates files, never directories.
    const path = join(tmp, "nested", "deeper", "out.db");
    const run = await q("", { db: path });
    expect(run.db?.files).toBe(6);
    expect(existsSync(path)).toBe(true);
  });

  it("overwrites its own artifact on a re-run", async () => {
    const path = join(tmp, "again.db");
    await q("", { db: path });
    const run = await q("", { db: path });
    expect(run.db?.files).toBe(6);
  });

  it("refuses to overwrite a file that is not a SQLite database", async () => {
    const path = join(tmp, "precious.txt");
    writeFileSync(path, "not a database\n");
    await expect(q("", { db: path })).rejects.toThrow(
      /not a SQLite database/,
    );
  });

  it("still requires SQL when --db is absent", async () => {
    await expect(q("")).rejects.toThrow(/SQL/);
  });
});

describe("renderQuery", () => {
  const run = {
    columns: ["_path", "n"],
    rows: [
      { _path: "docs/a.md", n: 2 },
      { _path: "x.md", n: null },
    ],
  };

  it("aligns columns, prints NULL as (null), and counts rows", () => {
    expect(renderQuery(run)).toBe(
      ["_path      n", "docs/a.md  2", "x.md       (null)", "2 rows"].join(
        "\n",
      ),
    );
  });

  it("prints only the count when no row matched, and knows singular", () => {
    expect(renderQuery({ columns: ["a"], rows: [] })).toBe("0 rows");
    expect(renderQuery({ columns: ["a"], rows: [{ a: 1 }] })).toContain(
      "1 row",
    );
  });

  it("check mode renders a red ✗ verdict on rows, a green ✓ on none", () => {
    const failed = renderQuery(run, { check: true, color: true });
    expect(failed).toContain("✗ 2 rows — check failed");
    expect(failed).toContain("[31m");
    const passed = renderQuery(
      { columns: ["a"], rows: [] },
      { check: true, color: true },
    );
    expect(passed).toContain("✓ 0 rows");
    expect(passed).toContain("[32m");
  });
});

describe("resolveQueryInputs", () => {
  // `corpus` holds a real `docs/` directory, so a bare `docs` token exercises
  // the exists-on-disk leg of `looksLikePath` exactly as `get`'s guard does.
  it("refuses a path in the SQL slot, naming the remedy", () => {
    expect(() => resolveQueryInputs("docs", [], undefined, corpus)).toThrow(
      /looks like a path, not SQL/,
    );
  });

  it("--query makes every positional a path", () => {
    expect(
      resolveQueryInputs("docs", ["authors"], "SELECT 1", corpus),
    ).toEqual({ sql: "SELECT 1", paths: ["docs", "authors"] });
  });

  it("`-` in the SQL slot is stdin, never SQL", () => {
    expect(resolveQueryInputs("-", ["docs"], "SELECT 1", corpus)).toEqual({
      sql: "SELECT 1",
      paths: ["-", "docs"],
    });
    expect(() => resolveQueryInputs("-", [], undefined, corpus)).toThrow(
      /Specify SQL/,
    );
  });

  it("requires SQL, and blank SQL does not count", () => {
    expect(() => resolveQueryInputs(undefined, [], undefined, corpus)).toThrow(
      /Specify SQL/,
    );
    expect(() => resolveQueryInputs("   ", [], undefined, corpus)).toThrow(
      /Specify SQL/,
    );
  });

  it("real SQL is never mistaken for a path", () => {
    const { sql, paths } = resolveQueryInputs(
      "SELECT a, b FROM docs",
      ["docs"],
      undefined,
      corpus,
    );
    expect(sql).toBe("SELECT a, b FROM docs");
    expect(paths).toEqual(["docs"]);
  });

  it("comma-free SQL with (*) is SQL, not a glob", () => {
    // picomatch reads `count(*)` as an extglob, so without the whitespace
    // guard this exact statement was refused as a path — and, with --db,
    // silently demoted to a no-match glob input instead of run.
    const statement = "SELECT count(*) n FROM docs";
    expect(
      resolveQueryInputs(statement, ["docs"], undefined, corpus).sql,
    ).toBe(statement);
    expect(
      resolveQueryInputs(statement, ["docs"], undefined, corpus, true).sql,
    ).toBe(statement);
  });

  it("--db makes the SQL optional: a lone path stays a path", () => {
    expect(
      resolveQueryInputs("docs", ["authors"], undefined, corpus, true),
    ).toEqual({ sql: "", paths: ["docs", "authors"] });
    expect(resolveQueryInputs(undefined, [], undefined, corpus, true)).toEqual({
      sql: "",
      paths: [],
    });
  });

  it("--db with SQL still runs it", () => {
    expect(
      resolveQueryInputs("SELECT 1", ["docs"], undefined, corpus, true),
    ).toEqual({ sql: "SELECT 1", paths: ["docs"] });
  });
});
