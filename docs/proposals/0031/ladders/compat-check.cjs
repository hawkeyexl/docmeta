// Composability cross-check: the three proposed content-strategy vocabularies
// against every current built-in in src/schemas AND the nine drafts of
// proposal 0023. Three questions, all wired to the exit code so this cannot
// fail open:
//
//   1. Which keys do the three share with anything else, and with what?
//   2. For each shared key, does the proposed owner accept the other
//      claimants' most extreme legal values? (A REJECT is either a recorded
//      design exception or a bug.)
//   3. Does a real strategy document still validate when the three are
//      stacked with the schemas a repo actually runs — Starlight, okf,
//      Diataxis, DCMI, the 0023 family?
//
// Run from the repo root:
//   node docs/proposals/0031/ladders/compat-check.cjs
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const req = createRequire(process.cwd() + "/");
let Ajv = req("ajv/dist/2020.js");
Ajv = Ajv.default ?? Ajv;
// The registered built-ins use `format` (Starlight's `editUrl` is a
// uri-reference), and the shipped validator registers ajv-formats. Without it
// this script throws on compile rather than reporting a verdict, which would
// be a fail-open dressed as a crash.
let addFormats = req("ajv-formats");
addFormats = addFormats.default ?? addFormats;

const V = "1.0.0-proposal.1";
const PROPOSED_DIRS = ["audience-profile", "persona", "journey"];
const FAMILY_DIRS = [
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

const proposed = PROPOSED_DIRS.map((n) =>
  JSON.parse(fs.readFileSync(`docs/proposals/0031/schemas/${n}/${V}.json`, "utf8")),
);
const family = FAMILY_DIRS.map((n) =>
  JSON.parse(fs.readFileSync(`docs/proposals/0023/schemas/${n}/${V}.json`, "utf8")),
);
// Everything under src/schemas is a real registered built-in — no
// hand-maintained skip set to drift.
const builtins = loadDir("src/schemas");
const others = [...builtins, ...family];

console.log(
  `proposed ids: ${proposed.length}; compared against ${builtins.length} registered built-ins + ${family.length} proposal-0023 drafts\n`,
);

// ── 1. Overlap map ──────────────────────────────────────────────────────
// Within the trio, a shared key is legal by design (they never judge the
// same document), so it is reported rather than counted as a finding.
const owners = new Map(); // key -> [proposed $id]
for (const s of proposed) {
  for (const k of Object.keys(s.properties ?? {})) {
    if (!owners.has(k)) owners.set(k, []);
    owners.get(k).push(s.$id);
  }
}
console.log("=== keys shared inside the trio (legal: each is wired to its own directory) ===");
for (const [k, ids] of [...owners.entries()].sort()) {
  if (ids.length > 1) console.log(`${k}  ${ids.join(", ")}`);
}

const overlaps = new Map(); // key -> [other ids]
for (const s of others) {
  for (const k of Object.keys(s.properties ?? {})) {
    if (owners.has(k)) {
      if (!overlaps.has(k)) overlaps.set(k, []);
      overlaps.get(k).push(s.$id);
    }
  }
}
console.log("\n=== keys shared with anything outside the trio ===");
if (overlaps.size === 0) console.log("(none)");
for (const [k, ids] of [...overlaps.entries()].sort()) {
  console.log(`${k}  (claimed in the trio by: ${owners.get(k).join(", ")})\n    also claimed by: ${ids.join(", ")}`);
}

/**
 * The narrowing allowance. `id` is the only key the trio may re-claim from
 * another schema, and only in the tightening direction. Anything else showing
 * up above is a design violation, not a note — so it is wired to the exit
 * code rather than printed and forgotten.
 */
const ALLOWED_SHARED = ["id"];
const unexpectedShared = [...overlaps.keys()].sort().filter((k) => !ALLOWED_SHARED.includes(k));
if (unexpectedShared.length) {
  console.log(`\n!!! keys shared outside the allowance: ${unexpectedShared.join(", ")}`);
  findings += unexpectedShared.length;
} else {
  console.log(`\nallowance holds: the only externally-claimed key is ${ALLOWED_SHARED.join(", ")}`);
}
const trioOnly = [...owners.keys()].filter((k) => !overlaps.has(k));
console.log(`trio-only keys (no other claimant anywhere): ${trioOnly.length} of ${owners.size}`);

// ── 2. Law probes ───────────────────────────────────────────────────────
// The other claimants' extreme legal values, thrown at the proposed owner of
// each shared key, plus the values the trio's own claimed-but-unshared keys
// would receive from a neighbouring vocabulary's habits.
// Same options the shipped validator uses (src/core/validator.ts), so a
// verdict here means what a verdict there means.
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const compiled = new Map(proposed.map((s) => [s.$id, ajv.compile(s)]));
const AUD = `docmeta:audience-profile:${V}`;
const PER = `docmeta:persona:${V}`;
const JRN = `docmeta:journey:${V}`;

const audBase = { id: "aud-x" };
const perBase = { id: "persona-x", role: "Writer" };
const jrnBase = {
  id: "cuj-x",
  trigger: "T",
  "success-criteria": "S",
  steps: [{ stage: "One" }],
};

const probes = [
  // `id` — the one key the trio re-claims. Every other claimant's legal
  // spellings must survive, or the narrowing was not a narrowing.
  ["id: Docusaurus path-shaped id", AUD, { ...audBase, id: "folder/doc" }, false],
  ["id: Hugo slug", PER, { ...perBase, id: "dana-docs-manager" }, false],
  ["id: DCMI URI identifier", JRN, { ...jrnBase, id: "https://example.org/cuj/1" }, false],
  ["id: empty string (core's floor, restated)", AUD, { ...audBase, id: "" }, true],
  ["id: absent (core leaves it optional; the trio does not)", AUD, {}, true],
  ["id: numeric, as a bare YAML scalar would parse", PER, { ...perBase, id: 12 }, true],

  // `type` is claimed by four other schemas and by NONE of the trio. These
  // probes are the proof that dropping the constant bought stackability:
  // every value the registry's `type` claimants require must pass here.
  ["type: Diataxis enum value passes untouched", AUD, { ...audBase, type: "how-to" }, false],
  ["type: okf free string passes untouched", PER, { ...perBase, type: "concept" }, false],
  ["type: DCMI repeated-element array passes untouched", JRN, { ...jrnBase, type: ["Text"] }, false],
  ["type: absent entirely (the trio never requires it)", JRN, jrnBase, false],

  // Keys the trio owns alone, probed with the shapes the family's own
  // stringList habits produce — the single-string shorthand must work
  // everywhere a list does, or values stop porting between altitudes.
  ["needs: single-string shorthand", AUD, { ...audBase, needs: "sso" }, false],
  ["needs: list", PER, { ...perBase, needs: ["sso", "roi"] }, false],
  ["needs: empty list (the 0023 empty-list hole)", AUD, { ...audBase, needs: [] }, true],
  ["expertise: single-string shorthand", PER, { ...perBase, expertise: "git" }, false],
  ["evidence: unrecognized source, per the open-enum idiom", JRN, { ...jrnBase, evidence: "win-loss-reviews" }, false],
  ["evidence-strength: outside the closed ladder", JRN, { ...jrnBase, "evidence-strength": "great" }, true],

  // The 0023 family's own keys, on a strategy document. None is claimed by
  // the trio, so all must pass through untouched — this is what "reuse,
  // don't re-claim" has to mean in practice.
  ["family: personas/journeys/audiences ride through", PER, { ...perBase, personas: ["p"], journeys: ["j"], audiences: "aud-x" }, false],
  ["family: stewardship keys ride through", AUD, { ...audBase, owner: "o", "last-reviewed": "2026-08-20", "review-interval": "P180D" }, false],
  ["family: lifecycle keys ride through", AUD, { ...audBase, lifecycle: "archived", "replaced-by": "aud-y" }, false],
  ["family: structure's prerequisites is NOT shadowed by expertise", PER, { ...perBase, prerequisites: ["read-this-first"], expertise: ["git"] }, false],
  ["family: the kg envelope rides through", JRN, { ...jrnBase, kg: { label: "Prove value" } }, false],

  // Generator keys. A strategy document that lives in the docs tree is built
  // by a generator like any other page, so its keys must survive.
  ["generator: Starlight sidebar object", JRN, { ...jrnBase, sidebar: { order: 3, label: "prove-value" } }, false],
  ["generator: Hugo draft flag", AUD, { ...audBase, draft: true }, false],
  ["generator: Docusaurus tags/slug", PER, { ...perBase, tags: ["strategy"], slug: "/personas/dana" }, false],

  // The source corpus's own extra keys must not become violations, or
  // adopting the vocabulary would mean deleting a team's fields first.
  ["source corpus: firmographics/maturity survive as extras", AUD, { ...audBase, firmographics: ["enterprise"], maturity: "enterprise", docs_owner: "team" }, false],
  ["source corpus: team_context survives as an extra", PER, { ...perBase, team_context: "leads 3-50 writers" }, false],

  // The step object is the one closed record. Its closure must be tight and
  // its escape hatch must work.
  ["step: unknown key is caught (the one closure)", JRN, { ...jrnBase, steps: [{ stage: "One", exists: true }] }, true],
  ["step: x- escape is honoured", JRN, { ...jrnBase, steps: [{ stage: "One", "x-issue": "DOCS-1" }] }, false],
];

console.log("\n=== law probes (other claimants' legal values vs the proposed owner) ===");
for (const [name, id, doc, expectReject] of probes) {
  const validate = compiled.get(id);
  if (!validate) {
    console.log(`!!! UNRESOLVED  ${name} — no compiled schema for ${id}`);
    findings++;
    continue;
  }
  const ok = validate(doc);
  const rejected = !ok;
  const asExpected = rejected === expectReject;
  if (!asExpected) findings++;
  const tag = asExpected
    ? rejected
      ? "REJECT (by design)"
      : "PASS              "
    : "!!! UNEXPECTED    ";
  const detail = rejected
    ? ` — ${validate.errors?.[0]?.instancePath || "/"} ${validate.errors?.[0]?.message}`
    : "";
  console.log(`${tag} ${name}${detail}`);
}

// ── 3. Real stacks ──────────────────────────────────────────────────────
// A schema set is only composable if a real document survives every member
// of it at once. These are the sets a repo would plausibly wire.
const byId = new Map([...builtins, ...family, ...proposed].map((s) => [s.$id, s]));
function stackCheck(label, ids, doc, expectValid) {
  const missing = ids.filter((i) => !byId.has(i));
  if (missing.length) {
    console.log(`!!! UNRESOLVED  ${label} — unknown ids: ${missing.join(", ")}`);
    findings++;
    return;
  }
  const failures = [];
  for (const i of ids) {
    const v = ajv.compile(byId.get(i));
    if (!v(doc)) {
      failures.push(`${i} (${v.errors?.[0]?.instancePath || "/"} ${v.errors?.[0]?.message})`);
    }
  }
  const ok = failures.length === 0;
  const asExpected = ok === expectValid;
  if (!asExpected) findings++;
  const tag = asExpected ? (ok ? "STACKS  " : "BLOCKED (by design)") : "!!! UNEXPECTED";
  console.log(`${tag} ${label}${failures.length ? `\n    ${failures.join("\n    ")}` : ""}`);
}

const realPersona = {
  title: "Dana — Documentation Manager",
  description: "Leads 3-50 writers across many products and engineering teams.",
  id: "persona-enterprise-docs-lead",
  type: "explanation",
  audiences: "aud-enterprise-docs-team",
  journeys: ["cuj-prove-value"],
  role: "Manager/Director of Documentation",
  expertise: ["docs-as-code", "docs-ops"],
  goals: ["Keep a large corpus current without new headcount"],
  pains: ["Cannot see what changed across many repos"],
  needs: ["security-and-self-host"],
  evidence: ["customer-interviews"],
  "evidence-strength": "strong",
  owner: "content-strategy",
  "last-reviewed": "2026-08-20",
  sidebar: { order: 2, label: "Dana" },
};

console.log("\n=== real stacks (one document, every schema in the set) ===");
stackCheck(
  "persona + the whole 0023 family",
  [`docmeta:persona:${V}`, ...family.map((s) => s.$id).filter((i) => !i.includes("artifact-evals"))],
  realPersona,
  true,
);
stackCheck(
  "persona + core + Starlight + okf",
  [`docmeta:persona:${V}`, `docmeta:core:${V}`, "astro:starlight:0.41", "google:okf:0.1"],
  realPersona,
  true,
);
stackCheck(
  "persona + Diataxis (type: explanation) — the stack a const type would have broken",
  [`docmeta:persona:${V}`, "diataxis:diataxis:1.0"],
  realPersona,
  true,
);
stackCheck(
  "persona + DCMI",
  [`docmeta:persona:${V}`, "dcmi:elements:1.1"],
  realPersona,
  true,
);
stackCheck(
  "journey + core + Starlight + okf",
  [`docmeta:journey:${V}`, `docmeta:core:${V}`, "astro:starlight:0.41", "google:okf:0.1"],
  {
    title: "Demonstrate docs-team value",
    description: "The make-the-case-upward journey.",
    id: "cuj-prove-value",
    type: "explanation",
    personas: ["persona-enterprise-docs-lead"],
    trigger: "Leadership wants proof.",
    "success-criteria": "The champion can report merged doc PRs.",
    "entry-point": "/docs/using-the-web-interface",
    steps: [{ stage: "See activity", doc: "/docs/using-the-web-interface", coverage: "partial" }],
  },
  true,
);
stackCheck(
  "the trio stacked on one document — still mutually exclusive, now by `required`",
  [`docmeta:audience-profile:${V}`, `docmeta:persona:${V}`, `docmeta:journey:${V}`],
  realPersona,
  false,
);

// ── 4. The counterfactual ───────────────────────────────────────────────
// An earlier draft pinned `type` to a constant so a misfiled document would
// fail by name. This reconstructs that draft and shows what it cost, so the
// claim in proposal 0031 is evidence rather than an assertion. If a future
// revision reintroduces the constant, this block turns red and says why.
console.log("\n=== counterfactual: what a `const type` would have cost ===");
const withConstType = {
  ...byId.get(`docmeta:persona:${V}`),
  $id: "counterfactual:persona-with-const-type:1.0",
  properties: {
    ...byId.get(`docmeta:persona:${V}`).properties,
    type: { const: "persona" },
  },
  required: ["id", "role", "type"],
};
byId.set(withConstType.$id, withConstType);
for (const [label, otherId, doc] of [
  ["Diataxis (type: explanation)", "diataxis:diataxis:1.0", realPersona],
  ["okf (type: concept)", "google:okf:0.1", { ...realPersona, type: "concept" }],
  ["DCMI (repeated type)", "dcmi:elements:1.1", { ...realPersona, type: ["Text"] }],
]) {
  const mine = ajv.compile(withConstType);
  const theirs = ajv.compile(byId.get(otherId));
  const mineOk = mine(doc);
  const theirsOk = theirs(doc);
  // The pair is unstackable exactly when each schema alone is satisfiable by
  // some document but no single document satisfies both.
  const verdict = mineOk && theirsOk ? "would have stacked" : "UNSTACKABLE";
  console.log(
    `${verdict.padEnd(18)} const-type persona + ${label}` +
      (mineOk ? "" : `\n    const-type persona rejects it: ${mine.errors?.[0]?.instancePath} ${mine.errors?.[0]?.message}`) +
      (theirsOk ? "" : `\n    ${otherId} rejects it: ${theirs.errors?.[0]?.instancePath} ${theirs.errors?.[0]?.message}`),
  );
}
// The shipped trio must stack with all three. That is the whole point.
for (const [label, otherId, doc] of [
  ["Diataxis", "diataxis:diataxis:1.0", realPersona],
  ["okf", "google:okf:0.1", { ...realPersona, type: "concept" }],
  ["DCMI", "dcmi:elements:1.1", { ...realPersona, type: ["Text"] }],
]) {
  stackCheck(`as shipped: persona + ${label}`, [`docmeta:persona:${V}`, otherId], doc, true);
}

console.log(`\nunexpected findings: ${findings}`);
process.exit(findings ? 1 : 0);
