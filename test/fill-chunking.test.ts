/**
 * Body chunking.
 *
 * `fill` used to send the first 12,000 characters and append `[body truncated]`,
 * so a long reference page was described from its introduction and its
 * conclusion was never read. The limit is now a *chunk size*: the whole file is
 * sent, in as many calls as it takes.
 *
 * The constraint that shapes this is that no per-model input context size is
 * discoverable — the inference catalog publishes `sizeBytes` and tiers, and its
 * `maxTokens` is an output cap — so docmeta cannot ask how much a model will
 * take. The budget is therefore docmeta's own, and overflow is a signal to
 * shrink it rather than something to predict.
 */
import { describe, it, expect } from "vitest";
import {
  splitBody,
  buildUserPrompt,
  mergeProposals,
  DEFAULT_CHUNK_CHARS,
} from "../src/commands/fill-prompt.js";
import type { ProposalSet } from "../src/commands/fill-types.js";

const candidate = {
  key: "description",
  required: false,
  present: false,
  subschema: { type: "string" as const },
};

describe("splitBody", () => {
  it("returns one chunk when the body fits", () => {
    expect(splitBody("short", 100)).toEqual(["short"]);
  });

  it("covers the whole body across chunks, losing nothing", () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const chunks = splitBody(body, 200);
    expect(chunks.length).toBeGreaterThan(1);
    // The concatenation is the original: no character is dropped or duplicated.
    expect(chunks.join("")).toBe(body);
  });

  it("keeps the final line in the final chunk", () => {
    // The regression the old truncation caused: a long page's conclusion was
    // simply never seen by the model.
    const body = `${"x".repeat(5000)}\nTHE CONCLUSION`;
    const chunks = splitBody(body, 400);
    expect(chunks[chunks.length - 1]).toContain("THE CONCLUSION");
  });

  it("prefers a line boundary over cutting mid-line", () => {
    const body = "aaaa\nbbbb\ncccc\ndddd\n";
    for (const chunk of splitBody(body, 10)) {
      // Every chunk ends at a newline, except possibly the last.
      if (chunk !== splitBody(body, 10).at(-1)) {
        expect(chunk.endsWith("\n")).toBe(true);
      }
    }
  });

  it("still splits a single line longer than the budget", () => {
    // A minified file has no line breaks to split on; the budget still binds.
    const body = "z".repeat(1000);
    const chunks = splitBody(body, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(body);
  });
});

describe("buildUserPrompt", () => {
  it("sends the body verbatim, with no truncation marker", () => {
    const body = "the whole page";
    const prompt = buildUserPrompt({
      filePath: "a.md",
      existing: {},
      candidates: [candidate],
      body,
    });
    expect(prompt).toContain(body);
    expect(prompt).not.toContain("[body truncated]");
  });

  it("tells the model which part it is looking at, when there are several", () => {
    const prompt = buildUserPrompt({
      filePath: "a.md",
      existing: {},
      candidates: [candidate],
      body: "part two",
      part: { index: 2, total: 3 },
    });
    expect(prompt).toMatch(/part 2 of 3/i);
  });

  it("says nothing about parts for a single-chunk file", () => {
    const prompt = buildUserPrompt({
      filePath: "a.md",
      existing: {},
      candidates: [candidate],
      body: "all of it",
    });
    expect(prompt).not.toMatch(/part \d+ of/i);
  });
});

describe("mergeProposals", () => {
  const p = (value: unknown, confidence: number): ProposalSet => ({
    description: { value, confidence, reasoning: "r" },
  });

  it("keeps the highest-confidence proposal for a key", () => {
    const merged = mergeProposals([p("from the intro", 0.4), p("from the conclusion", 0.9)]);
    expect(merged.description?.value).toBe("from the conclusion");
    expect(merged.description?.confidence).toBe(0.9);
  });

  it("does not let chunk order decide", () => {
    const high = p("high", 0.9);
    const low = p("low", 0.2);
    expect(mergeProposals([high, low]).description?.value).toBe("high");
    expect(mergeProposals([low, high]).description?.value).toBe("high");
  });

  it("unions keys proposed in different chunks", () => {
    const a: ProposalSet = { title: { value: "T", confidence: 0.8, reasoning: "" } };
    const b: ProposalSet = { description: { value: "D", confidence: 0.7, reasoning: "" } };
    expect(Object.keys(mergeProposals([a, b])).sort()).toEqual([
      "description",
      "title",
    ]);
  });

  it("returns an empty set for no chunks", () => {
    expect(mergeProposals([])).toEqual({});
  });
});

describe("the chunk budget", () => {
  it("defaults to the size the old truncation limit used", () => {
    // Same number, opposite job: it used to be where reading stopped.
    expect(DEFAULT_CHUNK_CHARS).toBe(12000);
  });
});
