/**
 * Resolve the schema *set* for a single file by precedence:
 *   1. CLI --schema overrides (apply to all files)
 *   2. $schema in the file's metadata (string or list)
 *   3. first matching config override (by glob)
 *   4. config default schemas
 *   5. the built-in default set (DEFAULT_SCHEMAS)
 */
import { isAbsolute, relative, resolve } from "node:path";
import picomatch from "picomatch";
import type {
  DocmetaConfig,
  DocumentRefTrust,
  SchemaEntry,
  SchemaTrustRoot,
} from "./config.js";
import { classifyRef, type SchemaPin } from "./schema-registry.js";
import { DocmetaError } from "../types.js";

/**
 * Applied when nothing else resolves. Seven-Action is safe to include here
 * because it constrains `action` — a key documents don't otherwise carry — and
 * does not require it, so adding it fails nothing that passed before.
 * Diataxis is deliberately absent: it both requires and constrains `type`, so
 * defaulting it would fail every repo not already on Diataxis.
 */
export const DEFAULT_SCHEMAS: readonly string[] = Object.freeze([
  "google:okf:0.1",
  "passo-uno:seven-action:1.0",
]);
export const FILE_SCHEMA_KEY = "$schema";

/**
 * The reference a `schemas:` entry loads, in either form.
 *
 * The ref *string* is what `resolveSchemaSet` returns and therefore what every
 * report names, what every baseline fingerprint is taken over, and what keys
 * `Validator`'s compile cache. Widening those to carry a mapping would have
 * changed all three; the `{source, integrity}` sidecar travels separately, in
 * the pin map below.
 */
export function schemaEntryRef(entry: SchemaEntry): string {
  return typeof entry === "string" ? entry : entry.ref;
}

/**
 * The ref → pin map for a config, for `loadSchema` to consult.
 *
 * Only entries that actually carry `source` or `integrity` are recorded, so a
 * config written entirely in the string form produces an empty map and nothing
 * about how it loads changes.
 *
 * Keyed on the ref exactly as `resolveSchemaSet` will hand it to `loadSchema`,
 * which means this must be built from the **rebased** config — the same
 * absolute spelling on both sides, or the pin silently fails to apply.
 */
export function collectSchemaPins(
  config: DocmetaConfig | null | undefined,
): Map<string, SchemaPin> {
  const pins = new Map<string, SchemaPin>();
  for (const entry of config?.schemas ?? []) {
    if (typeof entry === "string") continue;
    if (entry.source === undefined && entry.integrity === undefined) continue;
    pins.set(entry.ref, {
      ...(entry.source !== undefined ? { source: entry.source } : {}),
      ...(entry.integrity !== undefined ? { integrity: entry.integrity } : {}),
    });
  }
  return pins;
}

/**
 * Re-point a config's **local file** schema refs at the config's own directory.
 *
 * `schemas: ["./house.schema.json"]` means the file next to the config; that is
 * what the person editing the config can see. But `loadSchema` reads a file ref
 * relative to the process's working directory, so once the config lives
 * somewhere other than where the command was invoked — via `-c ../x.yaml`, or
 * via discovery finding an ancestor — the same ref points at nothing.
 *
 * Only refs the *config* supplied are rebased. A document's own `$schema` and a
 * `--schema` on the command line were both written by someone standing in the
 * working directory, so they keep resolving from there. Built-in ids and URLs
 * have no base to speak of and pass through untouched.
 *
 * When the config's directory *is* the working directory — every setup that
 * works today — the config object is returned unchanged, so nothing about an
 * existing run moves, right down to the ref strings that appear in reports.
 * The rebased form is absolute rather than relative on purpose: relative would
 * only be correct while `process.cwd()` matched `cwd`, which is true of the CLI
 * but not of `runValidate` called as a library.
 */
export function rebaseConfigSchemaRefs(
  config: DocmetaConfig,
  configDir: string,
  cwd: string,
): DocmetaConfig {
  // Exact string comparison, deliberately. `path.resolve` preserves input
  // casing rather than canonicalizing it, so two differently-cased spellings of
  // the same directory on a case-insensitive filesystem would compare unequal
  // and refs would be rebased to absolute paths needlessly — cosmetic, not
  // incorrect. Lowercasing instead would be wrong on a case-sensitive
  // filesystem, where two casings really are two directories. In practice both
  // values reach here from the same `resolve(cwd)` call site.
  if (resolve(configDir) === resolve(cwd)) return config;

  const rebase = (ref: string): string =>
    classifyRef(ref).kind === "file" && !isAbsolute(ref)
      ? resolve(configDir, ref)
      : ref;

  /**
   * The mapping form rebases its `ref` for the same reason a string does, and
   * its `source` too when that is itself a local path — a schema vendored from
   * a checkout elsewhere on disk names a file the config's author could see,
   * not one the caller's working directory can.
   *
   * A `source` that is a URL passes through `rebase` untouched, so no branch is
   * needed here for it.
   */
  const rebaseEntry = (entry: SchemaEntry): SchemaEntry =>
    typeof entry === "string"
      ? rebase(entry)
      : {
          ...entry,
          ref: rebase(entry.ref),
          ...(entry.source !== undefined
            ? { source: rebase(entry.source) }
            : {}),
        };

  return {
    ...config,
    ...(config.schemas ? { schemas: config.schemas.map(rebaseEntry) } : {}),
    ...(config.overrides
      ? {
          overrides: config.overrides.map((o) => ({
            ...o,
            schemas: o.schemas.map(rebase),
          })),
        }
      : {}),
  };
}

