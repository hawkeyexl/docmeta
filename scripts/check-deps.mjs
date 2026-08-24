/**
 * Assert that this checkout's dependencies are installed *in this checkout*,
 * at the versions package-lock.json pins.
 *
 * Why this exists: the repo keeps git worktrees at `.claude/worktrees/<name>/`,
 * nested inside the main checkout. A worktree whose dependencies were never
 * installed does not fail loudly — Node's resolution walks up the directory
 * chain and silently finds the outer checkout's `node_modules`, which belongs
 * to whatever branch is checked out there. `tsc` and `vitest` then run against
 * another branch's dependency tree, and the resulting type errors and test
 * failures read as real code bugs. That cost a full debugging detour once
 * already, so the walk is now named rather than diagnosed.
 *
 * Only direct dependencies are checked. They are the ones npm always places at
 * `<root>/node_modules/<name>`, so a miss is unambiguous — no guessing about
 * hoisting, and no false alarm from an optional transitive package npm
 * legitimately skipped on this platform.
 *
 * It also asserts that the npm running it is new enough to write a complete
 * lockfile — see MIN_NPM below. Both are questions about the environment rather
 * than the code, and both produce failures that read as code bugs when left
 * unnamed, which is why they share a guard.
 *
 * Usage:
 *   node scripts/check-deps.mjs [path/to/root]
 * Exit 0 = dependencies are sound, 1 = problems found, 2 = setup error.
 */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The oldest npm that writes a complete `package-lock.json` for this tree.
 *
 * At 11.6.2 and below, npm drops the top-level entries for the peer
 * dependencies of an optional package — here `@emnapi/core` and
 * `@emnapi/runtime`, reached through `@rolldown/binding-wasm32-wasi` — while
 * keeping the dependency edges that point at them. The lockfile still installs,
 * so nothing looks wrong locally; `npm ci` rejects it, so on the next push
 * every CI job fails at once with `Missing: @emnapi/core@<ver> from lock file`.
 * Nothing in that message names npm's version, and the fault is not
 * platform-specific — 11.6.2 does it on Linux, macOS and Windows alike — so it
 * is very hard to reach from the symptom.
 *
 * The floor is exact rather than rounded up to the next minor: 11.6.3 and
 * 11.6.4 both write a complete lockfile, and rejecting them would block a
 * contributor whose npm is fine.
 */
export const MIN_NPM = "11.6.3";

/** Compare two `major.minor.patch` strings; negative when `a` is the older. */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The too-old npm behind `userAgent`, or null if there is nothing to report.
 *
 * `npm_config_user_agent` is set by npm for every lifecycle script, and this
 * runs as a `pre*` hook, so reading it costs nothing — an `npm --version`
 * subprocess would cost more than the rest of this script put together. When it
 * is absent or belongs to another package manager there is no npm version to
 * judge, and inventing a failure for one would fail a run that is fine.
 */
export function checkNpm(userAgent) {
  const version = /^npm\/(\d+\.\d+\.\d+)/.exec(userAgent ?? "")?.[1];
  if (!version) return null;
  return compareVersions(version, MIN_NPM) < 0
    ? { actual: version, expected: MIN_NPM }
    : null;
}

/** Read a package.json, or null if it is absent or unreadable. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * First `<dir>/node_modules/<name>` that exists, walking up from `from` —
 * i.e. exactly what Node's resolution would find. Returns null if the walk
 * reaches the filesystem root without a hit.
 */
