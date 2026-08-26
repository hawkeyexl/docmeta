/**
 * The JSON spelling of a parsed date.
 *
 * Two callers need this and they need it to agree. TOML is the only front
 * matter flavor with a real date type, so `date = 2026-06-25` reaches us as a
 * `Date` where the identical line under a YAML or JSON fence yields a string —
 * and both the extractor (which hands values to a schema) and `schemas infer`
 * (which reports the JSON type it saw) have to render that `Date` the same way,
 * or a field is a string in one and something else in the other.
 *
 * `smol-toml` returns a `TomlDate`, whose `toISOString` round-trips the form the
 * author wrote rather than widening it: a local date stays `YYYY-MM-DD` instead
 * of becoming a datetime, and an offset is restored rather than rewritten to
 * `Z`. That is what lets `format: "date"` still match a date.
 *
 * Its own module rather than a copy in each caller, for the reason `patch-util`
 * gives for `deepEqual`: a second copy is a second chance for the two to
 * disagree, and the disagreement would be silent.
 */

/** A `Date` as its authored ISO string; any other value unchanged. */
export function isoDateValue(value: unknown): unknown {
  if (!(value instanceof Date)) return value;
  // An invalid date cannot reach here from `parseToml`, which throws first, but
  // `toISOString` throws on NaN — so fall back to the "Invalid Date" spelling
  // rather than letting an exception escape a parser.
  return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
}
