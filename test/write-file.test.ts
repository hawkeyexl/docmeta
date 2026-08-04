/**
 * The only tests in the suite that touch the filesystem, so they work inside a
 * fresh mkdtemp directory rather than against the shared read-only fixtures.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/core/write-file.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docmeta-fill-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("replaces the file's contents", async () => {
    const file = join(dir, "page.md");
    await writeFile(file, "old\n", "utf8");
    await writeFileAtomic(file, "new\n");
    expect(await readFile(file, "utf8")).toBe("new\n");
  });

  it("creates a file that does not exist yet", async () => {
    const file = join(dir, "fresh.md");
    await writeFileAtomic(file, "hello\n");
    expect(await readFile(file, "utf8")).toBe("hello\n");
  });

  it("leaves no temp files behind", async () => {
    const file = join(dir, "page.md");
    await writeFile(file, "old\n", "utf8");
    await writeFileAtomic(file, "new\n");
    expect(await readdir(dir)).toEqual(["page.md"]);
  });

  it("writes bytes verbatim, including CRLF and a BOM", async () => {
    const file = join(dir, "page.md");
    const content = "﻿---\r\ntype: concept\r\n---\r\n";
    await writeFileAtomic(file, content);
    expect(await readFile(file, "utf8")).toBe(content);
  });

  it.skipIf(process.platform === "win32")(
    "preserves the original file mode",
    async () => {
      const file = join(dir, "page.md");
      await writeFile(file, "old\n", "utf8");
      await chmod(file, 0o640);
      await writeFileAtomic(file, "new\n");
      expect((await stat(file)).mode & 0o777).toBe(0o640);
    },
  );
});
