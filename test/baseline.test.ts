import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE_VERSION,
  DEFAULT_BASELINE_PATH,
  applyBaseline,
  buildBaseline,
  diffBaselines,
  fingerprint,
  parseBaseline,
  serializeBaseline,
  writeBaselineFile,
} from "../src/core/baseline.js";
import { DocmetaError, type FieldError, type ValidationResult } from "../src/types.js";

const err = (over: Partial<FieldError> = {}): FieldError => ({
  schema: "google:okf:0.1",
  instancePath: "",
  message: "must have required property 'type'",
  keyword: "required",
  subject: "type",
  ...over,
});

const result = (
  file: string,
  errors: FieldError[],
): ValidationResult => ({
  file,
  format: "markdown",
  ok: errors.length === 0,
  schemas: ["google:okf:0.1"],
  errors,
});

describe("fingerprint", () => {
  it("is 16 hex characters", () => {
    expect(fingerprint(err())).toMatch(/^[0-9a-f]{16}$/);
  });

  it("survives a line shift — the line is deliberately excluded", () => {
    // Adding a key to frontmatter shifts `line` for everything below it. A
    // fingerprint that moved with it would present a pure reordering as a wall
    // of new findings, which is not a ratchet.
    expect(fingerprint(err({ line: 3 }))).toBe(fingerprint(err({ line: 41 })));
  });

  it("survives a reworded message — an Ajv upgrade must not invalidate a baseline", () => {
    expect(fingerprint(err({ message: "is invalid" }))).toBe(fingerprint(err()));
  });

  it("distinguishes two violations that differ only by keyword", () => {
    // The collision that forced `keyword` into the design: minLength and
    // pattern both fire at /slug under one schema.
    const minLength = err({
      instancePath: "/slug",
      keyword: "minLength",
      subject: undefined,
    });
    const pattern = err({
      instancePath: "/slug",
      keyword: "pattern",
      subject: undefined,
    });
    expect(fingerprint(minLength)).not.toBe(fingerprint(pattern));
  });

  it("distinguishes two required violations that differ only by subject", () => {
    expect(fingerprint(err({ subject: "type" }))).not.toBe(
      fingerprint(err({ subject: "title" })),
    );
  });

  it("distinguishes the same violation under a different schema ref", () => {
    expect(fingerprint(err({ schema: "https://example.com/okf.json" }))).not.toBe(
      fingerprint(err()),
    );
  });

  it("distinguishes the same violation at a different instance path", () => {
    expect(fingerprint(err({ instancePath: "/author" }))).not.toBe(
      fingerprint(err()),
    );
  });

  it("does not confuse a missing subject with a subject that spans the separator", () => {
    // A naive concatenation would let ("a", "") and ("", "a") collide.
    expect(fingerprint(err({ keyword: "ab", subject: undefined }))).not.toBe(
      fingerprint(err({ keyword: "a", subject: "b" })),
    );
  });
});

describe("fingerprint schema-ref canonicalization", () => {
  // 0004 rewrites a config's local file schema refs to ABSOLUTE paths whenever
  // the config directory is not the working directory. The ref is part of a
  // violation's identity, so without canonicalization the same repo produces one
  // fingerprint set from the root and a different, machine-specific one from a
  // subdirectory — CI green, and the developer in `docs/` sees the whole
  // baselined backlog as new.
  const base = "/repo";

  it("hashes an absolute local ref the same as the relative one it was rebased from", () => {
    const fromRoot = fingerprint(err({ schema: "./schemas/doc.json" }), {
      cwd: "/repo",
      base,
    });
    const fromSubdir = fingerprint(err({ schema: "/repo/schemas/doc.json" }), {
      cwd: "/repo/docs",
      base,
    });
    expect(fromSubdir).toBe(fromRoot);
  });

  it("leaves built-in ids alone — they are already stable", () => {
    const withCtx = fingerprint(err({ schema: "google:okf:0.1" }), {
      cwd: "/repo/docs",
      base,
    });
    expect(withCtx).toBe(fingerprint(err({ schema: "google:okf:0.1" })));
  });

  it("leaves URLs alone", () => {
    const ref = "https://example.com/okf.json";
    expect(fingerprint(err({ schema: ref }), { cwd: "/repo/docs", base })).toBe(
      fingerprint(err({ schema: ref })),
    );
  });

  it("still tells two different local schemas apart", () => {
    const ctx = { cwd: "/repo", base };
    expect(fingerprint(err({ schema: "./a.json" }), ctx)).not.toBe(
      fingerprint(err({ schema: "./b.json" }), ctx),
    );
  });

  it("canonicalizes through buildBaseline and applyBaseline alike", () => {
    const fromRoot = buildBaseline(
      [result("docs/a.md", [err({ schema: "./schemas/doc.json" })])],
      "3.4.2",
      { cwd: "/repo", base },
    );
    // The same run from a subdirectory, where 0004 handed us an absolute ref.
    const applied = applyBaseline(
      [result("docs/a.md", [err({ schema: "/repo/schemas/doc.json" })])],
      fromRoot,
      { cwd: "/repo/docs", base },
    );
    expect(applied.suppressed).toBe(1);
    expect(applied.results[0]?.ok).toBe(true);
  });
});

