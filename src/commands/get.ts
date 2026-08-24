/**
 * `get` command core. Prints one or more metadata field values from each file.
 * Input handling (positional paths, globs, directories, `-` for stdin, and
 * config `paths:` fallback) mirrors `validate` so the two commands behave
 * identically.
 */
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { resolveElements } from "../core/resolve-schema.js";
import { DocmetaError } from "../types.js";
import {
  extractorByName,
  extractorForExtension,
  supportedExtensions,
} from "../extractors/index.js";
import {
  assertNonEmpty,
  gitignoreOptions,
  resolveTargetSet,
  STDIN_TOKEN,
} from "../core/load-files.js";
import { resolveRunConfig, type ConfigNotice } from "../core/config.js";

export interface GetOptions {
  fields: string[];
  inputs: string[];
  as?: string;
  exclude?: string[];
  exts?: string[];
  configPath?: string;
  /** `--no-config`: skip config discovery and use the built-in defaults. */
  noConfig?: boolean;
  cwd?: string;
  /** Content for the `-` (stdin) input, injected by the CLI/tests. */
  stdinContent?: string;
  /** Permit an input set that resolves to zero files (see `assertNonEmpty`). */
  allowEmpty?: boolean;
  /**
   * `--no-gitignore` (false). Absent leaves config `respectGitignore:` in
   * charge, which itself defaults to on.
   */
  respectGitignore?: boolean;
  /** Diagnostics for the user; the CLI writes these to stderr. */
  onNotice?: (message: string) => void;
  /** Called once when a config governs the run, so the CLI can report it. */
  onConfigLoaded?: (info: ConfigNotice) => void;
  /**
   * `--offline`, accepted for surface parity with `validate` and `fill`.
   *
   * It has **no effect here**, and that is a property of the command rather
   * than an omission: `get` prints extracted field values and never resolves or
   * loads a schema, so it has no network dependency to suppress. Accepting it
   * keeps one flag set across the three commands, so a script can pass
   * `--offline` uniformly without knowing which subcommand needs it.
   */
  offline?: boolean;
}

export interface GetFileResult {
  file: string;
  present: boolean;
  values: Record<string, unknown>;
}

export async function runGet(opts: GetOptions): Promise<GetFileResult[]> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.fields.length === 0) {
    throw new DocmetaError("Specify at least one field to get.");
  }

  // Explicit CLI inputs win, else config `paths:`; `base` is whichever of the
  // two directories those inputs were written relative to.
  const { config, inputs, base } = await resolveRunConfig({
    cwd,
    configPath: opts.configPath,
    noConfig: opts.noConfig,
    inputs: opts.inputs,
    onConfigLoaded: opts.onConfigLoaded,
  });
  const usingStdin = inputs.includes(STDIN_TOKEN);

  if (inputs.length === 0) {
    throw new DocmetaError(
      "No files to read. Pass paths/globs, or add `paths:` to docmeta.config.yaml.",
    );
  }

  const forced = opts.as ? extractorByName(opts.as) : undefined;
  if (opts.as && !forced) {
    throw new DocmetaError(
      `Unknown format "${opts.as}". Supported extensions: ${supportedExtensions().join(", ")}.`,
    );
  }

  const exts = opts.exts ?? (forced ? forced.extensions : undefined);
  const fileInputs = inputs.filter((i) => i !== STDIN_TOKEN);
  const allowEmpty = opts.allowEmpty ?? config?.allowEmpty;
  const exclude = [...(config?.exclude ?? []), ...(opts.exclude ?? [])];
  const { files, gitignoreSkipped } = await resolveTargetSet({
    inputs: fileInputs,
    exts,
    exclude,
    cwd: base,
    allowEmpty,
    ...gitignoreOptions({
      flag: opts.respectGitignore,
      configured: config?.respectGitignore,
      onNotice: opts.onNotice,
    }),
  });
  assertNonEmpty({
    files,
    inputs: fileInputs,
    usingStdin,
    allowEmpty,
    exclude,
    exts,
    gitignoreSkipped,
    action: "read",
  });

  const out: GetFileResult[] = [];

  const readOne = (label: string, content: string, extension: string): void => {
    const extractor = forced ?? extractorForExtension(extension);
    if (!extractor) {
      throw new DocmetaError(
        `Unsupported file type "${extension}" for "${label}". Supported: ${supportedExtensions().join(", ")}. Use --as to override.`,
      );
    }
    const extracted = extractor.extract(content, label, {
      elements: resolveElements(label, config),
    });
    const values: Record<string, unknown> = {};
    for (const f of opts.fields) values[f] = resolveField(extracted.data, f);
    out.push({ file: label, present: extracted.present, values });
  };

  if (usingStdin) {
    if (!forced) {
      throw new DocmetaError(
        "Reading from stdin (`-`) requires --as <format> to choose an extractor.",
      );
    }
    readOne("<stdin>", opts.stdinContent ?? "", forced.extensions[0] ?? "");
  }

  for (const file of files) {
    const content = await readFile(resolve(base, file), "utf8");
    readOne(file, content, extname(file));
  }

  return out;
}

/**
 * Resolve a single field reference against extracted metadata.
 *
 * A reference starting with `/` is a JSON Pointer (RFC 6901) — the same
 * convention the validator and reporters already use for nested error paths,
 * so a pointer copied from a validation error works verbatim. Any other
 * reference is dot-notation (`author.name`, `tags.0`). Pointers also escape
 * keys that contain literal dots or slashes (`/odd.key`, `/a~1b` for `a/b`).
 *
 * Returns `undefined` when any segment is missing or descends into a scalar.
 * A bare top-level key (no `/`, no `.`) resolves to a single segment, so the
 * historical `get title` behavior is unchanged.
 *
 * **A key that literally contains a dot is tried as a fallback**, after descent
 * fails. Element-derived metadata makes those ordinary — `article.title`,
 * `prolog.author`, `ms.date` — and without this, `get article.title` returned
 * an *empty* result rather than an error, which is a silent wrong answer.
 * Descent still wins wherever it resolves, so a document with a genuine
 * `author: { name: … }` object answers `author.name` exactly as it always has;
 * the fallback only fires where the old behavior was to give up.
 */
function resolveField(data: Record<string, unknown>, field: string): unknown {
  const segments = field.startsWith("/")
    ? parseJsonPointer(field)
    : field.split(".");
  const descended = descend(data, segments);
  if (descended !== undefined) return descended;
  if (
    !field.startsWith("/") &&
    field.includes(".") &&
    Object.prototype.hasOwnProperty.call(data, field)
  ) {
    return data[field];
  }
  return undefined;
}

/** Walk `segments` into `data`, or `undefined` at the first miss. */
function descend(data: Record<string, unknown>, segments: string[]): unknown {
  let current: unknown = data;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (current !== null && typeof current === "object") {
      // Own-property check only: never resolve inherited members like
      // `toString` or `__proto__` — those are "missing", not values.
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Decode a JSON Pointer into path segments, unescaping `~1`→`/` and `~0`→`~`. */
function parseJsonPointer(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}
