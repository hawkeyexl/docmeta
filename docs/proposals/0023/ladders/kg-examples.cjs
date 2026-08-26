// Validate the docmeta:kg:1.0 example ladder against the draft schema,
// without registering anything. Run from the repo root: node design/kg-examples.cjs
const fs = require("fs");
const { createRequire } = require("module");
const req = createRequire(process.cwd() + "/");
let Ajv = req("ajv/dist/2020.js");
Ajv = Ajv.default ?? Ajv;
const { parse } = req("yaml");

const schema = JSON.parse(fs.readFileSync("docs/proposals/0023/schemas/kg/1.0.json", "utf8"));
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validate = ajv.compile(schema);

const cases = [
  ["1 no kg key at all — files without kg pass", true,
`title: Plain page
description: Nothing graph-related here.`],

  ["2 label alone", true,
`kg:
  label: Configuration`],

  ["3 full SKOS, arrays", true,
`kg:
  label: Configuration
  alt-labels: [config, settings]
  broader: [Administration]
  narrower: [Environment variables]
  related-concepts: [Installation]
  concepts: [reference]`],

  ["4 single-string shorthand on label fields (widening over 0.8)", true,
`kg:
  label: Configuration
  alt-labels: config
  broader: Administration
  concepts: reference`],

  ["5 iiRDS typing, list and single forms", true,
`kg:
  type: task
  applies-to: [SP-X100, SP-X200]
  about-product-lifecycle: deployment
  about-product-aspect: [interface]`],

  ["6 negative scope", true,
`kg:
  applies-to: [SP-X100]
  not-applicable-to: [SP-X300]
  about-product-aspect: [interface]
  not-about-product-aspect: [architecture]`],

  ["7 sections with per-section typing", true,
`kg:
  type: task
  sections:
    install:
      type: reference
      applies-to: SP-X200
      concepts: [installation]
    options:
      not-about-product-aspect: [architecture]`],

  ["8 provenance trail with fields and confidence", true,
`kg:
  label: API keys
  provenance:
    - generated-by: claude-opus-4-6
      fields: [label, type]
      confidence:
        label: 0.92
        type: 0.81`],

  ["9 the 0.8 worked example, translated (capability-fidelity demo)", true,
`title: Configuration Reference
kg:
  label: Configuration
  alt-labels: [config, settings]
  broader: [Administration]
  related-concepts: [Installation]
  concepts: [reference]
  type: reference
  applies-to: [SP-X100, SP-X200]
  about-product-aspect: [interface]
  not-applicable-to: [SP-X300]
  sections:
    options:
      not-about-product-aspect: [architecture]`],

  ["N1 hierarchy without a label (dependentRequired)", false,
`kg:
  alt-labels: [orphaned]`],

  ["N2 the 0.8 camelCase spelling now fails loudly", false,
`kg:
  prefLabel: Configuration`],

  ["N3 kg.generatedBy is gone — top-level generated-by owns it", false,
`kg:
  label: Configuration
  generatedBy: gpt-5`],

  ["N4 the deprecated single-object provenance shape is dropped", false,
`kg:
  label: API keys
  provenance:
    generated-by: claude-opus-4-6`],

  ["N5 a type outside the published iiRDS list", false,
`kg:
  type: tutorial`],

  ["N6 a provenance fields entry using the old spelling", false,
`kg:
  label: X
  provenance:
    - generated-by: m
      fields: [prefLabel]`],

  ["N7 duplicate labels in a list", false,
`kg:
  label: Configuration
  alt-labels: [config, config]`],

  ["N8 the 0.8 field names subjects / softwareSubject now fail", false,
`kg:
  label: Configuration
  subjects: [reference]
  softwareSubject: [interface]`],
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
