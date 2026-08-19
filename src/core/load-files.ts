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
import { GITIGNORE_UNAVAILABLE, gitIgnored } from "./gitignore.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];

export const STDIN_TOKEN = "-";

/**
 * What a stdin result is labelled in output. Lives here beside the input token
 * so the two spellings cannot drift: commands set it, reporters test for it,
 * and a reporter that missed a rename would give a `<stdin>` result an
 * `artifactLocation.uri` naming a file that does not exist.
 */
export const STDIN_LABEL = "<stdin>";

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
  /**
   * Skip files `.gitignore` covers during directory and glob expansion.
   * Default true; `--no-gitignore` / `respectGitignore: false` turns it off.
   *
   * Explicitly named files are never filtered — the user who types a path
   * means it — which mirrors how an explicit file already bypasses `--ext`.
   */
  respectGitignore?: boolean;
  /**
   * Called when filtering was asked for but git could not answer (no
   * repository, no git binary). Callers pass this only when the user asked
   * for filtering *explicitly*, since on the default it would put a line of
   * stderr on every run outside a repo.
   */
  onGitignoreUnavailable?: () => void;
}

export interface ResolvedTargets {
  /** The files to process, posix-style and relative to `cwd`. */
  files: string[];
  /**
   * Candidate documents `.gitignore` removed. Counted **after** the extension
   * filter, so the number answers "how many files I would otherwise have
   * checked did .gitignore take away" rather than including every ignored
   * `.png` under `build/`. `--exclude` removals are not counted here; those
   * are the caller's own instruction, not a surprise.
   */
  gitignoreSkipped: number;
}

/**
 * Settle the two gitignore knobs every command core passes down, so the three
 * of them cannot drift on either the precedence or the diagnostic.
 *
 * `flag` is `--no-gitignore` (or a programmatic override), `configured` is
 * `respectGitignore:` from config, and the default is on.
 */
export function gitignoreOptions(opts: {
  flag?: boolean;
  configured?: boolean;
  onNotice?: (message: string) => void;
}): Pick<ResolveOptions, "respectGitignore" | "onGitignoreUnavailable"> {
  // Only a value someone actually wrote is worth a diagnostic. On the default,
  // a note would land on every run outside a repository — an extracted
  // tarball, `npm pack` output, some Docker build contexts — for a filter
  // nobody asked for.
  const asked =
    opts.flag === true || (opts.flag === undefined && opts.configured === true);
  const notice = opts.onNotice;
  return {
    respectGitignore: opts.flag ?? opts.configured ?? true,
    ...(asked && notice
      ? { onGitignoreUnavailable: () => notice(GITIGNORE_UNAVAILABLE) }
      : {}),
  };
}

/** The file list alone, for callers with no use for what was filtered out. */
export async function resolveTargets(opts: ResolveOptions): Promise<string[]> {
  return (await resolveTargetSet(opts)).files;
}

export async function resolveTargetSet(
  opts: ResolveOptions,
): Promise<ResolvedTargets> {
  const cwd = opts.cwd ?? process.cwd();
  const exts = (opts.exts ?? supportedExtensions()).map((e) =>
    e.toLowerCase().startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`,
  );
  const ignore = [...DEFAULT_IGNORE, ...(opts.exclude ?? [])];
  // Kept apart until the end: `named` is what the user typed and is never
  // filtered, `walked` is what a directory or glob produced and is.
  const named = new Set<string>();
  const walked = new Set<string>();

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
      named.add(toPosix(relative(cwd, abs)));
      continue;
    }

    if (st?.isDirectory()) {
      const found = await fg(`${posixInput}/**/*`, {
        cwd,
        ignore,
        onlyFiles: true,
        dot: false,
      });
      for (const f of found) if (keepByExt(f)) walked.add(f);
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
    for (const f of found) if (keepByExt(f)) walked.add(f);
  }

  if (missing.length > 0 && !opts.allowEmpty) {
    const names = missing.map((m) => `"${m}"`).join(", ");
    throw new DocmetaError(
      missing.length === 1
        ? `File not found: ${names}.`
        : `Files not found: ${names}.`,
    );
  }

  // Gitignore runs last, over the extension-filtered walk only. A file the
  // user also named explicitly is excluded from the question rather than from
  // the answer, so it can neither be dropped nor inflate the skipped count.
  let gitignoreSkipped = 0;
  if (opts.respectGitignore !== false && walked.size > 0) {
    const candidates = [...walked].filter((f) => !named.has(f));
    const { ignored, available } = await gitIgnored(candidates, cwd);
    if (available) {
      for (const f of ignored) {
        if (walked.delete(f)) gitignoreSkipped += 1;
      }
    } else {
      opts.onGitignoreUnavailable?.();
    }
  }

  return {
    files: [...new Set([...named, ...walked])].sort(),
    gitignoreSkipped,
  };
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
  /** Candidates `.gitignore` removed, so an empty set says so rather than baffles. */
  gitignoreSkipped?: number;
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
  // The one filter the user never wrote down, so it is the one most worth
  // naming: a docs tree the repo happens to ignore looks like a broken glob.
  if (p.gitignoreSkipped && p.gitignoreSkipped > 0) {
    notes.push(
      `.gitignore skipped ${p.gitignoreSkipped} (pass --no-gitignore to check them)`,
    );
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
