import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveTargetSet, resolveTargets } from "../src/core/load-files.js";
import { DocmetaError } from "../src/types.js";
import { DOC, makeTempRepo, removeTempRepo } from "./helpers/temp-repo.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = `${here}/fixtures`;

describe("resolveTargets", () => {
  it("includes an explicit file as given", async () => {
    const files = await resolveTargets({
      inputs: ["test/fixtures/valid.md"],
      cwd: `${here}/..`,
    });
    expect(files).toContain("test/fixtures/valid.md");
  });

  it("walks a directory for supported extensions only", async () => {
    const files = await resolveTargets({ inputs: ["."], cwd: fixtures });
    expect(files).toContain("valid.md");
    expect(files).toContain("sample.mdx");
    expect(files).toContain("valid.rst");
    expect(files).toContain("topic.dita");
    // extra.schema.json is .json — not a supported document extension
    expect(files.some((f) => f.endsWith(".json"))).toBe(false);
  });

  it("expands a glob", async () => {
    const files = await resolveTargets({ inputs: ["*.md"], cwd: fixtures });
    expect(files).toContain("valid.md");
    expect(files).not.toContain("sample.mdx");
  });

  it("applies exclude globs", async () => {
    const files = await resolveTargets({
      inputs: ["*.md"],
      exclude: ["missing-*.md"],
      cwd: fixtures,
    });
    expect(files).not.toContain("missing-type.md");
    expect(files).toContain("valid.md");
  });

  it("de-duplicates and sorts", async () => {
    const files = await resolveTargets({
      inputs: ["*.md", "valid.md"],
      cwd: fixtures,
    });
    const validCount = files.filter((f) => f === "valid.md").length;
    expect(validCount).toBe(1);
    expect([...files]).toEqual([...files].sort());
  });

  it("ignores the stdin token", async () => {
    const files = await resolveTargets({ inputs: ["-"], cwd: fixtures });
    expect(files).toEqual([]);
  });
});

describe("resolveTargets: a named file that does not exist is an error", () => {
  it("reports a literal input that does not exist", async () => {
    await expect(
      resolveTargets({ inputs: ["no-such-file.md"], cwd: fixtures }),
    ).rejects.toThrow(DocmetaError);
    await expect(
      resolveTargets({ inputs: ["no-such-file.md"], cwd: fixtures }),
    ).rejects.toThrow(/File not found: "no-such-file\.md"/);
  });

  it("errors even when another input did match", async () => {
    await expect(
      resolveTargets({ inputs: ["valid.md", "no-such-file.md"], cwd: fixtures }),
    ).rejects.toThrow(/no-such-file\.md/);
  });

  it("does not error for a glob that matches nothing", async () => {
    // A pattern matching nothing is the caller's business (see the zero-files
    // check in the command cores); only a *named* file is reported here.
    const files = await resolveTargets({ inputs: ["*.nomatch"], cwd: fixtures });
    expect(files).toEqual([]);
  });

  it("treats a backslash path as a literal name, not a pattern", async () => {
    // picomatch.scan() consumes backslashes as escapes, so `nested\doc.md`
    // would scan as the literal `nesteddoc.md` and be misclassified unless the
    // input is normalized to posix first.
    const files = await resolveTargets({
      inputs: ["nested\\doc.md"],
      cwd: fixtures,
    });
    expect(files).toEqual(["nested/doc.md"]);
  });

  it("reports a missing backslash path under its posix name", async () => {
    await expect(
      resolveTargets({ inputs: ["nested\\nope.md"], cwd: fixtures }),
    ).rejects.toThrow(/nested\/nope\.md/);
  });

  it("allowEmpty suppresses the missing-file error", async () => {
    const files = await resolveTargets({
      inputs: ["valid.md", "no-such-file.md"],
      cwd: fixtures,
      allowEmpty: true,
    });
    expect(files).toEqual(["valid.md"]);
  });

  it("still accepts a directory that exists", async () => {
    const files = await resolveTargets({ inputs: ["nested"], cwd: fixtures });
    expect(files).toContain("nested/doc.md");
  });

  it("ignores the stdin token when checking for missing files", async () => {
    const files = await resolveTargets({ inputs: ["-"], cwd: fixtures });
    expect(files).toEqual([]);
  });
});

