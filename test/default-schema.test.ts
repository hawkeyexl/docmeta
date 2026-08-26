/**
 * Behavior of the six house vocabularies — the intent-scoped split of the
 * docmeta frontmatter vocabulary proposed in docs/proposals/0023 — plus the
 * default-set behavior docmeta:core:1.0 is intended to join.
 *
 * The drafts are deliberately unregistered while proposal 0023 is under
 * community review, so every case here validates through **file refs** into
 * docs/proposals/0023/schemas — which is exactly what `runValidate` does with
 * a `./x.json` schema entry, so the semantics under test are the shipped
 * pipeline's, not a harness approximation. The one block that genuinely needs
 * registration (default-set membership) is `describe.skip`ped at the bottom;
 * the registration PR swaps the file refs for built-in ids and flips it on.
 *
 * Design rules pinned here rather than in prose:
 *
 * 1. **The composability law.** A key another built-in also claims is claimed
 *    at the loosest published definition among the claimants, so a page valid
 *    for its own generator stays valid stacked with these schemas. The one
 *    deliberate exception is core's floor: every string core claims is
 *    non-empty, and `title`/`description` are single strings, even though
 *    DCMI permits arrays and Docusaurus permits empty values — a default
 *    whose floor accepts "" teaches the habit it exists to prevent.
 *
 * 2. **The house ids are disjoint.** No property name is claimed by two
 *    docmeta house schemas, so a page stacking all six gets every error
 *    attributed to exactly one intent.
 *
 * 3. **Companion namespaces are not claimed.** `evals` (docmeta:evals:1.0),
 *    `kg` (docmeta:kg:1.0) and `metadata` (docmeta:artifact-evals:1.0) are
 *    common vocabularies validated by their own schemas and implemented by
 *    their own tools; claiming them here — even loosely — would put them on
 *    `docmeta fill`'s menu, and each has its own fill loop.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runValidate } from "../src/commands/validate.js";
import { loadSchema } from "../src/core/schema-registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const DRAFTS = "./docs/proposals/0023/schemas";
const CORE = `${DRAFTS}/core/1.0.json`;
const HOUSE = [
  CORE,
  `${DRAFTS}/stewardship/1.0.json`,
  `${DRAFTS}/audience/1.0.json`,
  `${DRAFTS}/lifecycle/1.0.json`,
  `${DRAFTS}/structure/1.0.json`,
  `${DRAFTS}/ai-context/1.0.json`,
];
const SIBLINGS = [
  `${DRAFTS}/evals/1.0.json`,
  `${DRAFTS}/kg/1.0.json`,
  `${DRAFTS}/artifact-evals/1.0.json`,
];

/** The fields each house schema claims, pinned so growth is deliberate. */
const FIELDS: Record<string, string[]> = {
  core: [
    "authors",
    "description",
    "id",
    "keywords",
    "language",
    "title",
    "type",
  ],
  stewardship: [
    "last-reviewed",
    "owner",
    "review-interval",
    "reviewed-by",
    "source-of-truth",
    "stakeholders",
    "verified-against",
  ],
  audience: ["audiences", "intent", "journeys", "personas", "visibility"],
  lifecycle: ["lifecycle", "remove-by", "replaced-by", "supersedes"],
  structure: [
    "applies-to",
    "concepts",
    "next-steps",
    "prerequisites",
    "related-pages",
  ],
  "ai-context": ["generated-by", "provenance", "risks", "sample-questions"],
};

/** The schema's short name, from its draft path. */
const nameOf = (ref: string): string => ref.split("/").at(-2) ?? ref;

