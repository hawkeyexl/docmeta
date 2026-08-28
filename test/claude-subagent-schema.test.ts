/**
 * Behavior of `anthropic:claude-subagent:2.1`, exercised through the real
 * validate path rather than against the JSON object directly.
 *
 * A subagent definition is the other half of the Claude Code pair that
 * `anthropic:claude-skill:2.1` opened: a markdown file under `.claude/agents/`
 * whose front matter configures a delegate rather than a workflow. The two
 * contracts are close enough to be confused and different enough to matter —
 * the agent loader requires `name` and `description`, spells its tool keys
 * `tools`/`disallowedTools` rather than `allowed-tools`/`disallowed-tools`,
 * and takes only `true`/`false` where a skill takes six boolean spellings.
 *
 * Every enumerated set here is the set the shipped loader checks against, not
 * the set the docs happen to list. Where the two disagree — `isolation`
 * accepts `remote` as well as `worktree` — the loader wins, because a schema
 * that rejects a working file is the failure worth avoiding.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runValidate } from "../src/commands/validate.js";
import { DEFAULT_SCHEMAS } from "../src/core/resolve-schema.js";
import {
  listBuiltins,
  loadSchema,
  publishedBuiltins,
} from "../src/core/schema-registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const AGENT = "anthropic:claude-subagent:2.1";

/** Validate one fixture against an explicit schema set. */
async function check(fixture: string) {
  const { results } = await runValidate({
    inputs: [`test/fixtures/claude-subagent/${fixture}`],
    cliSchemas: [AGENT],
    cwd: root,
  });
  const r = results[0];
  if (!r) throw new Error(`no result for ${fixture}`);
  return r;
}

/**
 * Validate inline front matter, for cases too small to earn a fixture.
 *
 * `name` and `description` are supplied here because the schema requires them:
 * without them every inline case would fail for a reason it is not testing.
 */
async function checkInline(frontmatter: string) {
  const { results } = await runValidate({
    inputs: ["-"],
    as: "markdown",
    stdinContent: `---\nname: probe\ndescription: A probe agent.\n${frontmatter}\n---\n\nBody.\n`,
    cliSchemas: [AGENT],
    cwd: root,
  });
  const r = results[0];
  if (!r) throw new Error("no result for stdin");
  return r;
}

describe("registration", () => {
  it("is a built-in, addressable by id", async () => {
    expect(listBuiltins().map((b) => b.id)).toContain(AGENT);
    await expect(loadSchema(AGENT)).resolves.toBeTruthy();
  });

  it("is published at a version-pinned URL", () => {
    const entry = publishedBuiltins().find((b) => b.id === AGENT);
    expect(entry?.url).toBe(
      "https://hawkeyexl.github.io/docmeta/schemas/claude-subagent/2.1.json",
    );
  });

  it("is opt-in, like every other platform schema", () => {
    expect(DEFAULT_SCHEMAS).not.toContain(AGENT);
  });

  it("carries its id as its own `$id`", async () => {
    const schema = await loadSchema(AGENT);
    expect(schema.$id).toBe(AGENT);
  });
});

