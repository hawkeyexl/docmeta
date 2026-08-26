import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  it("refuses statements whose effect is not a metadata edit", async () => {
    // 0022: enforcement moved from PRAGMA query_only to effect-gating — the
    // statement runs against the disposable projection, and creating or
    // deleting rows (files, in the corpus's terms) refuses the run.
    await expect(q("DROP TABLE docs")).rejects.toThrow(
      /create or delete rows/i,
    );
    await expect(
      q("INSERT INTO docs (_path) VALUES ('x')"),
    ).rejects.toThrow(/create or delete rows/i);
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

describe("runQuery write-back (0022)", () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
  });
  /** A throwaway copy of the corpus, so writes never touch the fixtures. */
  function copy(): string {
    const d = mkdtempSync(join(tmpdir(), "docmeta-write-"));
    cpSync(corpus, d, { recursive: true });
    temps.push(d);
    return d;
  }
  function w(sql: string, cwd: string, write = false) {
    return runQuery({
      sql,
      inputs: ["docs", "authors"],
      cwd,
      noConfig: true,
      write,
    });
  }

  it("previews an UPDATE as per-file changes, touching nothing", async () => {
    const d = copy();
    const before = readFileSync(join(d, "docs", "beta.md"), "utf8");
    const run = await w("UPDATE docs SET draft = 0 WHERE draft = 1", d);
    expect(run.changes).toEqual([
      { file: "docs/beta.md", key: "draft", from: true, to: false, written: false },
    ]);
    expect(readFileSync(join(d, "docs", "beta.md"), "utf8")).toBe(before);
  });

  it("applies with write: booleans restored, body preserved, then converges", async () => {
    const d = copy();
    const run = await w("UPDATE docs SET draft = 0 WHERE draft = 1", d, true);
    expect(run.changes).toEqual([
      { file: "docs/beta.md", key: "draft", from: true, to: false, written: true },
    ]);
    const after = readFileSync(join(d, "docs", "beta.md"), "utf8");
    expect(after).toContain("draft: false");
    expect(after).toContain("The beta page.");
    const again = await w("UPDATE docs SET draft = 0 WHERE draft = 1", d);
    expect(again.changes).toEqual([]);
  });

  it("restores array values edited as JSON text", async () => {
    const d = copy();
    await w(
      `UPDATE docs SET tags = (
         SELECT json_group_array(CASE t.value WHEN 'guide' THEN 'guides' ELSE t.value END)
         FROM json_each(docs.tags) t)
       WHERE _path = 'docs/beta.md'`,
      d,
      true,
    );
    const check = await w("SELECT tags FROM docs WHERE _path = 'docs/beta.md'", d);
    expect(JSON.parse(check.rows[0]?.tags as string)).toEqual(["guides"]);
  });

  it("types a new key by the column's dominant type", async () => {
    const d = copy();
    // gamma never had draft; alpha (false) and beta (true) make it boolean.
    await w("UPDATE docs SET draft = 0 WHERE _path = 'docs/gamma.md'", d, true);
    expect(readFileSync(join(d, "docs", "gamma.md"), "utf8")).toContain(
      "draft: false",
    );
  });

  it("refuses a value the restored type cannot hold", async () => {
    const d = copy();
    const before = readFileSync(join(d, "docs", "beta.md"), "utf8");
    await expect(
      w("UPDATE docs SET draft = 2 WHERE _path = 'docs/beta.md'", d, true),
    ).rejects.toThrow(/boolean/i);
    expect(readFileSync(join(d, "docs", "beta.md"), "utf8")).toBe(before);
  });

  it("SET NULL writes an explicit null, not a deletion", async () => {
    const d = copy();
    await w("UPDATE docs SET author = NULL WHERE _path = 'docs/gamma.md'", d, true);
    expect(readFileSync(join(d, "docs", "gamma.md"), "utf8")).toMatch(
      /author: null/,
    );
  });

  it("refuses system-column changes", async () => {
    const d = copy();
    await expect(
      w("UPDATE docs SET _path = 'renamed.md' WHERE _path = 'docs/beta.md'", d),
    ).rejects.toThrow(/system column/i);
  });

  it("refuses ATTACH and VACUUM outright, comments included", async () => {
    const d = copy();
    await expect(w("ATTACH DATABASE 'x.db' AS x", d)).rejects.toThrow(
      /ATTACH|refused/,
    );
    await expect(w("VACUUM", d)).rejects.toThrow(/VACUUM|refused/);
    // A leading comment must not smuggle the statement past the name check.
    await expect(
      w("/* bypass */ ATTACH DATABASE 'x.db' AS x", d),
    ).rejects.toThrow(/ATTACH/);
    await expect(w("-- c\nVACUUM", d)).rejects.toThrow(/VACUUM/);
  });

  it("classifies CTE-prefixed DML as an edit even at zero rows", async () => {
    const d = copy();
    const run = await w(
      "WITH t AS (SELECT 1) UPDATE docs SET draft = 0 WHERE 1 = 0",
      d,
    );
    expect(run.changes).toEqual([]);
  });

  it("sees an ALTER ADD COLUMN DEFAULT backfill as the change it is", async () => {
    const d = copy();
    const run = await w(
      "ALTER TABLE docs ADD COLUMN stale INTEGER DEFAULT 7",
      d,
    );
    expect(run.changes?.length).toBe(6);
    expect(
      run.changes?.every((c) => c.to === 7 && c.from === undefined && !c.written),
    ).toBe(true);
  });

  it("is all-or-nothing: one refusal writes no file at all", async () => {
    const d = copy();
    const before = readFileSync(join(d, "docs", "beta.md"), "utf8");
    await expect(
      w(
        `UPDATE docs SET draft = CASE _path WHEN 'docs/beta.md' THEN 0 ELSE 2 END
         WHERE _path IN ('docs/beta.md', 'docs/gamma.md')`,
        d,
        true,
      ),
    ).rejects.toThrow(/boolean/i);
    expect(readFileSync(join(d, "docs", "beta.md"), "utf8")).toBe(before);
  });

  it("creates a corpus-new key: SET widens the table", async () => {
    const d = copy();
    const run = await w(
      "UPDATE docs SET reviewed_by = 'maya' WHERE _path = 'docs/alpha.md'",
      d,
      true,
    );
    // `from` is absent for a key the file never had — distinct from an
    // explicit null, which would carry `from: null`.
    expect(run.changes).toEqual([
      {
        file: "docs/alpha.md",
        key: "reviewed_by",
        from: undefined,
        to: "maya",
        written: true,
      },
    ]);
    expect(readFileSync(join(d, "docs", "alpha.md"), "utf8")).toContain(
      "reviewed_by: maya",
    );
  });

  it("deletes a key per file with drop_key()", async () => {
    const d = copy();
    const run = await w(
      "UPDATE docs SET author = drop_key() WHERE _path = 'docs/gamma.md'",
      d,
      true,
    );
    expect(run.changes).toEqual([
      {
        file: "docs/gamma.md",
        key: "author",
        from: "ghost",
        deleted: true,
        written: true,
      },
    ]);
    const gamma = readFileSync(join(d, "docs", "gamma.md"), "utf8");
    expect(gamma).not.toContain("author:");
    expect(gamma).toContain("title: Gamma");
    // Untouched files keep the key.
    expect(readFileSync(join(d, "docs", "alpha.md"), "utf8")).toContain(
      "author: ada",
    );
  });

  it("deletes a key corpus-wide with ALTER TABLE DROP COLUMN", async () => {
    const d = copy();
    const run = await w("ALTER TABLE docs DROP COLUMN tags", d, true);
    expect(run.changes?.length).toBe(3); // alpha, beta, gamma have tags
    for (const f of ["alpha", "beta", "gamma"]) {
      expect(readFileSync(join(d, "docs", `${f}.md`), "utf8")).not.toContain(
        "tags:",
      );
    }
  });

  it("deleting a key a file never had is a no-op for that file", async () => {
    const d = copy();
    // Only gamma-adjacent files carry draft; authors do not. Deleting draft
    // everywhere must not report changes for files without it.
    const run = await w("UPDATE docs SET draft = drop_key()", d, true);
    expect(run.changes?.map((c) => c.file).sort()).toEqual([
      "docs/alpha.md",
      "docs/beta.md",
    ]);
  });

  it("previews a deletion without touching the file", async () => {
    const d = copy();
    const before = readFileSync(join(d, "docs", "gamma.md"), "utf8");
    const run = await w(
      "UPDATE docs SET author = drop_key() WHERE _path = 'docs/gamma.md'",
      d,
    );
    expect(run.changes?.[0]).toEqual({
      file: "docs/gamma.md",
      key: "author",
      from: "ghost",
      deleted: true,
      written: false,
    });
    expect(readFileSync(join(d, "docs", "gamma.md"), "utf8")).toBe(before);
  });

  it("refuses deletion where the writer cannot remove the key", async () => {
    const d = copy();
    writeFileSync(
      join(d, "docs", "page.html"),
      "<html><head><title>Page</title></head><body>x</body></html>\n",
    );
    await expect(
      w("UPDATE docs SET title = drop_key() WHERE _format = 'html'", d, true),
    ).rejects.toThrow(/delet/i);
    // All-or-nothing: the html file is intact.
    expect(readFileSync(join(d, "docs", "page.html"), "utf8")).toContain(
      "<title>Page</title>",
    );
  });

  it("refuses a write that touches <stdin>", async () => {
    const d = copy();
    await expect(
      runQuery({
        sql: "UPDATE docs SET title = 'X' WHERE _path = '<stdin>'",
        inputs: ["docs", "-"],
        stdinContent: "---\ntitle: Piped\n---\n",
        as: "markdown",
        cwd: d,
        noConfig: true,
        write: true,
      }),
    ).rejects.toThrow(/stdin/i);
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

  it("renders changes as a diff with the mode's verdict line", () => {
    const changes = [
      { file: "docs/beta.md", key: "draft", from: true, to: false, written: false },
      { file: "docs/gamma.md", key: "draft", from: undefined, to: false, written: false },
    ];
    const preview = renderQuery({ columns: [], rows: [], changes });
    expect(preview).toContain("docs/beta.md: draft: true -> false");
    expect(preview).toContain("docs/gamma.md: draft: (unset) -> false");
    expect(preview).toContain("2 changes across 2 files");
    expect(preview).toContain("pass --write to apply");
    const written = renderQuery(
      { columns: [], rows: [], changes: changes.map((ch) => ({ ...ch, written: true })) },
      { write: true },
    );
    expect(written).toContain("— written");
    const gate = renderQuery({ columns: [], rows: [], changes }, { check: true });
    expect(gate).toContain("✗ 2 changes across 2 files — check failed");
    expect(
      renderQuery({ columns: [], rows: [], changes: [] }, { check: true }),
    ).toContain("✓ 0 changes");
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
