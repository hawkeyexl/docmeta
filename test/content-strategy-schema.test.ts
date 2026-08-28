/**
 * Behavior of the three content-strategy vocabularies — the audience,
 * persona, and journey *definition documents* proposed in
 * docs/proposals/0031, modelled on the public strategy corpus in
 * Promptless/promptless.ai (`docs/content_strategy/`).
 *
 * These are **document-type** vocabularies, which is what makes them
 * different from the nine facet vocabularies of 0023: a facet id says a page
 * *has* an audience, a document-type id says a document *is* one. So they
 * require the facts without which the document is not that kind of document
 * at all, which also makes them mutually exclusive with each other and
 * impossible to default onto a corpus.
 *
 * Crucially they do **not** claim `type`. Which document is which is settled
 * by the `overrides:` glob that wired the schema, not by a key inside the
 * file; `type` is the registry's most contested key — required and enumerated
 * by diataxis, required by okf, claimed by core, repeatable under DCMI — so
 * a constant there would have bought a misfiling check at the price of
 * stackability with all three. `compat-check.cjs` proves that trade rather
 * than asserting it.
 *
 * The drafts are unregistered while 0031 is under review, so every case here
 * validates through **file refs** into docs/proposals/0031/schemas — exactly
 * what `runValidate` does with a `./x.json` schema entry, so the semantics
 * under test are the shipped pipeline's.
 *
 * Design rules pinned here rather than in prose:
 *
 * 1. **Reuse, don't re-claim.** A definition document says who it serves with
 *    `personas`/`journeys`/`audiences` (docmeta:audience:1.0.0-proposal.1),
 *    names itself with `title`/`description` (docmeta:core), and records its
 *    own upkeep with `owner`/`last-reviewed` (docmeta:stewardship). The trio
 *    claims only what none of those claim.
 *
 * 2. **`id` is narrowed, never redefined.** It is the one exception to rule
 *    1, and it tightens core in the only direction that keeps stacking sound:
 *    required, at the same non-empty floor. Anything valid for a definition
 *    schema is therefore still valid for core.
 *
 * 3. **The trio may share keys with each other.** Each is wired to its own
 *    directory, so no document is ever judged by two of them; a coverage
 *    report reading `evidence` across the strategy corpus wants one key, not
 *    three.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runValidate } from "../src/commands/validate.js";
import { loadSchema } from "../src/core/schema-registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const DRAFTS = "./docs/proposals/0031/schemas";
/** Spelled once, so the next revision is a one-line bump. See 0023. */
const V = "1.0.0-proposal.1";
const AUDIENCE = `${DRAFTS}/audience-profile/${V}.json`;
const PERSONA = `${DRAFTS}/persona/${V}.json`;
const JOURNEY = `${DRAFTS}/journey/${V}.json`;
const TRIO = [AUDIENCE, PERSONA, JOURNEY];

/** The 0023 family the trio composes on, referenced the same way. */
const FAMILY = "./docs/proposals/0023/schemas";
const CORE = `${FAMILY}/core/${V}.json`;
const FACET = `${FAMILY}/audience/${V}.json`;
const STEWARDSHIP = `${FAMILY}/stewardship/${V}.json`;
const LIFECYCLE = `${FAMILY}/lifecycle/${V}.json`;
const STRUCTURE = `${FAMILY}/structure/${V}.json`;
const AI_CONTEXT = `${FAMILY}/ai-context/${V}.json`;
const HOUSE = [CORE, STEWARDSHIP, FACET, LIFECYCLE, STRUCTURE, AI_CONTEXT];

/** The fields each definition schema claims, pinned so growth is deliberate. */
const FIELDS: Record<string, string[]> = {
  "audience-profile": [
    "evidence",
    "evidence-strength",
    "id",
    "needs",
    "traits",
  ],
  persona: [
    "evidence",
    "evidence-strength",
    "expertise",
    "goals",
    "id",
    "needs",
    "pains",
    "role",
  ],
  journey: [
    "entry-point",
    "evidence",
    "evidence-strength",
    "id",
    "steps",
    "success-criteria",
    "trigger",
  ],
};

/** The only key a definition schema may share with a facet schema. */
const NARROWED = ["id"];

/** The schema's short name, from its draft path. */
const nameOf = (ref: string): string => ref.split("/").at(-2) ?? ref;

async function props(ref: string): Promise<string[]> {
  const schema = (await loadSchema(ref)) as {
    properties: Record<string, unknown>;
  };
  return Object.keys(schema.properties).sort();
}

