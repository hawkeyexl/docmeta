/** Shared shapes for the `fill` command, split out to keep imports acyclic. */
import type { InferenceProvider } from "@hawkeyexl/inference";

/** A schema property `fill` may propose a value for. */
export interface Candidate {
  key: string;
  /**
   * The property's own subschema, lifted from the document schema. When more
   * than one schema in the set defines the property, the subschemas are combined
   * with `allOf` so none of their rules is lost.
   */
  subschema: Record<string, unknown>;
  /** Whether any schema in the set lists this property as required. */
  required: boolean;
  /** True when the key exists but its value is invalid (vs simply missing). */
  present: boolean;
}

/** One model proposal, before gating. */
export interface Proposal {
  value: unknown;
  confidence: number;
  reasoning: string;
}

export type ProposalSet = Record<string, Proposal>;

/** Why a proposed value was not written. */
export type SkipReason =
  /** Self-reported confidence was below the threshold. */
  | "low-confidence"
  /** Writing it would leave the document failing its own schema. */
  | "schema-mismatch"
  /** The model declined to propose a value. */
  | "no-proposal";

export interface FilledField {
  /** JSON Pointer, e.g. "/title" — the same form `validate` reports. */
  field: string;
  required: boolean;
  confidence: number;
  reasoning: string;
  /** Absent when the field was skipped. */
  value?: unknown;
  written: boolean;
  skipReason?: SkipReason;
}

export interface FillFileResult {
  file: string;
  format: string;
  schemas: string[];
  fields: FilledField[];
  /** Whether the file's content changed (false under --dry-run too). */
  changed: boolean;
  /** Parse failure, read-only format, or provider error. */
  error?: string;
  /** The filled document. Populated only when the caller asks for it. */
  content?: string;
}

export interface FillSummary {
  files: number;
  changed: number;
  written: number;
  skipped: number;
  /** Skipped fields that the schema lists as required — drives exit code 1. */
  requiredSkipped: number;
  errors: number;
  costUsd: number;
  cached: number;
}

export interface FillRun {
  results: FillFileResult[];
  summary: FillSummary;
  /** Echoed so JSON consumers and CI can assert which gate actually ran. */
  threshold: number;
  dryRun: boolean;
  provider: string;
  model: string;
  /** True when the cost budget stopped the run before every file was seen. */
  budgetExhausted: boolean;
}

export interface FillOptions {
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
  /** Permit an input set that resolves to zero files (see `assertNonEmpty`). */
  allowEmpty?: boolean;
  /** Restrict proposals to these top-level fields. */
  fields?: string[];
  /** Minimum self-reported confidence to write (0-1). Default 0.7. */
  confidence?: number;
  /** Report proposals without writing them. */
  dryRun?: boolean;
  provider?: string;
  model?: string;
  /** Use the on-disk proposal cache. Default true. */
  cache?: boolean;
  /** Stop scheduling new files past this spend. */
  maxCostUsd?: number;
  /** Files inferred in parallel. Default 4. */
  concurrency?: number;
  /** Include the filled document on each result (used for stdin and tests). */
  includeContent?: boolean;
  /** Test seam: bypasses `makeProvider`, so no API key is needed. */
  inferenceProvider?: InferenceProvider;
}
