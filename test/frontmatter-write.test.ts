/**
 * Write-back tests. `applyFrontmatter` is pure — it takes content in and returns
 * content out — so every case here passes fixture *text*, and nothing on disk is
 * mutated.
 *
 * The CRLF and BOM cases use inline strings rather than fixture files on
 * purpose: git's `text=auto`/`core.autocrlf` normalizes a committed CRLF file
 * and can mangle a BOM, so a fixture would silently stop testing what it claims.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { applyFrontmatter } from "../src/extractors/frontmatter-write.js";
import { extractFrontmatter } from "../src/extractors/frontmatter.js";
import { DocmetaError } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string =>
  readFileSync(`${here}/fixtures/fill/${name}`, "utf8");

/** Everything from the closing fence onward — must never change. */
const tail = (s: string, fence: string): string =>
  s.slice(s.indexOf(`\n${fence}\n`));

describe("applyFrontmatter — no-ops", () => {
  it("returns the input identically for an empty patch", () => {
    const content = fx("missing-keys.md");
    expect(applyFrontmatter(content, {})).toBe(content);
  });

  it("ignores keys whose value is undefined", () => {
    const content = fx("missing-keys.md");
    expect(applyFrontmatter(content, { description: undefined })).toBe(content);
  });

  it("still rejects an unwritable document on an empty patch", () => {
    // An empty patch is used as a pre-flight writability probe, so structural
    // problems must surface here rather than reporting a false all-clear.
    expect(() => applyFrontmatter(fx("unterminated.md"), {})).toThrow(
      DocmetaError,
    );
  });
});

