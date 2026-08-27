import { describe, it, expect, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runQuery, type QueryOptions } from "../src/commands/query.js";
import { runValidate } from "../src/commands/validate.js";
import { loadSqlite } from "../src/core/projection.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, "fixtures", "collections");

/**
 * All cases run over `test/fixtures/collections/`: a config whose two
 * `overrides:` entries carry `name:` (proposal 0027) — `authors` over the
 * authors directory and `notes` over a deep-file glob — an `authors/` and
 * `docs/` split, one file matching both named globs, and one file naming its
 * own `$schema`. Inputs come from the config's `paths:`, so the run is the
 * config-resolved corpus.
 */
function q(sql: string, extra: Partial<QueryOptions> = {}) {
  return runQuery({ sql, inputs: [], cwd: corpus, ...extra });
}

const tempDirs: string[] = [];
function tempCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "docmeta-collections-"));
  tempDirs.push(dir);
  cpSync(corpus, dir, { recursive: true });
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("named collections (0027): views over override groups", () => {
  it("a named override is a view of the files it won resolution for", async () => {
    const run = await q("SELECT _path FROM authors ORDER BY _path");
    expect(run.rows).toEqual([
      { _path: "authors/ada.md" },
      { _path: "authors/deep.md" },
      { _path: "authors/grace.md" },
    ]);
  });

  it("views are disjoint: a file matching two named globs joins the first", async () => {
    // authors/deep.md matches the `notes` glob too, but `authors` is the
    // override that won its schema resolution — first-match-wins.
    const run = await q("SELECT _path FROM notes");
    expect(run.rows).toEqual([]);
  });

  it("the flagship join reads FROM authors instead of a GLOB self-join", async () => {
    const run = await q(
      `SELECT d._path, d.author FROM docs d
       LEFT JOIN authors a ON a.slug = d.author
       WHERE d.author IS NOT NULL AND a._path IS NULL`,
    );
    expect(run.rows).toEqual([{ _path: "docs/guide.md", author: "ghost" }]);
  });

  it("a file's own $schema takes it out of the view, with a stderr notice", async () => {
    const notices: string[] = [];
    const run = await q("SELECT _path FROM authors WHERE _path LIKE '%self%'", {
      onNotice: (m) => notices.push(m),
    });
    expect(run.rows).toEqual([]);
    // ...but the file is still an ordinary docs row.
    const asDoc = await q("SELECT _path FROM docs WHERE _path LIKE '%self%'");
    expect(asDoc.rows).toEqual([{ _path: "authors/self.md" }]);
    const notice = notices.find((m) => m.includes("authors/self.md"));
    expect(notice).toBeDefined();
    expect(notice).toContain('"authors"');
    expect(notice).toContain("$schema");
  });

  it("schemaTrust.documentRefs: none flips membership back in", async () => {
    const dir = tempCopy();
    writeFileSync(
      join(dir, "docmeta.config.yaml"),
      `${readFileSync(join(dir, "docmeta.config.yaml"), "utf8")}schemaTrust:\n  documentRefs: none\n`,
    );
    const run = await runQuery({
      sql: "SELECT _path FROM authors ORDER BY _path",
      inputs: [],
      cwd: dir,
    });
    expect(run.rows.map((r) => r._path)).toContain("authors/self.md");
  });

  it("a per-file trust refusal demotes to member-of-no-view, never exit 2", async () => {
    const dir = tempCopy();
    writeFileSync(
      join(dir, "docmeta.config.yaml"),
      `${readFileSync(join(dir, "docmeta.config.yaml"), "utf8")}schemaTrust:\n  documentRefs: local\n`,
    );
    writeFileSync(
      join(dir, "authors", "url.md"),
      "---\n$schema: https://schemas.example.com/x.json\ntitle: URL\nslug: url\n---\nBody.\n",
    );
    // The refused file must not abort a working SELECT...
    const ok = await runQuery({ sql: "SELECT 1 AS one", inputs: [], cwd: dir });
    expect(ok.rows).toEqual([{ one: 1 }]);
    // ...it is simply a member of no view, while its docs row is unaffected.
    const view = await runQuery({
      sql: "SELECT _path FROM authors WHERE _path LIKE '%url%'",
      inputs: [],
      cwd: dir,
    });
    expect(view.rows).toEqual([]);
    const table = await runQuery({
      sql: "SELECT title FROM docs WHERE _path = 'authors/url.md'",
      inputs: [],
      cwd: dir,
    });
    expect(table.rows).toEqual([{ title: "URL" }]);
  });

  it("views ride into the --db export", async () => {
    const dir = tempCopy();
    const out = join(dir, "export.db");
    await q("", { db: out });
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(out);
    try {
      const views = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
        .all() as { name: string }[];
      expect(views.map((v) => v.name)).toEqual(["authors", "notes"]);
      const rows = db.prepare("SELECT count(*) n FROM authors").all() as {
        n: number | bigint;
      }[];
      expect(Number(rows[0]?.n)).toBe(3);
    } finally {
      db.close();
    }
  });

  it("the effect gate never sees the views: a mutating diff is identical", async () => {
    const withViews = await q(
      "UPDATE docs SET title = 'Renamed' WHERE _path = 'docs/intro.md'",
      { dryRun: true },
    );
    const withoutViews = await runQuery({
      sql: "UPDATE docs SET title = 'Renamed' WHERE _path = 'docs/intro.md'",
      inputs: ["docs", "authors"],
      cwd: corpus,
      noConfig: true,
      dryRun: true,
    });
    expect(withViews.changes).toEqual([
      {
        file: "docs/intro.md",
        key: "title",
        from: "Intro",
        to: "Renamed",
        written: false,
      },
    ]);
    expect(withoutViews.changes).toEqual(withViews.changes);
  });

  it("a write through a view refuses with the write-through-docs remedy", async () => {
    let message = "";
    try {
      await q("UPDATE authors SET title = 'X'");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("cannot modify authors because it is a view");
    expect(message).toContain(
      'UPDATE docs … WHERE _path IN (SELECT _path FROM "authors")',
    );
  });

  it("the 0024 split-set refusal names the groups it found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docmeta-ddl-split-"));
    tempDirs.push(dir);
    cpSync(corpus, dir, { recursive: true });
    writeFileSync(
      join(dir, "docmeta.config.yaml"),
      [
        "paths:",
        '  - "docs/**/*.md"',
        '  - "authors/**/*.md"',
        "overrides:",
        "  - name: authors",
        '    files: "authors/**"',
        "    schemas: [./author.schema.json]",
        "  - name: guides",
        '    files: "docs/**"',
        "    schemas: [./base.schema.json]",
        "",
      ].join("\n"),
    );
    rmSync(join(dir, "authors", "self.md"));
    let message = "";
    try {
      await runQuery({
        sql: "ALTER TABLE docs ADD COLUMN reviewed TEXT",
        inputs: [],
        cwd: dir,
        dryRun: true,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("one schema set");
    expect(message).toContain("authors (authors/**)");
    expect(message).toContain("guides (docs/**)");
    expect(message).toContain("re-run over one group's files");
  });

  it("corpus checks read the same views", async () => {
    const dir = tempCopy();
    writeFileSync(
      join(dir, "docmeta.config.yaml"),
      `${readFileSync(join(dir, "docmeta.config.yaml"), "utf8")}checks:
  - name: dangling-author
    query: >-
      SELECT d._path AS path, 'author' AS key,
             'no author page for "' || d.author || '"' AS message
      FROM docs d LEFT JOIN authors a ON a.slug = d.author
      WHERE d.author IS NOT NULL AND a._path IS NULL
`,
    );
    const run = await runValidate({ inputs: [], cwd: dir });
    const guide = run.results.find((r) => r.file === "docs/guide.md");
    expect(guide?.ok).toBe(false);
    expect(guide?.errors[0]?.schema).toBe("check:dangling-author");
    expect(guide?.errors[0]?.message).toContain('no author page for "ghost"');
  });
});
