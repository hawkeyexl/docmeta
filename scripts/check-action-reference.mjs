/**
 * Drift-check for the GitHub Action reference docs.
 *
 * `action.yml` is a second public surface alongside the CLI, and it had no
 * guard. `docs:check-cli` exists because a hand-maintained flag table drifts
 * from `src/cli.ts` silently; the Action's input table drifts from `action.yml`
 * exactly the same way, and a consumer cannot discover an input that is not
 * documented.
 *
 * This reads `action.yml` and asserts that
 * docs/src/content/docs/reference/action.mdx documents exactly the same inputs
 * and outputs, with the same defaults. Descriptions stay hand-authored; only
 * the machine-checkable surface is guarded.
 *
 * Usage:
 *   node scripts/check-action-reference.mjs [path/to/action.mdx]
 * Exit 0 = in sync, 1 = drift found, 2 = setup error.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH =
  process.argv[2] ??
  path.join(ROOT, "docs/src/content/docs/reference/action.mdx");
const ACTION_PATH = path.join(ROOT, "action.yml");

const fail = (msg) => {
  console.error(`docs:check-action: ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// 1. Canonical surface from action.yml.
// ---------------------------------------------------------------------------
let action;
try {
  action = parseYaml(readFileSync(ACTION_PATH, "utf8"));
} catch (err) {
  console.error(`docs:check-action: could not read action.yml.\n${err.message}`);
  process.exit(2);
}

/** name -> default (string), or null when the input has no default. */
const realInputs = new Map(
  Object.entries(action.inputs ?? {}).map(([name, spec]) => [
    name,
    spec?.default === undefined ? null : String(spec.default),
  ]),
);
const realOutputs = new Set(Object.keys(action.outputs ?? {}));

if (realInputs.size === 0) {
  console.error("docs:check-action: action.yml declares no inputs — refusing.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 2. Documented surface from the reference page.
// ---------------------------------------------------------------------------
let md;
try {
  md = readFileSync(DOC_PATH, "utf8");
} catch {
  fail(
    `${path.relative(ROOT, DOC_PATH)} does not exist. action.yml is a public surface; it needs a reference page.`,
  );
}

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
const isSeparator = (row) => row.every((c) => /^:?-{2,}:?$/.test(c));
/** Strip backticks and the em-dash/hyphen placeholders used for "no default". */
const bare = (s) => s.replace(/`/g, "").trim();

const docInputs = new Map();
const docOutputs = new Set();

let section = null; // "inputs" | "outputs" | null
let header = null;

for (const line of md.split(/\r?\n/)) {
  const h2 = line.match(/^##\s+(.*\S)\s*$/);
  if (h2) {
    const title = h2[1].toLowerCase();
    section = title === "inputs" ? "inputs" : title === "outputs" ? "outputs" : null;
    header = null;
    continue;
  }
  if (!section || !line.trim().startsWith("|")) continue;

  const row = cells(line);
  if (isSeparator(row)) continue;
  if (!header) {
    header = row.map((c) => c.toLowerCase());
    continue;
  }

  const nameCol = header.indexOf(section === "inputs" ? "input" : "output");
  if (nameCol === -1) continue;
  const name = bare(row[nameCol] ?? "");
  if (!name) continue;

  if (section === "outputs") {
    docOutputs.add(name);
    continue;
  }
  const defCol = header.indexOf("default");
  const raw = defCol === -1 ? "" : bare(row[defCol] ?? "");
  // A dash, an em dash, or "none" all spell "this input has no default".
  const noDefault = raw === "" || raw === "-" || raw === "—" || /^none$/i.test(raw);
  docInputs.set(name, noDefault ? null : raw);
}

// ---------------------------------------------------------------------------
// 3. Compare.
// ---------------------------------------------------------------------------
const problems = [];
const sorted = (set) => [...set].sort().join(", ");

const missing = [...realInputs.keys()].filter((n) => !docInputs.has(n));
const extra = [...docInputs.keys()].filter((n) => !realInputs.has(n));
if (missing.length) {
  problems.push(`inputs in action.yml but not documented: ${sorted(new Set(missing))}`);
}
if (extra.length) {
  problems.push(`inputs documented but not in action.yml: ${sorted(new Set(extra))}`);
}

for (const [name, expected] of realInputs) {
  if (!docInputs.has(name)) continue;
  const documented = docInputs.get(name);
  if (documented !== expected) {
    problems.push(
      `input "${name}": action.yml default is ${expected === null ? "none" : `"${expected}"`}, ` +
        `docs say ${documented === null ? "none" : `"${documented}"`}`,
    );
  }
}

const missingOut = [...realOutputs].filter((n) => !docOutputs.has(n));
const extraOut = [...docOutputs].filter((n) => !realOutputs.has(n));
if (missingOut.length) {
  problems.push(`outputs in action.yml but not documented: ${sorted(new Set(missingOut))}`);
}
if (extraOut.length) {
  problems.push(`outputs documented but not in action.yml: ${sorted(new Set(extraOut))}`);
}

if (problems.length) {
  console.error("docs:check-action: action.yml and the reference have drifted.");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `docs:check-action: ${path.relative(ROOT, DOC_PATH).replace(/\\/g, "/")} is in sync with action.yml ✓`,
);
