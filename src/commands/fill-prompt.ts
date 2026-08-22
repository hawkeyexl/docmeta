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
import type { Candidate, ProposalSet } from "./fill-types.js";

/**
 * Part of the cache key: bump whenever the prompt wording or the envelope
 * schema construction changes, so stale proposals are not replayed.
 */
export const FILL_PROMPT_VERSION = 3;

/**
 * Characters of document sent per inference call.
 *
 * This was the point at which the document stopped being read: anything past it
 * was replaced with `[body truncated]`, so a long reference page was described
 * from its introduction and its own conclusion was never seen. Same number, but
 * it now bounds a *chunk* — the whole file is sent, in as many calls as it takes.
 *
 * It is docmeta's budget rather than the model's because no per-model input
 * context size is discoverable: the inference catalog publishes `uri`,
 * `sizeBytes`, `license` and tier, and its `maxTokens` is an *output* cap. So
 * overflow cannot be predicted, only hit — which is why the caller treats a
 * provider overflow as a signal to shrink this and retry, rather than trying to
 * compute the right value up front.
 */
export const DEFAULT_CHUNK_CHARS = 12000;

/**
 * Split a document into chunks of at most `chunkChars`.
 *
 * Splits on a line boundary when there is one inside the budget, so a chunk
 * rarely ends mid-sentence; a single line longer than the budget is cut anyway,
 * because a minified file has no boundary to prefer. Concatenating the result
 * reproduces the input exactly — the test asserts that, because "the whole file
 * is sent" is the entire point of the change.
 */
export function splitBody(body: string, chunkChars: number): string[] {
  if (body.length <= chunkChars) return [body];
  const chunks: string[] = [];
  let at = 0;
  while (at < body.length) {
    const end = Math.min(at + chunkChars, body.length);
    let cut = end;
    if (end < body.length) {
      const nl = body.lastIndexOf("\n", end - 1);
      // Only honour the boundary if it makes progress; otherwise the line is
      // longer than the budget and there is nothing to prefer.
      if (nl > at) cut = nl + 1;
    }
    chunks.push(body.slice(at, cut));
    at = cut;
  }
  return chunks;
}

/**
 * Combine per-chunk proposals, keeping the most confident value for each key.
 *
 * Confidence is already the accept/reject axis — `gate()` compares each
 * proposal against the threshold — so choosing between two proposals spends the
 * same currency once more rather than introducing a second one. (It is a
 * threshold, not a ranking: this is the first place two proposals are compared
 * against each other.) A value found in a page's conclusion therefore competes
 * on equal terms with one guessed from its introduction, which is the whole
 * point of reading past the first chunk. Ties keep the earlier chunk —
 * arbitrary, but stable across runs.
 */
export function mergeProposals(sets: ProposalSet[]): ProposalSet {
  const merged: ProposalSet = {};
  for (const set of sets) {
    for (const [key, proposal] of Object.entries(set)) {
      const held = merged[key];
      if (held === undefined || proposal.confidence > held.confidence) {
        merged[key] = proposal;
      }
    }
  }
  return merged;
}

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
  /** Set when the document was split, so the model knows it sees a slice. */
  part?: { index: number; total: number };
}): string {
  const { filePath, existing, candidates, body, part } = params;
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
    part === undefined
      ? "# Page body"
      : `# Page body (part ${part.index} of ${part.total})`,
    body,
  ].join("\n");
}
