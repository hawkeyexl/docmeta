import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { resolveTargets } from "../src/core/load-files.js";

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
