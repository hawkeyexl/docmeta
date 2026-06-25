/**
 * Shared types for docmeta.
 *
 * The pipeline is: load files -> extract metadata (format-specific) ->
 * resolve a schema set per file -> validate against each schema -> report.
 * Everything after extraction operates only on `ExtractedMetadata`, so new
 * input formats never touch validation, resolution, or reporting.
 */

/** Result of pulling a metadata block out of a single document. */
export interface ExtractedMetadata {
  /** Parsed metadata key/values. `{}` when a block is present but empty. */
  data: Record<string, unknown>;
  /** Whether a metadata block was found at all. */
  present: boolean;
  /** Name of the extractor/format that produced this (e.g. "markdown"). */
  format: string;
  /**
   * Map a JSON Pointer (Ajv `instancePath`, e.g. "/tags/0") or a bare top-level
   * key to its 1-based source line, for precise annotations. Returns undefined
   * when no position is known.
   */
  lineFor(pointer: string): number | undefined;
}

/** A pluggable metadata extractor for one document format. */
export interface MetadataExtractor {
  /** Stable name, also used as `ExtractedMetadata.format`. */
  name: string;
  /** Lowercase file extensions this extractor handles, incl. dot (e.g. ".md"). */
  extensions: string[];
  /** Whether this extractor is wired up (false for roadmap stubs). */
  implemented: boolean;
  /** Extract metadata from raw file content. */
  extract(content: string, filePath: string): ExtractedMetadata;
}

/** A single schema violation for one file, attributed to one schema. */
export interface FieldError {
  /** Schema id/ref that produced this error (e.g. "google:okf:0.1"). */
  schema: string;
  /** Ajv instancePath, e.g. "/tags/0" or "" for the root. */
  instancePath: string;
  /** Human-readable message. */
  message: string;
  /** 1-based source line, when known. */
  line?: number;
  /** 1-based column, when known. */
  col?: number;
}

/** Validation outcome for a single file. */
export interface ValidationResult {
  /** Absolute or cwd-relative path of the file. */
  file: string;
  /** Extractor/format used. */
  format: string;
  /** Whether validation passed against every schema in the set. */
  ok: boolean;
  /** Schema ids/refs the file was validated against. */
  schemas: string[];
  /** All violations, across every schema in the set. */
  errors: FieldError[];
}

/** Aggregate run summary. */
export interface RunSummary {
  files: number;
  passed: number;
  failed: number;
  errors: number;
}

/** An operational/usage failure that should map to exit code 2. */
export class DocmetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocmetaError";
  }
}
