/**
 * `schemas` command core. Reports built-in schemas and supported input formats,
 * and vendors a remote schema into the repository.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";
import { parseDocument, stringify } from "yaml";
import { DocmetaError } from "../types.js";
import {
  fetchSchemaBytes,
  listBuiltins,
  type BuiltinInfo,
} from "../core/schema-registry.js";
import { listFormats } from "../extractors/index.js";
import { integrityOf } from "../core/integrity.js";
import { gitIgnored } from "../core/gitignore.js";
import { parseConfig, loadConfig, type SchemaEntry } from "../core/config.js";
import { writeFileAtomic } from "../core/write-file.js";

export interface SchemasInfo {
  builtins: BuiltinInfo[];
  formats: {
    name: string;
    extensions: string[];
    implemented: boolean;
    /** Whether `docmeta fill` can write metadata back to this format. */
    writable: boolean;
  }[];
}

export function getSchemasInfo(): SchemasInfo {
  return { builtins: listBuiltins(), formats: listFormats() };
}

/**
 * Where a vendored schema lands by default.
 *
 * **Not** `.docmeta/`, which is gitignored wholesale and holds the schema and
 * proposal caches. A vendored schema is the opposite kind of artifact: it has
 * to be committed, because being in the consuming repository's own history is
 * the entire point of vendoring.
 */
export const DEFAULT_VENDOR_DIR = "./schema";

/** The config file `vendor` creates when a repository has none. */
export const DEFAULT_CONFIG_NAME = "docmeta.config.yaml";

export interface VendorOptions {
  /** The `http(s)` URL to download. */
  url: string;
  /** Directory for the vendored copy, relative to `cwd`. Default `./schema`. */
  dir?: string;
  /** `-c/--config`. Absent discovers a config, or creates one in `cwd`. */
  configPath?: string;
  cwd?: string;
  /** Diagnostics for the user; the CLI writes these to stderr. */
  onNotice?: (message: string) => void;
  /** Fetch timeout, in ms. Defaults to the registry's. */
  timeoutMs?: number;
  /** Response size cap, in bytes. Defaults to the registry's. */
  maxBytes?: number;
}

export interface VendorResult {
  /** The URL that was downloaded. */
  url: string;
  /** The vendored file, relative to `cwd`, posix-style. */
  file: string;
  /** The pin recorded for it. */
  integrity: string;
  /** Size of the vendored copy, in bytes. */
  bytes: number;
  /** The config that was written, relative to `cwd`, posix-style. */
  config: string;
  /** Whether that config had to be created. */
  configCreated: boolean;
  /** Whether an existing `schemas:` entry was replaced rather than appended. */
  replaced: boolean;
  /** Whether the downloaded bytes were identical to the copy already on disk. */
  unchanged: boolean;
}

/** A path spelled the way git and a config both want it: relative, posix. */
function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/**
 * The filename for a vendored schema, derived from the URL's last path segment.
 *
 * Sanitized rather than trusted: the segment reaches the filesystem, so
 * anything that is not an ordinary filename character is replaced, and a
 * leading dot is prefixed away so the copy cannot land as a hidden file that
 * directory walks skip.
 */
export function vendorFileName(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DocmetaError(`"${url}" is not a valid URL.`);
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  // `new URL` carries a malformed escape like `%zz` through untouched — the
  // WHATWG parser does not validate percent-encoding — so the segment reaches
  // here and `decodeURIComponent` throws `URIError`, which is not a
  // `DocmetaError` and escaped as an unhandled stack trace. Decoding is only a
  // nicety: the result is sanitized to `[A-Za-z0-9._-]` regardless, so an
  // undecodable segment is used as written.
  let decoded: string;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }
  let name = decoded.replace(/[^A-Za-z0-9._-]/g, "-");
  // No usable segment at all (`https://host/`): fall back to the host, which is
  // at least recognizable in a diff.
  if (name === "" || /^\.+$/.test(name)) {
    name = parsed.hostname.replace(/[^A-Za-z0-9._-]/g, "-");
  }
  if (name.startsWith(".")) name = `schema${name}`;
  if (!name.toLowerCase().endsWith(".json")) name += ".json";
  return name;
}

