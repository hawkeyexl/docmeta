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

/** `via` names the copy of the script to invoke, for the symlink case. */
function run(root: string, via: string = script): Run {
  try {
    execFileSync("node", [via, root], { encoding: "utf8", cwd: repoRoot });
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
