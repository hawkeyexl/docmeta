/**
 * `fill` command core.
 *
 * Every case here is hermetic: the inference provider is injected as a
 * `MockProvider`, so no API key and no network are involved. Cases that write
 * run inside a fresh mkdtemp copy — the shared fixtures stay read-only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MockProvider, type InferenceProvider } from "@hawkeyexl/inference";
import { runFill, collectCandidates } from "../src/commands/fill.js";
import { loadSchema } from "../src/core/schema-registry.js";
import { DocmetaError } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(join(here, "fixtures", "fill", name), "utf8");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docmeta-fill-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Copy a fixture into the scratch dir so a test may safely mutate it. */
async function stage(name: string, as = name): Promise<string> {
  await writeFile(join(dir, as), fixture(name), "utf8");
  return as;
}

const propose = (
  fields: Record<string, { value: unknown; confidence: number }>,
): MockProvider =>
  new MockProvider([
    {
      json: Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [
          k,
          { ...v, reasoning: "stated in the page" },
        ]),
      ),
    },
  ]);

const base = { cache: false as const, cwd: () => dir };

describe("collectCandidates", () => {
  it("picks missing properties and invalid ones, but not valid ones", async () => {
    const okf = await loadSchema("google:okf:0.1");
    const data = { type: "concept", title: "Hello", timestamp: "not-a-date" };
    const errors = [
      { schema: "google:okf:0.1", instancePath: "/timestamp", message: "bad" },
    ];
    const keys = collectCandidates([okf], data, errors).map((c) => c.key);

    expect(keys).toContain("timestamp"); // present but invalid
    expect(keys).toContain("description"); // missing
    expect(keys).toContain("resource"); // missing
    expect(keys).toContain("tags"); // missing
    expect(keys).not.toContain("type"); // present and valid
    expect(keys).not.toContain("title"); // present and valid
  });

  it("marks schema-required properties", async () => {
    const okf = await loadSchema("google:okf:0.1");
    const found = collectCandidates([okf], {}, []);
    expect(found.find((c) => c.key === "type")?.required).toBe(true);
    expect(found.find((c) => c.key === "title")?.required).toBe(false);
  });

  it("narrows to --fields when given", async () => {
    const okf = await loadSchema("google:okf:0.1");
    const keys = collectCandidates([okf], {}, [], new Set(["title"])).map(
      (c) => c.key,
    );
    expect(keys).toEqual(["title"]);
  });

  it("lifts the first-named schema's subschema when two define a key", async () => {
    // Pins the ordering advice in the taxonomy-schemas reference. Selection is
    // first-wins per key, and OKF accepts any non-empty string for `type`, so
    // naming OKF ahead of a vocabulary drops the enum from the inference
    // prompt and lets the model propose a value `validate` will then reject.
    const okf = await loadSchema("google:okf:0.1");
    const diataxis = await loadSchema("diataxis:diataxis:1.0");

    // `subschema` is a Record<string, unknown>, so `.enum` needs no cast; the
    // optional chain has to stay unbroken, or a missing candidate would throw
    // a TypeError here instead of failing the assertion below.
    const liftedTypeEnum = (cs: ReturnType<typeof collectCandidates>) =>
      cs.find((c) => c.key === "type")?.subschema.enum;

    expect(
      liftedTypeEnum(collectCandidates([diataxis, okf], { title: "x" }, [])),
    ).toEqual(["tutorial", "how-to", "reference", "explanation"]);

    expect(
      liftedTypeEnum(collectCandidates([okf, diataxis], { title: "x" }, [])),
    ).toBeUndefined();
  });

  it("never proposes the $schema wiring key", async () => {
    const schema = {
      type: "object",
      properties: { $schema: { type: "string" }, title: { type: "string" } },
    };
    const keys = collectCandidates([schema], {}, []).map((c) => c.key);
    expect(keys).toEqual(["title"]);
  });
});

