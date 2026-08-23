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
  lineFor(this: void, pointer: string): number | undefined;
  /**
   * The column counterpart of {@link lineFor}, 1-based, resolving the same
   * pointer forms.
   *
   * **Optional on purpose.** `lineFor` is required and public, so widening it
   * to return a position pair would break every consumer that implements
   * `MetadataExtractor` outside this repository. A format that cannot cheaply
   * give a column simply omits this — today that is every frontmatter-based
   * extractor, whose `yaml` node offsets would need an offset -> line/col
   * conversion first. `html` and `xml` implement it.
   */
  colFor?(this: void, pointer: string): number | undefined;
}

/** Fenced front matter flavors, in fence order: `---`, `+++`, `;;;`. */
export type FrontmatterFlavor = "yaml" | "toml" | "json";

/** Top-level metadata keys to set. Keys with `undefined` values are ignored. */
export type MetadataPatch = Record<string, unknown>;

export interface ApplyOptions {
  /** Flavor to use when creating a block from scratch. Default "yaml". */
  newBlockFlavor?: FrontmatterFlavor;
  /**
   * The document's path, when the caller knows it. `extract` receives one and
   * `apply` did not, which left a writer unable to use the extension as a
   * signal — the XML writer needs it to tell a DITA topic from hand-rolled XML
   * that happens to have a `<task>` root.
   */
  filePath?: string;
}

/** A pluggable metadata extractor for one document format. */
export interface MetadataExtractor {
  /** Stable name, also used as `ExtractedMetadata.format`. */
  name: string;
  /** Lowercase file extensions this extractor handles, incl. dot (e.g. ".md"). */
  extensions: string[];
  /**
   * Whether this extractor can *read* — false for a format that is registered
   * but not yet wired up. Every registered extractor sets it true today; it is
   * kept because it is a distinct capability from writability, which is the
   * presence of `apply`. A format can read without writing, and one being
   * added could be declared before it can do either.
   */
  implemented: boolean;
  /**
   * Extract metadata from raw file content.
   *
   * `this: void` — as on `apply` below, and on `ExtractedMetadata`'s
   * `lineFor`/`colFor`. Every implementation in this repo is a plain function
   * in an object literal and none of them reads `this`, so pulling one out
   * (`const apply = extractor.apply`) is the ordinary thing it looks like
   * rather than a binding hazard. Declaring that is what lets a reader — and
   * `unbound-method` — know it.
   *
   * Retyping these as properties holding functions would say the same thing,
   * and was tried first. It is the more expensive way: a property's parameters
   * are contravariant where a method's are bivariant, so on an *exported*
   * interface that swap silently narrows what an outside implementation may
   * be, which is a semver-visible change bought for a lint fix. `this: void`
   * leaves assignability exactly as it was.
   */
  extract(this: void, content: string, filePath: string): ExtractedMetadata;
  /**
   * Return new content with every key in `patch` set at the top level. Pure:
   * no IO, no mutation, deterministic; returns `content` itself for a no-op.
   *
   * Absent means the format is read-only. Present but throwing `DocmetaError`
   * means this particular document cannot be rewritten safely.
   */
  apply?(
    this: void,
    content: string,
    patch: MetadataPatch,
    options?: ApplyOptions,
  ): string;
}

/** A single schema violation for one file, attributed to one schema. */
export interface FieldError {
  /** Schema id/ref that produced this error (e.g. "google:okf:0.1"). */
  schema: string;
  /** Ajv instancePath, e.g. "/tags/0" or "" for the root. */
  instancePath: string;
  /** Human-readable message. */
  message: string;
  /**
   * Ajv keyword that failed (e.g. "required", "format", "pattern"), or
   * "parse"/"schema" for the synthetic errors the command layer raises.
   *
   * This and `subject` are the machine-stable half of a violation's identity:
   * `message` is generated prose that an Ajv upgrade may reword, so nothing
   * durable — a baseline fingerprint, a SARIF `ruleId` — may be built from it.
   */
  keyword: string;
  /**
   * Discriminator within that keyword, when it is a stable identifier: the
   * missing property, the additional property, the format name, the expected
   * type. Deliberately unset for keywords whose parameter is a schema-authored
   * *value* (`pattern`'s regex, `enum`'s list, `minLength`'s number), which
   * changes whenever the schema is edited.
   */
  subject?: string;
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
  /**
   * Findings a baseline suppressed for this file. Absent when no baseline
   * governed the run, or when it forgave nothing here.
   */
  baselined?: number;
}

/** How a baseline shaped the run. Present only when one governed it. */
export interface BaselineSummary {
  /** Baseline file path, spelled the way the user would type it. */
  path: string;
  /** Whether this run wrote the file (`--write-baseline`) or only read it. */
  written: boolean;
  /**
   * Fingerprints the baseline holds. On a read this counts only the files the
   * run checked, so validating one file does not report the rest as prunable.
   */
  recorded: number;
  /** Findings the baseline suppressed. */
  suppressed: number;
  /** Recorded fingerprints for checked files that no longer occur. */
  stale: number;
  /** Fingerprints this write added. Write only. */
  added?: number;
  /** Fingerprints this write dropped. Write only. */
  removed?: number;
}

/** Aggregate run summary. */
export interface RunSummary {
  files: number;
  passed: number;
  failed: number;
  /** Violations reported. Baselined ones are excluded — see `baseline`. */
  errors: number;
  /**
   * Candidate documents `.gitignore` removed from the walk. Omitted when it
   * removed none. Reported because silent removal is what makes the filter
   * dangerous — a counted removal is auditable.
   */
  gitignoreSkipped?: number;
  baseline?: BaselineSummary;
}

/** An operational/usage failure that should map to exit code 2. */
export class DocmetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocmetaError";
  }
}
