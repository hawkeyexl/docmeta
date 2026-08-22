/**
 * Install husky's git hooks — but only where husky exists.
 *
 * `npm` runs `prepare` on install-from-source, and husky is a devDependency. An
 * install that omits dev dependencies therefore reaches a bare `husky` that is
 * not on PATH, and the whole install fails:
 *
 *     npm error command cmd /d /s /c husky
 *     npm error 'husky' is not recognized as an internal or external command
 *
 * That is reproduced, not theorised — it is what `npm install` from a git clone
 * did before this file existed, which is how anyone doing
 * `npm i github:hawkeyexl/docmeta` would have met it.
 *
 * The obvious fix, `"prepare": "husky || true"`, is the wrong one twice over: it
 * swallows a genuinely broken husky for contributors, and `release.yml` and
 * `commitlint.yml` both set `HUSKY=0` deliberately, which husky itself honours —
 * suppressing husky's own exit code would hide whether that is still working.
 *
 * So: absent husky is a non-contributor install and exits quietly; present
 * husky runs and is allowed to fail as loudly as it likes.
 */
let husky;
try {
  ({ default: husky } = await import("husky"));
} catch {
  process.exit(0);
}
// husky() returns "HUSKY=0 skip install" rather than throwing when the env var
// is set, so the two workflows above keep the behaviour they rely on.
const message = husky();
if (message) console.log(message);