/**
 * Refuse a target `.gitignore` covers.
 *
 * The highest-value guard in this command. A vendored schema that git ignores
 * validates perfectly on the machine that downloaded it and is simply *absent*
 * on CI, where the failure arrives as a missing schema file in a repository
 * nobody changed.
 *
 * Three states, all of them enumerated. Git says the path is ignored — refuse,
 * naming whichever of the directory or the file matched, since the fix differs.
 * Git says it is not — proceed. Git cannot answer at all (no repository here,
 * no `git` on `PATH`) — proceed, but say so: refusing every non-repository
 * would make the command unusable in an extracted tarball, and staying silent
 * would claim a check that never ran.
 */
async function assertNotIgnored(
  absFile: string,
  absDir: string,
  cwd: string,
  onNotice: ((message: string) => void) | undefined,
): Promise<void> {
  const relFile = posixRelative(cwd, absFile);
  const relDir = posixRelative(cwd, absDir);
  const candidates = [relFile];
  // "" is cwd itself, and a path outside cwd is not something git can be asked
  // about relative to here.
  if (relDir !== "" && !relDir.startsWith("..")) candidates.push(relDir);

  const answer = await gitIgnored(candidates, cwd);
  if (!answer.available) {
    onNotice?.(
      `could not check .gitignore for "${relDir || "."}" (no repository here, or no git on PATH). A vendored schema must be committed — make sure this path is tracked.`,
    );
    return;
  }

  const ignoredDir = answer.ignored.has(relDir);
  const ignoredFile = answer.ignored.has(relFile);
  if (!ignoredDir && !ignoredFile) return;

  // Name the broadest thing git actually flagged. Both spellings are asked
  // about because a directory-only pattern (`vendor/`) does not match the bare
  // path `vendor` while the directory does not yet exist on disk — git can only
  // answer for the file underneath it. Which of the two matched is therefore a
  // fact about the pattern's shape, not about which rule the user should edit,
  // so the remedy names both routes rather than guessing.
  throw new DocmetaError(
    `Refusing to vendor into "${ignoredDir ? relDir : relFile}": git reports it as ignored. A vendored schema has to be committed — an ignored copy validates on this machine and is simply missing in CI, where the failure reads as a schema nobody changed. Vendor into a directory your repository tracks (\`--dir\`, default \`${DEFAULT_VENDOR_DIR}\`), or drop the .gitignore rule covering this path.`,
  );
}

/**
 * Fold the vendored entry into a `schemas:` list.
 *
 * Replaces rather than appends whenever the list already speaks about this
 * schema, in any of the three spellings it can take: the bare URL a
 * pre-vendoring config carried, an earlier vendored entry naming the same
 * `source`, or an entry already pointing at the same `ref`. Appending instead
 * would leave the URL live beside its own local copy, so the run would still
 * depend on the host being up — the exact failure vendoring removes.
 */
function foldEntry(
  entries: SchemaEntry[],
  next: { ref: string; source: string; integrity: string },
): { entries: SchemaEntry[]; replaced: boolean; displacedSource?: string } {
  const speaksAbout = (entry: SchemaEntry): boolean =>
    typeof entry === "string"
      ? entry === next.source || entry === next.ref
      : entry.ref === next.ref || entry.source === next.source;

  const index = entries.findIndex(speaksAbout);
  if (index === -1) return { entries: [...entries, next], replaced: false };

  // Matched on `ref` while naming a *different* origin. Two hosts serving
  // different schemas whose URLs end in the same segment both default to the
  // same filename, so this replaces one pinned contract with another and the
  // "already exists and is not ours" guard reads it as a re-vendor. Doing it is
  // right — the command was asked to — but the caller reports it, because a
  // pinned entry silently changing meaning is not something to find out from a
  // diff later.
  const displacedSource = entries
    .filter(speaksAbout)
    .map((entry) => (typeof entry === "string" ? undefined : entry.source))
    .find((source) => source !== undefined && source !== next.source);
  // Every match collapses into the one entry, not just the first. A config
  // carrying both the bare URL and an earlier vendored ref would otherwise keep
  // the one that was not replaced — leaving the list disagreeing with itself
  // about whether the schema is pinned.
  return {
    entries: entries.flatMap((entry, i) =>
      i === index ? [next] : speaksAbout(entry) ? [] : [entry],
    ),
    replaced: true,
    ...(displacedSource !== undefined ? { displacedSource } : {}),
  };
}

