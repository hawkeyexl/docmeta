## What changed

<!-- And why. If it fixes an issue, link it. -->

## Checklist

- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
      commitlint gates this in CI, and the type drives the release:
      `fix:` → patch, `feat:` → minor, `feat!:` or a `BREAKING CHANGE:` footer → major.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes. Run `npm run build` first if the CLI integration tests
      are affected. They run against `dist/`.
- [ ] Tests were written or adjusted first, and failed for the right reason
      before the fix made them pass.
- [ ] `npm run docs:check-cli` passes, if this touches the CLI surface.
- [ ] Docs updated, if this changes behaviour anyone reads about.

## For a `feat:` change: the demo video

Every feature ships with a short demo video. Aim for 20–45 seconds of terminal
session, captioned and suitable for posting. It is part of the change rather
than a nice-to-have. `fix:`, `refactor:`, `docs:`, and `chore:` do not need one.

- [ ] Video recorded, following `docs/content-strategy/design.md`.
- [ ] Written to `media/` (gitignored) and **attached to this PR**. Video and
      GIF binaries are never committed.
- [ ] Not applicable; this is not a `feat:`.
