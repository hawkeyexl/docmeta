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
// The registered built-ins use `format` (Starlight's `editUrl` is a
// uri-reference, okf's `resource` a uri) and several are lax about `strict`.
// The shipped validator registers ajv-formats and compiles with strict off, so
// this ladder does too: a verdict here should mean what a verdict there means,
// and without these eight built-ins fail to compile and the section reports
// them as findings rather than checking them.
let addFormats = req("ajv-formats");
addFormats = addFormats.default ?? addFormats;

const PROPOSED_ROOT = "docs/proposals/0023/schemas";
// The drafts' semver prerelease, spelled once. Both the file name and the `$id`
// carry it, and a mismatch between the two compiles fine and then looks up
// nothing — which is how a stale copy here reads as "validate is not a
// function" rather than as a failed probe.
const DRAFT_V = "1.0.0-proposal.1";
// Revisions are per family: evals, artifact-evals and core moved to
// proposal.2 for the scoring, targeting and versioning fields; the other six
// had no part in that and stay where they are. One table so the next bump is
// still a one-line edit.
const VERSIONS = {
  core: "1.0.0-proposal.2",
  evals: "1.0.0-proposal.2",
  "artifact-evals": "1.0.0-proposal.2",
};
const vOf = (family) => VERSIONS[family] ?? DRAFT_V;
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
  fs.readFileSync(`${PROPOSED_ROOT}/${name}/${vOf(name)}.json`, "utf8"),
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
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
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
  // No built-in claims a bare `locale` (Open Graph's is `og:locale`), so
  // these pin the family's own shape rather than another claimant's value:
  // one non-empty string, hyphen form recommended and not enforced.
  ["locale: differs from language (en text, de-DE conventions)", { ...base, language: "en", locale: "de-DE" }, "core", false],
  ["locale: Unicode -u- extension keywords", { ...base, locale: "hi-IN-u-nu-deva" }, "core", false],
  ["locale: og:locale underscore form (not enforced)", { ...base, locale: "en_US" }, "core", false],
  ["locale: empty string", { ...base, locale: "" }, "core", true],
  ["locale: list", { ...base, locale: ["en-GB", "en-US"] }, "core", true],
  ["keywords: Antora comma-string", { ...base, keywords: "alpha, beta" }, "core", false],
  ["keywords: Docusaurus/Hugo array", { ...base, keywords: ["alpha", "beta"] }, "core", false],
  ["keywords: Docusaurus empty-string item", { ...base, keywords: [""] }, "core", true],
  ["keywords: Antora empty string", { ...base, keywords: "" }, "core", true],
  ["id: Docusaurus path-shaped id", { ...base, id: "folder/doc" }, "core", false],
  ["id: empty string", { ...base, id: "" }, "core", true],
  ["authors: empty string", { ...base, authors: "" }, "stewardship", true],
  ["authors: empty list", { ...base, authors: [] }, "stewardship", true],
  ["authors: MyST person objects", { ...base, authors: [{ name: "J", orcid: "0000-0002-1825-0097", roles: ["Writing"] }] }, "stewardship", false],
  ["authors: Docusaurus authors.yml key", { ...base, authors: "jdoe" }, "stewardship", false],
  ["authors: Docusaurus mixed list", { ...base, authors: ["jdoe", { name: "J", imageURL: "/j.png" }] }, "stewardship", false],
];

