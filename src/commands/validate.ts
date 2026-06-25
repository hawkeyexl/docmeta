/**
 * `validate` command core. Resolves targets, extracts metadata, resolves a
 * schema set per file, validates, and returns structured results. Kept free of
 * CLI/IO plumbing so it can be tested directly.
 */
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import {
  DocmetaError,
  type FieldError,
  type RunSummary,
  type ValidationResult,
} from "../types.js";
import {
  extractorByName,
  extractorForExtension,
  supportedExtensions,
} from "../extractors/index.js";
import { resolveTargets, STDIN_TOKEN } from "../core/load-files.js";
import { loadConfig, type DocmetaConfig } from "../core/config.js";
import { resolveSchemaSet, FILE_SCHEMA_KEY } from "../core/resolve-schema.js";
import { Validator } from "../core/validator.js";

export interface ValidateOptions {
  inputs: string[];
  cliSchemas?: string[];
  exts?: string[];
  exclude?: string[];
  /** `--as` format override (extractor name). */
  as?: string;
  configPath?: string;
  cwd?: string;
  /** Content for the `-` (stdin) input, injected by the CLI/tests. */
  stdinContent?: string;
}

export interface ValidateRun {
  results: ValidationResult[];
  summary: RunSummary;
}

function parseErrorResult(
  file: string,
  format: string,
  message: string,
): ValidationResult {
  const err: FieldError = { schema: "(parse)", instancePath: "", message };
  return { file, format, ok: false, schemas: [], errors: [err] };
}

export async function runValidate(
  opts: ValidateOptions,
): Promise<ValidateRun> {
  const cwd = opts.cwd ?? process.cwd();

  const loaded = await loadConfig(opts.configPath, cwd);
  const config: DocmetaConfig | null = loaded?.config ?? null;

  // Determine inputs: explicit CLI inputs win, else config.paths.
  const inputs =
    opts.inputs.length > 0 ? opts.inputs : (config?.paths ?? []);
  const usingStdin = inputs.includes(STDIN_TOKEN);

  if (inputs.length === 0) {
    throw new DocmetaError(
      "No files to validate. Pass paths/globs, or add `paths:` to docmeta.config.yaml.",
    );
  }

  // Pick an explicit extractor for `--as`, validating it up front.
  const forcedExtractor = opts.as ? extractorByName(opts.as) : undefined;
  if (opts.as && !forcedExtractor) {
    throw new DocmetaError(
      `Unknown format "${opts.as}". Supported extensions: ${supportedExtensions().join(", ")}.`,
    );
  }

  const exts =
    opts.exts ?? (forcedExtractor ? forcedExtractor.extensions : undefined);

  const fileInputs = inputs.filter((i) => i !== STDIN_TOKEN);
  const files = await resolveTargets({
    inputs: fileInputs,
    exts,
    exclude: [...(config?.exclude ?? []), ...(opts.exclude ?? [])],
    cwd,
  });

  const validator = new Validator();
  const results: ValidationResult[] = [];

  const processOne = async (
    label: string,
    content: string,
    extension: string,
  ): Promise<void> => {
    const extractor =
      forcedExtractor ?? extractorForExtension(extension);
    if (!extractor) {
      throw new DocmetaError(
        `Unsupported file type "${extension}" for "${label}". Supported: ${supportedExtensions().join(", ")}. Use --as to override.`,
      );
    }

    let extracted;
    try {
      extracted = extractor.extract(content, label);
    } catch (err) {
      if (err instanceof DocmetaError) throw err; // operational (stub/unsupported)
      results.push(parseErrorResult(label, extractor.name, (err as Error).message));
      return;
    }

    let schemaSet: string[];
    try {
      schemaSet = resolveSchemaSet({
        filePath: label,
        fileSchema: extracted.data[FILE_SCHEMA_KEY],
        cliSchemas: opts.cliSchemas,
        config,
      });
    } catch (err) {
      results.push(parseErrorResult(label, extractor.name, (err as Error).message));
      return;
    }

    const errors = await validator.validate(
      extracted.data,
      schemaSet,
      extracted.lineFor,
    );
    results.push({
      file: label,
      format: extractor.name,
      ok: errors.length === 0,
      schemas: schemaSet,
      errors,
    });
  };

  if (usingStdin) {
    const content = opts.stdinContent ?? "";
    if (!forcedExtractor) {
      throw new DocmetaError(
        "Reading from stdin (`-`) requires --as <format> to choose an extractor.",
      );
    }
    await processOne("<stdin>", content, forcedExtractor.extensions[0] ?? "");
  }

  for (const file of files) {
    const content = await readFile(resolve(cwd, file), "utf8");
    await processOne(file, content, extname(file));
  }

  const failed = results.filter((r) => !r.ok).length;
  const summary: RunSummary = {
    files: results.length,
    passed: results.length - failed,
    failed,
    errors: results.reduce((n, r) => n + r.errors.length, 0),
  };

  return { results, summary };
}
