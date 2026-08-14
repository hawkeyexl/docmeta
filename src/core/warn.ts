/**
 * One-line diagnostics on stderr, deduped per process.
 *
 * Warnings are diagnostics, not output. stdout belongs to the report — and, for
 * `fill -`, to the filled document — so everything here goes to stderr, which
 * keeps `-f json` parseable while a warning is active. Uncolored, matching the
 * lock-contention notice in `write-file.ts`: core modules have no palette
 * threaded through them, and a warning is not worth threading one for.
 */

const seen = new Set<string>();

/**
 * Emit `message` once per process; repeats of the same text are dropped.
 *
 * Deduping on the exact text (rather than a call site) is deliberate: a library
 * consumer looping over fifty directories with fifty different deprecated files
 * should hear about each one, while a single run that resolves config twice
 * should say it once.
 */
export function warn(message: string): void {
  if (seen.has(message)) return;
  seen.add(message);
  process.stderr.write(`moose-meta: ${message}\n`);
}

/** Clear the dedupe set. Tests only. */
export function resetWarnings(): void {
  seen.clear();
}
