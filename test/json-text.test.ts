/**
 * `toJsonText` exists for one reason, and this file is that reason written as
 * assertions.
 *
 * `lib.es5.d.ts` declares the common `JSON.stringify` overload as returning
 * `string`. It does not: `undefined`, a function and a symbol each stringify to
 * `undefined`, as does any value whose `toJSON()` returns one. Four call sites
 * in this repo carry a `?? fallback` for exactly that, and against the *declared*
 * type every one of those fallbacks reads as dead code.
 *
 * The refactor this guards against is specific and plausible: swapping
 * `JSON.stringify` for `String()`. That typechecks, keeps every call site
 * compiling, and silently returns the seven-character string `"undefined"`
 * instead of the value `undefined` — so all four fallbacks stop firing and the
 * distinctions they preserve collapse. Nothing but a test notices.
 */
import { describe, it, expect } from "vitest";
import { stripBom, toJsonText } from "../src/core/json-text.js";

describe("toJsonText", () => {
  // The three the declared type denies. `String()` would return "undefined"
  // for each of these and pass every other check in the repo.
  it("returns undefined for undefined", () => {
    expect(toJsonText(undefined)).toBeUndefined();
  });

  it("returns undefined for a function", () => {
    expect(toJsonText(() => 1)).toBeUndefined();
  });

  it("returns undefined for a symbol", () => {
    expect(toJsonText(Symbol("nope"))).toBeUndefined();
  });

  it("returns undefined when toJSON returns undefined", () => {
    // The case with no `typeof` tell at all: an ordinary object that
    // stringifies to nothing. `collectCandidates` is public API, so a
    // hand-written value really can arrive shaped like this.
    expect(toJsonText({ toJSON: () => undefined })).toBeUndefined();
  });

  // null is a legitimate JSON value and must stay distinct from the above —
  // `canonical` in fill.ts depends on telling them apart.
  it("returns \"null\" for null, not undefined", () => {
    expect(toJsonText(null)).toBe("null");
  });

  it("stringifies ordinary values unchanged", () => {
    expect(toJsonText("a")).toBe('"a"');
    expect(toJsonText(3)).toBe("3");
    expect(toJsonText(false)).toBe("false");
    expect(toJsonText({ b: [1, 2] })).toBe('{"b":[1,2]}');
  });

  it("drops an undefined member rather than the whole object", () => {
    // Only the *top-level* value collapses to undefined; a nested one is
    // omitted. Worth pinning so the guard is not over-read as "anything
    // containing undefined vanishes".
    expect(toJsonText({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("stripBom", () => {
  it("drops a leading U+FEFF", () => {
    expect(stripBom("﻿{}")).toBe("{}");
  });

  it("leaves a BOM that is not leading alone", () => {
    // Anywhere but the head it is real content, not an encoding artefact.
    expect(stripBom('{"a":"﻿"}')).toBe('{"a":"﻿"}');
  });

  it("leaves text without a BOM untouched, including the empty string", () => {
    expect(stripBom("{}")).toBe("{}");
    expect(stripBom("")).toBe("");
  });
});
