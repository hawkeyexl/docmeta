/**
 * Prompt and schema construction for `fill`.
 *
 * The central idea is the **envelope schema**: rather than asking the model for
 * free-form values and checking them afterwards, each candidate property's own
 * subschema is lifted verbatim out of the document schema and wrapped in a
 * `{ value, confidence, reasoning }` object. The provider is then constrained to
 * emit something that already satisfies the user's schema, and the response is
 * validated against it before `fill` ever sees it. A malformed `date-time` or a
 * number where a string belongs never reaches the confidence gate at all — which
 * is what lets confidence be the *last* check rather than the only one.
 */
import type { Candidate } from "./fill-types.js";

/**
 * Part of the cache key: bump whenever the prompt wording or the envelope
 * schema construction changes, so stale proposals are not replayed.
 */
export const FILL_PROMPT_VERSION = 2;

/** Characters of document body sent to the model. */
export const BODY_CHAR_LIMIT = 12000;

export const FILL_SYSTEM_PROMPT = [
  "You infer document metadata from the document itself.",
  "",
  "You are given a page's existing metadata, the JSON Schema properties that are",
  "missing or currently invalid, and the page body. Propose a value for each",
  "property you can determine from the page.",
  "",
  "Rules:",
  "- Base every value on evidence in the page. Never invent facts, URLs, dates,",
  "  authors, or identifiers that the page does not support.",
  "- Omit a property entirely rather than guessing at it. A missing property is a",
  "  normal, expected outcome.",
  "- Report an honest confidence between 0 and 1 that the value is correct and",
  "  that a careful human reviewer would agree with it. Do not inflate it.",
  "  Reserve values above 0.9 for values the page states plainly.",
  "- Keep `reasoning` to one sentence naming the evidence you used.",
  "- Match each property's described purpose, not just its type.",
].join("\n");

/** JSON Schema for one proposal, wrapping the target property's own subschema. */
function proposalSchema(candidate: Candidate): Record<string, unknown> {
  const described =
    typeof candidate.subschema.description === "string"
      ? candidate.subschema.description
      : undefined;
  return {
    type: "object",
    additionalProperties: false,
    required: ["value", "confidence", "reasoning"],
    description: described
      ? `Proposed value for "${candidate.key}": ${described}`
      : `Proposed value for "${candidate.key}".`,
    properties: {
      value: candidate.subschema,
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Honest self-reported confidence that this value is correct. Do not inflate.",
      },
      reasoning: {
        type: "string",
        description: "One sentence naming the evidence in the page.",
      },
    },
  };
}

/**
 * Build the response schema for one file. Every candidate is optional so the
 * model can decline; `additionalProperties: false` means it cannot invent keys.
 * `$defs` from the source schemas are carried along so any `$ref` inside a
 * lifted subschema still resolves.
 */
export function buildEnvelopeSchema(
  candidates: Candidate[],
  defs: { $defs: Record<string, unknown>; definitions: Record<string, unknown> },
): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    // Both blocks are reproduced under their original names so a lifted
    // subschema's `$ref` — `#/$defs/X` on 2020-12, `#/definitions/X` on
    // draft-07 — still resolves against the envelope root.
    ...(Object.keys(defs.$defs).length > 0 ? { $defs: defs.$defs } : {}),
    ...(Object.keys(defs.definitions).length > 0
      ? { definitions: defs.definitions }
      : {}),
    properties: Object.fromEntries(
      candidates.map((c) => [c.key, proposalSchema(c)]),
    ),
  };
}

export function buildUserPrompt(params: {
  filePath: string;
  existing: Record<string, unknown>;
  candidates: Candidate[];
  body: string;
}): string {
  const { filePath, existing, candidates, body } = params;
  const truncated = body.length > BODY_CHAR_LIMIT;
  const wanted = candidates.map((c) => {
    const description =
      typeof c.subschema.description === "string"
        ? ` — ${c.subschema.description}`
        : "";
    const why = c.present
      ? "currently invalid, propose a replacement"
      : "missing";
    return `- ${c.key} (${why})${description}`;
  });

  return [
    `# File`,
    filePath,
    "",
    "# Existing metadata",
    Object.keys(existing).length > 0
      ? JSON.stringify(existing, null, 2)
      : "(none)",
    "",
    "# Properties to propose",
    ...wanted,
    "",
    "# Page body",
    truncated
      ? `${body.slice(0, BODY_CHAR_LIMIT)}\n\n[body truncated]`
      : body,
  ].join("\n");
}
