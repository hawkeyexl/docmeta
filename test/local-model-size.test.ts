/**
 * The documented download bound.
 *
 * `reference/cli.mdx` used to quote a precise range — "between 2.6 GB and
 * 6.7 GB" — which was true of the Gemma tiers and became false, silently, when
 * the inference dependency retiered its catalog. Nobody noticed because nothing
 * connected the sentence to the data.
 *
 * The fix is a bound plus this test, so the next retier fails here instead of
 * making the page wrong again. The claim is scoped to the *tiered* models,
 * which are the only ones `auto` and the tier selectors can reach; superseded
 * entries stay resolvable by name and are deliberately outside it — one of them
 * is 14 GB.
 */
import { describe, it, expect } from "vitest";
import { LLAMA_MODELS, LLAMA_TIERS } from "@hawkeyexl/inference";

/** The figure `reference/cli.mdx` publishes. Change both together, or neither. */
const DOCUMENTED_MAX_BYTES = 10 * 1000 * 1000 * 1000;

describe("the documented local-model download bound", () => {
  const entries = Object.entries(
    LLAMA_MODELS as Record<string, { sizeBytes: number; tier?: string }>,
  );

  it("holds for every model a tier can select", () => {
    const tiered = entries.filter(([, m]) => m.tier != null);
    expect(tiered.length).toBeGreaterThan(0);
    for (const [name, model] of tiered) {
      expect(
        model.sizeBytes,
        `${name} is ${(model.sizeBytes / 1e9).toFixed(2)} GB, over the documented bound`,
      ).toBeLessThan(DOCUMENTED_MAX_BYTES);
    }
  });

  it("covers every tier, so no tier is silently unchecked", () => {
    const covered = new Set(
      entries.filter(([, m]) => m.tier != null).map(([, m]) => m.tier),
    );
    for (const tier of LLAMA_TIERS) expect(covered).toContain(tier);
  });
});
