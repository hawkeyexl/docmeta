import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { resolveTargets } from "../src/core/load-files.js";
import { DocmetaError } from "../src/types.js";

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
