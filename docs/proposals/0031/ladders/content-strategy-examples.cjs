// Validate the docmeta:audience-profile / :persona / :journey example ladder
// against the draft schemas, without registering anything. Run from the repo
// root:
//   node docs/proposals/0031/ladders/content-strategy-examples.cjs
//
// Three groups of cases, per schema:
//   * positives — the shapes the vocabulary is for, from minimal to full;
//   * a fidelity case — a real document from the public strategy corpus in
//     Promptless/promptless.ai (docs/content_strategy/), translated into these
//     ids, proving the translation loses nothing;
//   * negatives — including the migration negatives, where the spellings that
//     corpus uses today must fail *loudly* rather than pass as extra keys.
const fs = require("fs");
const { createRequire } = require("module");
const req = createRequire(process.cwd() + "/");
let Ajv = req("ajv/dist/2020.js");
Ajv = Ajv.default ?? Ajv;
const { parse } = req("yaml");

// The drafts' semver prerelease, spelled once per ladder so a bump is a
// one-line edit here rather than a literal buried mid-expression.
const V = "1.0.0-proposal.1";
const load = (name) =>
  JSON.parse(
    fs.readFileSync(`docs/proposals/0031/schemas/${name}/${V}.json`, "utf8"),
  );

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validators = {
  audience: ajv.compile(load("audience-profile")),
  persona: ajv.compile(load("persona")),
  journey: ajv.compile(load("journey")),
};

