/**
 * Guard for `scripts/check-table-rows.mjs`.
 *
 * The bug it exists for: a GFM table row has to occupy one source line. A
 * prose reflow in #154 wrapped fifteen rows onto a second line, and every gate
 * the repo runs stayed green — `docs:check-links` resolved all 4,348 links and
 * the Astro build emitted all 50 pages, because the output is valid HTML. The
 * only symptom was cells rendering cut off mid-sentence.
 *
 * Driven as a subprocess rather than imported: the exit code and the
 * `file:line` list are the contract, since this runs as a CI step.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const script = join(repoRoot, "scripts", "check-table-rows.mjs");
const fixtures = join(repoRoot, "test", "fixtures", "table-rows");

interface Run {
  stdout: string;
  stderr: string;
  status: number;
}

function run(...targets: string[]): Run {
  try {
    const stdout = execFileSync("node", [script, ...targets], {
      encoding: "utf8",
      cwd: repoRoot,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", status: err.status ?? 1 };
  }
}

describe("check-table-rows", () => {
  it("reports a row that runs onto a second line, by file and line", () => {
    const { stderr, status } = run(join(fixtures, "split-row.md"));
    expect(status).toBe(1);
    expect(stderr).toContain("test/fixtures/table-rows/split-row.md:10");
  });

  it("reports a second broken row directly beneath the first", () => {
    // Two of the fifteen rows in #154 were consecutive. The naive rule — look
    // at the previous line — loses table context on the first break and misses
    // the second.
    const { stderr, status } = run(join(fixtures, "consecutive-split-rows.md"));
    expect(status).toBe(1);
    const lines = stderr.split("\n").filter((l) => l.trim().startsWith("- "));
    expect(lines).toHaveLength(2);
  });

  it("does not report a wrapped paragraph whose second line starts with a pipe", () => {
    // `docs/proposals/0005-command-parity.md` had exactly this: an inline code
    // span containing a pipe, wrapped so the continuation began with `|`. It
    // is prose, not a table, so the table-context test must exclude it.
    const { stdout, status } = run(join(fixtures, "pipe-in-prose.md"));
    expect(status).toBe(0);
    expect(stdout).toContain("on one source line");
  });

  it("ignores split rows inside fenced code, which are sample text", () => {
    const { stdout, status } = run(join(fixtures, "split-row-in-fence.md"));
    expect(status).toBe(0);
    expect(stdout).toContain("on one source line");
  });

  it("passes over the repository's own tracked prose", () => {
    // The corpus this gates. It is green today, and this is what keeps it so.
    const { stdout, status } = run();
    expect(status).toBe(0);
    expect(stdout).toContain("on one source line");
  });
});