/** Validate one fixture against an explicit schema set. */
async function check(fixture: string, cliSchemas: string[]) {
  const { results } = await runValidate({
    inputs: [`test/fixtures/content-strategy/${fixture}`],
    cliSchemas,
    cwd: root,
    // The repo config's overrides cannot match these fixtures, but the tests
    // should not be coupled to that ambient file at all.
    noConfig: true,
  });
  const r = results[0];
  if (!r) throw new Error(`no result for ${fixture}`);
  return r;
}

describe("the three content-strategy vocabularies", () => {
  it("accepts an audience definition stacked with the 0023 family", async () => {
    const r = await check("audience.md", [...HOUSE, AUDIENCE]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("accepts a persona definition stacked with the 0023 family", async () => {
    const r = await check("persona.md", [...HOUSE, PERSONA]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("accepts a journey definition stacked with the 0023 family", async () => {
    const r = await check("journey.md", [...HOUSE, JOURNEY]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("claims the pinned field sets, and nothing else", async () => {
    for (const ref of TRIO) {
      expect(await props(ref), ref).toEqual(FIELDS[nameOf(ref)]);
    }
  });

  it("re-claims nothing from the 0023 family except the one it narrows", async () => {
    const facetKeys = new Set<string>();
    for (const ref of HOUSE) for (const k of await props(ref)) facetKeys.add(k);
    for (const ref of TRIO) {
      const shared = (await props(ref)).filter((k) => facetKeys.has(k));
      expect(shared, ref).toEqual(NARROWED);
    }
  });

  it("spells every field in lowercase kebab-case", async () => {
    for (const ref of TRIO) {
      for (const key of await props(ref)) {
        expect(key, ref).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
    }
  });

  it("tolerates unknown keys, so a repo keeps its own strategy fields", async () => {
    for (const ref of TRIO) {
      const schema = (await loadSchema(ref)) as {
        additionalProperties?: boolean;
      };
      expect(schema.additionalProperties, ref).toBe(true);
    }
  });

  it("requires the facts without which the document is not that kind of document", async () => {
    const required: Record<string, string[]> = {
      "audience-profile": ["id"],
      persona: ["id", "role"],
      journey: ["id", "steps", "success-criteria", "trigger"],
    };
    for (const ref of TRIO) {
      const schema = (await loadSchema(ref)) as { required: string[] };
      expect([...schema.required].sort(), ref).toEqual(required[nameOf(ref)]);
    }
  });

  it("claims no type, so `type` stays the stacked schemas' to constrain", async () => {
    for (const ref of TRIO) {
      const schema = (await loadSchema(ref)) as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(Object.keys(schema.properties), ref).not.toContain("type");
      expect(schema.required ?? [], ref).not.toContain("type");
    }
  });

  it("stacks with Diataxis, which requires and enumerates type", async () => {
    // The stack a `const type` would have made impossible. Diataxis is the
    // strictest `type` claimant in the registry (required, four-value enum),
    // so if a strategy document survives it, it survives okf and DCMI too —
    // `compat-check.cjs` pins all three.
    const r = await check("persona-with-diataxis-type.md", [
      ...HOUSE,
      PERSONA,
      "diataxis:diataxis:1.0",
    ]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("placement: override-only, never the default set", () => {
  /**
   * Unlike the nine facet ids of 0023, these three can never join
   * `DEFAULT_SCHEMAS` — not as a review decision but by construction. Each
   * requires facts no ordinary page carries (`id` everywhere, plus `role`, or
   * `trigger`/`success-criteria`/`steps`), so defaulting one would fail every
   * page in every repo that is not that kind of strategy document. It is the
   * same rule `DEFAULT_SCHEMAS` already records for Diataxis, which is absent
   * because "it both requires and constrains `type`" — the requiring half is
   * enough on its own.
   *
   * These assertions are the guard rail, not a placeholder: they are meant to
   * keep passing after the registration PR, which adds the ids to `BUILTINS`
   * and leaves the default set alone.
   */
  it("keeps the default set to what it already was", async () => {
    const { DEFAULT_SCHEMAS } = await import("../src/core/resolve-schema.js");
    expect(DEFAULT_SCHEMAS).toEqual(["google:okf:0.1", "passo-uno:seven-action:1.0"]);
  });

  it("names no document-type id in the default set", async () => {
    const { DEFAULT_SCHEMAS } = await import("../src/core/resolve-schema.js");
    for (const ref of TRIO) {
      const { $id } = (await loadSchema(ref)) as { $id: string };
      const bare = $id.split(":").slice(0, 2).join(":");
      expect(
        DEFAULT_SCHEMAS.some((d) => d.startsWith(`${bare}:`)),
        `${bare} must stay override-only`,
      ).toBe(false);
    }
  });

  it("is unregistered while the proposal is under review", async () => {
    const { listBuiltins } = await import("../src/core/schema-registry.js");
    const ids = new Set(listBuiltins().map((b) => b.id));
    for (const ref of TRIO) {
      const { $id } = (await loadSchema(ref)) as { $id: string };
      expect(ids.has($id), $id).toBe(false);
    }
  });
});

describe("what the definition schemas reject", () => {
  it("still catches most misfilings, through required fields rather than a type constant", async () => {
    // Dropping `const type` gave up naming the misfiling; it did not give up
    // catching it. A journey filed into `personas/` carries no `role`, and a
    // persona filed into `journeys/` carries no `trigger`, `success-criteria`
    // or `steps`. What is genuinely lost is the audience direction: an
    // audience schema requires only `id`, so a persona filed into
    // `audiences/` now validates. That cost is recorded in proposal 0031 and
    // pinned here so it is a known hole rather than a surprise.
    const asPersona = await check("journey.md", [...HOUSE, PERSONA]);
    expect(asPersona.ok).toBe(false);
    expect(
      asPersona.errors.some(
        (e) => e.schema === PERSONA && e.subject === "role",
      ),
    ).toBe(true);

    const asJourney = await check("persona.md", [...HOUSE, JOURNEY]);
    expect(asJourney.ok).toBe(false);
    expect(
      asJourney.errors
        .filter((e) => e.schema === JOURNEY)
        .map((e) => e.subject)
        .sort(),
    ).toEqual(["steps", "success-criteria", "trigger"]);

    const asAudience = await check("persona.md", [...HOUSE, AUDIENCE]);
    expect(asAudience.ok, "the known hole: id alone cannot discriminate").toBe(
      true,
    );
  });

  it("rejects a journey with no steps, attributed to the journey schema", async () => {
    const r = await check("journey-missing-steps.md", [...HOUSE, JOURNEY]);
    expect(r.ok).toBe(false);
    for (const e of r.errors) expect(e.schema).toBe(JOURNEY);
    expect(r.errors[0]?.keyword).toBe("required");
    expect(r.errors[0]?.subject).toBe("steps");
  });

  it("rejects a step coverage value outside the ladder", async () => {
    const r = await check("journey-bad-coverage.md", [...HOUSE, JOURNEY]);
    expect(r.ok).toBe(false);
    for (const e of r.errors) expect(e.schema).toBe(JOURNEY);
    // The path reaches into the step, so a long journey names which one.
    expect(
      r.errors.some(
        (e) => e.instancePath === "/steps/0/coverage" && e.keyword === "enum",
      ),
    ).toBe(true);
  });

  it("rejects an empty goals list, which otherwise reads as goals recorded", async () => {
    const r = await check("persona-empty-goals.md", [...HOUSE, PERSONA]);
    expect(r.ok).toBe(false);
    for (const e of r.errors) expect(e.schema).toBe(PERSONA);
    expect(
      r.errors.some(
        (e) => e.instancePath === "/goals" && e.keyword === "minItems",
      ),
    ).toBe(true);
  });

  it("rejects a persona with no role, because a persona without one is a label", async () => {
    const r = await check("persona-no-role.md", [...HOUSE, PERSONA]);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.schema === PERSONA && e.subject === "role"),
    ).toBe(true);
  });

  it("rejects a cross-reference step that names no document", async () => {
    // The family's conditional idiom, applied one level down: a value that
    // defers to something else must say what. Same shape as
    // `deprecated` requiring `replaced-by` in docmeta:lifecycle.
    const r = await check("journey-dangling-crossref.md", [...HOUSE, JOURNEY]);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some(
        (e) =>
          e.schema === JOURNEY &&
          e.instancePath === "/steps/1" &&
          e.keyword === "required" &&
          e.subject === "doc",
      ),
    ).toBe(true);
  });

  it("rejects a misspelled step key, because the step object is closed", async () => {
    const r = await check("journey-step-typo.md", [...HOUSE, JOURNEY]);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some(
        (e) =>
          e.schema === JOURNEY &&
          e.instancePath === "/steps/1" &&
          e.subject === "covergae",
      ),
    ).toBe(true);
  });

  it("rejects a blank id, which cannot anchor a cross-reference", async () => {
    // core claims `id` too, at the same non-empty floor, so a blank one is a
    // finding twice over. That is the narrowing working as designed: the
    // definition schema never disagrees with core, it only says more.
    const r = await check("audience-blank-id.md", [...HOUSE, AUDIENCE]);
    expect(r.ok).toBe(false);
    const blank = r.errors.filter(
      (e) => e.instancePath === "/id" && e.keyword === "minLength",
    );
    expect(blank.map((e) => e.schema).sort()).toEqual([AUDIENCE, CORE].sort());
  });
});
