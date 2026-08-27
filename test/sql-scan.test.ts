/**
 * Adversarial parity suite for the SQL micro-scanners (quote / bracket /
 * comment skipping). Written against the pre-consolidation behavior and kept
 * green across the refactor that rebuilt every consumer on the shared
 * primitives in src/core/projection.ts — the same inputs, one consumer per
 * describe block, so a divergence names the consumer that drifted.
 */
import { describe, it, expect } from "vitest";
import {
  assertSingleStatement,
  collectNamedParameters,
  stripLeadingTrivia,
} from "../src/core/projection.js";

describe("SQL scanners: unterminated string literal at EOF", () => {
  const sql = "SELECT 'abc; $x";

  it("assertSingleStatement treats the rest of the input as the literal", () => {
    expect(() => { assertSingleStatement(sql); }).not.toThrow();
  });

  it("collectNamedParameters finds no parameter inside it", () => {
    expect(collectNamedParameters(sql)).toEqual([]);
  });

  it("the doubled-quote escape does not resurrect a terminator", () => {
    // `''` inside the literal is an escaped quote, not close-then-open.
    expect(() => { assertSingleStatement("SELECT 'a''b; $x"); }).not.toThrow();
    expect(collectNamedParameters("SELECT 'a''b; $x")).toEqual([]);
  });
});

describe("SQL scanners: a comment containing a quote", () => {
  it("a line comment's apostrophe does not open a string", () => {
    // If the `'` opened a literal, the `;` after the newline would be
    // swallowed and the second statement silently dropped.
    expect(() => { assertSingleStatement("SELECT 1 -- it's fine\n; SELECT 2"); },
    ).toThrow(/single SQL statement/);
    expect(
      collectNamedParameters("SELECT $a -- don't $b\nFROM docs"),
    ).toEqual(["$a"]);
  });

  it("a block comment's apostrophe does not open a string", () => {
    expect(() => { assertSingleStatement("SELECT 1 /* don't */; SELECT 2"); },
    ).toThrow(/single SQL statement/);
    expect(collectNamedParameters("SELECT /* it's $b */ $a")).toEqual(["$a"]);
  });

  it("stripLeadingTrivia walks quote-bearing comments without opening one", () => {
    expect(stripLeadingTrivia("-- it's\n /* don't */ SELECT 1")).toBe(
      "SELECT 1",
    );
    // An unterminated block comment consumes the rest of the input.
    expect(stripLeadingTrivia("/* it's open")).toBe("");
  });

  it("a semicolon inside a comment is not a terminator", () => {
    expect(() => { assertSingleStatement("SELECT 1 -- a; b\nFROM docs"); },
    ).not.toThrow();
    expect(() => { assertSingleStatement("SELECT /* a; b */ 1"); }).not.toThrow();
    // ...and trailing trivia after a real terminator stays legal, an
    // unterminated trailing comment included.
    expect(() => { assertSingleStatement("SELECT 1; -- it's fine"); },
    ).not.toThrow();
    expect(() => { assertSingleStatement("SELECT 1; /* open"); }).not.toThrow();
  });
});

describe("SQL scanners: a quoted string containing `;` and `$name`", () => {
  const sql = "SELECT 'a; $b' AS x FROM docs";

  it("assertSingleStatement sees one statement", () => {
    expect(() => { assertSingleStatement(sql); }).not.toThrow();
  });

  it("collectNamedParameters sees no parameter", () => {
    expect(collectNamedParameters(sql)).toEqual([]);
  });

  it("the same holds in quoted identifiers and backticks", () => {
    expect(collectNamedParameters('SELECT "x; $b", `y; :c` FROM docs')).toEqual(
      [],
    );
    expect(() => { assertSingleStatement('SELECT "x; $b", `y; :c` FROM docs'); },
    ).not.toThrow();
  });
});

describe("SQL scanners: a bracket identifier containing a quote", () => {
  it("the `'` does not open a string — the bracket closes at `]`", () => {
    // If [it's] left a string open, this `;` would be invisible.
    expect(() => { assertSingleStatement("SELECT [it's] FROM docs; SELECT 2"); },
    ).toThrow(/single SQL statement/);
  });

  it("a `;` or `$name` inside the bracket is data, not syntax", () => {
    expect(() => { assertSingleStatement("SELECT [a'; b] FROM docs"); }).not.toThrow();
    expect(collectNamedParameters("SELECT [$a'] , :b FROM docs")).toEqual([
      ":b",
    ]);
  });

  it("an unterminated bracket at EOF consumes the rest of the input", () => {
    expect(() => { assertSingleStatement("SELECT [a'; $x"); }).not.toThrow();
    expect(collectNamedParameters("SELECT [a'; $x")).toEqual([]);
  });
});