describe("required fields", () => {
  it("accepts an agent using every field the loader reads", async () => {
    const r = await check("valid.md");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("accepts the two-field minimum", async () => {
    const r = await check("minimal.md");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("requires both `name` and `description`", async () => {
    // Unlike a skill, an agent file cannot fall back to its body or filename:
    // no `name` and the file is skipped as documentation, no `description` and
    // it is reported as an error. Both are refusals to load.
    const r = await check("missing-required.md");
    expect(r.ok).toBe(false);
    const messages = r.errors.map((e) => e.message).join(" ");
    for (const field of ["name", "description"]) {
      expect(messages, field).toContain(field);
    }
    expect(r.errors[0]?.schema).toBe(AGENT);
  });

  it("accepts the two required fields and nothing else", async () => {
    // The baseline every `checkInline` case below builds on: with `name` and
    // `description` present and no other key, the file is valid.
    expect((await checkInline("")).ok).toBe(true);
  });

  it("rejects an empty `description`", async () => {
    const { results } = await runValidate({
      inputs: ["-"],
      as: "markdown",
      stdinContent: `---\nname: probe\ndescription: ""\n---\n\nBody.\n`,
      cliSchemas: [AGENT],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.errors[0]?.instancePath).toBe("/description");
  });
});

describe("`name`", () => {
  it("rejects a name starting with a hyphen", async () => {
    // The one character rule the loader enforces: it logs
    // `names must not start with '-'` and returns null, so the agent does not
    // exist. Everything else about the name is convention.
    const r = await check("leading-hyphen-name.md");
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.schema).toBe(AGENT);
    expect(r.errors[0]?.instancePath).toBe("/name");
  });

  it("does not impose the docs' lowercase-and-hyphens convention", async () => {
    // `Explore` and `Plan` ship as agent types with capitals in them. The
    // loader checks the leading hyphen and nothing else, so a schema holding
    // `name` to `^[a-z-]+$` would fail agents that work today.
    for (const name of ["Explore", "code_reviewer", "reviewer2"]) {
      const { results } = await runValidate({
        inputs: ["-"],
        as: "markdown",
        stdinContent: `---\nname: ${name}\ndescription: An agent.\n---\n\nBody.\n`,
        cliSchemas: [AGENT],
        cwd: root,
      });
      expect(results[0]?.ok, name).toBe(true);
    }
  });
});

describe("closed value sets", () => {
  it("enumerates the eight display colours", async () => {
    for (const color of [
      "red",
      "blue",
      "green",
      "yellow",
      "purple",
      "orange",
      "pink",
      "cyan",
    ]) {
      expect((await checkInline(`color: ${color}`)).ok, color).toBe(true);
    }
    const r = await check("bad-color.md");
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/color");
  });

  it("enumerates the permission modes, including the `manual` alias", async () => {
    for (const mode of [
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "default",
      "dontAsk",
      "manual",
      "plan",
    ]) {
      expect((await checkInline(`permissionMode: ${mode}`)).ok, mode).toBe(
        true,
      );
    }
    const r = await checkInline("permissionMode: readonly");
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/permissionMode");
  });

  it("enumerates the three memory scopes", async () => {
    for (const scope of ["user", "project", "local"]) {
      expect((await checkInline(`memory: ${scope}`)).ok, scope).toBe(true);
    }
    expect((await checkInline("memory: session")).ok).toBe(false);
  });

  it("accepts both isolation modes the loader takes", async () => {
    // The docs name only `worktree`; the loader's list is
    // `["worktree", "remote"]` and it warns on anything else.
    for (const mode of ["worktree", "remote"]) {
      expect((await checkInline(`isolation: ${mode}`)).ok, mode).toBe(true);
    }
    expect((await checkInline("isolation: sandbox")).ok).toBe(false);
  });

  it("enumerates the five effort levels and also takes an integer", async () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect((await checkInline(`effort: ${effort}`)).ok, effort).toBe(true);
    }
    expect((await checkInline("effort: 8")).ok).toBe(true);
    const r = await checkInline("effort: extreme");
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/effort");
  });

  it("puts no lower bound on the integer effort, unlike `maxTurns`", async () => {
    // Deliberate asymmetry, and a fact about the loader rather than an
    // oversight. `maxTurns` is checked for a *positive* integer and warns
    // otherwise; `effort` is checked with a bare `Number.isInteger`, so `0` and
    // `-3` are both taken and neither is reported. A `minimum` here would fail
    // an agent that runs.
    for (const effort of ["0", "-3"]) {
      expect((await checkInline(`effort: ${effort}`)).ok, effort).toBe(true);
      expect((await checkInline(`maxTurns: ${effort}`)).ok, effort).toBe(false);
    }
  });
});

describe("`background` is not a skill flag", () => {
  it("takes booleans and the two exact strings", async () => {
    // `True` and `FALSE` pass on the *boolean* branch: YAML 1.2 resolves all
    // three casings of the core spellings, so they never reach the validator
    // as strings.
    for (const value of ["true", "false", "True", "FALSE", '"true"']) {
      expect((await checkInline(`background: ${value}`)).ok, value).toBe(true);
    }
  });

  it("separates the boolean branch from the string one", async () => {
    // Quoting is what makes the difference visible. `"True"` stays a string,
    // and the loader compares the string form against 'true'/'false' exactly,
    // so the schema's case-sensitive pattern is the right model of it.
    const r = await checkInline('background: "True"');
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/background");
  });

  it("refuses the spellings a `SKILL.md` accepts", async () => {
    // `anthropic:claude-skill:2.1` takes yes/no/on/off/1/0. The agent loader
    // warns `Must be 'true', 'false', or omitted.` on every one of them, so
    // the two schemas type the same-looking key differently on purpose.
    for (const value of ["yes", "no", "on", "off", "1", "0"]) {
      expect((await checkInline(`background: ${value}`)).ok, value).toBe(false);
    }
    const r = await check("bad-background.md");
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.instancePath).toBe("/background");
  });
});

describe("`maxTurns`", () => {
  it("takes a positive integer in either YAML spelling", async () => {
    expect((await checkInline("maxTurns: 15")).ok).toBe(true);
    expect((await checkInline('maxTurns: "15"')).ok).toBe(true);
  });

  it("rejects zero, a negative, a fraction and null", async () => {
    for (const value of ["0", "-3", "2.5", "null"]) {
      const r = await checkInline(`maxTurns: ${value}`);
      expect(r.ok, value).toBe(false);
      expect(r.errors[0]?.instancePath, value).toBe("/maxTurns");
    }
  });
});

describe("delimited-or-list fields", () => {
  it("takes the string and list spellings of the same field", async () => {
    for (const field of ["tools", "disallowedTools", "skills"]) {
      const asString = await checkInline(`${field}: one two`);
      expect(asString.ok, `${field} as string`).toBe(true);
      const asList = await checkInline(`${field}:\n  - one\n  - two`);
      expect(asList.ok, `${field} as list`).toBe(true);
    }
  });

  it("accepts the tool spellings the loader parses", async () => {
    // The loader splits on commas and spaces outside parentheses, so a scoped
    // rule survives; `*` means "no restriction" rather than a literal tool,
    // and has to be quoted because a bare `*` opens a YAML alias node.
    for (const tools of [
      '"*"',
      "Read, Grep, Glob",
      "Bash(npm run test:*) Read",
      "mcp__github",
    ]) {
      expect((await checkInline(`tools: ${tools}`)).ok, tools).toBe(true);
    }
  });
});

describe("what the schema deliberately leaves open", () => {
  it("does not enum `model`, whose accepted values move with the product", async () => {
    for (const model of ["inherit", "opus", "haiku", "claude-opus-5"]) {
      expect((await checkInline(`model: ${model}`)).ok, model).toBe(true);
    }
    expect((await checkInline("model: ''")).ok).toBe(false);
  });

  it("leaves the `hooks` and `mcpServers` payloads unconstrained", async () => {
    const hooks =
      'hooks:\n  PreToolUse:\n    - matcher: "Bash"\n      hooks:\n        - type: command\n          command: "./check.sh"';
    expect((await checkInline(hooks)).ok).toBe(true);
    expect((await checkInline("hooks: []")).ok).toBe(false);

    // A server is named by string, or defined inline as a one-key map.
    expect((await checkInline("mcpServers:\n  - github")).ok).toBe(true);
    expect(
      (await checkInline("mcpServers:\n  - pw:\n      type: stdio")).ok,
    ).toBe(true);
    expect((await checkInline("mcpServers: github")).ok).toBe(false);
  });

  it("tolerates a key Claude Code does not recognise", async () => {
    // The loader reports an unknown agent key as telemetry and loads the file
    // anyway, so the schema stays open — the same reasoning as
    // `anthropic:claude-skill:2.1`.
    expect((await checkInline("owner: docs-team")).ok).toBe(true);
  });
});

describe("the pair with `anthropic:claude-skill:2.1`", () => {
  it("does not accept a SKILL.md written against the skill schema", async () => {
    // The keys a skill spells with hyphens are not the keys an agent reads.
    // Pointing this schema at a skill file is a real mistake, and the missing
    // `description` is what catches it.
    const { results } = await runValidate({
      inputs: ["test/fixtures/agent-skills/cc-empty-frontmatter.md"],
      cliSchemas: [AGENT],
      cwd: root,
    });
    expect(results[0]?.ok).toBe(false);
  });
});
