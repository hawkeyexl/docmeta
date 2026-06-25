/**
 * `get` command core. Prints one or more metadata field values from each file.
 * Input handling (positional paths, globs, directories, `-` for stdin, and
 * config `paths:` fallback) mirrors `validate` so the two commands behave
 * identically.
 */
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { DocmetaError } from "../types.js";
import {
  extractorByName,
  extractorForExtension,
  supportedExtensions,
} from "../extractors/index.js";
import { resolveTargets, STDIN_TOKEN } from "../core/load-files.js";
import { loadConfig, type DocmetaConfig } from "../core/config.js";

export interface GetOptions {
  fields: string[];
  inputs: string[];
  as?: string;
  exclude?: string[];
  exts?: string[];
  configPath?: string;
  cwd?: string;
  /** Content for the `-` (stdin) input, injected by the CLI/tests. */
  stdinContent?: string;
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

  const loaded = await loadConfig(opts.configPath, cwd);
  const config: DocmetaConfig | null = loaded?.config ?? null;

  // Determine inputs: explicit CLI inputs win, else config.paths.
  const inputs = opts.inputs.length > 0 ? opts.inputs : (config?.paths ?? []);
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
  const files = await resolveTargets({
    inputs: fileInputs,
    exts,
    exclude: [...(config?.exclude ?? []), ...(opts.exclude ?? [])],
    cwd,
  });

  const out: GetFileResult[] = [];

  const readOne = (label: string, content: string, extension: string): void => {
    const extractor = forced ?? extractorForExtension(extension);
    if (!extractor) {
      throw new DocmetaError(
        `Unsupported file type "${extension}" for "${label}". Supported: ${supportedExtensions().join(", ")}. Use --as to override.`,
      );
    }
    const extracted = extractor.extract(content, label);
    const values: Record<string, unknown> = {};
    for (const f of opts.fields) values[f] = extracted.data[f];
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
    const content = await readFile(resolve(cwd, file), "utf8");
    readOne(file, content, extname(file));
  }

  return out;
}
