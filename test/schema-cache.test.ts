/**
 * The cross-run schema cache (`.docmeta/schema-cache/`).
 *
 * Every test gets its own temp directory: the cache writes real files, so a
 * shared directory would let one test read another's entry — and a cache that
 * appears to work because of contamination is worse than no test at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  DEFAULT_TTL_HOURS,
  SCHEMA_CACHE_DIR,
  SCHEMA_CACHE_VERSION,
  SchemaCache,
  schemaCacheDir,
} from "../src/core/schema-cache.js";

const URL_A = "https://schemas.example.com/house/2.1.json";
const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["type"],
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "docmeta-schema-cache-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Backdate an entry's mtime by `hours`, which is what freshness is measured on. */
function ageEntry(path: string, hours: number): void {
  const when = new Date(Date.now() - hours * 3_600_000);
  utimesSync(path, when, when);
}

describe("schema cache", () => {
  it("round-trips a schema through disk", async () => {
    const cache = new SchemaCache(dir, DEFAULT_TTL_HOURS);
    expect(await cache.read(URL_A)).toBeNull();
    await cache.write(URL_A, SCHEMA);
    expect(await cache.read(URL_A)).toEqual(SCHEMA);
  });

  it("keys on a hash of the URL, never on the URL itself", async () => {
    // `join(dir, url + ".json")` is a path-traversal footgun: a URL carries
    // `/`, `..`, `:` and a query string, so the raw key decides where the write
    // lands. A hex digest cannot escape the directory.
    const cache = new SchemaCache(dir, DEFAULT_TTL_HOURS);
    await cache.write("https://evil.example/../../../etc/passwd?x=1", SCHEMA);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it("stores an envelope carrying the version, url, and fetch time", async () => {
    const cache = new SchemaCache(dir, DEFAULT_TTL_HOURS);
    await cache.write(URL_A, SCHEMA);
    const envelope = JSON.parse(
      readFileSync(cache.entryPath(URL_A), "utf8"),
    ) as Record<string, unknown>;
    expect(envelope.version).toBe(SCHEMA_CACHE_VERSION);
    expect(envelope.url).toBe(URL_A);
    expect(typeof envelope.fetchedAt).toBe("string");
    expect(envelope.schema).toEqual(SCHEMA);
  });

  it("expires an entry by file mtime, not by the embedded timestamp", async () => {
    // `fetchedAt` is for a human reading the file; it disagrees with the
    // filesystem after a clock change or a restored cache, and trusting it
    // produces a cache that never expires.
    const cache = new SchemaCache(dir, 24);
    await cache.write(URL_A, SCHEMA);
    ageEntry(cache.entryPath(URL_A), 25);
    expect(await cache.read(URL_A)).toBeNull();
    // The envelope still claims it was fetched moments ago — which is exactly
    // what would keep it alive if freshness read the embedded value.
    const envelope = JSON.parse(
      readFileSync(cache.entryPath(URL_A), "utf8"),
    ) as { fetchedAt: string };
    expect(Date.now() - Date.parse(envelope.fetchedAt)).toBeLessThan(60_000);
  });

  it("serves an entry that is still inside the TTL", async () => {
    const cache = new SchemaCache(dir, 24);
    await cache.write(URL_A, SCHEMA);
    ageEntry(cache.entryPath(URL_A), 23);
    expect(await cache.read(URL_A)).toEqual(SCHEMA);
  });

  it("serves a stale entry when the TTL is ignored", async () => {
    // What `--offline` needs: there is no refetch available, so a stale entry
    // beats failing the run.
    const cache = new SchemaCache(dir, 24);
    await cache.write(URL_A, SCHEMA);
    ageEntry(cache.entryPath(URL_A), 500);
    expect(await cache.read(URL_A, { ignoreTtl: true })).toEqual(SCHEMA);
  });

  it("ttlHours: 0 disables the cache in both directions", async () => {
    const cache = new SchemaCache(dir, 0);
    expect(cache.enabled).toBe(false);
    await cache.write(URL_A, SCHEMA);
    expect(readdirSync(dir)).toHaveLength(0);
    expect(await cache.read(URL_A)).toBeNull();
    // Even ignoring the TTL: disabled means disabled, so `--offline` with the
    // cache off fails rather than quietly reading a file it was told not to.
    expect(await cache.read(URL_A, { ignoreTtl: true })).toBeNull();
  });

  it("degrades to a miss on unparseable JSON", async () => {
    const cache = new SchemaCache(dir, 24);
    await cache.write(URL_A, SCHEMA);
    writeFileSync(cache.entryPath(URL_A), "{ truncated");
    expect(await cache.read(URL_A)).toBeNull();
  });

  it("degrades to a miss on a version it does not understand", async () => {
    const cache = new SchemaCache(dir, 24);
    await cache.write(URL_A, SCHEMA);
    writeFileSync(
      cache.entryPath(URL_A),
      JSON.stringify({ version: 99, url: URL_A, schema: SCHEMA }),
    );
    expect(await cache.read(URL_A)).toBeNull();
  });

  it("degrades to a miss when the envelope names a different URL", async () => {
    const cache = new SchemaCache(dir, 24);
    await cache.write(URL_A, SCHEMA);
    writeFileSync(
      cache.entryPath(URL_A),
      JSON.stringify({
        version: SCHEMA_CACHE_VERSION,
        url: "https://elsewhere.example/other.json",
        schema: SCHEMA,
      }),
    );
    expect(await cache.read(URL_A)).toBeNull();
  });

  it("degrades to a miss when the payload is not an object", async () => {
    const cache = new SchemaCache(dir, 24);
    await cache.write(URL_A, SCHEMA);
    for (const schema of ["nope", 7, null, [1, 2]]) {
      writeFileSync(
        cache.entryPath(URL_A),
        JSON.stringify({ version: SCHEMA_CACHE_VERSION, url: URL_A, schema }),
      );
      expect(await cache.read(URL_A)).toBeNull();
    }
  });

  it("does not fail the run when the cache cannot be written", async () => {
    // A read-only checkout, a full disk, a sandbox with no write access: the
    // cache is an optimization, and validation must not depend on it.
    const cache = new SchemaCache(join(dir, "file-in-the-way", "sub"), 24);
    writeFileSync(join(dir, "file-in-the-way"), "not a directory");
    // Reports that nothing landed, without throwing. The caller needs both
    // facts: the run continues, and the entry is not on disk — the second is
    // what stops an offline call being served from the in-process memo for a
    // schema that was never persisted.
    await expect(cache.write(URL_A, SCHEMA)).resolves.toBe(false);
    expect(await cache.read(URL_A)).toBeNull();
  });

  it("creates the cache directory on first write", async () => {
    const nested = join(dir, "deep", "cache");
    const cache = new SchemaCache(nested, 24);
    await cache.write(URL_A, SCHEMA);
    expect(basename(cache.entryPath(URL_A))).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(await cache.read(URL_A)).toEqual(SCHEMA);
  });

  it("puts the cache under .docmeta/schema-cache, beside fill's cache", () => {
    // `.docmeta/` is gitignored wholesale, and `fill` uses `.docmeta/cache` —
    // a different directory, so the two never collide.
    expect(SCHEMA_CACHE_DIR).toBe(".docmeta/schema-cache");
    mkdirSync(join(dir, "root"), { recursive: true });
    expect(schemaCacheDir(join(dir, "root"))).toBe(
      join(dir, "root", ".docmeta", "schema-cache"),
    );
  });
});

describe("schema cache: write reports whether the entry landed", () => {
  it("returns true on a successful write and false when disabled", async () => {
    // `ttlHours: 0` disables the cache in both directions, so a write is a
    // no-op — and must say so, rather than reporting a success that leaves
    // nothing behind.
    const ok = new SchemaCache(mkdtempSync(join(tmpdir(), "docmeta-w-")), 24);
    expect(await ok.write(URL_A, SCHEMA)).toBe(true);

    const off = new SchemaCache(mkdtempSync(join(tmpdir(), "docmeta-w0-")), 0);
    expect(await off.write(URL_A, SCHEMA)).toBe(false);
  });
});
