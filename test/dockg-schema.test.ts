import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runValidate } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, "fixtures", name);

describe("dockg:frontmatter:0.1 built-in", () => {
  it("passes a doc with a well-formed kg key", async () => {
    const run = await runValidate({
      inputs: [fixture("dockg-valid.md")],
      cliSchemas: ["dockg:frontmatter:0.1"],
    });
    expect(run.summary.failed).toBe(0);
    expect(run.summary.passed).toBe(1);
  });

  it("passes a doc without a kg key entirely", async () => {
    const run = await runValidate({
      inputs: [fixture("missing-type.md")],
      cliSchemas: ["dockg:frontmatter:0.1"],
    });
    expect(run.summary.failed).toBe(0);
  });

  it("fails on unknown kg fields and labels without a prefLabel", async () => {
    const run = await runValidate({
      inputs: [fixture("dockg-invalid.md")],
      cliSchemas: ["dockg:frontmatter:0.1"],
    });
    expect(run.summary.failed).toBe(1);
    const messages = run.results[0]!.errors.map((e) => e.message).join("\n");
    expect(messages).toMatch(/additional propert/i);
    expect(messages).toMatch(/prefLabel/);
  });
});
