/**
 * The validation baseline — a ratchet.
 *
 * A baseline records today's violations so a run can fail on *new* ones only.
 * That is what lets a team make a field `required` on a Monday instead of after
 * a 1,200-file cleanup: the standard tightens immediately, the backlog is
 * recorded, and nothing regresses past the recorded state.
 *
 * A violation is identified by a fingerprint over the parts of it that are
 * machine-stable. See `fingerprint` for what is deliberately excluded and why.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { DocmetaError, type FieldError, type ValidationResult } from "../types.js";
import { classifyRef } from "./schema-registry.js";
import { writeFileAtomic } from "./write-file.js";

/** Where `--baseline` / `--write-baseline` / `baseline:` point when unspecified. */
export const DEFAULT_BASELINE_PATH = ".docmeta-baseline.json";

/** The only file format this version understands. */
export const BASELINE_VERSION = 1;

/** Exactly what `fingerprint` emits: 16 lowercase hex characters. */
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

export interface Baseline {
  version: number;
  /** docmeta version that produced the file, for diagnosis only. */
  generatedWith: string;
  /** File path (as reported in results) -> sorted violation fingerprints. */
  entries: Record<string, string[]>;
}

/** The parts of a violation a fingerprint is built from. */
export type Fingerprintable = Pick<
  FieldError,
  "schema" | "instancePath" | "keyword" | "subject"
>;

/** What a schema reference is measured against when it names a local file. */
export interface FingerprintContext {
  /** Working directory a relative file ref was written against. */
  cwd: string;
  /** Directory canonical paths are expressed relative to: the config's, else `cwd`. */
  base: string;
  /**
   * Directory a `ValidationResult.file` label is relative to. Usually `base`,
   * but a run that took positional paths resolves them against `cwd` instead,
   * so the two genuinely differ. Defaults to `base` when omitted.
   */
  runBase?: string;
}

/**
 * The key a file's entry is stored under.
 *
 * Result labels are relative to whatever the run resolved against, so the same
 * page is `docs/legacy.md` from the repo root and `legacy.md` from inside
 * `docs/`. A baseline is a committed, shared artifact, so its keys have to name
 * the file the same way from anywhere — otherwise the lookup misses and every
 * baselined finding reads as new, without the fingerprints ever being compared.
 */
export function canonicalFilePath(
  file: string,
  ctx?: FingerprintContext,
): string {
  if (!ctx) return file;
  const from = ctx.runBase ?? ctx.base;
  return relative(ctx.base, resolve(from, file)).replace(/\\/g, "/");
}

/**
 * A schema reference reduced to a form that does not depend on where the
 * command was run from.
 *
 * The ref is part of a violation's identity, and config discovery rewrites a
 * config's **local file** refs to absolute paths whenever the config directory
 * is not the working directory. Left alone, that would give one fingerprint set
 * when CI runs from the repo root and a different, machine-specific one when a
 * developer runs from `docs/` — the whole baselined backlog reading as new for
 * exactly the subdirectory workflow config discovery exists to support.
 *
 * Built-in ids and URLs are already stable and pass through untouched. A local
 * file ref becomes its path relative to `base`, with posix separators so a
 * baseline recorded on Windows matches one recorded on Linux.
 *
 * Only the *fingerprint input* is canonicalized. Reports and schema loading
 * keep using the ref exactly as the user wrote it.
 */
export function canonicalSchemaRef(
  ref: string,
  ctx?: FingerprintContext,
): string {
  if (!ctx) return ref;
  if (classifyRef(ref).kind !== "file") return ref;
  // `resolve` is a no-op on an already-absolute ref, which is the rebased case.
  const abs = resolve(ctx.cwd, ref);
  return relative(ctx.base, abs).replace(/\\/g, "/");
}