/**
 * `.gitignore`-aware discovery.
 *
 * Every repo here is built at runtime by `makeTempRepo` — see that helper for
 * why a gitignored fixture cannot live in `test/fixtures/`.
 */
describe("resolveTargets: .gitignore-aware discovery", () => {
  let repo: string | undefined;

  // Cleanup runs whether the test passed or threw, so a failing assertion
  // never leaves a temp repo behind.
  afterEach(() => {
    removeTempRepo(repo);
    repo = undefined;
  });

  /** A repo with `build/` ignored and one document on each side of the line. */
  const buildIgnored = (init = true): string =>
    makeTempRepo({
      init,
      files: {
        ".gitignore": "build/\n",
        "build/x.md": DOC,
        "docs/x.md": DOC,
      },
    });

  it("drops a gitignored file from a glob expansion", async () => {
    repo = buildIgnored();
    const files = await resolveTargets({ inputs: ["**/*.md"], cwd: repo });
    expect(files).toEqual(["docs/x.md"]);
  });

  it("drops a gitignored file from a directory walk", async () => {
    repo = buildIgnored();
    const files = await resolveTargets({ inputs: ["."], cwd: repo });
    expect(files).toEqual(["docs/x.md"]);
  });

  /**
   * The control for the two above: the *filter* has to be what excludes
   * `build/x.md`. Remove the `git init` and the same tree must keep both files
   * — otherwise those tests would still pass on a machine with no git, where
   * the filter silently does nothing.
   */
  it("keeps everything in the same tree when there is no repository", async () => {
    repo = buildIgnored(false);
    const files = await resolveTargets({ inputs: ["**/*.md"], cwd: repo });
    expect(files).toEqual(["build/x.md", "docs/x.md"]);
  });

  it("never filters an explicitly named file", async () => {
    repo = buildIgnored();
    const files = await resolveTargets({
      inputs: ["build/x.md", "docs/x.md"],
      cwd: repo,
    });
    expect(files).toEqual(["build/x.md", "docs/x.md"]);
  });

  it("keeps an explicitly named file that a glob in the same run also matched", async () => {
    repo = buildIgnored();
    const files = await resolveTargets({
      inputs: ["**/*.md", "build/x.md"],
      cwd: repo,
    });
    expect(files).toEqual(["build/x.md", "docs/x.md"]);
  });

  it("respectGitignore: false keeps ignored files", async () => {
    repo = buildIgnored();
    const files = await resolveTargets({
      inputs: ["**/*.md"],
      cwd: repo,
      respectGitignore: false,
    });
    expect(files).toEqual(["build/x.md", "docs/x.md"]);
  });

  /**
   * git's own semantics, asserted rather than reimplemented: `!keep.md` does
   * not rescue a file inside an excluded directory. This is the case that
   * killed the hand-rolled picomatch translation.
   */
  it("honors a nested .gitignore, and does not re-include below an excluded directory", async () => {
    repo = makeTempRepo({
      files: {
        ".gitignore": "build/\n",
        "docs/.gitignore": "tmp/\n!keep.md\n",
        "docs/real.md": DOC,
        "docs/tmp/x.md": DOC,
        "docs/tmp/keep.md": DOC,
        "build/x.md": DOC,
      },
    });
    const files = await resolveTargets({ inputs: ["**/*.md"], cwd: repo });
    expect(files).toEqual(["docs/real.md"]);
  });

  /**
   * `git check-ignore` exits 1 when nothing matched. That is a successful
   * answer meaning "keep everything", and reading it as a failure would make
   * the filter no-op in the common clean case.
   */
  it("keeps every file when nothing is ignored (check-ignore exits 1)", async () => {
    repo = makeTempRepo({
      files: {
        ".gitignore": "never-matches-anything/\n",
        "a.md": DOC,
        "docs/b.md": DOC,
      },
    });
    // The file list alone cannot tell the two readings of exit 1 apart —
    // "keep everything" and "git failed, so filter nothing" produce the same
    // answer here. The notice is what distinguishes them: git answered, so
    // nothing may be reported as unavailable.
    let told = 0;
    const files = await resolveTargets({
      inputs: ["**/*.md"],
      cwd: repo,
      onGitignoreUnavailable: () => {
        told += 1;
      },
    });
    expect(files).toEqual(["a.md", "docs/b.md"]);
    expect(told).toBe(0);
  });

  it("keeps every file when git is not on PATH", async () => {
    repo = buildIgnored();
    const realPath = process.env.PATH;
    try {
      // Point PATH at a directory that exists but holds no executables, so the
      // spawn fails the way a minimal CI container would.
      process.env.PATH = join(repo, "docs");
      const files = await resolveTargets({ inputs: ["**/*.md"], cwd: repo });
      expect(files).toEqual(["build/x.md", "docs/x.md"]);
    } finally {
      process.env.PATH = realPath;
    }
  });

  it("reports that git could not answer, when a caller asked to be told", async () => {
    repo = buildIgnored();
    const realPath = process.env.PATH;
    let told = 0;
    try {
      process.env.PATH = join(repo, "docs");
      await resolveTargets({
        inputs: ["**/*.md"],
        cwd: repo,
        onGitignoreUnavailable: () => {
          told += 1;
        },
      });
    } finally {
      process.env.PATH = realPath;
    }
    expect(told).toBe(1);
  });

  it("stays silent when git answered normally", async () => {
    repo = buildIgnored();
    let told = 0;
    await resolveTargets({
      inputs: ["**/*.md"],
      cwd: repo,
      onGitignoreUnavailable: () => {
        told += 1;
      },
    });
    expect(told).toBe(0);
  });

  it("filters a run started from a subdirectory of the git root", async () => {
    repo = makeTempRepo({
      files: {
        ".gitignore": "build/\n",
        "docs/real.md": DOC,
        "docs/build/x.md": DOC,
      },
    });
    const files = await resolveTargets({
      inputs: ["**/*.md"],
      cwd: join(repo, "docs"),
    });
    expect(files).toEqual(["real.md"]);
  });
});

