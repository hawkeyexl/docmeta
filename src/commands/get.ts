/**
 * `get` command core. Prints one or more metadata field values from each file.
 */
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { DocmetaError } from "../types.js";
import {
  extractorByName,
  extractorForExtension,
  supportedExtensions,
} from "../extractors/index.js";
import { resolveTargets } from "../core/load-files.js";

export interface GetOptions {
  fields: string[];
  inputs: string[];
  as?: string;
  exclude?: string[];
  exts?: string[];
  cwd?: string;
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

  const forced = opts.as ? extractorByName(opts.as) : undefined;
  if (opts.as && !forced) {
    throw new DocmetaError(
      `Unknown format "${opts.as}". Supported extensions: ${supportedExtensions().join(", ")}.`,
    );
  }

  const files = await resolveTargets({
    inputs: opts.inputs,
    exts: opts.exts ?? (forced ? forced.extensions : undefined),
    exclude: opts.exclude,
    cwd,
  });

  const out: GetFileResult[] = [];
  for (const file of files) {
    const content = await readFile(resolve(cwd, file), "utf8");
    const extractor = forced ?? extractorForExtension(extname(file));
    if (!extractor) {
      throw new DocmetaError(
        `Unsupported file type "${extname(file)}" for "${file}". Use --as to override.`,
      );
    }
    const extracted = extractor.extract(content, file);
    const values: Record<string, unknown> = {};
    for (const f of opts.fields) values[f] = extracted.data[f];
    out.push({ file, present: extracted.present, values });
  }
  return out;
}
