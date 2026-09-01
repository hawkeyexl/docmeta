// Validate the docmeta:artifact-evals:1.0.0-proposal.2 example ladder against the draft
// schema. Run from the repo root:
//   node docs/proposals/0023/ladders/artifact-evals-examples.cjs
const fs = require("fs");
const { createRequire } = require("module");
const req = createRequire(process.cwd() + "/");
let Ajv = req("ajv/dist/2020.js");
Ajv = Ajv.default ?? Ajv;
const { parse } = req("yaml");

// The drafts' semver prerelease, spelled once per ladder so a bump is a
// one-line edit here rather than a literal buried mid-expression.
const V = "1.0.0-proposal.2";
const schema = JSON.parse(
  fs.readFileSync(`docs/proposals/0023/schemas/artifact-evals/${V}.json`, "utf8"),
);
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validate = ajv.compile(schema);

const cases = [
  ["1 an artifact with no metadata at all", true,
`name: fix-bug
description: Fix a reported bug, reproducing it with a failing test first.`],

  ["2 metadata carrying other tools' entries, no evals", true,
`name: fix-bug
description: Fix a reported bug.
metadata:
  some-other-tool:
    setting: value`],

  ["3 single-string shorthand — the whole block is one assertion", true,
`metadata:
  evals: Reproduce the bug with a failing test before applying the fix.`],

  ["4 list of shorthands", true,
`metadata:
  evals:
    - Reproduce the bug with a failing test before applying the fix.
    - The session never touched files outside src/ and test/.`],

  ["5 mixed shorthand and object entries", true,
`metadata:
  evals:
    - id: used-read
      assertion: The session read at least one source file before editing.
      grader: tool-usage
      options:
        tool: Read
        expect: used
    - Reproduce the bug with a failing test before applying the fix.`],

  ["6 session graders, spread", true,
`metadata:
  evals:
    - id: forbidden-tool
      assertion: The session never ran shell commands; this skill is edit-only.
      grader: tool-usage
      options:
        tool: Bash
        expect: not-used
    - id: stayed-cheap
      assertion: The session stayed under budget.
      grader: cost
      options:
        maxUsd: 2
      severity: warning
    - id: bounded-turns
      assertion: The session finished within a reasonable number of turns.
      grader: turn-count
      options:
        max: 30`],

  ["7 ai judge with provider, capability probe, anchor lists", true,
`metadata:
  evals:
    - id: honored-tdd
      assertion: The session wrote a failing test before the fix.
      grader: ai
      provider: claude-cli
      type: capability
      evidence: The first Edit and Bash calls of the session
      examples:
        pass:
          - A test file edit lands before the src edit, and the first run fails.
          - The session narrates red-green explicitly.
        fail: The fix lands first and a test is added afterwards.`],

  ["8 artifact skipped", true,
`metadata:
  eval-skip: true`],

  ["9 eval-provenance, the family pattern one level down", true,
`metadata:
  eval-provenance:
    - generated-by: claude-fable-5
      evals: [used-read, forbidden-tool]
      confidence:
        used-read: 0.91
        forbidden-tool: 0.86
  evals:
    - id: used-read
      assertion: The session read at least one source file before editing.
      grader: tool-usage
      options:
        tool: Read`],

  ["10 the 0.2 fixture, translated and flattened (capability-fidelity demo)", true,
`name: fix-bug
description: Fix a reported bug, reproducing it with a failing test first.
metadata:
  evals:
    - id: used-read
      assertion: The session read at least one source file before editing.
      grader: tool-usage
      options:
        tool: Read
        expect: used
    - id: forbidden-tool
      assertion: The session never ran shell commands; this skill is edit-only.
      grader: tool-usage
      options:
        tool: Bash
        expect: not-used
    - Reproduce the bug with a failing test before applying the fix.`],

  ["11 human grader — a review-queue entry per session", true,
`metadata:
  evals:
    - id: refactor-preserved-intent
      assertion: The session's refactor preserved the module's public behavior.
      grader: human
      evidence: The diff of src/core/ across the session
      severity: warning`],

  ["12 command grader, authored and post-generation", true,
`metadata:
  evals:
    - id: no-force-push
      assertion: The trace contains no force push.
      grader: command
    - id: no-force-push-materialized
      assertion: The trace contains no force push.
      grader: command
      command: ["node", "tracevals/no-force-push.mjs", "{trace}"]
      success-exit-codes: [0]
      timeout-ms: 15000
      generated-assertion-hash: 07d185732a48ace07056e847b0fadd72fa35f830f7b793f2790db1a59182fd7a`],

  ["13 a future grader nobody has written yet (open enum)", true,
`metadata:
  evals:
    - id: frontier
      assertion: Something the registry will learn to check.
      grader: memory-usage`],

  ["N1 the 0.2 criteria envelope now fails loudly", false,
`metadata:
  evals:
    criteria:
      - Something.`],

  ["N2 the 0.2 optional name is now a required id", false,
`metadata:
  evals:
    - assertion: A nameless object entry.`],

  ["N3 the old name key fails loudly", false,
`metadata:
  evals:
    - name: used-read
      assertion: The session read a file.`],

  ["N4 an object entry without an assertion", false,
`metadata:
  evals:
    - id: empty-claim`],

  ["N5 a misspelled field inside an entry", false,
`metadata:
  evals:
    - id: typo-demo
      assertion: Something.
      severty: error`],

  ["N6 eval-skip must be a boolean", false,
`metadata:
  eval-skip: "true"`],

  ["N7 anchor examples must be strings or lists of them", false,
`metadata:
  evals:
    - id: bad-anchor
      assertion: Something.
      examples:
        pass: 5`],

  ["N8 exit codes on an ai grader (command-family fields need grader: command)", false,
`metadata:
  evals:
    - id: wrong-family
      assertion: Something.
      grader: ai
      timeout-ms: 5000`],

  ["N9 a hash without its command (half write-back)", false,
`metadata:
  evals:
    - id: orphan-hash
      assertion: Something.
      grader: command
      generated-assertion-hash: 07d185732a48ace07056e847b0fadd72fa35f830f7b793f2790db1a59182fd7a`],

  // proposal.2: assertion is conditional, plus scoring, judge selection, target.
  ["P10 a deterministic grader needs no assertion (options say it all)", true,
`metadata:
  evals:
    - id: no-force-push
      grader: tool-usage
      options:
        tool: Bash
        expect: not-used`],

  ["P11 weight, model and runs on an ai eval", true,
`metadata:
  evals:
    - id: followed-the-skill
      assertion: The session edited files rather than shelling out.
      weight: 2
      model: claude-sonnet-4-5
      runs: 5`],

  ["P12 target selects the final message", true,
`metadata:
  evals:
    - id: reported-cleanly
      assertion: The final message summarizes what changed.
      target: last-message`],

  ["N10 an ai eval still needs its assertion", false,
`metadata:
  evals:
    - id: no-assertion
      grader: ai`],

  ["N11 no grader means the ai default, so the assertion is still required", false,
`metadata:
  evals:
    - id: bare`],

  ["N12 a human eval still needs its assertion", false,
`metadata:
  evals:
    - id: needs-eyes
      grader: human`],

  ["N13 weight zero is a silent disable; skip says it loudly", false,
`metadata:
  evals:
    - id: weightless
      assertion: Something.
      weight: 0`],

  ["N14 a page-side target member on a session", false,
`metadata:
  evals:
    - id: wrong-subject
      assertion: Something.
      target: body`],

  ["N15 an unrecognized metadata eval-* key is a typo, not an extension", false,
`metadata:
  eval-skipp: true
  evals:
    - The session followed the skill.`],

  ["18 the core version declaration, nested as artifacts nest the trio", true,
`metadata:
  docmeta-vocabularies:
    evals: 1.0.0-proposal.2
  evals:
    - The session followed the skill.`],

  ["N16 a mis-cased family name in the declaration", false,
`metadata:
  docmeta-vocabularies:
    Evals: 1.0.0-proposal.2
  evals:
    - The session followed the skill.`],

  ["N17 a version that is not a string", false,
`metadata:
  docmeta-vocabularies:
    evals: 1
  evals:
    - The session followed the skill.`],
];

let bad = 0;
for (const [name, expectValid, yamlText] of cases) {
  const ok = validate(parse(yamlText));
  const verdict = ok === expectValid ? "OK " : "UNEXPECTED";
  if (ok !== expectValid) bad++;
  const detail =
    !ok && expectValid === false
      ? ` (fails as intended: ${validate.errors?.[0]?.instancePath || "/"} ${validate.errors?.[0]?.message})`
      : ok === false
        ? ` errors: ${JSON.stringify(validate.errors?.slice(0, 3))}`
        : "";
  console.log(`${verdict} ${name}${detail}`);
}
process.exit(bad ? 1 : 0);