describe("baseline file", () => {
  it("round-trips through serialize/parse", () => {
    const baseline = {
      version: BASELINE_VERSION,
      generatedWith: "3.4.2",
      entries: { "docs/a.md": ["a1b2c3d4e5f60718"] },
    };
    expect(parseBaseline(serializeBaseline(baseline), DEFAULT_BASELINE_PATH)).toEqual(
      baseline,
    );
  });

  it("parses a baseline an editor re-saved with a UTF-8 BOM", () => {
    // A baseline is committed, so a Windows editor can re-save it with a BOM
    // and Node's `JSON.parse` then rejects a file every other tool reads. The
    // ratchet would fail with "invalid JSON" on a file nobody meaningfully
    // changed. Nothing hashes a baseline, so this is purely a parse concession.
    const baseline = {
      version: BASELINE_VERSION,
      generatedWith: "3.4.2",
      entries: { "docs/a.md": ["a1b2c3d4e5f60718"] },
    };
    const withBom = "\u{FEFF}" + serializeBaseline(baseline);
    expect(parseBaseline(withBom, DEFAULT_BASELINE_PATH)).toEqual(baseline);
  });

  it("sorts file keys and fingerprints so the file is diff-stable", () => {
    const text = serializeBaseline({
      version: BASELINE_VERSION,
      generatedWith: "3.4.2",
      entries: { "docs/z.md": ["ffff000000000000", "0000ffff00000000"], "docs/a.md": ["1111111111111111"] },
    });
    expect(text.indexOf('"docs/a.md"')).toBeLessThan(text.indexOf('"docs/z.md"'));
    expect(text.indexOf("0000ffff00000000")).toBeLessThan(
      text.indexOf("ffff000000000000"),
    );
  });

  it("ends with a newline so the file is a well-formed text file", () => {
    expect(serializeBaseline(buildBaseline([], "3.4.2"))).toMatch(/\n$/);
  });

  it("rejects an unknown version and names the remedy", () => {
    const text = JSON.stringify({ version: 2, generatedWith: "9.0.0", entries: {} });
    expect(() => parseBaseline(text, ".docmeta-baseline.json")).toThrow(DocmetaError);
    expect(() => parseBaseline(text, ".docmeta-baseline.json")).toThrow(
      /--write-baseline/,
    );
  });

  it("rejects malformed JSON, naming the file", () => {
    expect(() => parseBaseline("{ nope", "custom.json")).toThrow(/custom\.json/);
  });

  it("rejects entries that are not arrays of strings", () => {
    const text = JSON.stringify({
      version: 1,
      generatedWith: "3.4.2",
      entries: { "docs/a.md": "a1b2c3d4e5f60718" },
    });
    expect(() => parseBaseline(text, ".docmeta-baseline.json")).toThrow(DocmetaError);
  });
});

describe("buildBaseline", () => {
  it("keys findings by file and dedupes identical fingerprints", () => {
    const e = err();
    const built = buildBaseline([result("docs/a.md", [e, { ...e }])], "3.4.2");
    expect(built.entries["docs/a.md"]).toEqual([fingerprint(e)]);
    expect(built.version).toBe(BASELINE_VERSION);
    expect(built.generatedWith).toBe("3.4.2");
  });

  it("omits files with no findings", () => {
    const built = buildBaseline([result("docs/clean.md", [])], "3.4.2");
    expect(built.entries).toEqual({});
  });
});