export interface ResolveParams {
  /** File path (relative is fine) used for override glob matching. */
  filePath: string;
  /** `$schema` value pulled from the file's metadata. */
  fileSchema?: unknown;
  /** Repeatable `--schema` values; non-empty means override. */
  cliSchemas?: string[];
  /** Loaded config, if any. */
  config?: DocmetaConfig | null;
  /**
   * Directory a **relative document-supplied** file ref is measured from — the
   * run's `cwd`, matching `LoadSchemaOptions.fileBase`. Only the containment
   * check below reads it; the ref string itself is never rewritten.
   */
  fileBase?: string;
  /**
   * The repository a document-supplied local path may not escape. Supplied by
   * the command cores via `schemaTrustRoot`.
   *
   * **Omitting it skips containment.** The resolver is synchronous and pure,
   * and finding a git root is a filesystem walk — so the root is settled once
   * per run by the caller rather than rediscovered per file. `runValidate` and
   * `runFill` both pass it, and `test/commands.test.ts` proves they do end to
   * end; a library caller that resolves refs itself opts in the same way.
   */
  trustRoot?: SchemaTrustRoot;
  /**
   * Diagnostics for the user. Used by `documentRefs: none`, which must say
   * which document's `$schema` it dropped — discarding input in silence is the
   * failure mode this key exists to remove.
   */
  onNotice?: (message: string) => void;
}

const matcherCache = new Map<string, (p: string) => boolean>();
function matches(glob: string, filePath: string): boolean {
  let m = matcherCache.get(glob);
  if (!m) {
    m = picomatch(glob, { dot: true });
    matcherCache.set(glob, m);
  }
  // Normalize Windows separators so globs written with `/` still match.
  return m(filePath.replace(/\\/g, "/"));
}

function coerceFileSchema(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  throw new Error(
    `Invalid "${FILE_SCHEMA_KEY}": must be a string or a list of strings.`,
  );
}

function dedupe(refs: string[]): string[] {
  return [...new Set(refs)];
}

/**
 * Does a document-supplied URL name a host the config listed?
 *
 * Both `hostname` (`schemas.example.com`) and `host` (`127.0.0.1:8080`) are
 * compared, so an entry may carry a port or not. Case-insensitive, because DNS
 * is: an allowlist that `Schemas.Example.com` slipped past would be a footgun,
 * not a feature.
 */
function hostAllowed(url: URL, hosts: readonly string[]): boolean {
  const hostname = url.hostname.toLowerCase();
  const host = url.host.toLowerCase();
  return hosts.some((h) => {
    const want = h.trim().toLowerCase();
    return want === hostname || want === host;
  });
}

/**
 * Refuse a ref this document is not trusted to name.
 *
 * Called **only** from the `fileSchema` branch below, which is the last place
 * that still knows where a ref came from — by the time `loadSchema` sees one it
 * is just a string. Config- and CLI-supplied refs never reach here, in any
 * mode, and that is deliberate: an operator wrote those.
 *
 * Throws `DocmetaError` per ref. `runValidate` and `runFill` both catch it and
 * file it as a per-file `keyword: "schema"` finding, so a refusal is **one
 * failing file** (exit 1) annotated on the offending document rather than an
 * aborted run.
 */
