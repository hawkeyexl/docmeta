/** Programmatic API for docmeta. */
export { runValidate } from "./commands/validate.js";
export type { ValidateOptions, ValidateRun } from "./commands/validate.js";
export { runGet } from "./commands/get.js";
export type { GetOptions, GetFileResult } from "./commands/get.js";
export { getSchemasInfo } from "./commands/schemas.js";
export { Validator } from "./core/validator.js";
export { resolveSchemaSet, DEFAULT_SCHEMA } from "./core/resolve-schema.js";
export { loadConfig, parseConfig } from "./core/config.js";
export type { DocmetaConfig } from "./core/config.js";
export {
  listBuiltins,
  loadSchema,
  classifyRef,
} from "./core/schema-registry.js";
export { render } from "./reporters/index.js";
export type { ReportFormat } from "./reporters/index.js";
export { extractFrontmatter } from "./extractors/frontmatter.js";
export {
  extractorForExtension,
  supportedExtensions,
} from "./extractors/index.js";
export * from "./types.js";
