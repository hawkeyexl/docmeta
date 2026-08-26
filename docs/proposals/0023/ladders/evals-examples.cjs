// Validate the docmeta:evals:1.0 example ladder against the draft schema,
// without registering anything. Run from the worktree root.
const fs = require("fs");
const { createRequire } = require("module");
const req = createRequire(process.cwd() + "/");
let Ajv = req("ajv/dist/2020.js");
Ajv = Ajv.default ?? Ajv;
const { parse } = req("yaml");

const schema = JSON.parse(
  fs.readFileSync("docs/proposals/0023/schemas/evals/1.0.json", "utf8"),
);
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validate = ajv.compile(schema);

const cases = [
  ["1 single-string shorthand", true,
`evals: The documented install command matches the current package name.`],

  ["2 list shorthand", true,
`evals:
  - The install command is \`npm i -g docmeta\`.
  - The stated Node minimum is 24 or later.`],

  ["3 mixed list with config references", true,
`evals:
  - use: no-future-promises
  - use: readable
    severity: warning
  - The exit codes table lists 0, 1, and 2.`],

  ["4 flat suite assignment", true,
`eval-suite: how-to
evals:
  - Screenshots show the current UI.`],

  ["5 suite alone, no page evals", true,
`eval-suite: reference`],

  ["6 page skipped", true,
`eval-skip: true`],

  ["7 ai judge (default grader), fully aimed", true,
`eval-suite: reference
evals:
  - id: flags-current
    assertion: Every flag in the table exists in the CLI help output.
    type: regression
    evidence: The flags table under "Options"
    examples:
      pass: Table lists --as, --ext, --exclude; help shows all three.
      fail: Table lists --in, which the CLI no longer accepts.`],

  ["8 ai judge with an explicit provider (agent)", true,
`evals:
  - id: install-works-clean
    assertion: The install steps produce a working CLI on a clean machine.
    grader: ai
    provider: claude-cli
    type: capability
    severity: warning`],

  ["9 command, authored for generation (no command yet)", true,
`evals:
  - id: has-examples-heading
    assertion: The page includes an Examples heading.
    grader: command`],

  ["9b command, after generation writes back", true,
`evals:
  - id: has-examples-heading
    assertion: The page includes an Examples heading.
    grader: command
    command: ["node", "docevals/install.has-examples-heading.mjs", "{file}"]
    generated-assertion-hash: 07d185732a48ace07056e847b0fadd72fa35f830f7b793f2790db1a59182fd7a`],

  ["10 command, explicit, maximal", true,
`evals:
  - id: links-resolve
    assertion: Every link on the page resolves.
    grader: command
    command: ["npx", "linkinator", "{file}"]
    success-exit-codes: [0, 2]
    timeout-ms: 45000
    type: regression
    severity: warning`],

  ["11 human, maximal", true,
`evals:
  - id: screenshots-current
    assertion: The screenshots match the current product UI.
    grader: human
    evidence: Images under "Configure the dashboard"
    severity: warning`],

  ["12 tool graders, maximal spread", true,
`evals:
  - id: fresh-enough
    assertion: Page was reviewed within the last half year.
    grader: tool:freshness
    options:
      field: last-reviewed
      maxAgeDays: 180
    severity: warning
  - id: follows-template
    grader: tool:doc-structure-lint
    options:
      template: how-to
      templatePath: templates.yaml
  - id: house-style
    grader: tool:vale
    options:
      command: ["vale", "--output=JSON", "--config", ".vale.ini"]
    severity-map:
      suggestion: info
      warning: info
  - id: distinct-from-siblings
    grader: tool:differentiation
    options:
      scope: "docs/reference/actions/*.md"
      maxSimilarity: 0.8`],

  ["13 eval-provenance: fill's trail, retired by humans as they review", true,
`eval-provenance:
  - generated-by: claude-fable-5
    evals: [install-verified, eks-coverage]
    confidence:
      install-verified: 0.88
      eks-coverage: 0.74
evals:
  - id: install-verified
    assertion: The Helm install steps produce a Ready operator pod.`],

  ["14 anchor examples widen to lists", true,
`evals:
  - id: multi-anchor
    assertion: The page's flags table matches the CLI.
    examples:
      pass:
        - Table lists --as, --ext, --exclude; help shows all three.
        - Table and help agree after a new flag lands in both.
      fail: Table lists --in, which the CLI no longer accepts.`],

  ["N1 the 0.1 object form now fails loudly", false,
`evals:
  suite: how-to
  generatedBy: gpt-5
  evals:
    - Something.`],

  ["N2 misspelled field inside an entry", false,
`evals:
  - id: typo-demo
    assertion: Something.
    severty: error`],

  ["N3 ai grader without an assertion", false,
`evals:
  - id: judged-but-empty
    grader: ai`],

  ["N4 the old llm spelling no longer matches the grader pattern", false,
`evals:
  - id: yesterdays-spelling
    assertion: Something.
    grader: llm`],

  ["N5 human grader without an assertion", false,
`evals:
  - id: review-something
    grader: human`],

  ["N6 eval-skip must be a boolean, not a string", false,
`eval-skip: "true"`],

  ["N7 an eval-provenance entry without generated-by", false,
`eval-provenance:
  - evals: [something]`],

  ["N8 the old generated wrapper now fails (flattened to generated-assertion-hash)", false,
`evals:
  - id: has-examples-heading
    assertion: The page includes an Examples heading.
    grader: command
    command: ["node", "docevals/x.mjs", "{file}"]
    generated:
      assertion-hash: 07d185732a48ace07056e847b0fadd72fa35f830f7b793f2790db1a59182fd7a`],

  ["N9 exit codes on an ai grader (command-family fields need grader: command)", false,
`evals:
  - id: wrong-family
    assertion: Something.
    grader: ai
    success-exit-codes: [0]`],

  ["N10 a hash without its command (half write-back)", false,
`evals:
  - id: orphan-hash
    assertion: Something.
    grader: command
    generated-assertion-hash: 07d185732a48ace07056e847b0fadd72fa35f830f7b793f2790db1a59182fd7a`],
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