/** Validate one fixture against an explicit schema set. */
async function check(fixture: string, cliSchemas: string[] = HOUSE) {
  const { results } = await runValidate({
    inputs: [`test/fixtures/default-schema/${fixture}`],
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

/** Validate inline frontmatter against an explicit schema set. */
async function checkStdin(yaml: string, cliSchemas: string[] = HOUSE) {
  const { results } = await runValidate({
    inputs: ["-"],
    as: "markdown",
    stdinContent: `---\n${yaml}\n---\n`,
    cliSchemas,
    cwd: root,
    noConfig: true,
  });
  const r = results[0];
  if (!r) throw new Error("no result for stdin");
  return r;
}

describe("the six house vocabularies", () => {
  it("accepts a page exercising the whole vocabulary, stacked", async () => {
    const r = await check("full-page.md");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("claims disjoint field sets, pinned per schema", async () => {
    const seen = new Map<string, string>();
    for (const ref of HOUSE) {
      const schema = (await loadSchema(ref)) as {
        properties: Record<string, unknown>;
      };
      expect(Object.keys(schema.properties).sort(), ref).toEqual(
        FIELDS[nameOf(ref)],
      );
      for (const key of Object.keys(schema.properties)) {
        const claimant = seen.get(key) ?? "nobody";
        expect(seen.has(key), `${key} claimed by ${claimant} and ${ref}`).toBe(
          false,
        );
        seen.set(key, ref);
      }
    }
    expect(seen.size).toBe(32);
  });

  it("spells every field in lowercase kebab-case", async () => {
    for (const ref of HOUSE) {
      const schema = (await loadSchema(ref)) as {
        properties: Record<string, unknown>;
      };
      for (const key of Object.keys(schema.properties)) {
        expect(key, ref).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
    }
  });

  it("tolerates unknown keys on every schema", async () => {
    for (const ref of HOUSE) {
      const schema = (await loadSchema(ref)) as {
        additionalProperties?: boolean;
      };
      expect(schema.additionalProperties, ref).toBe(true);
    }
  });

  it("requires title and description on core, and nothing anywhere else", async () => {
    const core = (await loadSchema(CORE)) as { required: string[] };
    expect([...core.required].sort()).toEqual(["description", "title"]);
    for (const ref of HOUSE.slice(1)) {
      const schema = (await loadSchema(ref)) as { required?: string[] };
      expect(schema.required, ref).toBeUndefined();
    }
  });

  it("attributes a missing description to core, and only core", async () => {
    const r = await check("missing-description.md");
    expect(r.ok).toBe(false);
    for (const e of r.errors) expect(e.schema).toBe(CORE);
    expect(r.errors[0]?.message).toContain("description");
  });

  it("rejects a lifecycle outside the four-stage ladder, attributed to lifecycle", async () => {
    const r = await check("bad-lifecycle.md");
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(`${DRAFTS}/lifecycle/1.0.json`);
    expect(r.errors[0]?.instancePath).toBe("/lifecycle");
  });

  it("requires a replacement or a removal date once deprecated", async () => {
    const r = await check("deprecated-without-replacement.md");
    expect(r.ok).toBe(false);
    const messages = r.errors.map((e) => e.message).join(" ");
    expect(messages).toContain("replaced-by");
  });

  it("accepts a deprecation that names only a removal date", async () => {
    const r = await check("deprecated-with-remove-by.md");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects a prose review date, attributed to stewardship", async () => {
    const r = await check("bad-last-reviewed.md");
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(`${DRAFTS}/stewardship/1.0.json`);
    expect(r.errors[0]?.instancePath).toBe("/last-reviewed");
  });

  it("accepts the reduced W3CDTF precisions on review dates", async () => {
    for (const value of ["2026", "2026-08", "2026-08-23", "2026-08-23T09:00:00Z"]) {
      const r = await checkStdin(
        `title: T\ndescription: D\nlast-reviewed: "${value}"`,
      );
      expect(r.ok, `last-reviewed: ${value}`).toBe(true);
    }
  });

  it("rejects impossible dates, which W3CDTF's shape alone would admit", async () => {
    // Field-ranged, not calendar-exact: 2026-13-45 fails here instead of
    // becoming Invalid Date (and a NaN age) in the tooling that derives
    // review deadlines; February 31 remains a reviewer's catch.
    for (const value of ["2026-13-01", "2026-00-10", "2026-01-32", "0000-13-99"]) {
      const r = await checkStdin(
        `title: T\ndescription: D\nlast-reviewed: "${value}"`,
      );
      expect(r.ok, `last-reviewed: ${value}`).toBe(false);
    }
  });

  it("passes a review that is decades overdue, because a schema cannot read a clock", async () => {
    // Pinned as intended behavior: `last-reviewed` + `review-interval` are
    // records, not a freshness gate. Deriving the due date and judging it
    // belongs to tooling that can read a clock — docevals' freshness grader
    // reads this same `last-reviewed` field. There is deliberately no stored
    // due-date field: it would be derivable, and derivable fields lie.
    const r = await check("overdue-review.md");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("requires ISO 8601 durations for review-interval", async () => {
    for (const value of ["P90D", "P1Y6M", "PT30M", "P2W"]) {
      const r = await checkStdin(
        `title: T\ndescription: D\nreview-interval: ${value}`,
      );
      expect(r.ok, `review-interval: ${value}`).toBe(true);
    }
    const bad = await checkStdin(`title: T\ndescription: D\nreview-interval: 90d`);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]?.instancePath).toBe("/review-interval");
  });

  it("enums visibility, and rejects a value outside its ladder", async () => {
    // `visibility` and `lifecycle` are the only enums in the house set — both
    // keys something downstream switches on. Reader expertise fell to the
    // altitude test: level belongs to persona definitions, not pages.
    const bad = await checkStdin("title: T\ndescription: D\nvisibility: secret");
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]?.instancePath).toBe("/visibility");
  });

  it("keeps visibility and lifecycle as separate axes", async () => {
    // `lifecycle: draft` says the content is unfinished; `visibility: draft`
    // says nobody outside the authors can see it. An unfinished page already
    // visible inside the org is legal and real.
    const r = await checkStdin(
      "title: T\ndescription: D\nlifecycle: draft\nvisibility: internal",
    );
    expect(r.ok).toBe(true);
  });

  it("leaves audiences unenumerated, deliberately", async () => {
    const r = await checkStdin(
      "title: T\ndescription: D\naudiences: [sre, felines]",
    );
    expect(r.ok).toBe(true);
  });

  it("recommends risk flags without closing the vocabulary", async () => {
    const known = await checkStdin(
      "title: T\ndescription: D\nrisks: [destructive, open-world, read-only]",
    );
    expect(known.ok).toBe(true);
    const orgSpecific = await checkStdin(
      "title: T\ndescription: D\nrisks: [grail-costs]",
    );
    expect(orgSpecific.ok).toBe(true);
    const notAString = await checkStdin("title: T\ndescription: D\nrisks: [true]");
    expect(notAString.ok).toBe(false);
    // Assert the error lands on the offending item, not which anyOf branch's
    // message Ajv happened to surface — branch selection on total failure is
    // implementation-defined and survives Ajv upgrades; the path does not.
    expect(notAString.errors[0]?.instancePath).toBe("/risks/0");
  });

  it("records machine-proposed metadata in provenance entries", async () => {
    const ok = await checkStdin(
      "title: T\ndescription: D\nprovenance:\n  - generated-by: claude-fable-5\n    fields: [intent]\n    confidence:\n      intent: 0.9",
    );
    expect(ok.ok).toBe(true);
    const anonymous = await checkStdin(
      "title: T\ndescription: D\nprovenance:\n  - fields: [intent]",
    );
    expect(anonymous.ok).toBe(false);
  });

  it("accepts flat applies-to labels and rejects non-label values", async () => {
    const single = await checkStdin("title: T\ndescription: D\napplies-to: kubernetes");
    expect(single.ok).toBe(true);
    const asObject = await checkStdin(
      "title: T\ndescription: D\napplies-to:\n  deployment: kubernetes",
    );
    expect(asObject.ok).toBe(false);
    expect(asObject.errors[0]?.instancePath).toBe("/applies-to");
  });

  it("rejects empty and duplicated lists — a list that says nothing is not a declaration", async () => {
    // minItems + uniqueItems on the one-or-list shape, matching kg's
    // labelList exactly, so the harvest fallback and the deeper twin accept
    // identical values. `owner: []` must not satisfy an ownership gate.
    const emptyOwner = await checkStdin("title: T\ndescription: D\nowner: []");
    expect(emptyOwner.ok).toBe(false);
    const dupLabels = await checkStdin(
      "title: T\ndescription: D\napplies-to: [operator-1.4, operator-1.4]",
    );
    expect(dupLabels.ok).toBe(false);
  });

  it("holds every string core claims non-empty", async () => {
    // The weak-floor exception, extended past the required pair: an empty
    // `type` reaches the kg type derivation and template selection as a falsy
    // key instead of failing loudly here.
    for (const yaml of [
      'title: T\ndescription: D\ntype: ""',
      'title: T\ndescription: D\nid: ""',
      'title: T\ndescription: D\nkeywords: ""',
      'title: T\ndescription: D\nkeywords: ["", "beta"]',
      'title: T\ndescription: D\nauthors: ""',
      "title: T\ndescription: D\nauthors: []",
    ]) {
      const r = await checkStdin(yaml, [CORE]);
      expect(r.ok, yaml).toBe(false);
    }
    const badAuthors = await checkStdin(
      "title: T\ndescription: D\nauthors: [123, true]",
      [CORE],
    );
    expect(badAuthors.ok).toBe(false);
  });

  it("keeps sample-questions one question or a list, like every list field", async () => {
    const single = await checkStdin(
      "title: T\ndescription: D\nsample-questions: How do I install on EKS?",
    );
    expect(single.ok).toBe(true);
    const listed = await checkStdin(
      "title: T\ndescription: D\nsample-questions:\n  - How do I install on EKS?",
    );
    expect(listed.ok).toBe(true);
    const bad = await checkStdin("title: T\ndescription: D\nsample-questions: []");
    expect(bad.ok).toBe(false);
  });

  it("leaves the companion namespaces alone, and they validate under their own drafts", async () => {
    // `evals`, `kg` and `metadata.evals` are unclaimed by the house schemas;
    // stacked with the companion drafts themselves, the fixture's blocks are
    // checked by their owners — proving the fixture speaks the current
    // shapes, not the superseded 0.1/0.2/0.8 ones.
    const houseOnly = await check("companion-namespaces.md");
    expect(houseOnly.errors).toEqual([]);
    const stacked = await check("companion-namespaces.md", [...HOUSE, ...SIBLINGS]);
    expect(stacked.errors).toEqual([]);
    expect(stacked.ok).toBe(true);
  });

  it("does not claim the companion namespaces even loosely", async () => {
    for (const ref of HOUSE) {
      const schema = (await loadSchema(ref)) as {
        properties: Record<string, unknown>;
      };
      for (const reserved of ["evals", "kg", "metadata"]) {
        expect(schema.properties, `${ref} claims ${reserved}`).not.toHaveProperty(
          reserved,
        );
      }
    }
  });
});

describe("the composability law on claimed keys", () => {
  it("holds the required core to single non-empty strings, by design", async () => {
    const empty = await checkStdin('title: ""\ndescription: ""', [CORE]);
    expect(empty.ok).toBe(false);
    const arrays = await checkStdin("title: [A, B]\ndescription: [C, D]", [CORE]);
    expect(arrays.ok).toBe(false);
  });

  it("attributes the empty-title failure to core when stacked with a platform", async () => {
    // The documented cost of the exception: a page Docusaurus itself accepts
    // fails the stack, and the error names the core schema — which is
    // correct, because it is this schema's floor doing the rejecting.
    const r = await checkStdin('title: ""\ndescription: D', [
      CORE,
      "docusaurus:docs:3.10",
    ]);
    expect(r.ok).toBe(false);
    for (const e of r.errors) expect(e.schema).toBe(CORE);
  });

  it("keeps single-valued keys plain strings", async () => {
    const r = await checkStdin(
      "title: T\ndescription: D\ntype: [how-to, reference]",
      [CORE],
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/type");
  });

  it("tolerates Antora's comma-string keywords", async () => {
    const r = await checkStdin('title: T\ndescription: D\nkeywords: "alpha, beta"', [
      CORE,
    ]);
    expect(r.ok).toBe(true);
  });

  it("tolerates MyST person objects in authors", async () => {
    const r = await checkStdin(
      "title: T\ndescription: D\nauthors:\n  - name: Jane Doe\n    orcid: 0000-0002-1825-0097",
      [CORE, "myst:frontmatter:1.10"],
    );
    expect(r.ok).toBe(true);
  });

  it("stacks cleanly under a platform schema", async () => {
    const r = await checkStdin(
      "title: T\ndescription: D\nowner: docs-team\nsidebar:\n  order: 3",
      [...HOUSE, "astro:starlight:0.41"],
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

/**
 * Default-set membership is the one thing file refs cannot test: it needs
 * `docmeta:core:1.0` registered and appended to `DEFAULT_SCHEMAS`. Skipped
 * until the registration PR that follows the 0023 review; that PR flips this
 * to `describe` and replaces the draft paths above with built-in ids. The
 * expectations inside are written against that future state on purpose.
 */
describe.skip("the default set (flips on registration)", () => {
  const CORE_ID = "docmeta:core:1.0";

  it("appends only core after the two existing members", async () => {
    const { DEFAULT_SCHEMAS } = await import("../src/core/resolve-schema.js");
    expect(DEFAULT_SCHEMAS).toEqual([
      "google:okf:0.1",
      "passo-uno:seven-action:1.0",
      CORE_ID,
    ]);
  });

  it("passes a fully-annotated page on a bare run", async () => {
    const r = await check("full-page.md", []);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fails a bare run on a page without a description, naming core", async () => {
    const r = await check("missing-description.md", []);
    expect(r.ok).toBe(false);
    const fromCore = r.errors.filter((e) => e.schema === CORE_ID);
    expect(fromCore.some((e) => e.message.includes("description"))).toBe(true);
  });

  it("leaves the companion namespaces alone on a bare run", async () => {
    const r = await check("companion-namespaces.md", []);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
