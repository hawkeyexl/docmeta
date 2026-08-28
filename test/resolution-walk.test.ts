/**
 * The validate+checks path resolves every file's schema set exactly once.
 *
 * `validate`'s per-file loop already resolves each file; when the named
 * corpus checks then build collection views (proposal 0027), the membership
 * walk must reuse those resolutions instead of re-resolving the whole corpus
 * a second time. The counter seam wraps `resolveSchemaSetWithSource` — the
 * one function both walks go through — and the parity cases pin that reuse
 * changed nothing observable: the "$schema won" notice still fires, and a
 * file whose resolution failed is still a member of no view.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const counter = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../src/core/resolve-schema.js", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../src/core/resolve-schema.js")>();
  return {
    ...mod,
    resolveSchemaSetWithSource: (
      ...args: Parameters<typeof mod.resolveSchemaSetWithSource>
    ) => {
      counter.calls += 1;
      return mod.resolveSchemaSetWithSource(...args);
    },
  };
});

import { runValidate } from "../src/commands/validate.js";
import { runQuery } from "../src/commands/query.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, "fixtures", "collections");

const CHECK = `checks:
  - name: dangling-author
    query: >-
      SELECT d._path AS path, 'author' AS key,
             'no author page for "' || d.author || '"' AS message
      FROM docs d LEFT JOIN authors a ON a.slug = d.author
      WHERE d.author IS NOT NULL AND a._path IS NULL
`;

const tempDirs: string[] = [];
function corpusWithChecks(extraConfig = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "docmeta-resolution-walk-"));
  tempDirs.push(dir);
  cpSync(corpus, dir, { recursive: true });
  const config = join(dir, "docmeta.config.yaml");
  writeFileSync(config, `${readFileSync(config, "utf8")}${CHECK}${extraConfig}`);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  counter.calls = 0;
});

describe("validate+checks: one resolution walk (not two)", () => {
  it("resolves each file exactly once when checks build collection views", async () => {
    const dir = corpusWithChecks();
    const run = await runValidate({ inputs: [], cwd: dir });
    expect(run.results.length).toBeGreaterThan(0);
    // One call per file from the per-file loop; the checks' membership walk
    // reuses them. A second full walk would double this.
    expect(counter.calls).toBe(run.results.length);
    // ...and the check still fired over the views it needed.
    const guide = run.results.find((r) => r.file === "docs/guide.md");
    expect(guide?.errors.some((e) => e.schema === "check:dangling-author")).toBe(
      true,
    );
  });

  it('the "$schema won" exclusion notice still fires from the reused walk', async () => {
    const dir = corpusWithChecks();
    const notices: string[] = [];
    await runValidate({ inputs: [], cwd: dir, onNotice: (m) => notices.push(m) });
    const notice = notices.find((m) => m.includes("authors/self.md"));
    expect(notice).toBeDefined();
    expect(notice).toContain('"authors"');
    expect(notice).toContain("$schema");
  });

  it("query DDL under -s resolves the CLI set once, never per file (0030)", async () => {
    // The -s set goes through the same resolver as every other CLI-ref
    // surface — its cli branch, called exactly once for the run. The pin is
    // "not O(files)": a per-entry walk under -s would defeat the flag's
    // whole point (the walk's disagreement is what -s exists to bypass).
    const dir = mkdtempSync(join(tmpdir(), "docmeta-resolution-walk-"));
    tempDirs.push(dir);
    cpSync(resolve(here, "fixtures", "query-schema-flag"), dir, {
      recursive: true,
    });
    counter.calls = 0;
    const run = await runQuery({
      sql: "ALTER TABLE docs ADD COLUMN reviewed TEXT",
      inputs: ["docs"],
      cwd: dir,
      dryRun: true,
      schemas: ["./schemas/house.json"],
    });
    expect(run.changes?.some((c) => "schema" in c)).toBe(true);
    expect(counter.calls).toBe(1);
  });

  it("a file whose resolution failed is a member of no view, not re-resolved", async () => {
    const dir = corpusWithChecks("schemaTrust:\n  documentRefs: local\n");
    writeFileSync(
      join(dir, "authors", "url.md"),
      "---\n$schema: https://schemas.example.com/x.json\ntitle: URL\nslug: url\n---\nBody.\n",
    );
    const run = await runValidate({ inputs: [], cwd: dir });
    // The refusal is that file's own schema finding...
    const refused = run.results.find((r) => r.file === "authors/url.md");
    expect(refused?.ok).toBe(false);
    expect(refused?.errors[0]?.keyword).toBe("schema");
    // ...the checks still ran over the rest of the corpus...
    const guide = run.results.find((r) => r.file === "docs/guide.md");
    expect(guide?.errors.some((e) => e.schema === "check:dangling-author")).toBe(
      true,
    );
    // ...and nothing resolved the failed file a second time.
    expect(counter.calls).toBe(run.results.length);
  });
});