/**
 * A violation's stable identity: 16 hex characters of
 * `sha256(schema NUL instancePath NUL keyword NUL subject)`.
 *
 * Deliberately excludes:
 *
 * - **the line number** — adding one key to frontmatter shifts every line below
 *   it, and a fingerprint that moved with it would present a pure reordering as
 *   a wall of new findings;
 * - **the message prose** — Ajv generates it, so any Ajv release that rewords a
 *   message would invalidate every affected entry in every consuming repo at
 *   once, presenting as "docmeta broke our build";
 * - **the file path** — it is already the entry key, so hashing it again buys
 *   nothing.
 *
 * 64 bits against a realistic per-file population of tens of violations is
 * overwhelming headroom, and a collision costs one forgiven violation rather
 * than a corrupt file. The NUL separators are what keep `("ab", undefined)` and
 * `("a", "b")` apart.
 *
 * Note the sharp edge in the *included* half: the schema **ref string** is part
 * of the identity, so re-pointing a schema from `google:okf:0.1` to a URL
 * serving the same bytes changes every fingerprint. That is correct — docmeta
 * cannot tell it is the same contract — but it is surprising, and the remedy is
 * a re-record.
 */
export function fingerprint(
  e: Fingerprintable,
  ctx?: FingerprintContext,
): string {
  const parts = [
    canonicalSchemaRef(e.schema, ctx),
    e.instancePath,
    e.keyword,
    e.subject ?? "",
  ];
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/** Sorted keys and sorted fingerprints, so the file diffs and merges legibly. */
export function serializeBaseline(baseline: Baseline): string {
  // Null-prototype for the same reason `parseBaseline` uses one: a file key of
  // `__proto__` assigned into a plain object literal would set the prototype
  // and drop the entry, so a parse/serialize round-trip would lose it silently.
  const entries: Record<string, string[]> = Object.create(null);
  for (const file of Object.keys(baseline.entries).sort()) {
    entries[file] = [...(baseline.entries[file] ?? [])].sort();
  }
  return `${JSON.stringify(
    {
      version: baseline.version,
      generatedWith: baseline.generatedWith,
      entries,
    },
    null,
    2,
  )}\n`;
}

function bad(source: string, detail: string): never {
  throw new DocmetaError(`Baseline "${source}": ${detail}`);
}

/** Parse baseline JSON. `source` is the path as the user would type it. */
export function parseBaseline(text: string, source: string): Baseline {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    bad(source, `invalid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    bad(source, "top level must be an object.");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.version !== BASELINE_VERSION) {
    bad(
      source,
      `unsupported version ${JSON.stringify(obj.version)} (this docmeta writes version ${BASELINE_VERSION}). Re-record it with \`docmeta validate --write-baseline\`.`,
    );
  }

  const generatedWith =
    typeof obj.generatedWith === "string" ? obj.generatedWith : "";

  const rawEntries = obj.entries;
  if (
    typeof rawEntries !== "object" ||
    rawEntries === null ||
    Array.isArray(rawEntries)
  ) {
    bad(source, '"entries" must be an object mapping file paths to fingerprints.');
  }

  // Null-prototype, so a file key of `__proto__` is stored as an ordinary entry
  // rather than triggering the inherited setter — which would replace this
  // object's prototype and silently drop the entry. Every other malformation
  // here is rejected loudly; this one would not even be visible.
  const entries: Record<string, string[]> = Object.create(null);
  for (const [file, value] of Object.entries(
    rawEntries as Record<string, unknown>,
  )) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      bad(source, `entries["${file}"] must be a list of fingerprint strings.`);
    }
    // A fingerprint that is not the shape this code writes can never match a
    // real violation, so a typo in a hand-edited baseline would otherwise
    // present as "that finding came back" with nothing to explain it. Reject it
    // where the user can still see which entry is wrong.
    const malformed = (value as string[]).find((v) => !FINGERPRINT_RE.test(v));
    if (malformed !== undefined) {
      bad(
        source,
        `entries["${file}"] contains ${JSON.stringify(malformed)}, which is not a fingerprint (16 lowercase hex characters).`,
      );
    }
    entries[file] = value as string[];
  }

  return { version: BASELINE_VERSION, generatedWith, entries };
}

/** Read a baseline from disk. Returns null when the file does not exist. */
export async function readBaseline(
  absPath: string,
  source: string,
): Promise<Baseline | null> {
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DocmetaError(
      `Baseline "${source}" could not be read: ${(err as Error).message}`,
    );
  }
  return parseBaseline(text, source);
}

