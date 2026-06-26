/**
 * Drift-check for the CLI reference docs.
 *
 * Introspects the real commander program (`buildProgram()` from the built CLI)
 * and asserts that docs/src/content/docs/reference/cli.mdx documents exactly the
 * same commands, arguments, options, and value-defaults. Descriptions stay
 * hand-authored; this only guards the machine-checkable surface so the page
 * cannot silently drift from src/cli.ts.
 *
 * Usage:
 *   node scripts/check-cli-reference.mjs [path/to/cli.mdx]
 * Requires `npm run build` first (imports dist/cli.js).
 * Exit 0 = in sync, 1 = drift found, 2 = setup error.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH =
  process.argv[2] ?? path.join(ROOT, "docs/src/content/docs/reference/cli.mdx");

let buildProgram;
try {
  ({ buildProgram } = await import(
    pathToFileURL(path.join(ROOT, "dist/cli.js")).href
  ));
} catch (err) {
  console.error(
    `docs:check-cli: could not import dist/cli.js — run \`npm run build\` first.\n${err.message}`,
  );
  process.exit(2);
}

// Help and version are commander built-ins documented once under Global options.
const GLOBAL_ONLY = new Set(["help", "version"]);
const stripDashes = (long) => long.replace(/^--/, "");

// ---------------------------------------------------------------------------
// 1. Canonical surface from the commander program.
// ---------------------------------------------------------------------------
const program = buildProgram();

function optionLongs(cmd) {
  return cmd.options
    .filter((o) => o.long)
    .map((o) => stripDashes(o.long));
}

const codeGlobalOptions = new Set([
  ...optionLongs(program),
  "version", // registered via .version()
  "help", // commander auto-adds -h, --help
]);

const codeCommands = new Map(); // name -> { options:Set, args:[{name,required,variadic}], defaults:Map }
for (const cmd of program.commands) {
  const options = new Set(
    optionLongs(cmd).filter((l) => !GLOBAL_ONLY.has(l)),
  );
  const args = cmd.registeredArguments.map((a) => ({
    name: a.name(),
    required: a.required,
    variadic: a.variadic,
  }));
  // Only primitive, non-empty defaults are machine-comparable to the docs.
  const defaults = new Map();
  for (const o of cmd.options) {
    if (!o.long) continue;
    const d = o.defaultValue;
    if (typeof d === "string" || typeof d === "number") {
      defaults.set(stripDashes(o.long), String(d));
    }
  }
  codeCommands.set(cmd.name(), { options, args, defaults });
}

// ---------------------------------------------------------------------------
// 2. What the docs page documents (parsed from markdown tables).
// ---------------------------------------------------------------------------
const md = readFileSync(DOC_PATH, "utf8");
const lines = md.split(/\r?\n/);

const docGlobalOptions = new Set();
const docCommands = new Map(); // name -> { options:Set, args:Set<name>, defaults:Map }

let section = null; // 'global' | { command } | null
let header = null; // current table header cells, lowercased

function cellList(line) {
  // Split on unescaped pipes only — table cells may contain `\|` (e.g. a
  // `<pretty\|json>` value column), which must not be treated as a separator.
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
}
const isSeparatorRow = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c));
const longsIn = (text) =>
  [...text.matchAll(/--[a-z][a-z-]*/g)].map((m) => stripDashes(m[0]));
const argNameIn = (text) => {
  const m = text.match(/[`[<]+\s*([a-zA-Z][\w-]*)/);
  return m ? m[1] : null;
};

for (const line of lines) {
  const h2 = line.match(/^##\s+(.*\S)\s*$/);
  if (h2) {
    const title = h2[1];
    const cmd = title.match(/^`([a-z][a-z-]*)`$/);
    if (cmd) {
      section = { command: cmd[1] };
      docCommands.set(cmd[1], {
        options: new Set(),
        args: new Set(),
        defaults: new Map(),
      });
    } else if (/^global options$/i.test(title)) {
      section = "global";
    } else {
      section = null; // narrative section — ignore for parity
    }
    header = null;
    continue;
  }
  if (!section) continue;
  if (!/^\s*\|.*\|\s*$/.test(line)) {
    if (line.trim() === "") header = null;
    continue;
  }
  const cells = cellList(line);
  if (isSeparatorRow(cells)) continue;
  const lower = cells.map((c) => c.toLowerCase());
  if (lower.includes("option") || lower.includes("argument")) {
    header = lower;
    continue;
  }
  if (!header) continue;

  const optCol = header.indexOf("option");
  const argCol = header.indexOf("argument");
  const defCol = header.indexOf("default");

  if (section === "global") {
    if (optCol >= 0 && cells[optCol]) {
      for (const l of longsIn(cells[optCol])) docGlobalOptions.add(l);
    }
    continue;
  }

  const bucket = docCommands.get(section.command);
  if (!bucket) continue;
  // An "Options" table has Option + (Argument value column) + Default columns.
  // An "Arguments" table has a single Argument column and no Default column.
  const isOptionsTable = optCol >= 0;
  if (isOptionsTable) {
    const longs = longsIn(cells[optCol] ?? "");
    for (const l of longs) bucket.options.add(l);
    if (defCol >= 0 && longs.length === 1) {
      const raw = (cells[defCol] ?? "").replace(/`/g, "").trim();
      if (raw && !/^[—-]$/.test(raw)) {
        bucket.defaults.set(longs[0], raw.toLowerCase());
      }
    }
  } else if (argCol >= 0) {
    const name = argNameIn(cells[argCol] ?? "");
    if (name) bucket.args.add(name);
  }
}

// ---------------------------------------------------------------------------
// 3. Compare.
// ---------------------------------------------------------------------------
const problems = [];
const diff = (label, codeSet, docSet) => {
  for (const x of codeSet)
    if (!docSet.has(x)) problems.push(`${label}: \`${x}\` in code but not documented`);
  for (const x of docSet)
    if (!codeSet.has(x)) problems.push(`${label}: \`${x}\` documented but not in code`);
};

// Commands.
diff(
  "commands",
  new Set(codeCommands.keys()),
  new Set(docCommands.keys()),
);

// Global options.
diff("global options", codeGlobalOptions, docGlobalOptions);

// Per-command options, args, and value-defaults.
for (const [name, code] of codeCommands) {
  const doc = docCommands.get(name);
  if (!doc) continue; // already reported as a missing command
  diff(`${name} options`, code.options, doc.options);
  diff(
    `${name} arguments`,
    new Set(code.args.map((a) => a.name)),
    doc.args,
  );
  for (const [opt, codeDefault] of code.defaults) {
    if (!doc.options.has(opt)) continue;
    const docDefault = doc.defaults.get(opt);
    if (docDefault == null) {
      problems.push(
        `${name} options: \`${opt}\` default is \`${codeDefault}\` in code but no default documented`,
      );
    } else if (docDefault !== codeDefault.toLowerCase()) {
      problems.push(
        `${name} options: \`${opt}\` default mismatch (docs: \`${docDefault}\`, code: \`${codeDefault}\`)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Report.
// ---------------------------------------------------------------------------
const rel = path.relative(ROOT, DOC_PATH).replace(/\\/g, "/");
if (problems.length === 0) {
  console.log(`docs:check-cli: ${rel} is in sync with src/cli.ts ✓`);
  process.exit(0);
}
console.error(`docs:check-cli: ${rel} is out of sync with src/cli.ts:`);
for (const p of problems.sort()) console.error(`  - ${p}`);
console.error(
  `\nUpdate the page (flags/args/defaults are the source of truth) and re-run \`npm run docs:check-cli\`.`,
);
process.exit(1);
