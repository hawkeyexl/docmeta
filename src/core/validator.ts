/**
 * JSON Schema validation engine. Compiles and caches an Ajv validator per
 * schema reference, validates extracted metadata against each schema in a set,
 * and maps every violation to a {schema, instancePath, line} FieldError.
 */
import * as Ajv2020Ns from "ajv/dist/2020.js";
import * as addFormatsNs from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { DocmetaError, type FieldError } from "../types.js";

// ajv and ajv-formats are CommonJS with a default export; under NodeNext the
// callable/constructable value lives on `.default`. Cast through the named
// default types so tsc sees a constructor / callable.
const Ajv2020 =
  Ajv2020Ns.default as unknown as typeof import("ajv/dist/2020.js").default;
const addFormats =
  addFormatsNs.default as unknown as typeof import("ajv-formats").default;
import { loadSchema } from "./schema-registry.js";
import { FILE_SCHEMA_KEY } from "./resolve-schema.js";

export class Validator {
  private ajv: InstanceType<typeof Ajv2020>;
  private cache = new Map<string, ValidateFunction>();

  constructor() {
    // strict: false so user-supplied schemas with lax metadata still compile.
    this.ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(this.ajv);
  }

  private async compile(ref: string): Promise<ValidateFunction> {
    const cached = this.cache.get(ref);
    if (cached) return cached;
    const schema = await loadSchema(ref);
    let fn: ValidateFunction;
    try {
      fn = this.ajv.compile(schema);
    } catch (err) {
      throw new DocmetaError(
        `Schema "${ref}" failed to compile: ${(err as Error).message}`,
      );
    }
    this.cache.set(ref, fn);
    return fn;
  }

  /**
   * Validate `data` against every schema in `refs`. Returns all violations,
   * each tagged with the schema that produced it and a source line via
   * `lineFor`.
   */
  async validate(
    data: Record<string, unknown>,
    refs: string[],
    lineFor: (pointer: string) => number | undefined,
  ): Promise<FieldError[]> {
    // `$schema` is a docmeta directive, not part of the document's metadata —
    // strip it so schemas with additionalProperties:false don't flag it.
    const { [FILE_SCHEMA_KEY]: _omit, ...subject } = data;
    void _omit;

    const errors: FieldError[] = [];
    for (const ref of refs) {
      const fn = await this.compile(ref);
      const ok = fn(subject);
      if (ok) continue;
      for (const e of fn.errors ?? []) {
        errors.push(toFieldError(ref, e, lineFor));
      }
    }
    return errors;
  }
}

function toFieldError(
  schema: string,
  e: ErrorObject,
  lineFor: (pointer: string) => number | undefined,
): FieldError {
  const instancePath = e.instancePath;
  // For `required`, point at the parent object but name the missing property.
  let message = e.message ?? "is invalid";
  if (e.keyword === "required" && e.params && "missingProperty" in e.params) {
    message = `must have required property '${String(e.params.missingProperty)}'`;
  } else if (
    e.keyword === "additionalProperties" &&
    e.params &&
    "additionalProperty" in e.params
  ) {
    message = `must NOT have additional property '${String(e.params.additionalProperty)}'`;
  }
  const line = lineFor(instancePath);
  return { schema, instancePath, message, ...(line != null ? { line } : {}) };
}
