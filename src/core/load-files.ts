/**
 * Resolve a mix of explicit files, directories, and globs into a concrete,
 * de-duplicated, sorted list of file paths (posix-style, relative to cwd).
 * Directory and glob expansion is restricted to the given extensions; explicit
 * file arguments are always included so the user can target any single file.
 */
import { stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import fg from "fast-glob";
import { supportedExtensions } from "../extractors/index.js";

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

  for (const input of opts.inputs) {
    if (input === STDIN_TOKEN) continue;

    const abs = resolve(cwd, input);
    const st = await statOrNull(abs);

    if (st?.isFile()) {
      out.add(toPosix(relative(cwd, abs)));
      continue;
    }

    if (st?.isDirectory()) {
      const found = await fg(`${toPosix(input)}/**/*`, {
        cwd,
        ignore,
        onlyFiles: true,
        dot: false,
      });
      for (const f of found) if (keepByExt(f)) out.add(f);
      continue;
    }

    // Treat as a glob pattern.
    const found = await fg(toPosix(input), {
      cwd,
      ignore,
      onlyFiles: true,
      dot: false,
    });
    for (const f of found) if (keepByExt(f)) out.add(f);
  }

  return [...out].sort();
}