describe("runFill — the confidence gate", () => {
  it("writes a value at or above the threshold and skips one below", async () => {
    const file = await stage("missing-keys.md");
    const { results, summary, threshold } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["description", "resource"],
      confidence: 0.7,
      includeContent: true,
      inferenceProvider: propose({
        description: { value: "A summary.", confidence: 0.7 },
        resource: { value: "https://example.com/x", confidence: 0.69 },
      }),
    });

    expect(threshold).toBe(0.7);
    const fields = results[0]?.fields ?? [];
    const byName = Object.fromEntries(fields.map((f) => [f.field, f]));
    // Exactly at the threshold counts as confident.
    expect(byName["/description"]?.written).toBe(true);
    expect(byName["/resource"]?.written).toBe(false);
    expect(byName["/resource"]?.skipReason).toBe("low-confidence");
    expect(summary.written).toBe(1);
    expect(summary.skipped).toBe(1);

    const written = await readFile(join(dir, file), "utf8");
    expect(written).toContain("description: A summary.");
    expect(written).not.toContain("example.com");
  });

  it("never writes the confidence or reasoning into the document", async () => {
    const file = await stage("missing-keys.md");
    await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["description"],
      inferenceProvider: propose({
        description: { value: "A summary.", confidence: 0.95 },
      }),
    });
    const written = await readFile(join(dir, file), "utf8");
    expect(written).not.toContain("confidence");
    expect(written).not.toContain("stated in the page");
  });

  it("reports a required field skipped below the threshold", async () => {
    const file = await stage("no-block.md");
    const { summary } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["type"],
      inferenceProvider: propose({
        type: { value: "concept", confidence: 0.2 },
      }),
    });
    expect(summary.requiredSkipped).toBe(1);
    expect(summary.written).toBe(0);
  });

  it("records a declined property as no-proposal rather than inventing one", async () => {
    const file = await stage("missing-keys.md");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["description", "resource"],
      inferenceProvider: propose({
        description: { value: "A summary.", confidence: 0.9 },
      }),
    });
    const resource = results[0]?.fields.find((f) => f.field === "/resource");
    expect(resource?.written).toBe(false);
    expect(resource?.skipReason).toBe("no-proposal");
  });
});

describe("runFill — mechanical checks precede confidence", () => {
  it("rejects a malformed value at the envelope, before the gate is consulted", async () => {
    // `timestamp` carries `format: date-time`, so a confidence of 1 cannot get
    // "still-not-a-date" past the schema-constrained response itself.
    const file = await stage("missing-keys.md");
    const before = await readFile(join(dir, file), "utf8");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["timestamp"],
      inferenceProvider: new MockProvider([
        {
          json: {
            timestamp: {
              value: "still-not-a-date",
              confidence: 1,
              reasoning: "x",
            },
          },
        },
      ]),
    });
    expect(results[0]?.error).toMatch(/schema validation/i);
    expect(await readFile(join(dir, file), "utf8")).toBe(before);
  });

  it("reverts a high-confidence value that another schema in the set rejects", async () => {
    // The envelope is built from the first schema's subschema, so a value can
    // satisfy it and still break a second schema in the set. Re-validating
    // after the merge is what catches that.
    const file = await stage("no-block.md");
    const before = await readFile(join(dir, file), "utf8");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      cliSchemas: [
        "google:okf:0.1",
        join(here, "fixtures", "fill", "strict-title.schema.json"),
      ],
      fields: ["title"],
      inferenceProvider: propose({
        title: { value: "Hi", confidence: 1 },
      }),
    });
    const field = results[0]?.fields.find((f) => f.field === "/title");
    expect(field?.written).toBe(false);
    expect(field?.skipReason).toBe("schema-mismatch");
    expect(await readFile(join(dir, file), "utf8")).toBe(before);
  });

  it("keeps an uncompilable proposal schema to one file instead of aborting the run", async () => {
    // A draft-07 `#/definitions/X` ref must still resolve in the envelope, and
    // if a schema genuinely cannot compile it must not take the run down.
    await writeFile(
      join(dir, "d7.schema.json"),
      JSON.stringify({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        definitions: { Tag: { type: "string", minLength: 1 } },
        properties: {
          type: { type: "string" },
          tags: { type: "array", items: { $ref: "#/definitions/Tag" } },
        },
      }),
      "utf8",
    );
    const file = await stage("no-block.md");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      cliSchemas: [join(dir, "d7.schema.json")],
      fields: ["tags"],
      dryRun: true,
      inferenceProvider: propose({
        tags: { value: ["a", "b"], confidence: 0.9 },
      }),
    });
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.fields[0]?.written).toBe(true);
  });

  it("does not pay for inference on a document it cannot write", async () => {
    // `description` is genuinely absent from the fixture, so there is a
    // candidate and the run would otherwise reach the provider.
    const file = await stage("native-docinfo.rst");
    const provider = propose({
      description: { value: "A summary.", confidence: 1 },
    });
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["description"],
      inferenceProvider: provider,
    });
    expect(results[0]?.error).toMatch(/fenced/i);
    // The point of the check: no request was ever made.
    expect(provider.requests).toHaveLength(0);
    // Schema resolution already succeeded, so the result must say so — "never
    // resolved" and "resolved, then writing refused" need different follow-up.
    expect(results[0]?.schemas).toEqual([
      "google:okf:0.1",
      "passo-uno:seven-action:1.0",
    ]);
  });

  it("reports a read-only format as a per-file error, not a run abort", async () => {
    const file = await stage("unsupported.html");
    const { results, summary } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      inferenceProvider: propose({}),
    });
    expect(results[0]?.error).toMatch(/read-only/);
    expect(summary.errors).toBe(1);
  });

  it("refuses to touch a document with an unterminated fence", async () => {
    const file = await stage("unterminated.md");
    const before = await readFile(join(dir, file), "utf8");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["title"],
      inferenceProvider: propose({
        title: { value: "Hello", confidence: 1 },
      }),
    });
    expect(results[0]?.error).toMatch(/[Uu]nterminated/);
    expect(await readFile(join(dir, file), "utf8")).toBe(before);
  });
});