/**
 * The skipped count, which is what makes a quieter gate auditable rather than
 * silent. It answers "how many candidate documents did .gitignore remove",
 * so it counts only files that survived the extension filter.
 */
describe("resolveTargetSet: what .gitignore removed", () => {
  let repo: string | undefined;

  afterEach(() => {
    removeTempRepo(repo);
    repo = undefined;
  });

  it("counts the documents it dropped", async () => {
    repo = makeTempRepo({
      files: {
        ".gitignore": "build/\n",
        "build/a.md": DOC,
        "build/b.md": DOC,
        "docs/c.md": DOC,
      },
    });
    const resolved = await resolveTargetSet({ inputs: ["**/*.md"], cwd: repo });
    expect(resolved.files).toEqual(["docs/c.md"]);
    expect(resolved.gitignoreSkipped).toBe(2);
  });

  it("counts only extension-eligible files, not everything git ignores", async () => {
    repo = makeTempRepo({
      files: {
        ".gitignore": "build/\n",
        "build/a.md": DOC,
        "build/bundle.js": "//\n",
        "build/styles.css": "a{}\n",
        "docs/c.md": DOC,
      },
    });
    const resolved = await resolveTargetSet({ inputs: ["**/*"], cwd: repo });
    expect(resolved.files).toEqual(["docs/c.md"]);
    expect(resolved.gitignoreSkipped).toBe(1);
  });

  it("does not count a dropped file twice when two inputs both matched it", async () => {
    repo = makeTempRepo({
      files: { ".gitignore": "build/\n", "build/a.md": DOC, "docs/c.md": DOC },
    });
    const resolved = await resolveTargetSet({
      inputs: ["**/*.md", "build/*.md"],
      cwd: repo,
    });
    expect(resolved.gitignoreSkipped).toBe(1);
  });

  it("does not count an explicitly named file that git ignores", async () => {
    repo = makeTempRepo({
      files: { ".gitignore": "build/\n", "build/a.md": DOC, "docs/c.md": DOC },
    });
    const resolved = await resolveTargetSet({
      inputs: ["**/*.md", "build/a.md"],
      cwd: repo,
    });
    expect(resolved.files).toEqual(["build/a.md", "docs/c.md"]);
    expect(resolved.gitignoreSkipped).toBe(0);
  });

  it("counts nothing when there is no repository to ask", async () => {
    repo = makeTempRepo({
      init: false,
      files: { ".gitignore": "build/\n", "build/a.md": DOC, "docs/c.md": DOC },
    });
    const resolved = await resolveTargetSet({ inputs: ["**/*.md"], cwd: repo });
    expect(resolved.files).toEqual(["build/a.md", "docs/c.md"]);
    expect(resolved.gitignoreSkipped).toBe(0);
  });
});
