/**
 * Guard for `scripts/check-deps.mjs`.
 *
 * The bug it exists for: this repo keeps git worktrees at
 * `.claude/worktrees/<name>/`, *inside* the main checkout. A worktree whose
 * dependencies were never installed does not fail — Node's resolution walks up
 * and silently finds the outer checkout's `node_modules`, which belongs to
 * whatever branch happens to be checked out there. Typecheck and tests then run
 * against another branch's dependency tree and report failures that look like
 * real code bugs.
 *
 * Driven as a subprocess rather than an import: the exit code and the stderr
 * text are the contract, since this runs as a `pre*` hook.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const script = join(repoRoot, "scripts", "check-deps.mjs");

interface Run {
  stderr: string;
  status: number;
}

/**
 * `via` names the copy of the script to invoke, for the symlink case. `env`
 * replaces the whole environment, so a test can control what npm reports about
 * itself — or say that npm is not in the picture at all.
 */
function run(root: string, via: string = script, env?: NodeJS.ProcessEnv): Run {
  try {
    execFileSync("node", [via, root], {
      encoding: "utf8",
      cwd: repoRoot,
      env: env ?? process.env,
    });
    return { stderr: "", status: 0 };
  } catch (e) {
    const err = e as { stderr?: string; status?: number };
    return { stderr: err.stderr ?? "", status: err.status ?? 1 };
  }
}

let outer: string;
let proj: string;

beforeEach(async () => {
  // `proj` sits inside `outer`, mirroring `.claude/worktrees/<name>/` inside
  // the main checkout — that nesting is what makes the walk possible.
  outer = await mkdtemp(join(tmpdir(), "docmeta-deps-"));
  proj = join(outer, "proj");
  await mkdir(proj, { recursive: true });
  await writeFile(
    join(proj, "package-lock.json"),
    JSON.stringify({
      name: "fake",
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: { "@scope/dep-a": "^0.2.0" },
          devDependencies: { "dep-b": "^1.0.0" },
        },
        "node_modules/@scope/dep-a": { version: "0.2.0" },
        "node_modules/dep-b": { version: "1.0.0" },
      },
    }),
    "utf8",
  );
});

afterEach(async () => {
  await rm(outer, { recursive: true, force: true });
});

/** Write a fake installed package into `<dir>/node_modules/<name>`. */
async function install(
  dir: string,
  name: string,
  version: string,
): Promise<void> {
  const target = join(dir, "node_modules", name);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "package.json"),
    JSON.stringify({ name, version }),
    "utf8",
  );
}

describe("check-deps", () => {
  it("passes when every dependency is installed locally at the locked version", async () => {
    await install(proj, "@scope/dep-a", "0.2.0");
    await install(proj, "dep-b", "1.0.0");
    expect(run(proj).status).toBe(0);
  });

  it("fails when a dependency resolves from a parent checkout instead", async () => {
    // The exact shape of the worktree bug: nothing installed here, a different
    // version installed above. Silently usable, and wrong.
    await install(outer, "@scope/dep-a", "0.0.1");
    await install(outer, "dep-b", "1.0.0");

    const r = run(proj);
    expect(r.status).toBe(1);
    // Naming the outside path is the point — "missing dependency" alone sends
    // you looking in the wrong checkout.
    expect(r.stderr).toContain("@scope/dep-a");
    expect(r.stderr).toContain(join(outer, "node_modules"));
    expect(r.stderr).toMatch(/npm ci/);
  });

  it("fails on a locally installed dependency at the wrong version", async () => {
    await install(proj, "@scope/dep-a", "0.0.1");
    await install(proj, "dep-b", "1.0.0");

    const r = run(proj);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("@scope/dep-a");
    expect(r.stderr).toContain("0.0.1");
    expect(r.stderr).toContain("0.2.0");
  });

  it("fails when a dependency is absent everywhere", async () => {
    await install(proj, "dep-b", "1.0.0");
    const r = run(proj);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("@scope/dep-a");
  });

  it("keeps the report short when nothing at all is installed", async () => {
    // A bare checkout puts every direct dependency in the list. Thirty
    // identical lines bury the one instruction that resolves them.
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`dep-${i}`, "^1.0.0"]),
    );
    await writeFile(
      join(proj, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: many },
          ...Object.fromEntries(
            Object.keys(many).map((n) => [`node_modules/${n}`, { version: "1.0.0" }]),
          ),
        },
      }),
      "utf8",
    );

    const r = run(proj);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("...and 15 more");
    expect(r.stderr).toMatch(/npm ci/);
  });

  it("still runs when reached through a symlinked checkout", async () => {
    // Node resolves symlinks for the entry module but not for argv[1], so a
    // main-module check that compares the two raw paths is false through a
    // symlink and the whole run block is skipped — the guard exits 0 having
    // checked nothing. Failing open is the worst possible mode for a guard,
    // and CLAUDE.md now tells the reader a passing check:deps means something.
    const link = join(outer, "linked-repo");
    try {
      // "junction" is the Windows form that needs no elevation; ignored on
      // POSIX, where a plain directory symlink is used.
      await symlink(repoRoot, link, "junction");
    } catch (e) {
      // Only "this machine will not let me make links" is a reason to skip.
      // A bare catch here would swallow a genuine bug in the setup above and
      // report a green test that never ran.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS") return;
      throw e;
    }

    await install(proj, "dep-b", "1.0.0"); // @scope/dep-a deliberately absent
    const r = run(proj, join(link, "scripts", "check-deps.mjs"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("@scope/dep-a");
  });

  it("exits 2 when there is no lockfile to check against", async () => {
    const bare = join(outer, "bare");
    await mkdir(bare, { recursive: true });
    expect(run(bare).status).toBe(2);
  });

  it("passes on this checkout, which is what the pre* hooks rely on", () => {
    expect(run(repoRoot).status).toBe(0);
  });
});

