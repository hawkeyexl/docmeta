/** Programmatic API for docmeta. */
export { runValidate } from "./commands/validate.js";
export type { ValidateOptions, ValidateRun } from "./commands/validate.js";
export { runGet } from "./commands/get.js";
export type { GetOptions, GetFileResult } from "./commands/get.js";
export {
  getSchemasInfo,
  runVendorSchema,
  vendorFileName,
  DEFAULT_VENDOR_DIR,
} from "./commands/schemas.js";
export type { VendorOptions, VendorResult } from "./commands/schemas.js";
export { runFill } from "./commands/fill.js";
export type {
  FillOptions,
  FillRun,
  FillFileResult,
  FillSummary,
  FilledField,
  SkipReason,
} from "./commands/fill.js";
export { Validator } from "./core/validator.js";
export {
  resolveSchemaSet,
  collectSchemaPins,
  schemaEntryRef,
  rebaseConfigSchemaRefs,
  DEFAULT_SCHEMAS,
} from "./core/resolve-schema.js";
export { loadConfig, parseConfig, resolveRunConfig } from "./core/config.js";
export type {
  ConfigNotice,
  DocmetaConfig,
  FillConfig,
  LoadedConfig,
  RunConfig,
  RunConfigOptions,
  SchemaCacheConfig,
  SchemaEntry,
  SchemaRefEntry,
} from "./core/config.js";
export {
  listBuiltins,
  loadSchema,
  fetchSchemaBytes,
  classifyRef,
  schemaLoadOptions,
} from "./core/schema-registry.js";
export type {
  FetchedSchema,
  LoadSchemaOptions,
  SchemaPin,
} from "./core/schema-registry.js";
export { integrityOf, isIntegrity, INTEGRITY_SHAPE } from "./core/integrity.js";
export {
  SchemaCache,
  SCHEMA_CACHE_DIR,
  SCHEMA_CACHE_VERSION,
  DEFAULT_TTL_HOURS,
  schemaCacheDir,
} from "./core/schema-cache.js";
export type { ReadOptions, SchemaCacheEntry } from "./core/schema-cache.js";
export {
  REPORT_FORMATS,
  isReportFormat,
  render,
  renderJunit,
  renderSarif,
} from "./reporters/index.js";
export type {
  ReportFormat,
  ReportOptions,
  SarifOptions,
} from "./reporters/index.js";
// `ValidateRun.frame` is typed with this, so a caller passing the frame back
// into `render` needs to be able to name it.
export type { FingerprintContext } from "./core/baseline.js";
export { renderFill } from "./reporters/fill.js";
export type { FillReportFormat } from "./reporters/fill.js";
export {
  extractFrontmatter,
  locateFrontmatter,
  frontmatterInnerText,
} from "./extractors/frontmatter.js";
export type { FrontmatterLocation } from "./extractors/frontmatter.js";
export { applyFrontmatter } from "./extractors/frontmatter-write.js";
export { writeFileAtomic } from "./core/write-file.js";
export {
  extractorForExtension,
  supportedExtensions,
} from "./extractors/index.js";
export * from "./types.js";