describe("runFill — writing", () => {
  it("leaves the file byte-identical under --dry-run", async () => {
    const file = await stage("missing-keys.md");
    const before = await readFile(join(dir, file), "utf8");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["description"],
      dryRun: true,
      includeContent: true,
      inferenceProvider: propose({
        description: { value: "A summary.", confidence: 0.95 },
      }),
    });
    // The proposed document is still computed and reported...
    expect(results[0]?.changed).toBe(true);
    expect(results[0]?.content).toContain("description: A summary.");
    // ...but nothing reached the disk.
    expect(await readFile(join(dir, file), "utf8")).toBe(before);
  });

  it("creates a block on a file with no metadata at all", async () => {
    const file = await stage("no-block.md");
    await runFill({
      ...base,
      cwd: dir,
      inputs: [file],
      fields: ["type", "title"],
      inferenceProvider: propose({
        type: { value: "concept", confidence: 0.95 },
        title: { value: "Hello", confidence: 0.95 },
      }),
    });
    const out = await readFile(join(dir, file), "utf8");
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("type: concept");
    expect(out).toContain("# Hello");
  });

  it("makes no inference call when nothing needs filling", async () => {
    // "Complete" is relative to the resolved schema set, which by default is
    // OKF *and* Seven-Action — hence `action` alongside the OKF fields.
    await writeFile(
      join(dir, "complete.md"),
      "---\ntype: concept\naction: understand\ntitle: T\ndescription: D\nresource: https://e.com/x\ntags: [a]\ntimestamp: 2026-06-25T10:00:00Z\n---\n\n# T\n",
      "utf8",
    );
    const provider = propose({});
    const { results, summary } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["complete.md"],
      inferenceProvider: provider,
    });
    expect(provider.requests).toHaveLength(0);
    expect(results[0]?.fields).toEqual([]);
    expect(summary.changed).toBe(0);
  });

  it("processes stdin *and* the named paths, not stdin instead of them", async () => {
    // Parity with validate/get: `-` is one more input, not a mode switch.
    const file = await stage("missing-keys.md");
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["-", file],
      as: "markdown",
      fields: ["description"],
      dryRun: true,
      stdinContent: fixture("no-block.md"),
      inferenceProvider: new MockProvider([
        {
          json: {
            description: { value: "A.", confidence: 0.9, reasoning: "r" },
          },
        },
      ]),
    });
    expect(results.map((r) => r.file)).toEqual(["<stdin>", file]);
  });

  it("fills from stdin without touching disk", async () => {
    const { results } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["-"],
      as: "markdown",
      fields: ["description"],
      stdinContent: fixture("missing-keys.md"),
      includeContent: true,
      inferenceProvider: propose({
        description: { value: "A summary.", confidence: 0.95 },
      }),
    });
    expect(results[0]?.file).toBe("<stdin>");
    expect(results[0]?.content).toContain("description: A summary.");
  });
});

