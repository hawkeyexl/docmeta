import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runValidate } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, "fixtures", name);

describe("docevals:frontmatter:0.1 built-in", () => {
  it("passes the object form: suite, references with overrides, inline llm and command evals", async () => {
    const run = await runValidate({
      inputs: [fixture("docevals-valid-object.md")],
      cliSchemas: ["docevals:frontmatter:0.1"],
    });
    expect(run.summary.failed).toBe(0);
    expect(run.summary.passed).toBe(1);
  });

  it("passes the array shorthand, including a command eval with assertion only", async () => {
    const run = await runValidate({
      inputs: [fixture("docevals-valid-array.md")],
      cliSchemas: ["docevals:frontmatter:0.1"],
    });
    expect(run.summary.failed).toBe(0);
    expect(run.summary.passed).toBe(1);
  });

  it("passes a doc without an evals key entirely", async () => {
    const run = await runValidate({
      inputs: [fixture("docevals-no-evals.md")],
      cliSchemas: ["docevals:frontmatter:0.1"],
    });
    expect(run.summary.failed).toBe(0);
  });

  it("fails on bad names, llm evals without assertions, and unknown fields", async () => {
    const run = await runValidate({
      inputs: [fixture("docevals-invalid.md")],
      cliSchemas: ["docevals:frontmatter:0.1"],
    });
    expect(run.summary.failed).toBe(1);
    const result = run.results[0];
    expect(result).toBeDefined();
    // Each broken entry must be rejected: the entry violating the name
    // pattern, the llm eval missing its assertion (the if/then branch), and
    // the entry carrying an unknown field. Ajv reports oneOf-branch failures
    // per entry, so assert per-entry error pointers rather than message text.
    const paths = (result?.errors ?? []).map((e) => e.instancePath).join("\n");
    expect(paths).toContain("/evals/evals/0");
    expect(paths).toContain("/evals/evals/1");
    expect(paths).toContain("/evals/evals/2");
  });
});
