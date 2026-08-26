// Composability cross-check: the nine proposed docmeta vocabularies against
// every current built-in in src/schemas (plus PR #117's four when their
// copies are supplied as argv[2]). For each shared key, probes the proposed
// schema with the other claimant's most extreme legal value — a REJECT is
// either a recorded design exception (proposal 0023 names them all) or a bug.
// Any violated invariant is wired to the exit code: this script cannot fail
// open. Run from the repo root:
//   node docs/proposals/0023/ladders/compat-check.cjs [path-to-pr117-schemas]
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const req = createRequire(process.cwd() + "/");
let Ajv = req("ajv/dist/2020.js");
Ajv = Ajv.default ?? Ajv;

const PROPOSED_ROOT = "docs/proposals/0023/schemas";
const PROPOSED_DIRS = [
  "core", "stewardship", "audience", "lifecycle", "structure", "ai-context",
  "evals", "kg", "artifact-evals",
];

let findings = 0;

function loadDir(root) {
  const out = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(root, d.name))) {
      if (!f.endsWith(".json")) continue;
      const s = JSON.parse(fs.readFileSync(path.join(root, d.name, f), "utf8"));
      if (s.$id) out.push(s);
    }
  }
  return out;
}

const proposed = PROPOSED_DIRS.map((name) => JSON.parse(
  fs.readFileSync(`${PROPOSED_ROOT}/${name}/1.0.json`, "utf8"),
));
// The drafts live outside src/schemas, so everything there is a real
// registered built-in — no hand-maintained skip set to drift.
const current = loadDir("src/schemas");
const pr117Path = process.argv[2];
let pr117 = [];
if (pr117Path !== undefined) {
  if (!fs.existsSync(pr117Path)) {
    // An explicitly requested comparison set that cannot be read is a
    // failure, not a silent downgrade to a smaller check.
    console.error(`PR #117 schema path not found: ${pr117Path}`);
    process.exit(2);
  }
  pr117 = loadDir(pr117Path);
} else {
  console.log("note: PR #117 schema copies not supplied; checking against src/schemas built-ins only");
}
const others = [...current, ...pr117];
console.log(`proposed ids: ${proposed.length}; current built-ins checked: ${others.length}\n`);

// 1. Overlap map: which proposed keys other built-ins also claim.
const ownerOf = new Map(); // key -> proposed $id
for (const s of proposed) {
  for (const k of Object.keys(s.properties ?? {})) {
    if (ownerOf.has(k)) {
      console.log(`COLLISION inside the family: ${k} claimed by ${ownerOf.get(k)} and ${s.$id}`);
      findings++;
    }
    ownerOf.set(k, s.$id);
  }
}
const overlaps = new Map(); // key -> [other ids]
for (const s of others) {
  for (const k of Object.keys(s.properties ?? {})) {
    if (ownerOf.has(k)) {
      if (!overlaps.has(k)) overlaps.set(k, []);
      overlaps.get(k).push(s.$id);
    }
  }
}
console.log("=== keys shared with current built-ins ===");
for (const [k, ids] of [...overlaps.entries()].sort()) {
  console.log(`${k}  (proposed owner: ${ownerOf.get(k)})  also claimed by: ${ids.join(", ")}`);
}
const proposedOnly = [...ownerOf.keys()].filter((k) => !overlaps.has(k));
console.log(`\nproposed-only keys (no other claimant): ${proposedOnly.length} of ${ownerOf.size} across the nine ids`);

// 2. Law probes: the other claimants' extreme legal values, validated against
// the proposed owner of each shared key. EXPECTED-REJECT entries are the
// recorded design exceptions in proposal 0023; anything else rejecting — or
// any expected exception silently passing — is a finding.
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const compiled = new Map(proposed.map((s) => [s.$id, ajv.compile(s)]));
const base = { title: "T", description: "D" };

const probes = [
  ["title: DCMI repeated-element array", { ...base, title: ["A", "B"] }, "core", true],
  ["title: Docusaurus empty string", { ...base, title: "" }, "core", true],
  ["description: DCMI repeated-element array", { ...base, description: ["A", "B"] }, "core", true],
  ["description: Docusaurus empty string", { ...base, description: "" }, "core", true],
  ["description: Microsoft Learn 75+ chars", { ...base, description: "x".repeat(120) }, "core", false],
  ["type: DCMI repeated-element array", { ...base, type: ["Text"] }, "core", true],
  ["type: Docusaurus/Hugo empty string", { ...base, type: "" }, "core", true],
  ["type: Diataxis enum value", { ...base, type: "how-to" }, "core", false],
  ["type: TGDP template slug", { ...base, type: "api-getting-started" }, "core", false],
  ["type: OKF free string", { ...base, type: "concept" }, "core", false],
  ["language: DCMI repeated-element array", { ...base, language: ["en", "pt"] }, "core", true],
  ["language: DCMI single string", { ...base, language: "en" }, "core", false],
  ["keywords: Antora comma-string", { ...base, keywords: "alpha, beta" }, "core", false],
  ["keywords: Docusaurus/Hugo array", { ...base, keywords: ["alpha", "beta"] }, "core", false],
  ["keywords: Docusaurus empty-string item", { ...base, keywords: [""] }, "core", true],
  ["id: Docusaurus path-shaped id", { ...base, id: "folder/doc" }, "core", false],
  ["id: empty string", { ...base, id: "" }, "core", true],
  ["authors: MyST person objects", { ...base, authors: [{ name: "J", orcid: "0000-0002-1825-0097", roles: ["Writing"] }] }, "core", false],
  ["authors: Docusaurus authors.yml key", { ...base, authors: "jdoe" }, "core", false],
  ["authors: Docusaurus mixed list", { ...base, authors: ["jdoe", { name: "J", imageURL: "/j.png" }] }, "core", false],
];

console.log("\n=== law probes (other claimants' extreme legal values vs the proposed owner) ===");
for (const [name, doc, ownerShort, expectReject] of probes) {
  const id = `docmeta:${ownerShort}:1.0`;
  const validate = compiled.get(id);
  const ok = validate(doc);
  const rejected = !ok;
  const asExpected = rejected === expectReject;
  if (!asExpected) findings++;
  const tag = asExpected
    ? rejected ? "REJECT (recorded exception)" : "PASS"
    : "!!! UNEXPECTED";
  const detail = rejected
    ? ` — ${validate.errors?.[0]?.instancePath || "/"} ${validate.errors?.[0]?.message}`
    : "";
  console.log(`${tag}  ${name}${detail}`);
}

// 3. Envelope keys: the sibling vocabularies' top-level claims must not be
// claimed by any current built-in — and a violation fails the run.
console.log("\n=== envelope keys vs current built-ins ===");
for (const key of ["evals", "eval-suite", "eval-skip", "eval-provenance", "kg", "metadata"]) {
  const claimants = others
    .filter((s) => Object.prototype.hasOwnProperty.call(s.properties ?? {}, key))
    .map((s) => s.$id);
  if (claimants.length) findings++;
  console.log(`${key}: ${claimants.length ? `CLAIMED by ${claimants.join(", ")} — violation` : "unclaimed — clear"}`);
}

console.log(`\nunexpected findings: ${findings}`);
process.exit(findings ? 1 : 0);
