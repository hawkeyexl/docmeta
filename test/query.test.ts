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
import { renderQuery, renderQueryCsv } from "../src/reporters/query.js";
import { parseQueryParams, resolveQueryInputs } from "../src/cli.js";
import { collectNamedParameters } from "../src/core/projection.js";
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

  it("DROP TABLE stays refused, naming the statements that do the jobs", async () => {
    // 0024: DELETE/INSERT became real DML, but "delete the table definition"
    // is the accident-shaped spelling and keeps its refusal.
    await expect(q("DROP TABLE docs")).rejects.toThrow(/DELETE FROM docs/);
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
  // `apply` keeps every call site's meaning across the 0025 default flip:
  // third-arg true still means "land it", absent still means "preview".
  function w(sql: string, cwd: string, apply = false) {
    return runQuery({
      sql,
      inputs: ["docs", "authors"],
      cwd,
      noConfig: true,
      dryRun: !apply,
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

  it("SET NULL removes the key; explicit_null() writes the literal", async () => {
    // 0024: the standard-vocabulary flip. NULL is the removal spelling.
    const d = copy();
    await w("UPDATE docs SET author = NULL WHERE _path = 'docs/gamma.md'", d, true);
    const gamma = readFileSync(join(d, "docs", "gamma.md"), "utf8");
    expect(gamma).not.toContain("author:");
    // The rare literal null keeps a spelling of its own.
    await w(
      "UPDATE docs SET draft = explicit_null() WHERE _path = 'docs/alpha.md'",
      d,
      true,
    );
    expect(readFileSync(join(d, "docs", "alpha.md"), "utf8")).toMatch(
      /draft: null/,
    );
  });

  it("refuses changes to the read-only system columns", async () => {
    // `_path` became the rename spelling (0024); the other three stay locked.
    const d = copy();
    await expect(
      w("UPDATE docs SET _format = 'html' WHERE _path = 'docs/beta.md'", d),
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

  it("backfills a corpus-new key with a plain UPDATE", async () => {
    // The data-only backfill spelling; the schema-and-data version is
    // ALTER ADD COLUMN … DEFAULT on a corpus with a schema (query-ddl tests).
    const d = copy();
    const run = await w("UPDATE docs SET stale = 7 WHERE stale IS NULL", d);
    expect(run.changes?.length).toBe(6);
    expect(
      run.changes?.every(
        (c) =>
          "to" in c && c.to === 7 && "from" in c && c.from === undefined && !c.written,
      ),
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

  it("deletes a key per file with NULL", async () => {
    const d = copy();
    const run = await w(
      "UPDATE docs SET author = NULL WHERE _path = 'docs/gamma.md'",
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

  it("deletes a key corpus-wide with an unqualified SET NULL", async () => {
    // 0024: ALTER is schema DDL now, and this corpus has no schema to edit —
    // the corpus-wide data spelling is the WHERE-less UPDATE.
    const d = copy();
    const run = await w("UPDATE docs SET tags = NULL", d, true);
    expect(run.changes?.length).toBe(3); // alpha, beta, gamma have tags
    for (const f of ["alpha", "beta", "gamma"]) {
      expect(readFileSync(join(d, "docs", `${f}.md`), "utf8")).not.toContain(
        "tags:",
      );
    }
  });

  it("ALTER on a schemaless corpus refuses, naming the UPDATE spellings", async () => {
    const d = copy();
    await expect(
      w("ALTER TABLE docs DROP COLUMN tags", d),
    ).rejects.toThrow(/default set|UPDATE/);
  });

  it("deleting a key a file never had is a no-op for that file", async () => {
    const d = copy();
    // Only gamma-adjacent files carry draft; authors do not. Deleting draft
    // everywhere must not report changes for files without it.
    const run = await w("UPDATE docs SET draft = NULL", d, true);
    expect(run.changes?.map((c) => c.file).sort()).toEqual([
      "docs/alpha.md",
      "docs/beta.md",
    ]);
  });

  it("previews a deletion without touching the file", async () => {
    const d = copy();
    const before = readFileSync(join(d, "docs", "gamma.md"), "utf8");
    const run = await w(
      "UPDATE docs SET author = NULL WHERE _path = 'docs/gamma.md'",
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
      w("UPDATE docs SET title = NULL WHERE _format = 'html'", d, true),
    ).rejects.toThrow(/delet/i);
    // All-or-nothing: the html file is intact.
    expect(readFileSync(join(d, "docs", "page.html"), "utf8")).toContain(
      "<title>Page</title>",
    );
  });

  it("DELETE refuses an element-backed format at preview time", async () => {
    const d = copy();
    writeFileSync(
      join(d, "docs", "page.html"),
      "<html><head><title>Page</title></head><body>x</body></html>\n",
    );
    // A preview, not a write: the plan itself must refuse — the element
    // formats have no block to strip, and promising one would be a lie
    // --write discovers later.
    await expect(
      w("DELETE FROM docs WHERE _path = 'docs/page.html'", d),
    ).rejects.toThrow(/no front matter block to strip/);
  });

  it("DELETE refuses a native-header RST file, fence-family or not", async () => {
    const d = copy();
    // Docinfo fields, no fence: present metadata with nothing strippable.
    // The refusal must be per-file — the same extractor strips fenced RST.
    writeFileSync(join(d, "docs", "guide.rst"), ":author: Ada\n\nBody.\n");
    await expect(
      w("DELETE FROM docs WHERE _path = 'docs/guide.rst'", d),
    ).rejects.toThrow(/no front matter block to strip/);
  });

  it("DELETE strips the block, keeps the body, and converges", async () => {
    const d = copy();
    const run = await w("DELETE FROM docs WHERE _path = 'docs/beta.md'", d, true);
    expect(run.changes?.length).toBe(1);
    expect(run.changes?.[0]).toMatchObject({
      file: "docs/beta.md",
      cleared: true,
      written: true,
    });
    const beta = readFileSync(join(d, "docs", "beta.md"), "utf8");
    expect(beta).toBe("The beta page.\n");
    const again = await w("DELETE FROM docs WHERE _path = 'docs/beta.md'", d);
    expect(again.changes).toEqual([]);
  });

  it("INSERT creates a file: that frontmatter, an empty body", async () => {
    const d = copy();
    // `reviewed` is corpus-new: the INSERT column list widens the table too.
    const run = await w(
      "INSERT INTO docs (_path, title, draft, reviewed) VALUES ('docs/delta.md', 'Delta', 0, 'todo')",
      d,
      true,
    );
    expect(run.changes).toEqual([
      {
        file: "docs/delta.md",
        created: true,
        to: { draft: false, reviewed: "todo", title: "Delta" },
        written: true,
      },
    ]);
    const delta = readFileSync(join(d, "docs", "delta.md"), "utf8");
    expect(delta).toContain("title: Delta");
    expect(delta).toContain("draft: false");
    expect(delta).toContain("reviewed: todo");
  });

  it("INSERT refuses bad paths, existing files, and system columns", async () => {
    const d = copy();
    await expect(
      w("INSERT INTO docs (_path, title) VALUES ('../evil.md', 'X')", d, true),
    ).rejects.toThrow(/path/i);
    await expect(
      w("INSERT INTO docs (_path, title) VALUES ('docs/alpha.md', 'X')", d, true),
    ).rejects.toThrow(/exists/i);
    await expect(
      w("INSERT INTO docs (_path, _format) VALUES ('docs/e.md', 'markdown')", d, true),
    ).rejects.toThrow(/system/i);
    await expect(
      w("INSERT INTO docs (title) VALUES ('X')", d, true),
    ).rejects.toThrow(/_path/);
    // The empty string slips past the PRIMARY KEY's NOT NULL, so this is the
    // guard's own message, not SQLite's.
    await expect(
      w("INSERT INTO docs (_path, title) VALUES ('', 'X')", d, true),
    ).rejects.toThrow(/non-empty _path/);
    // An unwritable extension refuses at *preview* time — the plan must never
    // promise a file only --write can discover it cannot build.
    await expect(
      w("INSERT INTO docs (_path, title) VALUES ('docs/new.xyz', 'X')", d),
    ).rejects.toThrow(/no writable format/);
  });

  it("SET _path renames the file, body byte-preserved", async () => {
    const d = copy();
    const bytes = readFileSync(join(d, "docs", "beta.md"), "utf8");
    const run = await w(
      "UPDATE docs SET _path = 'docs/renamed-beta.md' WHERE _path = 'docs/beta.md'",
      d,
      true,
    );
    expect(run.changes).toEqual([
      { file: "docs/beta.md", renamed: "docs/renamed-beta.md", written: true },
    ]);
    expect(existsSync(join(d, "docs", "beta.md"))).toBe(false);
    expect(readFileSync(join(d, "docs", "renamed-beta.md"), "utf8")).toBe(bytes);
  });

  it("SET _path renames into a directory that does not exist yet", async () => {
    const d = copy();
    const bytes = readFileSync(join(d, "docs", "beta.md"), "utf8");
    await w(
      "UPDATE docs SET _path = 'archive/2026/beta.md' WHERE _path = 'docs/beta.md'",
      d,
      true,
    );
    expect(readFileSync(join(d, "archive", "2026", "beta.md"), "utf8")).toBe(
      bytes,
    );
  });

  it("renames one file while editing another in the same statement", async () => {
    const d = copy();
    // One row's _path moves, a different row's cell changes — the same-row
    // mix stays refused, but cross-file combinations are one statement.
    const run = await w(
      "UPDATE docs SET " +
        "_path = CASE _path WHEN 'docs/beta.md' THEN 'docs/moved-beta.md' ELSE _path END, " +
        "draft = CASE _path WHEN 'docs/alpha.md' THEN 1 ELSE draft END",
      d,
      true,
    );
    expect(run.changes?.length).toBe(2);
    expect(existsSync(join(d, "docs", "moved-beta.md"))).toBe(true);
    expect(readFileSync(join(d, "docs", "alpha.md"), "utf8")).toContain(
      "draft: true",
    );
  });

  it("rename refusals: extension change, collision, mixed edits", async () => {
    const d = copy();
    await expect(
      w("UPDATE docs SET _path = 'docs/beta.html' WHERE _path = 'docs/beta.md'", d),
    ).rejects.toThrow(/extension/i);
    await expect(
      w("UPDATE docs SET _path = 'docs/alpha.md' WHERE _path = 'docs/beta.md'", d),
    ).rejects.toThrow(/exists/i);
    await expect(
      w(
        "UPDATE docs SET _path = 'docs/x.md', draft = 0 WHERE _path = 'docs/beta.md'",
        d,
      ),
    ).rejects.toThrow(/separately/i);
  });

  it("a cross-column UPDATE pairs as a key rename, arrays intact", async () => {
    // The schemaless rename spelling; ALTER RENAME COLUMN does schema and
    // data together on a corpus with a schema (query-ddl tests).
    const d = copy();
    const run = await w("UPDATE docs SET topics = tags, tags = NULL WHERE tags IS NOT NULL", d, true);
    expect(run.changes).toEqual([
      { file: "docs/alpha.md", key: "topics", renamedFrom: "tags", to: ["guide", "intro"], written: true },
      { file: "docs/beta.md", key: "topics", renamedFrom: "tags", to: ["guide"], written: true },
      { file: "docs/gamma.md", key: "topics", renamedFrom: "tags", to: ["api"], written: true },
    ]);
    const alpha = readFileSync(join(d, "docs", "alpha.md"), "utf8");
    expect(alpha).not.toContain("tags:");
    // The pairing carries the original value — never the JSON-text projection.
    const check = await w("SELECT topics FROM docs WHERE _path = 'docs/alpha.md'", d);
    expect(JSON.parse(check.rows[0]?.topics as string)).toEqual(["guide", "intro"]);
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
    const preview = renderQuery({ columns: [], rows: [], changes }, { dryRun: true });
    expect(preview).toContain("docs/beta.md: draft: true -> false");
    expect(preview).toContain("docs/gamma.md: draft: (unset) -> false");
    expect(preview).toContain("2 changes across 2 files");
    expect(preview).toContain("without --dry-run to apply");
    const written = renderQuery({
      columns: [],
      rows: [],
      changes: changes.map((ch) => ({ ...ch, written: true })),
    });
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

describe("runQuery params (0029)", () => {
  it("binds a named parameter under all three prefixes", async () => {
    for (const token of ["$author", ":author", "@author"]) {
      const run = await q(
        `SELECT _path FROM docs WHERE author = ${token} ORDER BY _path`,
        { params: { author: "ada" } },
      );
      expect(run.rows).toEqual([{ _path: "docs/alpha.md" }]);
    }
  });

  it("binds booleans as 1/0, matching the projection's own encoding", async () => {
    const run = await q("SELECT _path FROM docs WHERE draft = $d", {
      params: { d: true },
    });
    expect(run.rows).toEqual([{ _path: "docs/beta.md" }]);
  });

  it("a string param matches a stored YAML string; a number does not", async () => {
    // Proposal 0029 § stress test 2: columns have no type affinity, so the
    // bound number 2026 never equals the stored string "2026".
    const opts = {
      inputs: ["-"],
      stdinContent: '---\ntitle: "2026"\n---\nBody.\n',
      as: "markdown",
    };
    const hit = await q("SELECT _path FROM docs WHERE title = $t", {
      ...opts,
      params: { t: "2026" },
    });
    expect(hit.rows).toEqual([{ _path: "<stdin>" }]);
    const miss = await q("SELECT _path FROM docs WHERE title = $t", {
      ...opts,
      params: { t: 2026 },
    });
    expect(miss.rows).toEqual([]);
  });

  it("refuses a referenced-but-unbound parameter, naming it", async () => {
    // The false-green guard: unbound binds NULL, matches nothing, and a
    // zero-row --check would pass. Refused before any file is read.
    await expect(
      q("SELECT _path FROM docs WHERE draft = $d"),
    ).rejects.toThrow(/\$d/);
    await expect(
      q("SELECT _path FROM docs WHERE draft = $d"),
    ).rejects.toBeInstanceOf(DocmetaError);
  });

  it("refuses an extra bound parameter, naming it", async () => {
    await expect(
      q("SELECT _path FROM docs WHERE author = $author", {
        params: { author: "ada", extra: 1 },
      }),
    ).rejects.toThrow(/extra/);
  });

  it("does not read $ or : inside string literals as parameters", async () => {
    const run = await q(
      "SELECT _path FROM docs WHERE title = 'costs $5 : @once'",
    );
    expect(run.rows).toEqual([]);
  });

  it("binds parameters in DML the same way", async () => {
    const run = await q("UPDATE docs SET draft = $v WHERE _path = $p", {
      params: { v: true, p: "docs/alpha.md" },
      dryRun: true,
    });
    expect(run.changes).toEqual([
      {
        file: "docs/alpha.md",
        key: "draft",
        from: false,
        to: true,
        written: false,
      },
    ]);
  });
});

describe("collectNamedParameters", () => {
  it("finds $, :, and @ tokens outside literals", () => {
    expect(
      collectNamedParameters("SELECT $a, :b, @c FROM docs WHERE x = $a"),
    ).toEqual(["$a", ":b", "@c"]);
  });

  it("skips string literals, quoted identifiers, and comments", () => {
    expect(
      collectNamedParameters(
        "SELECT '$nope', \"$nor\", `$this` -- $comment\n /* :block */ FROM docs",
      ),
    ).toEqual([]);
  });

  it("does not misread a doubled colon as a parameter", () => {
    expect(collectNamedParameters("SELECT a :: b FROM docs")).toEqual([]);
    expect(collectNamedParameters("SELECT a::b FROM docs")).toEqual([]);
  });

  it("ignores a bare prefix with no identifier after it", () => {
    expect(collectNamedParameters("SELECT a $ 1, b : 2 FROM docs")).toEqual([]);
  });
});

describe("parseQueryParams", () => {
  it("binds the value as a string, splitting on the first =", () => {
    expect(parseQueryParams(["msg=a=b"])).toEqual({ msg: "a=b" });
  });

  it(":= parses the value as JSON, and wins when it comes first", () => {
    expect(parseQueryParams(["v:=5"])).toEqual({ v: 5 });
    expect(parseQueryParams(["v:=true"])).toEqual({ v: true });
    expect(parseQueryParams(["v:=null"])).toEqual({ v: null });
    expect(parseQueryParams(["v:=[1,2]"])).toEqual({ v: [1, 2] });
  });

  it('the quoted spelling binds the string: v:="5" is "5", v:=5 the number', () => {
    // Proposal 0029 § stress test 3: the program receives the argv verbatim —
    // `--param 'v:="5"'` arrives with its inner quotes, unquoted v:=5 without.
    expect(parseQueryParams(['v:="5"'])).toEqual({ v: "5" });
    expect(parseQueryParams(["v:=5"])).toEqual({ v: 5 });
  });

  it("an = before the := makes it a plain string split", () => {
    expect(parseQueryParams(["a=b:=c"])).toEqual({ a: "b:=c" });
  });

  it("refuses a param with no separator or no name", () => {
    expect(() => parseQueryParams(["nope"])).toThrow(DocmetaError);
    expect(() => parseQueryParams(["=v"])).toThrow(DocmetaError);
  });

  it("refuses invalid JSON after :=, pointing at the string spelling", () => {
    expect(() => parseQueryParams(["v:=high"])).toThrow(/v=/);
  });
});

/**
 * A strict RFC 4180 reader, so the CSV tests parse the emitted bytes back
 * instead of string-matching the escaping (proposal 0029 § stress test 5).
 * Accepts LF line endings (docmeta's documented divergence) as well as CRLF.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) break; // unreachable; satisfies indexed-access
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === ",") {
      endField();
      i++;
    } else if (ch === "\n") {
      endRow();
      i++;
    } else if (ch === "\r" && text[i + 1] === "\n") {
      endRow();
      i += 2;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

describe("renderQueryCsv (0029)", () => {
  it("always emits the header; a zero-row result is the header alone", () => {
    expect(renderQueryCsv({ columns: ["_path", "title"], rows: [] })).toBe(
      "_path,title",
    );
  });

  it("prints SQL NULL as an empty field and uses LF endings", () => {
    const text = renderQueryCsv({
      columns: ["a", "b"],
      rows: [{ a: "x", b: null }],
    });
    expect(text).toBe("a,b\nx,");
    expect(text).not.toContain("\r");
  });

  it("round-trips commas, quotes, and newlines through an RFC 4180 reader", async () => {
    const run = await runQuery({
      sql: "SELECT title, owner FROM docs ORDER BY _path",
      inputs: ["."],
      cwd: resolve(here, "fixtures", "query-csv"),
      noConfig: true,
    });
    const text = renderQueryCsv(run);
    expect(parseCsv(text)).toEqual([
      ["title", "owner"],
      ["Stale, but shipping", "docs"],
      ["Line one\nLine two", ""],
      ['She said "ship it"', "ci"],
    ]);
  });

  it("keeps arrays and objects as the JSON text the projection holds", () => {
    const text = renderQueryCsv({
      columns: ["tags"],
      rows: [{ tags: '["guide","intro"]' }],
    });
    expect(parseCsv(text)).toEqual([["tags"], ['["guide","intro"]']]);
  });
});