console.log("\n=== law probes (other claimants' extreme legal values vs the proposed owner) ===");
for (const [name, doc, ownerShort, expectReject] of probes) {
  const id = `docmeta:${ownerShort}:${vOf(ownerShort)}`;
  const validate = compiled.get(id);
  if (!validate) {
    // A probe naming an id nothing compiled to is a broken probe, not a pass.
    console.log(`!!! UNRESOLVED  ${name} — no compiled schema for ${id}`);
    findings++;
    continue;
  }
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

// 3. Envelope keys: the companion vocabularies' top-level claims must survive
// alongside every built-in a page could realistically stack them with.
//
// This used to assert that *no* built-in may claim these keys at all, and that
// was the wrong test. It is not the composability law — which is about whether
// two claimants' *values* agree (section 2's method), not about whether a name
// appears twice — and this proposal never argued for the stricter rule. It
// also produced a false positive that stood for a while: `metadata` is claimed
// by anthropic:claude-skill:2.1, whose `metadata` is a free-form object, which
// is *exactly* the arrangement docmeta:artifact-evals is designed around ("an
// artifact's top level is the host tool's contract and `metadata` is its
// sanctioned extension bag"). The overlap there is the design working, not a
// collision.
//
// So the test now asks the real question: does adding the envelope key to a
// document break the other claimant? Errors are compared before and after, and
// only a new error pointing *at that key* counts.
//
// One precondition first. A schema sealed against the family's own floor
// composes with nothing docmeta publishes — docmeta:core requires `title`, so a
// root that forbids unknown keys and does not declare `title` can never be
// stacked with any of the nine. Per-key probes against such a schema report a
// conflict for every key, which says nothing about the key. Those are named and
// set aside with the reason, rather than silently skipped or counted.
console.log("\n=== envelope keys vs current built-ins ===");

/** One legal value per envelope key, exercising the shape the schema allows. */
const ENVELOPE_VALUES = {
  evals: [{ id: "cites-a-source", assertion: "must cite a source" }],
  "eval-suite": "house-suite",
  "eval-skip": true,
  "eval-provenance": [{ "generated-by": "claude-opus-5" }],
  kg: { label: "Configuration" },
  metadata: {
    evals: [{ id: "used-the-tool", assertion: "must call the search tool" }],
    "eval-skip": false,
  },
};

/** Errors the schema raises for a document, as instancePath+keyword pairs. */
function errorsFor(validate, doc) {
  validate(doc);
  return (validate.errors ?? []).map((e) => `${e.instancePath}|${e.keyword}|${e.params?.additionalProperty ?? ""}`);
}

/**
 * Can this built-in be stacked with the docmeta family at all? Probed, not
 * assumed: add the family's own required floor and see whether the schema
 * rejects the key itself.
 */
function sealedAgainstTheFamily(validate) {
  const before = new Set(errorsFor(validate, {}));
  return errorsFor(validate, { title: "T" }).some(
    (e) => !before.has(e) && e.includes("|additionalProperties|title"),
  );
}

const compiledOthers = others.map((s) => {
  try {
    return { id: s.$id, validate: ajv.compile(s) };
  } catch (err) {
    // A built-in that will not compile is a finding in its own right, not a
    // reason to report the envelope keys as clear.
    console.log(`!!! ${s.$id} failed to compile: ${err.message}`);
    findings++;
    return null;
  }
}).filter(Boolean);

const sealed = compiledOthers.filter((o) => sealedAgainstTheFamily(o.validate));
for (const o of sealed) {
  console.log(
    `${o.id}: sealed root — rejects docmeta:core's own \`title\`, so it composes with no vocabulary in this family. Per-key probes below skip it.`,
  );
}
const stackable = compiledOthers.filter((o) => !sealed.includes(o));

for (const [key, value] of Object.entries(ENVELOPE_VALUES)) {
  const conflicts = [];
  for (const { id, validate } of stackable) {
    const before = new Set(errorsFor(validate, {}));
    const introduced = errorsFor(validate, { [key]: value }).filter(
      (e) => !before.has(e) && (e.startsWith(`/${key}`) || e.includes(`|${key}`)),
    );
    if (introduced.length) conflicts.push(`${id} (${introduced[0]})`);
  }
  const alsoClaims = stackable
    .filter(({ validate }) => {
      const s = others.find((o) => o.$id === validate.schema.$id);
      return Object.prototype.hasOwnProperty.call(s?.properties ?? {}, key);
    })
    .map((o) => o.id);
  if (conflicts.length) findings += conflicts.length;
  const note = alsoClaims.length
    ? ` (also claimed, compatibly, by ${alsoClaims.join(", ")})`
    : "";
  console.log(
    `${key}: ${conflicts.length ? `CONFLICTS with ${conflicts.join(", ")} — violation` : `clear${note}`}`,
  );
}

// The one detail worth carrying even though it is not a finding: inside the
// sealed set, agentskills:skill:1.0 declares `metadata` as a map of strings, so
// of docmeta:artifact-evals' shapes only the single-assertion string shorthand
// would fit it. That is moot while the same schema also forbids `title` — the
// pair can never validate one document — but it is the thing to re-check if the
// standard ever opens its root.
console.log(
  "\nnote: agentskills:skill:1.0 types `metadata` as a string map, so only artifact-evals'",
);
console.log(
  "      single-assertion shorthand would fit it. Moot while its root also forbids `title`.",
);

console.log(`\nunexpected findings: ${findings}`);
process.exit(findings ? 1 : 0);
