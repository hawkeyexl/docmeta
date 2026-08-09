/**
 * Behavior of the built-in taxonomy schemas, exercised through the real
 * validate path (extraction -> resolution -> validation) rather than against
 * the JSON objects directly, so a typo'd enum member fails here.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runValidate } from "../src/commands/validate.js";
import { DEFAULT_SCHEMAS } from "../src/core/resolve-schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const DIATAXIS = "diataxis:diataxis:1.0";
const SEVEN_ACTION = "passo-uno:seven-action:1.0";

/** Validate one fixture against an explicit schema set. */
async function check(fixture: string, cliSchemas: string[]) {
  const { results } = await runValidate({
    inputs: [`test/fixtures/taxonomy/${fixture}`],
    cliSchemas,
    cwd: root,
  });
  const r = results[0];
  if (!r) throw new Error(`no result for ${fixture}`);
  return r;
}

describe("diataxis:diataxis:1.0", () => {
  it("accepts a canonical type", async () => {
    expect((await check("diataxis-how-to.md", [DIATAXIS])).ok).toBe(true);
  });

  it("rejects a near-miss spelling, naming the schema", async () => {
    const r = await check("diataxis-bad-type.md", [DIATAXIS]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(DIATAXIS);
    expect(r.errors[0]?.instancePath).toBe("/type");
  });

  it("accepts every value in the published vocabulary", async () => {
    // Guards against a typo in the enum: each of the four must pass on its own.
    for (const type of ["tutorial", "how-to", "reference", "explanation"]) {
      const { results } = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent: `---\ntype: ${type}\n---\n`,
        cliSchemas: [DIATAXIS],
        cwd: root,
      });
      expect(results[0]?.ok, `type: ${type}`).toBe(true);
    }
  });
});

describe("passo-uno:seven-action:1.0", () => {
  it("accepts a canonical action", async () => {
    expect((await check("seven-action-practice.md", [SEVEN_ACTION])).ok).toBe(
      true,
    );
  });

  it("rejects an alt verb, naming the schema", async () => {
    const r = await check("seven-action-bad-action.md", [SEVEN_ACTION]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(SEVEN_ACTION);
    expect(r.errors[0]?.instancePath).toBe("/action");
  });

  it("accepts every value in the published vocabulary", async () => {
    for (const action of [
      "appraise",
      "understand",
      "explore",
      "practice",
      "remember",
      "develop",
      "troubleshoot",
    ]) {
      const { results } = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent: `---\naction: ${action}\n---\n`,
        cliSchemas: [SEVEN_ACTION],
        cwd: root,
      });
      expect(results[0]?.ok, `action: ${action}`).toBe(true);
    }
  });
});

describe("neither schema requires its key", () => {
  it("passes a document with no type at all", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntitle: No type here\n---\n",
      cliSchemas: [DIATAXIS],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
  });

  it("passes a document with no action at all", async () => {
    expect((await check("diataxis-how-to.md", [SEVEN_ACTION])).ok).toBe(true);
  });
});

describe("composing the two", () => {
  it("passes a document carrying both keys", async () => {
    const r = await check("composed-how-to-practice.md", [
      DIATAXIS,
      SEVEN_ACTION,
    ]);
    expect(r.ok).toBe(true);
    expect(r.schemas).toEqual([DIATAXIS, SEVEN_ACTION]);
  });

  it("keeps each schema's own errors when stacked with OKF", async () => {
    // Passes Diataxis on `type`, fails OKF on `timestamp` format: the error
    // must be attributed to OKF, not to the taxonomy schema.
    const r = await check("diataxis-okf-composed.md", [
      "google:okf:0.1",
      DIATAXIS,
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.schema).toBe("google:okf:0.1");
    expect(r.errors[0]?.instancePath).toBe("/timestamp");
  });
});

describe("the default schema set", () => {
  it("is OKF plus Seven-Action", () => {
    expect([...DEFAULT_SCHEMAS]).toEqual(["google:okf:0.1", SEVEN_ACTION]);
  });

  it("still passes an existing document that carries no action", async () => {
    // The regression guard for the non-breaking claim: valid.md predates this
    // change and has `type: concept` and no `action`.
    const { results } = await runValidate({
      inputs: ["test/fixtures/valid.md"],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.schemas).toEqual(["google:okf:0.1", SEVEN_ACTION]);
  });

  it("fails an out-of-vocabulary action with no flags at all", async () => {
    const { results } = await runValidate({
      inputs: ["test/fixtures/taxonomy/seven-action-bad-action.md"],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.errors[0]?.schema).toBe(SEVEN_ACTION);
  });
});