function findUp(from, name) {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (readJson(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function checkDeps(root) {
  const lock = readJson(path.join(root, "package-lock.json"));
  if (!lock?.packages) return { ok: false, setupError: true, problems: [] };

  const declared = {
    ...(lock.packages[""]?.dependencies ?? {}),
    ...(lock.packages[""]?.devDependencies ?? {}),
  };

  const problems = [];
  for (const name of Object.keys(declared)) {
    const expected = lock.packages[`node_modules/${name}`]?.version;
    if (!expected) continue; // not pinned at the top level; nothing to assert

    const local = path.join(root, "node_modules", name);
    const installed = readJson(path.join(local, "package.json"));

    if (installed) {
      if (installed.version !== expected) {
        problems.push({
          kind: "mismatch",
          name,
          expected,
          actual: installed.version,
        });
      }
      continue;
    }

    // Absent here — so where would Node actually find it? Start the walk above
    // `root`, since `root/node_modules` is the case just ruled out.
    const outside = findUp(path.dirname(root), name);
    problems.push(
      outside
        ? {
            kind: "external",
            name,
            expected,
            actual: readJson(path.join(outside, "package.json"))?.version,
            at: outside,
          }
        : { kind: "missing", name, expected },
    );
  }

  return { ok: problems.length === 0, setupError: false, problems };
}

function formatProblem(p) {
  switch (p.kind) {
    case "external":
      return `  ${p.name}: not installed here — Node resolves it from ${p.at} (version ${p.actual ?? "unknown"}, lockfile wants ${p.expected})`;
    case "mismatch":
      return `  ${p.name}: installed ${p.actual}, lockfile wants ${p.expected}`;
    default:
      return `  ${p.name}: not installed anywhere (lockfile wants ${p.expected})`;
  }
}

/**
 * Both sides through realpath before comparing. Node resolves symlinks for the
 * entry module but leaves `argv[1]` as given, so comparing them raw is false
 * whenever the checkout is reached through a symlink (macOS `/tmp`, a Docker
 * bind mount, a Windows junction) — and this guard would then skip its own body
 * and exit 0 having checked nothing. Failing open is the one outcome a guard
 * must never have.
 */
const realOf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

// Run only when invoked directly, so the export stays importable.
if (
  process.argv[1] &&
  realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))
) {
  // First: an npm that cannot write a correct lockfile makes every other
  // answer here provisional, and it is the cheaper question to settle.
  const npm = checkNpm(process.env.npm_config_user_agent);
  if (npm) {
    console.error(
      `check-deps: npm ${npm.actual} writes an incomplete package-lock.json — this repo needs npm >= ${npm.expected}.

At 11.6.2 and below, npm drops the top-level entries for the peer dependencies
of an optional package (@emnapi/core and @emnapi/runtime, reached through
@rolldown/binding-wasm32-wasi) while keeping the edges that point at them. The
lockfile still installs here, and \`npm ci\` rejects it — so the first sign is
every CI job failing at once with \`Missing: @emnapi/core@<ver> from lock file\`.

Run \`npm install -g npm@latest\`. If package-lock.json was already written by
this npm, rewrite it afterwards with \`npm install --package-lock-only\`.`,
    );
    process.exit(1);
  }

  const root = path.resolve(process.argv[2] ?? SELF);
  const { ok, setupError, problems } = checkDeps(root);

  if (setupError) {
    console.error(
      `check-deps: no readable package-lock.json in ${root} — cannot verify dependencies.`,
    );
    process.exit(2);
  }
  if (!ok) {
    const walked = problems.some((p) => p.kind === "external");
    // A checkout with nothing installed puts every direct dependency in this
    // list, and thirty identical lines bury the advice underneath them. The
    // first few carry the diagnosis; the count carries the scale.
    const SHOWN = 5;
    const listed = problems.slice(0, SHOWN).map(formatProblem).join("\n");
    const rest = problems.length - SHOWN;
    console.error(
      `check-deps: dependencies in ${root} do not match package-lock.json.\n` +
        listed +
        (rest > 0 ? `\n  ...and ${rest} more` : "") +
        (walked
          ? `\n\nNode resolved at least one dependency from a directory above this one.` +
            `\nThat is usually a git worktree whose dependencies were never installed:` +
            `\nit silently borrows the outer checkout's node_modules, which may be on a` +
            `\ndifferent branch with different versions.`
          : "") +
        `\n\nRun \`npm ci\` in ${root}.`,
    );
    process.exit(1);
  }
}