/**
 * Serialize the updated config, preserving everything else in the file.
 *
 * `parseDocument` keeps comments and key order, so a config someone documented
 * comes back documented — including one that is nothing *but* comments, which
 * is why an empty file is not special-cased here. Only `schemas:` is rewritten;
 * comments written *inside* the old `schemas:` list are the one thing that does
 * not survive, because the list itself is replaced.
 */
function renderConfig(existing: string | null, entries: SchemaEntry[]): string {
  // No file at all is the one case with nothing to preserve.
  if (existing === null) return stringify({ schemas: entries });
  const doc = parseDocument(existing);
  doc.set("schemas", entries);
  return doc.toString();
}

/**
 * Download a remote schema into the repository and pin it.
 *
 * The order of operations is the contract: everything that can refuse does so
 * *before* the network call or the write, so a refused run leaves the working
 * tree exactly as it found it.
 */
export async function runVendorSchema(
  opts: VendorOptions,
): Promise<VendorResult> {
  const cwd = opts.cwd ?? process.cwd();
  const url = opts.url;

  if (!/^https?:\/\//i.test(url)) {
    throw new DocmetaError(
      `\`docmeta schemas pull\` takes an http(s) URL to download; "${url}" is ${/^[a-z0-9][a-z0-9._-]*:/i.test(url) && !url.includes("/") ? "a built-in id, which is already bundled" : "a local reference, which is already in your repository"}.`,
    );
  }

  // Load first, so a malformed or missing config fails before anything is
  // downloaded or written.
  const loaded = await loadConfig(opts.configPath, cwd);
  const configPath = loaded?.path ?? resolve(cwd, DEFAULT_CONFIG_NAME);
  const configDir = loaded?.dir ?? cwd;

  const absDir = resolve(cwd, opts.dir ?? DEFAULT_VENDOR_DIR);
  const absFile = join(absDir, vendorFileName(url));

  await assertNotIgnored(absFile, absDir, cwd, opts.onNotice);

  // The ref is written into the config, so it is relative to the **config**,
  // not to wherever the command was run from — that is what makes it resolve
  // the same way from a subdirectory, from the repo root, and in CI.
  const fromConfig = posixRelative(configDir, absFile);
  const ref =
    isAbsolute(fromConfig) || fromConfig === ""
      ? absFile
      : fromConfig.startsWith(".")
        ? fromConfig
        : `./${fromConfig}`;

  const { bytes } = await fetchSchemaBytes(url, {
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });
  const integrity = integrityOf(bytes);

  const entries = loaded?.config.schemas ?? [];
  const folded = foldEntry(entries, { ref, source: url, integrity });
  if (folded.displacedSource !== undefined) {
    opts.onNotice?.(
      `"${ref}" was vendored from ${folded.displacedSource}; replacing it with ${url}.`,
    );
  }

  // Whether this path is already ours. Three states: nothing there, our own
  // earlier copy (a re-vendor, which is the update path), or a file that
  // belongs to something else — which must not be silently overwritten just
  // because two schemas share a last URL segment.
  let unchanged = false;
  if (existsSync(absFile)) {
    const current = await readFile(absFile);
    unchanged = bytes.equals(current);
    if (!unchanged && !folded.replaced) {
      throw new DocmetaError(
        `"${posixRelative(cwd, absFile)}" already exists and is not the copy this config points at, so vendoring ${url} here would overwrite it. Vendor into a different directory with --dir, or remove that file first.`,
      );
    }
  }

  await mkdir(absDir, { recursive: true });
  await writeFileAtomic(absFile, bytes);

  const existing = loaded ? await readFile(configPath, "utf8") : null;
  const text = renderConfig(existing, folded.entries);
  // Parse what is about to be written rather than trusting the serializer. A
  // config docmeta itself cannot read is worse than a failed vendor, and this
  // is the last moment it can be caught before it reaches disk.
  parseConfig(text, posixRelative(cwd, configPath) || DEFAULT_CONFIG_NAME);
  await writeFileAtomic(configPath, text);

  return {
    url,
    file: posixRelative(cwd, absFile),
    integrity,
    bytes: bytes.byteLength,
    config: posixRelative(cwd, configPath),
    configCreated: loaded === null,
    replaced: folded.replaced,
    unchanged,
  };
}
