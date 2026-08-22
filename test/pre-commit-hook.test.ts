/**
 * The published pre-commit hook's `files` pattern must cover exactly the
 * extensions docmeta actually reads.
 *
 * Both directions matter, and each has its own failure. Too narrow and the hook
 * silently skips files the CLI would have checked — a green commit over an
 * unvalidated page, which is the failure docmeta exists to prevent. Too wide and
 * pre-commit hands docmeta files it will refuse, turning an unrelated commit
 * red.
 *
 * `test/extractors.test.ts` asserts only that `supportedExtensions()` *contains*
 * a handful of extensions. That is why the pattern first drafted for this hook
 * could omit `.markdown` and `.asciidoc` without anything noticing: a
 * containment check cannot see an omission. This one is an exact-set check on
 * purpose.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { supportedExtensions } from "../src/extractors/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Hook {
  id: string;
  files: string;
  entry: string;
  language: string;
}

const hooks = parse(
  readFileSync(join(repoRoot, ".pre-commit-hooks.yaml"), "utf8"),
) as Hook[];

const docmetaHook = hooks.find((h) => h.id === "docmeta");

describe("the published pre-commit hook", () => {
  it("declares a docmeta hook", () => {
    expect(docmetaHook).toBeDefined();
  });

  it("matches exactly the extensions docmeta supports", () => {
    if (!docmetaHook) throw new Error("no docmeta hook");
    // pre-commit uses Python's `re`; `(?i)` is an inline flag JS spells as a
    // trailing `i`, so translate rather than assuming they are interchangeable.
    const source = docmetaHook.files.replace(/^\(\?i\)/, "");
    const re = new RegExp(source, "i");

    const supported = supportedExtensions();
    const missed = supported.filter((ext) => !re.test(`page${ext}`));
    expect(missed, `hook skips supported extensions: ${missed.join(", ")}`).toEqual([]);

    // And nothing beyond them: a pattern that matched `.txt` would hand docmeta
    // files it refuses, failing commits that have nothing to do with metadata.
    const foreign = [".txt", ".json", ".yaml", ".ts", ".png", ".mdxx"];
    const overreach = foreign.filter((ext) => re.test(`page${ext}`));
    expect(overreach, `hook claims unsupported extensions: ${overreach.join(", ")}`).toEqual([]);
  });

  it("matches regardless of case, as the CLI does", () => {
    if (!docmetaHook) throw new Error("no docmeta hook");
    const re = new RegExp(docmetaHook.files.replace(/^\(\?i\)/, ""), "i");
    // `extractors/index.ts` lowercases on both insert and lookup, so the CLI
    // reads `README.MD`; a case-sensitive hook would skip it.
    expect(re.test("README.MD")).toBe(true);
    expect(re.test("Guide.DITA")).toBe(true);
  });

  it("declares the case-insensitive flag pre-commit needs", () => {
    // The JS translation above would pass whether or not the shipped pattern
    // carries `(?i)`, because it forces `i`. pre-commit gets no such help.
    if (!docmetaHook) throw new Error("no docmeta hook");
    expect(docmetaHook.files.startsWith("(?i)")).toBe(true);
  });
});
