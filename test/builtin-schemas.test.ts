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
import { loadSchema } from "../src/core/schema-registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const DIATAXIS = "diataxis:diataxis:1.0";
const SEVEN_ACTION = "passo-uno:seven-action:1.0";
const TGDP = "tgdp:templates:1.0";

/** Every template slug published by The Good Docs Project. */
const TGDP_SLUGS = [
  "api-getting-started",
  "api-reference",
  "bug-report",
  "changelog",
  "code-of-conduct",
  "code-of-conduct-incident-record",
  "code-of-conduct-remediation-record",
  "code-of-conduct-response-plan",
  "concept",
  "contact-support",
  "contributing-guide",
  "glossary",
  "how-to",
  "installation-guide",
  "our-team",
  "quickstart",
  "readme",
  "reference",
  "release-notes",
  "sdk-overview",
  "style-guide",
  "terminology-system",
  "troubleshooting",
  "tutorial",
  "user-personas",
];

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

  it("requires `type`, so an untyped document fails", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntitle: No type here\n---\n",
      cliSchemas: [DIATAXIS],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.errors[0]?.schema).toBe(DIATAXIS);
    expect(results[0]?.errors[0]?.message).toContain("type");
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

describe("tgdp:templates:1.0", () => {
  it("accepts a template slug that Diataxis has no word for", async () => {
    expect((await check("tgdp-installation-guide.md", [TGDP])).ok).toBe(true);
  });

  it("rejects a near-miss spelling, naming the schema", async () => {
    const r = await check("tgdp-bad-type.md", [TGDP]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(TGDP);
    expect(r.errors[0]?.instancePath).toBe("/type");
  });

  it("accepts every value in the published vocabulary", async () => {
    for (const type of TGDP_SLUGS) {
      const { results } = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent: `---\ntype: ${type}\n---\n`,
        cliSchemas: [TGDP],
        cwd: root,
      });
      expect(results[0]?.ok, `type: ${type}`).toBe(true);
    }
  });

  it("requires `type`, as Diataxis does", async () => {
    // Both content-type vocabularies demand the key: opting into either is a
    // statement that every page is one of its forms, so a page with no `type`
    // is a gap rather than an abstention.
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntitle: No type here\n---\n",
      cliSchemas: [TGDP],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.errors[0]?.schema).toBe(TGDP);
    expect(results[0]?.errors[0]?.message).toContain("type");
  });

  it("composes with Seven-Action, which keys off a different field", async () => {
    const r = await check("tgdp-troubleshooting-composed.md", [
      TGDP,
      SEVEN_ACTION,
    ]);
    expect(r.ok).toBe(true);
    expect(r.schemas).toEqual([TGDP, SEVEN_ACTION]);
  });

  it("carries exactly the published vocabulary and nothing more", async () => {
    // TGDP_SLUGS is checked value-by-value above, which catches a slug the
    // schema is *missing*. This catches the other direction: a stray or
    // duplicated enum member would otherwise ship unnoticed, since no
    // accept-each loop can fail on a value it never tries.
    const schema = (await loadSchema(TGDP)) as {
      properties: { type: { enum: string[] } };
    };
    const published = schema.properties.type.enum;
    expect([...published].sort()).toEqual([...TGDP_SLUGS].sort());
    expect(new Set(published).size).toBe(published.length);
  });

  it("has values Diataxis rejects, and vice versa", async () => {
    // Both classify what a page *is*, so each vocabulary has a value the
    // other rejects. This is what makes stacking them a narrowing; the next
    // test covers the stacked case itself.
    const explanation = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntype: explanation\n---\n",
      cliSchemas: [TGDP],
      cwd: root,
    });
    expect(explanation.results[0]?.ok).toBe(false);

    const installGuide = await check("tgdp-installation-guide.md", [DIATAXIS]);
    expect(installGuide.ok).toBe(false);
  });

  it("stacks with Diataxis without erroring, admitting only the intersection", async () => {
    // Guards the documented claim that stacking the two `type` schemas is a
    // narrowing, not an operational error: a shared value still passes, and a
    // value unique to one vocabulary is rejected by the other by name.
    const shared = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntype: how-to\n---\n",
      cliSchemas: [DIATAXIS, TGDP],
      cwd: root,
    });
    expect(shared.results[0]?.ok).toBe(true);
    expect(shared.results[0]?.schemas).toEqual([DIATAXIS, TGDP]);

    const tgdpOnly = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntype: concept\n---\n",
      cliSchemas: [DIATAXIS, TGDP],
      cwd: root,
    });
    expect(tgdpOnly.results[0]?.ok).toBe(false);
    expect(tgdpOnly.results[0]?.errors[0]?.schema).toBe(DIATAXIS);
  });
});

describe("Seven-Action does not require its key", () => {
  // It is the only one of the three that checks a value without demanding it;
  // that is what makes it safe to carry in the default set.
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
