/**
 * Resolve a mix of explicit files, directories, and globs into a concrete,
 * de-duplicated, sorted list of file paths (posix-style, relative to cwd).
 * Directory and glob expansion is restricted to the given extensions; explicit
 * file arguments are always included so the user can target any single file.
 */
import { stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import fg from "fast-glob";
import picomatch from "picomatch";
import { supportedExtensions } from "../extractors/index.js";
import { DocmetaError } from "../types.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];

export const STDIN_TOKEN = "-";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

async function statOrNull(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

export interface ResolveOptions {
  /** Positional inputs: files, directories, or globs. `-` is ignored here. */
  inputs: string[];
  /** Extensions to keep during dir/glob expansion (default: supported). */
  exts?: string[];
  /** Extra exclude globs (added to node_modules/.git defaults). */
  exclude?: string[];
  cwd?: string;
  /**
   * Do not report inputs that name a path which does not exist. Set by
   * `--allow-empty` / `allowEmpty:` for callers that legitimately run against
   * a repo where the targets may be absent (a shared CI template, a
   * pre-commit hook with an empty file list).
   */
  allowEmpty?: boolean;
}

export async function resolveTargets(opts: ResolveOptions): Promise<string[]> {
  const cwd = opts.cwd ?? process.cwd();
  const exts = (opts.exts ?? supportedExtensions()).map((e) =>
    e.toLowerCase().startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`,
  );
  const ignore = [...DEFAULT_IGNORE, ...(opts.exclude ?? [])];
  const out = new Set<string>();

  const keepByExt = (file: string): boolean =>
    exts.includes(extname(file).toLowerCase());

  // Inputs that name a single path rather than describing a pattern, and that
  // do not exist. Collected rather than thrown on first sight so one error can
  // name every mistake.
  const missing: string[] = [];

  for (const input of opts.inputs) {
    if (input === STDIN_TOKEN) continue;

    // Normalize before resolving, not after. `path.resolve` treats a backslash
    // as a separator on Windows and as an ordinary filename character on Linux,
    // so `nested\doc.md` would stat successfully on a developer's machine and
    // then fail on Linux CI — while the not-found message, built from the posix
    // form, named a different path than the one actually looked for. Normalizing
    // here keeps the stat, the glob, and the message on one spelling.
    //
    // The cost is that a Linux file whose name genuinely contains a backslash is
    // not addressable. That is accepted: this module already treats backslash as
    // a separator everywhere else (glob expansion and the returned labels both
    // go through `toPosix`), and a docs tree containing such a name is a
    // hypothetical, whereas Windows-authored paths reaching Linux CI is routine.
    const posixInput = toPosix(input);
    const abs = resolve(cwd, posixInput);
    const st = await statOrNull(abs);

    if (st?.isFile()) {
      out.add(toPosix(relative(cwd, abs)));
      continue;
    }

    if (st?.isDirectory()) {
      const found = await fg(`${posixInput}/**/*`, {
        cwd,
        ignore,
        onlyFiles: true,
        dot: false,
      });
      for (const f of found) if (keepByExt(f)) out.add(f);
      continue;
    }

    // Nothing on disk. Decide whether this input was a *name* or a *pattern*:
    // a name that does not exist is a mistake worth reporting, while a pattern
    // matching nothing is the caller's business (the command cores check for an
    // empty result set).
    if (!picomatch.scan(posixInput).isGlob) {
      missing.push(posixInput);
      continue;
    }

    const found = await fg(posixInput, {
      cwd,
      ignore,
      onlyFiles: true,
      dot: false,
    });
    for (const f of found) if (keepByExt(f)) out.add(f);
  }

  if (missing.length > 0 && !opts.allowEmpty) {
    const names = missing.map((m) => `"${m}"`).join(", ");
    throw new DocmetaError(
      missing.length === 1
        ? `File not found: ${names}.`
        : `Files not found: ${names}.`,
    );
  }

  return [...out].sort();
}

export interface NonEmptyParams {
  /** Files actually resolved. */
  files: string[];
  /** The positional inputs, stdin token already removed. */
  inputs: string[];
  /** Whether `-` was among the inputs; stdin is one input, so it is not empty. */
  usingStdin: boolean;
  allowEmpty?: boolean;
  exclude?: string[];
  exts?: string[];
  /** Past-tense verb for the message: "validated", "read", "filled". */
  action: string;
}

/**
 * Resolving zero files is an operational error, not a pass.
 *
 * Exit 0 means "every file passed"; with no files there is no verdict, so
 * reporting success turns a broken glob, a moved directory, or a too-broad
 * `--exclude` into a permanently green gate that checks nothing. Exit 2 (a
 * `DocmetaError`) is the documented code for "docmeta could not produce a
 * verdict", which is exactly this case.
 */
export function assertNonEmpty(p: NonEmptyParams): void {
  if (p.allowEmpty || p.usingStdin || p.files.length > 0) return;

  const tried = p.inputs.map((i) => `"${i}"`).join(", ");
  const notes: string[] = [];
  // Name the filters, because "no files matched" is baffling when the pattern
  // plainly matches files on disk and an --ext or --exclude removed them.
  if (p.exts && p.exts.length > 0) {
    notes.push(`extensions: ${p.exts.join(", ")}`);
  }
  if (p.exclude && p.exclude.length > 0) {
    notes.push(`excludes: ${p.exclude.map((e) => `"${e}"`).join(", ")}`);
  }

  throw new DocmetaError(
    [
      `No files matched. Patterns tried: ${tried}.`,
      ...(notes.length > 0 ? [`Filters applied — ${notes.join("; ")}.`] : []),
      `Nothing was ${p.action}, so this is an error rather than a pass.`,
      `Pass --allow-empty (or set allowEmpty: true) if matching nothing is expected.`,
    ].join("\n"),
  );
}
