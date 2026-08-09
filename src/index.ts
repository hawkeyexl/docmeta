/** Programmatic API for docmeta. */
export { runValidate } from "./commands/validate.js";
export type { ValidateOptions, ValidateRun } from "./commands/validate.js";
export { runGet } from "./commands/get.js";
export type { GetOptions, GetFileResult } from "./commands/get.js";
export { getSchemasInfo } from "./commands/schemas.js";
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
export { resolveSchemaSet, DEFAULT_SCHEMAS } from "./core/resolve-schema.js";
export { loadConfig, parseConfig } from "./core/config.js";
export type { DocmetaConfig, FillConfig } from "./core/config.js";
export {
  listBuiltins,
  loadSchema,
  classifyRef,
} from "./core/schema-registry.js";
export { render } from "./reporters/index.js";
export type { ReportFormat } from "./reporters/index.js";
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