describe("applyBaseline", () => {
  const missingType = err({ subject: "type" });
  const missingTitle = err({ subject: "title" });

  it("suppresses a baselined finding and passes the file", () => {
    const baseline = buildBaseline([result("docs/a.md", [missingType])], "3.4.2");
    const applied = applyBaseline([result("docs/a.md", [missingType])], baseline);
    expect(applied.results[0]?.ok).toBe(true);
    expect(applied.results[0]?.errors).toEqual([]);
    expect(applied.results[0]?.baselined).toBe(1);
    expect(applied.suppressed).toBe(1);
    expect(applied.stale).toBe(0);
  });

  it("still reports a finding that is not in the baseline", () => {
    const baseline = buildBaseline([result("docs/a.md", [missingType])], "3.4.2");
    const applied = applyBaseline(
      [result("docs/a.md", [missingType, missingTitle])],
      baseline,
    );
    expect(applied.results[0]?.ok).toBe(false);
    expect(applied.results[0]?.errors).toEqual([missingTitle]);
    expect(applied.suppressed).toBe(1);
  });

  it("reports a baselined finding that no longer occurs as stale, not as a failure", () => {
    const baseline = buildBaseline(
      [result("docs/a.md", [missingType, missingTitle])],
      "3.4.2",
    );
    const applied = applyBaseline([result("docs/a.md", [missingType])], baseline);
    expect(applied.results[0]?.ok).toBe(true);
    expect(applied.stale).toBe(1);
    expect(applied.recorded).toBe(2);
    expect(applied.suppressed).toBe(1);
  });

  it("counts only the checked files, so validating one file is not 'everything is stale'", () => {
    // Otherwise `docmeta validate one.md --baseline` reports every other file's
    // entries as prunable and the advice to re-record would destroy them.
    const baseline = buildBaseline(
      [result("docs/a.md", [missingType]), result("docs/b.md", [missingTitle])],
      "3.4.2",
    );
    const applied = applyBaseline([result("docs/a.md", [missingType])], baseline);
    expect(applied.recorded).toBe(1);
    expect(applied.stale).toBe(0);
  });

  it("treats a file with no baseline entry as entirely new — a rename is loud", () => {
    const baseline = buildBaseline([result("docs/old.md", [missingType])], "3.4.2");
    const applied = applyBaseline([result("docs/new.md", [missingType])], baseline);
    expect(applied.results[0]?.ok).toBe(false);
    expect(applied.results[0]?.baselined).toBeUndefined();
  });
});

describe("diffBaselines", () => {
  const a = buildBaseline([result("docs/a.md", [err({ subject: "type" })])], "3.4.2");
  const b = buildBaseline(
    [
      result("docs/a.md", [err({ subject: "type" }), err({ subject: "title" })]),
      result("docs/b.md", [err({ subject: "type" })]),
    ],
    "3.4.2",
  );

  it("counts added and removed fingerprints in both directions", () => {
    expect(diffBaselines(a, b)).toEqual({ added: 2, removed: 0 });
    expect(diffBaselines(b, a)).toEqual({ added: 0, removed: 2 });
  });

  it("treats a missing previous baseline as everything being new", () => {
    expect(diffBaselines(null, b)).toEqual({ added: 3, removed: 0 });
  });
});

describe("parseBaseline: a hostile entry key", () => {
  it("stores `__proto__` as an ordinary entry instead of dropping it", () => {
    // Written as a raw string on purpose: an object literal with a `__proto__`
    // key sets the prototype rather than creating one, so building this fixture
    // through JSON.stringify would not reproduce the case at all.
    const text =
      '{"version":1,"generatedWith":"3.4.2",' +
      '"entries":{"__proto__":["aaaaaaaaaaaaaaaa"],"docs/a.md":["bbbbbbbbbbbbbbbb"]}}';
    const parsed = parseBaseline(text, "hostile.json");

    // Assigning into a plain `{}` would fire the inherited setter: the entry
    // vanishes and the object's prototype becomes the array.
    expect(Object.keys(parsed.entries).sort()).toEqual([
      "__proto__",
      "docs/a.md",
    ]);
    expect(Array.isArray(Object.getPrototypeOf(parsed.entries))).toBe(false);
    expect(parsed.entries["docs/a.md"]).toEqual(["bbbbbbbbbbbbbbbb"]);
  });

  it("round-trips that entry through serialize", () => {
    const text =
      '{"version":1,"generatedWith":"3.4.2","entries":{"__proto__":["aaaaaaaaaaaaaaaa"]}}';
    const again = parseBaseline(serializeBaseline(parseBaseline(text, "h.json")), "h.json");
    expect(again.entries["__proto__"]).toEqual(["aaaaaaaaaaaaaaaa"]);
  });
});

