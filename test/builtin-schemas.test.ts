/**
 * Behavior of the built-in taxonomy schemas, exercised through the real
 * validate path (extraction -> resolution -> validation) rather than against
 * the JSON objects directly, so a typo'd enum member fails here.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join, resolve } from "node:path";
import { runValidate } from "../src/commands/validate.js";
import { DEFAULT_SCHEMAS } from "../src/core/resolve-schema.js";
import {
  loadSchema,
  publishedBuiltins,
  PUBLISHED_BASE,
} from "../src/core/schema-registry.js";

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

  it("rejects an untyped document once per schema when stacked with Diataxis", async () => {
    // Both now require the key, so an untyped document is not merely outside
    // the intersection — each schema faults it on its own, and the report
    // names both rather than attributing the gap to one arbitrarily.
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: "---\ntitle: No type here\n---\n",
      cliSchemas: [DIATAXIS, TGDP],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.errors.map((e) => e.schema).sort()).toEqual(
      [DIATAXIS, TGDP].sort(),
    );
    for (const err of results[0]?.errors ?? []) {
      expect(err.message).toContain("type");
    }
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

// ---------------------------------------------------------------------------
// 0009 — publishing the built-ins is a promise, so it needs enforcement
// ---------------------------------------------------------------------------

/** `<dir>/<version>.json` for every built-in, posix, relative to src/schemas. */
function sourceFiles(): string[] {
  const base = join(root, "src", "schemas");
  const out: string[] = [];
  for (const dir of readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(base, dir.name))) {
      if (file.endsWith(".json")) out.push(`${dir.name}/${file}`);
    }
  }
  return out.sort();
}

const sha256 = (bytes: Buffer): string =>
  `sha256-${createHash("sha256").update(bytes).digest("hex")}`;

describe("0009 · the immutability manifest", () => {
  const manifestPath = join(root, "src", "schemas", "manifest.json");

  it("records a hash for every built-in file", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version: number;
      schemas: Record<string, string>;
    };
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.schemas).sort()).toEqual(sourceFiles());
  });

  it("matches the exact bytes of every file it records", () => {
    // Over the bytes, with no JSON canonicalization: the published artifact is
    // the bytes, so that is what a consumer pinning this URL depends on.
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schemas: Record<string, string>;
    };
    for (const [key, recorded] of Object.entries(manifest.schemas)) {
      const bytes = readFileSync(join(root, "src", "schemas", ...key.split("/")));
      expect(sha256(bytes), key).toBe(recorded);
    }
  });

  it("keeps its keys sorted, so a change is one line of diff", () => {
    const keys = Object.keys(
      (JSON.parse(readFileSync(manifestPath, "utf8")) as {
        schemas: Record<string, string>;
      }).schemas,
    );
    expect(keys).toEqual([...keys].sort());
  });
});

describe("0009 · the published copies under docs/public", () => {
  it("exist for every built-in, byte-identical to src/schemas", () => {
    // The two copies are what makes the URL work without coupling the docs
    // build to a path outside docs/. This runs in `npm test` rather than only
    // in the docs workflow, so a PR that touches neither still cannot drift
    // them apart — and it has to, because the docs build is a separate checkout
    // that never sees the repo root's node_modules.
    for (const key of sourceFiles()) {
      const segments = key.split("/");
      const src = readFileSync(join(root, "src", "schemas", ...segments));
      const published = readFileSync(
        join(root, "docs", "public", "schemas", ...segments),
      );
      expect(published.equals(src), key).toBe(true);
    }
  });

  it("publishes nothing that src/schemas does not have", () => {
    const base = join(root, "docs", "public", "schemas");
    const found: string[] = [];
    for (const dir of readdirSync(base, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const file of readdirSync(join(base, dir.name))) {
        found.push(`${dir.name}/${file}`);
      }
    }
    expect(found.sort()).toEqual(sourceFiles());
  });

  it("serves each built-in at the URL the registry aliases", () => {
    // Ties the three together: the alias table, the file on disk, and the URL
    // the docs advertise. A file moved without the table (or the other way
    // round) fails here rather than in production.
    for (const { id, url, schema } of publishedBuiltins()) {
      const rel = url.slice(PUBLISHED_BASE.length);
      const published = JSON.parse(
        readFileSync(join(root, "docs", "public", "schemas", ...rel.split("/")), "utf8"),
      ) as { $id?: string };
      expect(published.$id, url).toBe(id);
      expect(published, url).toEqual(schema);
    }
  });
});
