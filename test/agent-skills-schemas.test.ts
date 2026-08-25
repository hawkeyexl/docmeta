/**
 * Behavior of the two Agent Skills schemas, exercised through the real
 * validate path rather than against the JSON objects directly.
 *
 * They are a pair on purpose. `agentskills:skill:1.0` is the portable open
 * standard, and it is the one built-in that closes `additionalProperties`,
 * because the tooling it models — `package_skill.py`, the claude.ai upload,
 * the Skills API — hard-errors on any key outside the spec's six rather than
 * ignoring it. `anthropic:claude-skill:2.1` is the Claude Code superset, which
 * requires nothing and tolerates unknown keys, matching what Claude Code does.
 *
 * The split is the point: a `SKILL.md` that passes the Claude Code schema and
 * fails the spec schema is exactly a skill that runs locally and refuses to
 * upload.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runValidate } from "../src/commands/validate.js";
import { DEFAULT_SCHEMAS } from "../src/core/resolve-schema.js";
import { loadSchema } from "../src/core/schema-registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const SPEC = "agentskills:skill:1.0";
const CLAUDE = "anthropic:claude-skill:2.1";

/** Validate one fixture against an explicit schema set. */
async function check(fixture: string, cliSchemas: string[]) {
  const { results } = await runValidate({
    inputs: [`test/fixtures/agent-skills/${fixture}`],
    cliSchemas,
    cwd: root,
  });
  const r = results[0];
  if (!r) throw new Error(`no result for ${fixture}`);
  return r;
}

/** Validate inline front matter, for cases too small to earn a fixture. */
async function checkInline(frontmatter: string, cliSchemas: string[]) {
  const { results } = await runValidate({
    inputs: ["-"],
    as: "markdown",
    stdinContent: `---\n${frontmatter}\n---\n\nBody.\n`,
    cliSchemas,
    cwd: root,
  });
  const r = results[0];
  if (!r) throw new Error("no result for stdin");
  return r;
}