const cases = [
  // ── docmeta:audience-profile ──────────────────────────────────────────
  ["audience", "A1 minimal — an id alone is a legal segment stub", true,
`id: aud-oss-maintainer`],

  ["audience", "A2 full vocabulary", true,
`id: aud-enterprise-docs-team
traits: [maturity:enterprise, multi-product, procurement-driven]
needs: [release-timing, sso, multi-repo-routing]
evidence: [customer-interviews, prospect-interviews]
evidence-strength: strong`],

  ["audience", "A3 single-string shorthand everywhere a list is allowed", true,
`id: aud-devrel-devex
traits: api-first
needs: agent-friendliness
evidence: prospect-interviews`],

  ["audience", "A4 an org-specific evidence source, outside the recommendations", true,
`id: aud-scaleup-docs-team
evidence: [win-loss-reviews]
evidence-strength: moderate`],

  ["audience", "A5 the segment's own keys survive alongside the claimed ones", true,
`id: aud-brownfield-docs-team
traits: [large-existing-corpus]
segment_lead: rowan
firmographics: [mature-product]`],

  ["audience", "A6 fidelity — enterprise-docs-team, translated from the public corpus", true,
`id: aud-enterprise-docs-team
title: Enterprise documentation team
description: Established docs orgs keeping a sprawling multi-product corpus accurate without adding headcount.
personas: [persona-enterprise-docs-lead]
traits:
  - maturity:enterprise
  - owner:established-docs-team
  - multi-product
  - multi-repo
  - regulated
  - procurement-driven
  - stage:prospect
  - stage:customer
needs:
  - release-timing
  - screenshots
  - self-hosting
  - sso
  - multi-repo-routing
  - localization
  - deep-analysis
  - security-review
evidence: [customer-interviews, prospect-interviews]
evidence-strength: strong`],

  ["audience", "NA1 no id — nothing can reference the segment", false,
`traits: [enterprise]`],

  ["audience", "A7 a Diataxis type rides through untouched — the trio never claims type", true,
`id: aud-enterprise-docs-team
type: explanation
traits: [enterprise]`],

  ["audience", "NA3 blank id cannot anchor a cross-reference", false,
`id: ""`],

  // The recorded hole. With no type constant, the audience schema requires
  // only an id, so a persona filed into audiences/ validates. Pinned as a
  // PASS so the limitation is a known cost rather than a surprise; the other
  // two directions still fail, on their required fields (NP4, NJ9).
  ["audience", "A8 the recorded hole — a persona filed as an audience passes", true,
`id: persona-enterprise-docs-lead
role: Documentation Manager`],

  ["audience", "NA5 empty traits list reads as traits recorded", false,
`id: aud-oss-maintainer
traits: []`],

  ["audience", "NA6 evidence-strength outside the four-rung ladder", false,
`id: aud-oss-maintainer
evidence-strength: pretty-good`],

  ["audience", "NA7 duplicate needs", false,
`id: aud-oss-maintainer
needs: [localization, localization]`],

  // ── docmeta:persona ───────────────────────────────────────────────────
  ["persona", "P1 minimal — an id and the role that makes it a persona", true,
`id: persona-oss-maintainer
role: Project maintainer / core contributor`],

  ["persona", "P2 full vocabulary", true,
`id: persona-scaleup-solo-writer
role: Sole or lead technical writer
expertise: [git-and-prs, markdown, docs-as-code-ssg]
goals:
  - Get told what shipped that needs docs
pains:
  - No reliable signal of what changed
needs: [triggers-setup, screenshots]
evidence: [customer-interviews]
evidence-strength: strong`],

  ["persona", "P3 single-string shorthand on every list", true,
`id: persona-eng-docs-owner
role: Engineer who owns docs
expertise: git-and-ci
goals: Maintain customer-facing docs without hiring a writer
pains: No one owns the queue
needs: auto-assignment`],

  ["persona", "P4 fidelity — Dana, translated from the public corpus", true,
`id: persona-enterprise-docs-lead
title: Dana — Documentation Manager
description: Leads 3–50 writers across many products and engineering teams.
audiences: aud-enterprise-docs-team
journeys:
  - cuj-evaluate-pilot
  - cuj-enterprise-security-review
  - cuj-multi-repo-routing
  - cuj-prove-value
role: "Manager/Director of Documentation (also: Digital CX manager, Docs Engineering lead)"
expertise:
  - docs-as-code
  - ci-release-process
  - security-compliance-vocab
  - docs-ops
  - git-and-prs
goals:
  - Keep a large multi-product corpus current without new headcount
  - Scope drafting to actual releases, avoiding pre-ship and feature-flag noise
  - Pass security, self-host, and SSO review, and procurement
  - Show docs-team efficiency and ROI to leadership
pains:
  - Cannot see what changed across many products, repos, and orgs
  - AI output trust after an underwhelming in-house pilot
  - Legacy CCMS, mid-migration off hosted platforms
needs:
  - multi-repo-routing
  - security-and-self-host
  - sso
  - release-timing-config
  - localization
  - roi-reporting
evidence: [customer-interviews, prospect-interviews]
evidence-strength: strong`],

  ["persona", "NP1 no role — a persona without one is a label", false,
`id: persona-oss-maintainer
goals: [Keep project docs accurate]`],

  ["persona", "NP2 blank role", false,
`id: persona-oss-maintainer
role: ""`],

  ["persona", "NP3 empty goals list reads as goals recorded", false,
`id: persona-oss-maintainer
role: Project maintainer
goals: []`],

  ["persona", "NP4 a journey filed as a persona still fails — on role, not on a type constant", false,
`id: cuj-prove-value
trigger: Leadership wants proof.
success-criteria: The champion can report outcomes.`],

  ["persona", "NP5 a role is one string, not a list of titles", false,
`id: persona-oss-maintainer
role: [Maintainer, Docs lead]`],

  // ── docmeta:journey ───────────────────────────────────────────────────
  ["journey", "J1 minimal — trigger, success criteria, and one step", true,
`id: cuj-oss-onboarding
trigger: An OSS maintainer wants the tool on their project.
success-criteria: The project is connected read-only across its repos.
steps:
  - stage: Understand the OSS program and eligibility`],

  ["journey", "J2 every rung of the coverage ladder, plus notes", true,
`id: cuj-connect-sources
trigger: The champion is ready to wire the tool into their repos.
success-criteria: Triggers fire on real change events without a silent auth failure.
entry-point: /docs/setup-quickstart
steps:
  - stage: Install the source-control app
    doc: /docs/github-integration
    coverage: covered
  - stage: Choose an access scope
    doc: /docs/github-integration#permissions
    coverage: partial
    note: Access-scope guidance is scattered across three pages.
  - stage: Verify the connection is live
    doc: /docs/connection-health
    coverage: missing
    note: No troubleshooting page for silent token expiry.
  - stage: Route across versions
    doc: cuj-multi-repo-routing
    coverage: cross-reference`],

  ["journey", "J3 a step may carry team bookkeeping under the x- escape", true,
`id: cuj-screenshots
trigger: A UI change just invalidated dozens of screenshots.
success-criteria: Screenshots refresh automatically on UI changes.
steps:
  - stage: Authenticate to the app being captured
    coverage: partial
    x-issue: DOCS-4192
    x-owner: rowan`],

  ["journey", "J4 fidelity — cuj-prove-value, translated from the public corpus", true,
`id: cuj-prove-value
title: Demonstrate docs-team value and ROI to leadership
description: The make-the-case-upward journey, for champions who must justify spend or headcount.
personas:
  - persona-scaleup-solo-writer
  - persona-enterprise-docs-lead
  - persona-devrel-owner
  - persona-eng-docs-owner
  - persona-brownfield-docs-lead
trigger: The champion needs to show leadership that the docs function delivers measurable leverage.
entry-point: /docs/using-the-web-interface
success-criteria: The champion can report merged doc PRs, coverage gains, and time saved in a form leadership accepts.
steps:
  - stage: See activity — PRs drafted and merged, coverage
    doc: /docs/using-the-web-interface
    coverage: partial
    note: Activity is visible; the reporting view is unclear.
  - stage: Quantify impact — time saved, freshness, share of doc PRs
    doc: /docs/reporting-and-roi
    coverage: missing
    note: One customer cited the tool as ~40% of doc PRs; there is no reporting page.
  - stage: Export and share results with leadership
    doc: /docs/reporting-and-roi#sharing
    coverage: missing
evidence: [customer-interviews]
evidence-strength: moderate`],

  ["journey", "NJ1 no steps — a journey with no path is a wish", false,
`id: cuj-prove-value
trigger: Leadership wants proof.
success-criteria: The champion can report outcomes.`],

  ["journey", "NJ2 empty steps list reads to a report as fully covered", false,
`id: cuj-prove-value
trigger: Leadership wants proof.
success-criteria: The champion can report outcomes.
steps: []`],

  ["journey", "NJ3 no trigger — two journeys over the same pages are indistinguishable", false,
`id: cuj-prove-value
success-criteria: The champion can report outcomes.
steps:
  - stage: See activity`],

  ["journey", "NJ4 no success criteria — nothing to test the last step against", false,
`id: cuj-prove-value
trigger: Leadership wants proof.
steps:
  - stage: See activity`],

  ["journey", "NJ5 a step that names a document but not the reader's question", false,
`id: cuj-prove-value
trigger: Leadership wants proof.
success-criteria: The champion can report outcomes.
steps:
  - doc: /docs/using-the-web-interface
    coverage: covered`],

  ["journey", "NJ6 migration — the boolean exists flag, whose key is now coverage", false,
`id: cuj-prove-value
trigger: Leadership wants proof.
success-criteria: The champion can report outcomes.
steps:
  - stage: See activity
    doc: /docs/using-the-web-interface
    exists: true`],

  ["journey", "NJ7 migration — coverage: true, the boolean this ladder replaced", false,
`id: cuj-prove-value
trigger: Leadership wants proof.
success-criteria: The champion can report outcomes.
steps:
  - stage: See activity
    coverage: true`],

  ["journey", "NJ8 migration — the ref spelling, now cross-reference", false,
`id: cuj-oss-onboarding
trigger: An OSS maintainer wants the tool on their project.
success-criteria: The project is connected read-only.
steps:
  - stage: Route across versions
    doc: cuj-multi-repo-routing
    coverage: ref`],

  ["journey", "NJ9 a persona filed as a journey fails on all three required facts", false,
`id: persona-enterprise-docs-lead
role: Documentation Manager`],

  ["journey", "J5 a repeated stage is legal — steps is an ordered array, not a label set", true,
`id: cuj-triage-review-queue
trigger: Suggestions are flowing.
success-criteria: The queue is cleared on a sustainable cadence.
steps:
  - stage: Review the queue
  - stage: Review the queue`],

  ["journey", "NJ11 cross-reference with no doc names no journey to follow", false,
`id: cuj-oss-onboarding
trigger: An OSS maintainer wants the tool on their project.
success-criteria: The project is connected read-only.
steps:
  - stage: Route across versions
    coverage: cross-reference`],

  ["journey", "NJ10 a typo in a step key is caught, which is why the step is closed", false,
`id: cuj-prove-value
trigger: Leadership wants proof.
success-criteria: The champion can report outcomes.
steps:
  - stage: See activity
    covergae: covered`],
];

let bad = 0;
for (const [which, name, expectValid, yamlText] of cases) {
  const validate = validators[which];
  const ok = validate(parse(yamlText));
  const verdict = ok === expectValid ? "OK " : "UNEXPECTED";
  if (ok !== expectValid) bad++;
  const detail =
    !ok && expectValid === false
      ? ` (fails as intended: ${validate.errors?.[0]?.instancePath || "/"} ${validate.errors?.[0]?.message})`
      : ok === false
        ? ` errors: ${JSON.stringify(validate.errors?.slice(0, 3))}`
        : "";
  console.log(`${verdict} ${which.padEnd(8)} ${name}${detail}`);
}
process.exit(bad ? 1 : 0);
