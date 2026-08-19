/**
 * The cross-run cache for schemas fetched over `http(s)`.
 *
 * The in-process `Map` in `schema-registry.ts` collapses N files into one
 * fetch and then dies with the process, so every `docmeta validate` in a
 * developer's edit loop re-fetches the same remote contract. This is the piece
 * that survives the run: one file per URL under `.docmeta/schema-cache/`,
 * served while it is inside the TTL.
 *
 * **Its scope, stated honestly:** this is a local dev-loop and pre-commit win,
 * not a CI one. An ephemeral runner starts with an empty workspace, so the
 * cache is cold on every job and the remote host is still a single point of
 * failure for the org. Vendoring the schema into the consuming repo is what
 * fixes that; see `docs/proposals/0008-remote-schema-durability.md`.
 *
 * Written here rather than reusing `JsonCache` from `@hawkeyexl/inference`
 * (which `fill` keeps using for proposals) for three reasons the cache
 * semantics turn on: `JsonCache` has no TTL, no eviction, and writes with a
 * plain `writeFileSync`. Schema resolution is the most correctness-critical
 * path docmeta has, and a truncated entry there would be read back on the next
 * run — so writes go through `writeFileAtomic`.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./write-file.js";

/**
 * Where the cache lives, relative to the project root.
 *
 * `.docmeta/` is already ignored wholesale, and `fill` writes its proposal
 * cache to `.docmeta/cache` — a different directory, so the two never collide.
 */
export const SCHEMA_CACHE_DIR = ".docmeta/schema-cache";

/** The only entry format this version understands. */
export const SCHEMA_CACHE_VERSION = 1;

/** How long a cached schema is served before it is re-fetched. */
export const DEFAULT_TTL_HOURS = 24;

/** The cache directory for a project rooted at `root`. */
export function schemaCacheDir(root: string): string {
  return join(root, SCHEMA_CACHE_DIR);
}

/** What one cache file holds. */
export interface SchemaCacheEntry {
  version: number;
  /** The URL this entry was fetched from; re-checked on read. */
  url: string;
  /**
   * When it was fetched, ISO-8601. **Diagnostic only** — freshness is measured
   * on the file's mtime, which a restored cache or a clock change cannot make
   * disagree with the filesystem the way an embedded timestamp can.
   */
  fetchedAt: string;
  schema: Record<string, unknown>;
}

export interface ReadOptions {
  /**
   * Serve an entry regardless of age. What `--offline` needs: there is no
   * re-fetch available, so a stale copy beats failing the run outright.
   */
  ignoreTtl?: boolean;
}

export class SchemaCache {
  constructor(
    private readonly dir: string,
    private readonly ttlHours: number = DEFAULT_TTL_HOURS,
  ) {}

  /** A TTL of 0 disables the cache in both directions. */
  get enabled(): boolean {
    return this.ttlHours > 0;
  }

  /**
   * The file an entry lives in.
   *
   * Keyed on a hex digest of the URL, never on the URL itself: a URL carries
   * `/`, `..`, `:`, and a query string, so `join(dir, url + ".json")` lets the
   * *server's* address decide where the write lands. A digest cannot escape the
   * directory.
   */
  entryPath(url: string): string {
    const key = createHash("sha256").update(url).digest("hex");
    return join(this.dir, `${key}.json`);
  }

  /**
   * The cached schema for `url`, or null.
   *
   * Every malformation — an unreadable file, unparseable JSON, an unknown
   * version, an envelope naming a different URL, a payload that is not an
   * object — degrades to a **miss**. A cache is an optimization, and a corrupt
   * entry must cost one fetch, never a failed run that no `docmeta` command
   * explains how to fix.
   */
  async read(
    url: string,
    options: ReadOptions = {},
  ): Promise<Record<string, unknown> | null> {
    if (!this.enabled) return null;
    const file = this.entryPath(url);

    if (options.ignoreTtl !== true) {
      let mtimeMs: number;
      try {
        ({ mtimeMs } = await stat(file));
      } catch {
        return null;
      }
      if (Date.now() - mtimeMs >= this.ttlHours * 3_600_000) return null;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }
    const entry = raw as Record<string, unknown>;
    if (entry.version !== SCHEMA_CACHE_VERSION) return null;
    // A digest collision cannot realistically produce this, but a hand-edited
    // or half-copied cache directory can, and validating against the wrong
    // contract is a silent wrong answer rather than an error.
    if (entry.url !== url) return null;
    const schema = entry.schema;
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      return null;
    }
    return schema as Record<string, unknown>;
  }

  /**
   * Record a freshly fetched schema.
   *
   * A failure to write is swallowed. A read-only checkout, a full disk, or a
   * sandbox with no write access must cost the *next* run one fetch, not this
   * run its result.
   */
  async write(url: string, schema: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;
    const entry: SchemaCacheEntry = {
      version: SCHEMA_CACHE_VERSION,
      url,
      fetchedAt: new Date().toISOString(),
      schema,
    };
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFileAtomic(
        this.entryPath(url),
        `${JSON.stringify(entry, null, 2)}\n`,
      );
    } catch {
      // Intentionally silent: see the doc comment.
    }
  }
}