describe("parseBaseline: fingerprint shape", () => {
  const wrap = (prints: string) =>
    `{"version":1,"generatedWith":"3.4.2","entries":{"docs/a.md":[${prints}]}}`;

  it("rejects a fingerprint that is not 16 lowercase hex characters", () => {
    // A hand-edited typo can never match a real violation, so without this the
    // symptom is "a baselined finding came back" with nothing to explain it.
    expect(() => parseBaseline(wrap('"nope"'), "b.json")).toThrow(DocmetaError);
    expect(() => parseBaseline(wrap('"NOTHEXNOTHEXNOTH"'), "b.json")).toThrow(
      /not a fingerprint/,
    );
    expect(() => parseBaseline(wrap('"aaaaaaaaaaaaaaa"'), "b.json")).toThrow(
      /not a fingerprint/,
    );
  });

  it("names the offending value and its file", () => {
    expect(() => parseBaseline(wrap('"aaaaaaaaaaaaaaaa","zz"'), "b.json")).toThrow(
      /entries\["docs\/a\.md"\] contains "zz"/,
    );
  });

  it("accepts what fingerprint() actually emits", () => {
    const print = fingerprint(err());
    expect(() => parseBaseline(wrap(JSON.stringify(print)), "b.json")).not.toThrow();
  });
});

describe("writeBaselineFile: failures name the baseline", () => {
  it("wraps an I/O failure as a DocmetaError naming the path", async () => {
    // A missing parent directory is the realistic case: `--write-baseline
    // .meta/base.json` in a repo with no `.meta/`. Unwrapped, the CLI reports it
    // through the "Unexpected error" branch with a bare ENOENT and no mention of
    // the baseline — `readBaseline` already wraps its own failures this way.
    const missing = join(tmpdir(), "docmeta-no-such-dir-9f8e7d", "base.json");
    const baseline = buildBaseline([result("docs/a.md", [err()])], "3.4.2");
    await expect(
      writeBaselineFile(missing, baseline, ".meta/base.json"),
    ).rejects.toThrow(DocmetaError);
    await expect(
      writeBaselineFile(missing, baseline, ".meta/base.json"),
    ).rejects.toThrow(/Baseline ".meta\/base\.json" could not be written/);
  });
});

describe("entry keys that collide with Object.prototype", () => {
  // The `__proto__` case is the famous one, but it is not the reachable one:
  // a file path can never be literally `__proto__` after canonicalization,
  // while `toString` is a perfectly legal filename. A *clean* file named
  // `toString` is skipped by buildBaseline, so applyBaseline's lookup finds the
  // inherited method instead of `undefined`, sails past the `!known` guard, and
  // dies in `new Set(known)` with "function is not iterable".
  const proto = ["toString", "constructor", "valueOf", "hasOwnProperty"];

  it("does not inherit Object.prototype members as entries", () => {
    const built = buildBaseline([result("docs/a.md", [err()])], "3.4.2");
    for (const name of proto) {
      expect(built.entries[name]).toBeUndefined();
    }
  });

  it("applies cleanly when a clean file is named like a prototype member", () => {
    const built = buildBaseline([result("docs/a.md", [err()])], "3.4.2");
    // `toString` is clean, so it has no entry — the exact shape that crashed.
    const results = [result("docs/a.md", [err()]), result("toString", [])];
    expect(() => applyBaseline(results, built)).not.toThrow();
    const applied = applyBaseline(results, built);
    expect(applied.results.find((r) => r.file === "toString")?.ok).toBe(true);
  });
});