describe("applyFrontmatter — YAML", () => {
  const content = fx("missing-keys.md");

  it("appends a new key and leaves the body byte-identical", () => {
    const out = applyFrontmatter(content, { description: "A summary." });
    expect(out).toContain("description: A summary.");
    expect(tail(out, "---")).toBe(tail(content, "---"));
  });

  it("preserves comments above and beside existing keys", () => {
    const out = applyFrontmatter(content, { description: "A summary." });
    expect(out).toContain("# Ownership: docs team");
    expect(out).toContain("# kind of page");
  });

  it("replaces an invalid value in place, not by appending", () => {
    const out = applyFrontmatter(content, {
      timestamp: "2026-06-25T10:00:00Z",
    });
    expect(out).not.toContain("not-a-date");
    // Still ahead of the closing fence in its original position, and its
    // trailing comment survived the replacement.
    expect(out).toMatch(/timestamp: 2026-06-25T10:00:00Z # kind of page/);
  });

  it("keeps the original quoting style of a replaced scalar", () => {
    const out = applyFrontmatter(content, { title: "Replaced" });
    expect(out).toContain("title: 'Replaced'");
  });

  it("re-quotes when keeping the style would change the type", () => {
    // `version: 2` is a plain number; setting the string "2" must emit quotes
    // or the value would read back as a number.
    const out = applyFrontmatter(content, { version: "2" });
    expect(extractFrontmatter(out, "markdown").data.version).toBe("2");
  });

  it("keeps a flow sequence in flow style", () => {
    const out = applyFrontmatter(content, { tags: ["x", "y"] });
    expect(out).toMatch(/tags: \[\s*x,\s*y\s*\]/);
  });

  it("does not fold a long value across lines", () => {
    const long = "x".repeat(150);
    const out = applyFrontmatter(content, { description: long });
    expect(out).toContain(`description: ${long}`);
  });

  it("writes null explicitly", () => {
    const out = applyFrontmatter(content, { description: null });
    expect(out).toContain("description: null");
  });

  it("fills an empty block rather than creating a second one", () => {
    const empty = fx("empty-block.md");
    const out = applyFrontmatter(empty, { type: "concept" });
    expect(out.match(/^---$/gm)).toHaveLength(2);
    expect(extractFrontmatter(out, "markdown").data).toEqual({
      type: "concept",
    });
    expect(tail(out, "---")).toBe(tail(empty, "---"));
  });
});

describe("applyFrontmatter — TOML", () => {
  const content = fx("toml-comments.md");

  it("leaves an untouched date-time byte-identical", () => {
    // smol-toml's stringify would rewrite this to `...10:00:00.000Z`, which is
    // why the writer splices per key instead of re-emitting the block.
    const out = applyFrontmatter(content, { title: "Hello" });
    expect(out).toContain("timestamp = 2026-06-25T10:00:00Z");
  });

  it("preserves comments", () => {
    const out = applyFrontmatter(content, { title: "Hello" });
    expect(out).toContain("# Ownership: docs team");
    expect(out).toContain("# kind of page");
  });

  it("appends a new key above the first table header", () => {
    const out = applyFrontmatter(content, { title: "Hello" });
    expect(out.indexOf('title = "Hello"')).toBeLessThan(out.indexOf("[meta]"));
    expect(out).toContain('[meta]\nowner = "docs"');
  });

  it("replaces a multi-line array without disturbing later lines", () => {
    const out = applyFrontmatter(content, { tags: ["x", "y"] });
    expect(extractFrontmatter(out, "markdown").data.tags).toEqual(["x", "y"]);
    expect(out).toContain("version = 2 # kind of page");
    expect(out).toContain("[meta]");
  });

  it("refuses a null value instead of silently dropping it", () => {
    expect(() => applyFrontmatter(content, { title: null })).toThrow(
      DocmetaError,
    );
    expect(() => applyFrontmatter(content, { title: null })).toThrow(/title/);
  });
});

describe("applyFrontmatter — JSON", () => {
  const content = fx("json-4space.md");

  it("reproduces the source indentation and appends new keys", () => {
    const out = applyFrontmatter(content, { title: "Hello" });
    expect(out).toContain('    "title": "Hello"');
    expect(out.indexOf('"type"')).toBeLessThan(out.indexOf('"title"'));
    expect(tail(out, ";;;")).toBe(tail(content, ";;;"));
  });
});

describe("applyFrontmatter — creating a block", () => {
  it("prepends a YAML block above a leading heading", () => {
    const content = fx("no-block.md");
    const out = applyFrontmatter(content, { type: "concept" });
    expect(out).toBe(`---\ntype: concept\n---\n\n${content}`);
  });

  it("emits the requested flavor", () => {
    const out = applyFrontmatter(fx("no-block.md"), { type: "concept" }, {
      newBlockFlavor: "toml",
    });
    expect(out.startsWith('+++\ntype = "concept"\n+++\n')).toBe(true);
  });

  it("adds no trailing blank line for empty content", () => {
    expect(applyFrontmatter("", { type: "concept" })).toBe(
      "---\ntype: concept\n---\n",
    );
  });

  it("takes the line ending from the first terminator, not a stray CRLF", () => {
    // An LF document with one CRLF inside a code block must not gain a CRLF
    // front matter block.
    const content = "# Body\n\n```\nembedded\r\n```\n";
    const out = applyFrontmatter(content, { type: "concept" });
    expect(out).toBe(`---\ntype: concept\n---\n\n${content}`);
  });
});

describe("applyFrontmatter — hostile input", () => {
  it("refuses an unterminated fence rather than prepending a second block", () => {
    const content = fx("unterminated.md");
    expect(() => applyFrontmatter(content, { title: "Hello" })).toThrow(
      DocmetaError,
    );
    expect(() => applyFrontmatter(content, { title: "Hello" })).toThrow(
      /[Uu]nterminated/,
    );
  });

  it("refuses frontmatter whose root is not a mapping", () => {
    expect(() =>
      applyFrontmatter("---\n- a\n- b\n---\n\n# Body\n", { title: "x" }),
    ).toThrow(DocmetaError);
  });

  it("preserves CRLF throughout", () => {
    const content = "---\r\ntype: concept\r\n---\r\n\r\n# Body\r\n";
    const out = applyFrontmatter(content, { title: "Hello" });
    // No lone LF anywhere.
    expect(out.match(/(?<!\r)\n/g)).toBeNull();
    expect(out).toContain("title: Hello");
    expect(out.endsWith("---\r\n\r\n# Body\r\n")).toBe(true);
  });

  it("keeps exactly one BOM, still at offset 0", () => {
    const content = "﻿---\ntype: concept\n---\n\n# Body\n";
    const out = applyFrontmatter(content, { title: "Hello" });
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.match(/﻿/g)).toHaveLength(1);
    expect(extractFrontmatter(out, "markdown").data.title).toBe("Hello");
  });

  it("inserts the new block after a BOM, never before it", () => {
    const out = applyFrontmatter("﻿# Body\n", { type: "concept" });
    expect(out).toBe("﻿---\ntype: concept\n---\n\n# Body\n");
  });

  it("preserves the absence of a trailing newline", () => {
    const content = "---\ntype: concept\n---\n\n# Body";
    expect(applyFrontmatter(content, { title: "Hello" }).endsWith("# Body")).toBe(
      true,
    );
  });

  it("quotes a key that needs it", () => {
    const out = applyFrontmatter("---\ntype: concept\n---\n", {
      "my key": true,
    });
    expect(extractFrontmatter(out, "markdown").data["my key"]).toBe(true);
  });
});

describe("applyFrontmatter — round trip", () => {
  const PATCH = {
    type: "concept",
    title: "Round Trip",
    tags: ["a", "b"],
    timestamp: "2026-06-25T10:00:00Z",
  };
  const FIXTURES = [
    "missing-keys.md",
    "toml-comments.md",
    "json-4space.md",
    "empty-block.md",
    "no-block.md",
  ];

  it.each(FIXTURES)("reads back exactly what was written: %s", (name) => {
    const content = fx(name);
    const out = applyFrontmatter(content, PATCH);
    expect(extractFrontmatter(out, "markdown").data).toEqual({
      ...extractFrontmatter(content, "markdown").data,
      ...PATCH,
    });
  });

  it.each(FIXTURES)("is idempotent: %s", (name) => {
    const once = applyFrontmatter(fx(name), PATCH);
    expect(applyFrontmatter(once, PATCH)).toBe(once);
  });
});