function assertDocumentRefAllowed(
  ref: string,
  mode: Exclude<DocumentRefTrust, "none">,
  params: ResolveParams,
): void {
  const { kind } = classifyRef(ref);

  // A built-in id is bundled with docmeta: it names no host and reads no file,
  // so there is nothing for a document to reach with it. Allowed in every mode
  // — `test/fixtures/schema-ref.md` and the documented "self-describing
  // document" pattern both depend on that.
  if (kind === "builtin") return;

  if (kind === "url") {
    if (mode === "local") {
      throw new DocmetaError(
        `Refusing the "${FILE_SCHEMA_KEY}" URL "${ref}": schemaTrust.documentRefs is "local", so a document may name a built-in id or a schema file inside the repository, but not a URL. Vendor it with \`docmeta schemas vendor ${ref}\` and reference the local copy, or put the URL in \`schemas:\` where an operator controls it.`,
      );
    }
    const hosts = params.config?.schemaTrust?.hosts;
    if (!hosts || hosts.length === 0) return; // `any` with no list: as before
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      throw new DocmetaError(
        `Refusing the "${FILE_SCHEMA_KEY}" URL "${ref}": it cannot be parsed as a URL, so it cannot be checked against schemaTrust.hosts.`,
      );
    }
    if (!hostAllowed(url, hosts)) {
      throw new DocmetaError(
        `Refusing the "${FILE_SCHEMA_KEY}" URL "${ref}": host "${url.host}" is not in schemaTrust.hosts (${hosts.join(", ")}). Add the host there, or reference a schema the config already names.`,
      );
    }
    return;
  }

  // A local path. "A schema in this project" is what a document naming one
  // reasonably means — not any file the CI process happens to be able to open.
  // Applies in `any` as well as `local`: containment costs no existing setup a
  // feature, so it is not something a repo should have to opt into.
  //
  // No `trustRoot` means the caller did not settle a boundary; see the field's
  // documentation for why that is the caller's job and not this function's.
  const root = params.trustRoot;
  if (!root) return;
  const abs = resolve(params.fileBase ?? process.cwd(), ref);
  const within = relative(root.dir, abs);
  // `""` is the root directory itself, which is not a file either way.
  // `path.relative` compares case-insensitively on Windows, so a differently
  // cased spelling of an in-repo path is still recognized as inside.
  if (within !== "" && !within.startsWith("..") && !isAbsolute(within)) return;
  // The boundary is named by the rule that produced it. Saying "the config's
  // own directory" to someone who has no config file sends them looking for a
  // file that is not there, and the `cwd` case is the one where the boundary
  // moves depending on where the command was run — which is worth saying out
  // loud rather than leaving them to infer it.
  const boundary =
    root.source === "git"
      ? `the repository root (${root.dir})`
      : root.source === "config"
        ? `${root.dir} — no git repository was found, so the config file's own directory is the boundary`
        : `${root.dir} — no git repository and no config file were found, so the directory the command was run from is the boundary`;
  const scope = root.source === "git" ? "the repository" : "the project";
  throw new DocmetaError(
    `Refusing the "${FILE_SCHEMA_KEY}" path "${ref}": it resolves outside ${boundary}. A document may only name a schema inside ${scope}; a path in \`schemas:\` or on \`--schema\` is not restricted this way.`,
  );
}

/** Which precedence level produced a schema set. */
export type SchemaSetSource =
  | "cli"
  | "document"
  | "override"
  | "config"
  | "default";

export interface ResolvedSchemaSet {
  schemas: string[];
  source: SchemaSetSource;
}

/**
 * `resolveSchemaSet`, plus the branch that won.
 *
 * The caller needs this to answer one question: if a ref in this set fails to
 * *load*, whose problem is it? A schema the **document** chose is that
 * document's problem and belongs in its own finding. A schema the **operator**
 * configured invalidates every file in the run, so it stays operational and
 * aborts. Without the source those two are indistinguishable by the time a
 * `DocmetaError` comes back from `loadSchema`, and both aborted — which let one
 * contributed document take down validation of every other file.
 *
 * Kept as a separate export rather than widening `resolveSchemaSet`'s return,
 * which is public API and is what every existing caller wants.
 */
export function resolveSchemaSetWithSource(
  params: ResolveParams,
): ResolvedSchemaSet {
  const { filePath, fileSchema, cliSchemas, config } = params;

  if (cliSchemas && cliSchemas.length > 0) {
    return { schemas: dedupe(cliSchemas), source: "cli" };
  }

  const fromFile = coerceFileSchema(fileSchema);
  if (fromFile && fromFile.length > 0) {
    // The one branch a trust boundary can be applied in. `none` drops the refs
    // and falls through to the levels below; the other two modes vet each ref
    // and throw on the first they refuse.
    const mode = config?.schemaTrust?.documentRefs ?? "any";
    if (mode === "none") {
      params.onNotice?.(
        `${filePath}: "${FILE_SCHEMA_KEY}" is ignored (${fromFile.join(", ")}) — schemaTrust.documentRefs is "none", so the schema set comes from the config instead. Remove the key from the document, or set schemaTrust.documentRefs to "local" or "any" to honor it.`,
      );
    } else {
      for (const ref of fromFile) assertDocumentRefAllowed(ref, mode, params);
      return { schemas: dedupe(fromFile), source: "document" };
    }
  }

  if (config?.overrides) {
    for (const ov of config.overrides) {
      if (matches(ov.files, filePath) && ov.schemas.length > 0) {
        return { schemas: dedupe(ov.schemas), source: "override" };
      }
    }
  }

  if (config?.schemas && config.schemas.length > 0) {
    return {
      schemas: dedupe(config.schemas.map(schemaEntryRef)),
      source: "config",
    };
  }

  return { schemas: [...DEFAULT_SCHEMAS], source: "default" };
}

export function resolveSchemaSet(params: ResolveParams): string[] {
  return resolveSchemaSetWithSource(params).schemas;
}