/**
 * Write the baseline atomically.
 *
 * The baseline is a committed artifact the whole team's gate reads, and a
 * truncated write is not merely lost work: the next run cannot parse it and
 * exits 2 until someone re-records. `writeFileAtomic` gives the same
 * temp-file-plus-rename guarantee `fill` relies on when it edits sources.
 */
export async function writeBaselineFile(
  absPath: string,
  baseline: Baseline,
): Promise<void> {
  await writeFileAtomic(absPath, serializeBaseline(baseline));
}

/** Record every finding in `results` as a baseline. Clean files are omitted. */
export function buildBaseline(
  results: ValidationResult[],
  generatedWith: string,
  ctx?: FingerprintContext,
): Baseline {
  const entries: Record<string, string[]> = {};
  for (const r of results) {
    if (r.errors.length === 0) continue;
    // Two identical violations in one file are one fingerprint; storing the
    // duplicate would only make the count meaningless.
    const prints = [...new Set(r.errors.map((e) => fingerprint(e, ctx)))].sort();
    entries[canonicalFilePath(r.file, ctx)] = prints;
  }
  return { version: BASELINE_VERSION, generatedWith, entries };
}

export interface AppliedBaseline {
  /** Results with baselined findings removed and `ok`/`baselined` updated. */
  results: ValidationResult[];
  /** Fingerprints the baseline holds **for the files this run checked**. */
  recorded: number;
  /** Findings suppressed because the baseline already had them. */
  suppressed: number;
  /** Recorded fingerprints for checked files that no longer occur. */
  stale: number;
}

/**
 * Subtract a baseline from a run's results.
 *
 * `recorded` and `stale` count only the files this run actually checked. The
 * alternative — counting the whole file — would make `docmeta validate one.md
 * --baseline` announce that hundreds of entries "no longer occur", and the
 * advice that follows (`--write-baseline` to prune) would then destroy them.
 */
export function applyBaseline(
  results: ValidationResult[],
  baseline: Baseline,
  ctx?: FingerprintContext,
): AppliedBaseline {
  let recorded = 0;
  let suppressed = 0;
  let stale = 0;

  const applied = results.map((r) => {
    const known = baseline.entries[canonicalFilePath(r.file, ctx)];
    if (!known) return r; // no entry: a new or renamed file, everything is new
    const recordedHere = new Set(known);
    recorded += recordedHere.size;

    const seen = new Set<string>();
    const fresh: FieldError[] = [];
    for (const e of r.errors) {
      const print = fingerprint(e, ctx);
      if (recordedHere.has(print)) {
        seen.add(print);
        suppressed += 1;
      } else {
        fresh.push(e);
      }
    }
    stale += recordedHere.size - seen.size;

    const baselined = r.errors.length - fresh.length;
    return {
      ...r,
      ok: fresh.length === 0,
      errors: fresh,
      ...(baselined > 0 ? { baselined } : {}),
    };
  });

  return { results: applied, recorded, suppressed, stale };
}

/**
 * Count fingerprints added and dropped between two baselines.
 *
 * The `removed` half is the load-bearing one: an accidental `--write-baseline`
 * on a narrowed glob or a mistyped `--exclude` silently forgives everything it
 * did not see, and this number is the only thing that makes that visible in a
 * CI log.
 */
export function diffBaselines(
  previous: Baseline | null,
  next: Baseline,
): { added: number; removed: number } {
  const flatten = (b: Baseline | null): Set<string> => {
    const out = new Set<string>();
    if (!b) return out;
    for (const [file, prints] of Object.entries(b.entries)) {
      for (const p of prints) out.add(`${file}\0${p}`);
    }
    return out;
  };
  const before = flatten(previous);
  const after = flatten(next);
  let added = 0;
  let removed = 0;
  for (const k of after) if (!before.has(k)) added += 1;
  for (const k of before) if (!after.has(k)) removed += 1;
  return { added, removed };
}

/** Total fingerprints held in a baseline, across every file. */
export function countFingerprints(baseline: Baseline): number {
  let n = 0;
  for (const prints of Object.values(baseline.entries)) n += prints.length;
  return n;
}
