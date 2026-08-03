/**
 * Locator tests. `locateFrontmatter` reports character offsets into the
 * *original* content (BOM included, CRLF intact) so the writer can splice the
 * block surgically. `frontmatterInnerText` must reproduce, byte for byte, the
 * string the reader has always parsed — that equivalence is what lets
 * `extractFrontmatter` be rebuilt on top of the locator with no behavior change.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  locateFrontmatter,
  frontmatterInnerText,
} from "../src/extractors/frontmatter.js";

const here = dirname(fileURLToPath(import.meta.url));
const readFixture = (name: string): string =>
  readFileSync(`${here}/fixtures/${name}`, "utf8");

describe("locateFrontmatter", () => {
  it("reports offsets that bracket the YAML block exactly", () => {
    const content = readFixture("valid.md");
    const loc = locateFrontmatter(content);
    expect(loc).not.toBeNull();
    if (!loc) return;

    expect(loc.flavor).toBe("yaml");
    expect(loc.openStart).toBe(0);
    expect(loc.eol).toBe("\n");
    expect(loc.firstContentLine).toBe(2);
    // The opening fence and its terminator.
    expect(content.slice(loc.openStart, loc.innerStart)).toBe("---\n");
    // innerEnd sits at the first character of the closing fence line.
    expect(content.slice(loc.innerEnd, loc.closeEnd)).toBe("---\n");
    // The body is everything after the block, untouched.
    expect(content.slice(loc.closeEnd)).toBe("\n# A Valid Document\n\nBody content goes here.\n");
  });

  it("detects the TOML and JSON flavors from their fences", () => {
    const toml = locateFrontmatter(readFixture("valid-toml.md"));
    expect(toml?.flavor).toBe("toml");
    const json = locateFrontmatter(readFixture("valid-json.md"));
    expect(json?.flavor).toBe("json");
  });

  it("reproduces the exact string the reader parses", () => {
    const content = readFixture("valid-toml.md");
    const loc = locateFrontmatter(content);
    expect(loc).not.toBeNull();
    if (!loc) return;
    expect(frontmatterInnerText(content, loc)).toBe(
      [
        'type = "concept"',
        'title = "Hello"',
        "version = 2",
        'tags = ["a", "b"]',
        'timestamp = "2026-06-25T10:00:00Z"',
      ].join("\n"),
    );
  });

  it("keeps CRLF in the source but normalizes the inner text to LF", () => {
    const content = "---\r\ntype: concept\r\ntitle: Hi\r\n---\r\n\r\n# Body\r\n";
    const loc = locateFrontmatter(content);
    expect(loc).not.toBeNull();
    if (!loc) return;
    expect(loc.eol).toBe("\r\n");
    // The inner text is LF-normalized for the parsers...
    expect(frontmatterInnerText(content, loc)).toBe("type: concept\ntitle: Hi");
    // ...but the offsets still address the original CRLF content.
    expect(content.slice(loc.innerEnd, loc.closeEnd)).toBe("---\r\n");
    expect(content.slice(loc.closeEnd)).toBe("\r\n# Body\r\n");
  });

  it("places the block after a leading BOM", () => {
    const content = "﻿---\ntype: concept\n---\n\n# Body\n";
    const loc = locateFrontmatter(content);
    expect(loc?.openStart).toBe(1);
    if (!loc) return;
    expect(content.slice(loc.openStart, loc.innerStart)).toBe("---\n");
    expect(frontmatterInnerText(content, loc)).toBe("type: concept");
  });

  it("returns an empty inner text for an empty block", () => {
    const content = "---\n---\n\n# Body\n";
    const loc = locateFrontmatter(content);
    expect(loc).not.toBeNull();
    if (!loc) return;
    expect(loc.innerStart).toBe(loc.innerEnd);
    expect(frontmatterInnerText(content, loc)).toBe("");
  });

  it("accepts `...` as a YAML closing fence", () => {
    const loc = locateFrontmatter("---\ntype: concept\n...\n\n# Body\n");
    expect(loc?.flavor).toBe("yaml");
    expect(loc).not.toBeNull();
  });

  it("returns null with no fence, and for an unterminated fence", () => {
    expect(locateFrontmatter("# Just a heading\n")).toBeNull();
    expect(locateFrontmatter("---\ntype: concept\n\n# Body\n")).toBeNull();
  });

  it("handles a closing fence at EOF with no trailing newline", () => {
    const content = "---\ntype: concept\n---";
    const loc = locateFrontmatter(content);
    expect(loc).not.toBeNull();
    if (!loc) return;
    expect(loc.closeEnd).toBe(content.length);
    expect(frontmatterInnerText(content, loc)).toBe("type: concept");
  });
});
