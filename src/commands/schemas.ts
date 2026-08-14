/**
 * `schemas` command core. Reports built-in schemas and supported input formats.
 */
import { listBuiltins, type BuiltinInfo } from "../core/schema-registry.js";
import { listFormats } from "../extractors/index.js";

export interface SchemasInfo {
  builtins: BuiltinInfo[];
  formats: {
    name: string;
    extensions: string[];
    implemented: boolean;
    /** Whether `moose-meta fill` can write metadata back to this format. */
    writable: boolean;
  }[];
}

export function getSchemasInfo(): SchemasInfo {
  return { builtins: listBuiltins(), formats: listFormats() };
}