describe("runFill — cost budget", () => {
  /**
   * MockProvider's default model has no entry in the price table, so its cost
   * is always $0 and the budget can never trigger. Naming a priced model makes
   * each call cost $0.001 (500 in / 100 out at haiku rates), which is what
   * makes this gate observable at all.
   */
  const priced = (): MockProvider =>
    new MockProvider(
      [
        {
          json: {
            description: { value: "A.", confidence: 0.9, reasoning: "r" },
          },
        },
      ],
      "claude-haiku-4-5",
    );

  it("stops scheduling new files once the budget is reached", async () => {
    await writeFile(join(dir, "a.md"), fixture("missing-keys.md"), "utf8");
    await writeFile(join(dir, "b.md"), fixture("missing-keys.md"), "utf8");

    const { results, summary, budgetExhausted } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["a.md", "b.md"],
      fields: ["description"],
      dryRun: true,
      // Serial, so the first call's cost is banked before the second is
      // considered — otherwise both would clear the check concurrently.
      concurrency: 1,
      maxCostUsd: 0.0005, // less than one call
      inferenceProvider: priced(),
    });

    expect(budgetExhausted).toBe(true);
    expect(summary.costUsd).toBeGreaterThan(0);
    expect(results[0]?.error).toBeUndefined();
    expect(results[1]?.error).toMatch(/cost budget reached/);
  });

  it("processes everything when the budget is ample", async () => {
    await writeFile(join(dir, "a.md"), fixture("missing-keys.md"), "utf8");
    await writeFile(join(dir, "b.md"), fixture("missing-keys.md"), "utf8");

    const { results, budgetExhausted } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["a.md", "b.md"],
      fields: ["description"],
      dryRun: true,
      concurrency: 1,
      maxCostUsd: 10,
      inferenceProvider: priced(),
    });

    expect(budgetExhausted).toBe(false);
    expect(results.every((r) => r.error === undefined)).toBe(true);
  });

  /**
   * MockProvider resolves within a microtask, so workers never actually
   * overlap and the concurrency behavior is untestable with it. This provider
   * takes real time, which lets every worker reach the budget check before any
   * call has completed — the situation a network provider creates and the one
   * the priming gate exists for.
   */
  class SlowProvider implements InferenceProvider {
    readonly requests: unknown[] = [];
    provider(): string {
      return "mock";
    }
    modelName(): string {
      return "claude-haiku-4-5";
    }
    async completeJSON(req: unknown): Promise<{
      json: unknown;
      usage: { inputTokens: number; outputTokens: number };
    }> {
      this.requests.push(req);
      await new Promise((r) => setTimeout(r, 25));
      return {
        json: { description: { value: "A.", confidence: 0.9, reasoning: "r" } },
        usage: { inputTokens: 500, outputTokens: 100 },
      };
    }
  }

  it("does not let a parallel first wave blow past the budget", async () => {
    // Four files, concurrency 4, budget 0.0015 — room for one $0.001 call, not
    // two. Every worker reaches the budget check before any call has completed,
    // so without the priming gate all four would clear a check made against $0
    // and bill $0.004. With it, the first call runs alone; the rest then see a
    // real per-call cost and only one more fits.
    for (const n of ["a", "b", "c", "d"]) {
      await writeFile(join(dir, `${n}.md`), fixture("missing-keys.md"), "utf8");
    }
    const provider = new SlowProvider();
    const { summary, budgetExhausted } = await runFill({
      ...base,
      cwd: dir,
      inputs: ["a.md", "b.md", "c.md", "d.md"],
      fields: ["description"],
      dryRun: true,
      concurrency: 4,
      maxCostUsd: 0.0015,
      inferenceProvider: provider,
    });

    // Exactly two: the primer, then one more that fits before the reservation
    // for it pushes the projection over the limit.
    expect(provider.requests).toHaveLength(2);
    expect(summary.costUsd).toBeCloseTo(0.002, 6);
    expect(budgetExhausted).toBe(true);
  });
});