/**
 * The second thing this guard asserts: that the npm running it is new enough to
 * write a complete `package-lock.json`.
 *
 * npm 11.6.2 and below drop the top-level entries for the peer dependencies of
 * an optional package — here `@emnapi/core` and `@emnapi/runtime`, reached through
 * `@rolldown/binding-wasm32-wasi` — while keeping the edges that point at them.
 * The result installs fine and `npm ci` rejects it, so the first sign of trouble
 * is every CI job failing at once with `Missing: @emnapi/core@<ver> from lock
 * file`. Nothing about that message points at npm's version, which is why the
 * check is here rather than left to be rediscovered.
 */

/**
 * This process's environment with npm's user-agent set to `userAgent`, or
 * removed when it is null.
 *
 * Every case-variant of the name has to be stripped first. Windows environment
 * variables are case-insensitive, but a spread of `process.env` inside a vitest
 * worker carries `NPM_CONFIG_USER_AGENT` and `npm_config_user_agent` as two
 * separate keys — so overriding only the lower-case one leaves the real value
 * behind under the other spelling, and the child reads the npm that launched
 * the test run instead of the one the test is describing. Every assertion below
 * then passes while testing nothing, which is the one way a guard's tests must
 * not fail.
 */
function withUserAgent(userAgent: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => k.toLowerCase() !== "npm_config_user_agent",
    ),
  );
  if (userAgent !== null) env.npm_config_user_agent = userAgent;
  return env;
}

/** The environment npm exports to a lifecycle script, for a given npm version. */
function underNpm(version: string): NodeJS.ProcessEnv {
  return withUserAgent(`npm/${version} node/v24.11.0 win32 x64 workspaces/false`);
}

describe("check-deps: npm version floor", () => {
  beforeEach(async () => {
    // Both dependencies present, so the only thing left that can fail is npm.
    await install(proj, "@scope/dep-a", "0.2.0");
    await install(proj, "dep-b", "1.0.0");
  });

  it("fails on an npm old enough to write an incomplete lockfile", () => {
    const r = run(proj, script, underNpm("11.6.2"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("11.6.2"); // what you have
    expect(r.stderr).toContain("11.6.3"); // what you need
    expect(r.stderr).toMatch(/npm install -g npm/); // how to get there
  });

  it("passes at exactly the floor", () => {
    expect(run(proj, script, underNpm("11.6.3")).status).toBe(0);
  });

  it("passes on the rest of the 11.6 line above the floor", () => {
    // The floor is a patch release, not a minor. Rounding it up to 11.7.0 —
    // the first version this was confirmed good on — would have rejected an
    // npm that writes a perfectly complete lockfile, and blocked the whole
    // `pre*` chain for someone whose environment was fine.
    expect(run(proj, script, underNpm("11.6.4")).status).toBe(0);
  });

  it("passes above the floor, including across a major", () => {
    expect(run(proj, script, underNpm("11.19.0")).status).toBe(0);
    expect(run(proj, script, underNpm("12.0.2")).status).toBe(0);
  });

  it("says nothing when npm is not the thing running it", () => {
    // Invoked by hand, or by another package manager. There is no npm version
    // to judge, and inventing a failure for one is worse than staying quiet.
    expect(run(proj, script, withUserAgent(null)).status).toBe(0);
  });

  it("ignores a user agent that is not npm's", () => {
    const env = withUserAgent("pnpm/10.4.1 node/v24.11.0");
    expect(run(proj, script, env).status).toBe(0);
  });
});
