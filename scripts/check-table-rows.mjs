/**
 * Source check for GFM table rows split across lines.
 *
 * A table row has to occupy one source line. A following line that does not
 * start with `|` ends the table and begins a paragraph, so the cell it was
 * meant to continue renders cut off mid-sentence. In #154 a prose reflow broke
 * fifteen rows this way across nine files, and the Action reference shipped a
 * cell reading "docmeta's exit code. `0` clean, `1` validation failures, `2`"
 * and stopping there.
 *
 * Nothing caught it. `docs:check-links` passed with 4,348 links resolving and
 * the Astro build emitted all 50 pages, because the output is valid HTML whose
 * links all work. It is only wrong. That is the gap this closes: unlike the
 * drift checks next to it, which compare a page against a source of truth,
 * this one reads the Markdown source, because the defect is invisible by the
 * time the site is built.
 *
 * The rule is deliberately narrow. A line starting with `|` and not ending
 * with one is only a finding when the previous non-blank line is itself a full
 * `|...|` row, a delimiter row included. Without that table-context test, a
 * wrapped prose paragraph whose second line happens to begin with `|` reads as
 * a broken row; `docs/proposals/0005-command-parity.md` had exactly that case,
 * from an inline code span containing a pipe.
 *
 * Usage:
 *   node scripts/check-table-rows.mjs [path...]
 * With no arguments it scans the tracked `*.md` and `*.mdx` corpus, minus
 * `test/fixtures/**` (deliberately malformed test data) and `CHANGELOG.md`
 * (semantic-release writes it). Explicit paths are scanned as given, so a test
 * can point it at a fixture.
 * Exit 0 = every row is on one line, 1 = split rows found, 2 = setup error.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

const EXCLUDED = (p) => p.startsWith("test/fixtures/") || p === "CHANGELOG.md";

/** Every tracked Markdown file this repo authors. */
function trackedCorpus() {
  let out;
  try {
    out = execFileSync("git", ["ls-files", "*.md", "*.mdx"], {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch (err) {
    console.error(
      `docs:check-tables: could not list tracked files with git.\n${err.message}`,
    );
    process.exit(2);
  }
  return out.split("\n").filter((p) => p && !EXCLUDED(p));
}

/** Markdown under an explicit path, which may be a file or a directory. */
function walk(target) {
  const abs = path.resolve(ROOT, target);
  if (!existsSync(abs)) {
    console.error(`docs:check-tables: no such path: ${target}`);
    process.exit(2);
  }
  if (!statSync(abs).isDirectory()) return [rel(abs)];
  const found = [];
  const skip = new Set(["node_modules", "dist", ".git"]);
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) visit(child);
      } else if (/\.mdx?$/.test(entry.name)) found.push(rel(child));
    }
  };
  visit(abs);
  return found;
}

const isFence = (s) => s.startsWith("```") || s.startsWith("~~~");

/**
 * Line numbers (1-based) in `text` where a table row runs onto the next line.
 */
export function splitRows(text) {
  const lines = text.split("\n");
  const hits = [];
  let inFence = false;
  let start = 0;

  // Frontmatter: a leading `---` block is YAML, not Markdown.
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end !== -1) start = end + 1;
  }

  // `inTable` is the context test: only a line following a real row can be a
  // broken row. `runOn` carries that context across the continuation lines of
  // a row already found broken, so a second broken row directly beneath a
  // first is still seen — two of the fifteen in #154 were exactly that.
  let inTable = false;
  let runOn = false;

  for (let i = start; i < lines.length; i++) {
    const s = (lines[i] ?? "").trim();

    if (isFence(s)) {
      inFence = !inFence;
      inTable = runOn = false;
      continue;
    }
    if (inFence) continue;

    if (!s) {
      inTable = runOn = false;
      continue;
    }
    if (runOn) {
      // Swallow the wrapped remainder; the row closes at the trailing pipe.
      if (s.endsWith("|")) {
        runOn = false;
        inTable = true;
      }
      continue;
    }
    if (s.startsWith("|")) {
      if (s.endsWith("|")) inTable = true;
      else if (inTable) {
        hits.push(i + 1);
        runOn = true;
      } else inTable = false;
      continue;
    }
    inTable = false;
  }
  return hits;
}

const targets = process.argv.slice(2);
const files = targets.length
  ? targets.flatMap(walk)
  : trackedCorpus();

const problems = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(path.resolve(ROOT, file), "utf8");
  } catch (err) {
    console.error(`docs:check-tables: could not read ${file}.\n${err.message}`);
    process.exit(2);
  }
  for (const line of splitRows(text)) problems.push(`${file}:${line}`);
}

if (problems.length) {
  console.error(
    `docs:check-tables: ${problems.length} table row(s) run onto a second source line.\n` +
      "A row must be one line; the next line without a leading `|` ends the table,\n" +
      "so the cell renders cut off. Join each row back onto one line:",
  );
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `docs:check-tables: every table row in ${files.length} file(s) is on one source line ✓`,
);
