/**
 * Integrity pins for vendored schemas.
 *
 * A vendored schema is a file in the consuming repository's own history, so the
 * question an integrity pin answers is narrow: are the bytes on disk still the
 * bytes that were downloaded? That makes an edited, truncated, or
 * merge-mangled copy a loud failure instead of a contract that quietly changed
 * meaning.
 *
 * One algorithm and one encoding, deliberately. Every additional accepted form
 * is another state the mismatch message has to be right about, and there is no
 * interoperability argument here — docmeta writes these strings itself.
 */
import { createHash } from "node:crypto";

/** The only digest algorithm `integrity:` accepts. */
export const INTEGRITY_ALGORITHM = "sha256";

/** What a well-formed pin looks like, for error messages. */
export const INTEGRITY_SHAPE = `${INTEGRITY_ALGORITHM}-<64 hex characters>`;

const INTEGRITY_RE = new RegExp(`^${INTEGRITY_ALGORITHM}-([0-9a-f]{64})$`);

/**
 * The pin for a byte sequence.
 *
 * Hashes the **bytes**, never a string: decoding to UTF-8 and re-encoding is
 * lossy for a payload that is not valid UTF-8, which would make the pin wrong
 * in exactly the case an integrity check exists to catch.
 */
export function integrityOf(bytes: Uint8Array): string {
  return `${INTEGRITY_ALGORITHM}-${createHash(INTEGRITY_ALGORITHM).update(bytes).digest("hex")}`;
}

/** Whether `value` is a pin this version can verify. */
export function isIntegrity(value: string): boolean {
  return INTEGRITY_RE.test(value);
}

/**
 * How two byte sequences differ, for the mismatch message.
 *
 * `line-endings` is not a nicety. A vendored schema is committed, and a
 * repository with `core.autocrlf=true` (or a `*.json text` attribute) hands a
 * Windows checkout CRLF bytes that hash differently from the LF bytes that were
 * downloaded — a mismatch on a file nobody touched. Naming that case is the
 * difference between a five-minute fix and a user deleting the pin.
 */
export type IntegrityDiff = "line-endings" | "content";

/** Bytes with every CRLF collapsed to LF. */
function toLf(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === undefined) continue;
    // 0x0d CR followed by 0x0a LF: drop the CR, keep the LF.
    if (byte === 0x0d && bytes[i + 1] === 0x0a) continue;
    out[n++] = byte;
  }
  return out.subarray(0, n);
}

/** Bytes with every bare LF expanded to CRLF. */
function toCrlf(bytes: Uint8Array): Uint8Array {
  const lf = toLf(bytes);
  const out = new Uint8Array(lf.length * 2);
  let n = 0;
  for (let i = 0; i < lf.length; i++) {
    const byte = lf[i];
    if (byte === undefined) continue;
    if (byte === 0x0a) out[n++] = 0x0d;
    out[n++] = byte;
  }
  return out.subarray(0, n);
}

/**
 * Why `bytes` does not match `expected`.
 *
 * Only ever called once a mismatch is established, so "they are identical" is
 * not among the answers.
 *
 * Both conversions are tried because only the *pin* survives, not the bytes it
 * was taken from, so there is no way to normalize both sides. A CRLF working
 * copy of an LF download is caught by the first; an LF checkout of a CRLF
 * download by the second.
 */
export function diagnoseIntegrity(
  bytes: Uint8Array,
  expected: string,
): IntegrityDiff {
  if (integrityOf(toLf(bytes)) === expected) return "line-endings";
  if (integrityOf(toCrlf(bytes)) === expected) return "line-endings";
  return "content";
}