describe("agentskills:skill:1.0", () => {
  it("accepts a skill using every field the spec defines", async () => {
    const r = await check("spec-valid.md", [SPEC]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("accepts the two-field minimum", async () => {
    expect((await check("spec-minimal.md", [SPEC])).ok).toBe(true);
  });

  it("requires both `name` and `description`", async () => {
    const r = await check("spec-missing-required.md", [SPEC]);
    expect(r.ok).toBe(false);
    const messages = r.errors.map((e) => e.message).join(" ");
    for (const field of ["name", "description"]) {
      expect(messages, field).toContain(field);
    }
  });

  it("rejects a name that breaks the character rules", async () => {
    // Three violations in one value: uppercase, consecutive hyphens, and a
    // trailing hyphen. The spec calls out all three by name.
    const r = await check("spec-bad-name.md", [SPEC]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(SPEC);
    expect(r.errors[0]?.instancePath).toBe("/name");
  });

  it("rejects each name violation on its own", async () => {
    for (const name of ["PDF-processing", "-pdf", "pdf-", "pdf--processing"]) {
      const r = await checkInline(`name: ${name}\ndescription: A skill.`, [
        SPEC,
      ]);
      expect(r.ok, name).toBe(false);
      expect(r.errors[0]?.instancePath, name).toBe("/name");
    }
  });

  it("accepts the names the spec gives as valid", async () => {
    for (const name of ["pdf-processing", "data-analysis", "code-review", "a"]) {
      const r = await checkInline(`name: ${name}\ndescription: A skill.`, [
        SPEC,
      ]);
      expect(r.ok, name).toBe(true);
    }
  });

  it("enforces the published length caps", async () => {
    const cases: [string, string, string][] = [
      ["/name", `name: ${"a".repeat(65)}`, "description: A skill."],
      ["/description", "name: ok", `description: ${"a".repeat(1025)}`],
      [
        "/compatibility",
        "name: ok",
        `description: A skill.\ncompatibility: ${"a".repeat(501)}`,
      ],
    ];
    for (const [path, first, rest] of cases) {
      const r = await checkInline(`${first}\n${rest}`, [SPEC]);
      expect(r.ok, path).toBe(false);
      expect(r.errors[0]?.instancePath, path).toBe(path);
    }
  });

  it("rejects a Claude Code-only field, which is why the schema is strict", async () => {
    // The failure this schema exists for. Both keys load fine in Claude Code
    // and fail packaging with "Unexpected key(s) in SKILL.md frontmatter".
    const r = await check("spec-claude-only-field.md", [SPEC]);
    expect(r.ok).toBe(false);
    const messages = r.errors.map((e) => e.message).join(" ");
    expect(messages).toContain("argument-hint");
    expect(messages).toContain("disable-model-invocation");
  });

  it("rejects a non-string metadata value, because the spec maps strings to strings", async () => {
    // `version: "1.0"` is quoted in the spec's own example for this reason:
    // unquoted it is a YAML float, and the map is string -> string.
    const r = await check("spec-numeric-metadata.md", [SPEC]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/metadata/version");
  });

  it("is the one built-in that closes additionalProperties", async () => {
    const schema = await loadSchema(SPEC);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("anthropic:claude-skill:2.1", () => {
  it("accepts a skill using every documented Claude Code field", async () => {
    const r = await check("cc-valid.md", [CLAUDE]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("requires nothing, because Claude Code marks every field optional", async () => {
    expect((await check("cc-empty-frontmatter.md", [CLAUDE])).ok).toBe(true);
  });

  it("accepts the YAML 1.1 boolean spellings Claude Code takes", async () => {
    // `yes`, `off` and `0` are not booleans to a YAML 1.2 parser, so they
    // reach the validator as a string and an integer. Claude Code accepts
    // them anyway, so a schema typing these as `boolean` would fail a file
    // that works.
    const r = await check("cc-yaml-flag-spellings.md", [CLAUDE]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("takes a quoted 0 or 1, which YAML hands over as a string", async () => {
    for (const value of ['"1"', '"0"', "1", "0"]) {
      const r = await checkInline(`background: ${value}`, [CLAUDE]);
      expect(r.ok, value).toBe(true);
    }
    expect((await checkInline("background: 2", [CLAUDE])).ok).toBe(false);
  });

  it("still rejects a word that is not a boolean spelling", async () => {
    const r = await check("cc-bad-flag.md", [CLAUDE]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/disable-model-invocation");
  });

  it("enumerates the closed value sets", async () => {
    for (const [fixture, path] of [
      ["cc-bad-effort.md", "/effort"],
      ["cc-bad-shell.md", "/shell"],
      ["cc-bad-context.md", "/context"],
    ] as const) {
      const r = await check(fixture, [CLAUDE]);
      expect(r.ok, fixture).toBe(false);
      expect(r.errors[0]?.schema, fixture).toBe(CLAUDE);
      expect(r.errors[0]?.instancePath, fixture).toBe(path);
    }
  });

  it("takes the string and list spellings of the same field", async () => {
    for (const field of [
      "allowed-tools",
      "disallowed-tools",
      "arguments",
      "paths",
    ]) {
      const asString = await checkInline(`${field}: one two`, [CLAUDE]);
      expect(asString.ok, `${field} as string`).toBe(true);
      const asList = await checkInline(`${field}:\n  - one\n  - two`, [CLAUDE]);
      expect(asList.ok, `${field} as list`).toBe(true);
    }
  });

  it("does not enum `model`, whose accepted values move with the product", async () => {
    for (const model of ["inherit", "opus", "sonnet[1m]", "claude-opus-5"]) {
      const r = await checkInline(`model: ${model}`, [CLAUDE]);
      expect(r.ok, model).toBe(true);
    }
  });

  it("does not constrain `name`, which Claude Code uses as a display label", async () => {
    // The spec's lowercase-hyphen rule is not Claude Code's rule: a personal
    // skill takes its command from the directory, and `name` is the label.
    // Validate against the spec schema when portability is what you want.
    const r = await checkInline("name: Fancy Review", [CLAUDE]);
    expect(r.ok).toBe(true);
    expect((await checkInline("name: Fancy Review", [SPEC])).ok).toBe(false);
  });

  it("takes a free-form metadata map, unlike the spec schema", async () => {
    const frontmatter = "metadata:\n  tier: 2\n  owners:\n    - docs";
    expect((await checkInline(frontmatter, [CLAUDE])).ok).toBe(true);
    const r = await checkInline(`name: ok\ndescription: A.\n${frontmatter}`, [
      SPEC,
    ]);
    expect(r.ok).toBe(false);
  });

  it("tolerates an unknown key, because Claude Code ignores one", async () => {
    expect((await checkInline("future-field: 1", [CLAUDE])).ok).toBe(true);
  });
});

describe("the Agent Skills schemas are opt-in", () => {
  for (const id of [SPEC, CLAUDE]) {
    it(`${id} is not in the default set`, () => {
      expect(DEFAULT_SCHEMAS).not.toContain(id);
    });
  }
});