describe("runFill — cache", () => {
  it("re-gates a cached proposal at a new threshold with no provider call", async () => {
    const file = await stage("missing-keys.md");
    const first = propose({
      description: { value: "A summary.", confidence: 0.8 },
    });
    const opts = {
      cwd: dir,
      inputs: [file],
      fields: ["description"],
      dryRun: true,
      inferenceProvider: first,
    };

    const lenient = await runFill({ ...opts, confidence: 0.7 });
    expect(first.requests).toHaveLength(1);
    expect(lenient.results[0]?.fields[0]?.written).toBe(true);

    // A different threshold must re-gate from cache, not re-ask the model —
    // that is what makes tuning the gate on a real docset free.
    const second = propose({
      description: { value: "Different.", confidence: 0.99 },
    });
    const strict = await runFill({
      ...opts,
      inferenceProvider: second,
      confidence: 0.9,
    });
    expect(second.requests).toHaveLength(0);
    expect(strict.summary.cached).toBe(1);
    expect(strict.results[0]?.fields[0]?.written).toBe(false);
    expect(strict.results[0]?.fields[0]?.skipReason).toBe("low-confidence");
  });
});

describe("runFill — operational errors", () => {
  it("errors when there are no inputs and no config", async () => {
    await expect(
      runFill({ ...base, cwd: dir, inputs: [], inferenceProvider: propose({}) }),
    ).rejects.toBeInstanceOf(DocmetaError);
  });

  it("errors on an unknown provider even when no file needs filling", async () => {
    // resolveProviderIdentity happily returns a bogus identity, and makeProvider
    // is lazy — so without an explicit check this exits 0 having done nothing.
    await writeFile(
      join(dir, "complete.md"),
      "---\ntype: concept\ntitle: T\ndescription: D\nresource: https://e.com/x\ntags: [a]\ntimestamp: 2026-06-25T10:00:00Z\n---\n\n# T\n",
      "utf8",
    );
    await expect(
      runFill({
        ...base,
        cwd: dir,
        inputs: ["complete.md"],
        provider: "nonsense",
      }),
    ).rejects.toThrow(/Unknown provider/);
  });

  it("validates numeric options rather than trusting its caller", async () => {
    // runFill is a public API and also reads config, so bad numbers must be
    // rejected here — not just by the CLI's flag parsing. A NaN threshold
    // would otherwise skip every field silently.
    const file = await stage("missing-keys.md");
    const bad = { ...base, cwd: dir, inputs: [file], inferenceProvider: propose({}) };
    await expect(runFill({ ...bad, confidence: Number.NaN })).rejects.toThrow(
      /confidence/,
    );
    await expect(runFill({ ...bad, confidence: 1.5 })).rejects.toThrow(
      /between 0 and 1/,
    );
    await expect(runFill({ ...bad, concurrency: 2.5 })).rejects.toThrow(
      /whole number/,
    );
    await expect(
      runFill({ ...bad, maxCostUsd: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/maxCostUsd/);
  });

  it("errors on an unknown --as format, naming extractors not extensions", async () => {
    // `--as` takes "markdown", so listing ".md" would point at the wrong value.
    const run = runFill({
      ...base,
      cwd: dir,
      inputs: ["-"],
      as: "nonsense",
      inferenceProvider: propose({}),
    });
    await expect(run).rejects.toThrow(/Unknown format/);
    await expect(run).rejects.toThrow(/markdown/);
    await expect(run).rejects.not.toThrow(/\.md/);
  });

  it("errors when stdin is used without --as", async () => {
    await expect(
      runFill({
        ...base,
        cwd: dir,
        inputs: ["-"],
        inferenceProvider: propose({}),
      }),
    ).rejects.toThrow(/--as/);
  });

  it("takes the threshold from config when no flag is given", async () => {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(
      join(dir, "docmeta.config.yaml"),
      "paths:\n  - 'docs/**/*.md'\nfill:\n  confidenceThreshold: 0.95\n",
      "utf8",
    );
    await writeFile(join(dir, "docs", "page.md"), fixture("no-block.md"), "utf8");

    const { threshold, summary } = await runFill({
      ...base,
      cwd: dir,
      inputs: [],
      fields: ["title"],
      dryRun: true,
      inferenceProvider: propose({
        title: { value: "Hello", confidence: 0.9 },
      }),
    });
    expect(threshold).toBe(0.95);
    expect(summary.written).toBe(0);
  });
});
