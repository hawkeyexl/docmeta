# Releasing

Releases are automated by [semantic-release](https://semantic-release.gitbook.io/)
via [`.github/workflows/release.yml`](../../.github/workflows/release.yml). On a
push to a release branch it reads the conventional commits since the last tag,
computes the next version, updates `CHANGELOG.md`/`package.json`, tags, creates a
GitHub Release, and publishes to npm.

| Branch    | npm dist-tag            |
| --------- | ----------------------- |
| `main`    | `latest`                |
| `next`    | `next` (prerelease)     |
| `feat/**` | per-branch prerelease   |

You don't run anything by hand for a normal release — merge a PR with the right
commit types and the workflow does the rest. The two pieces below are **one-time
infrastructure setup** that's already configured; this page documents it so it
can be recreated or audited.

## npm publishing: OIDC trusted publishing

The workflow publishes to npm with **no `NPM_TOKEN`**. It uses
[trusted publishing](https://docs.npmjs.com/trusted-publishers): npm exchanges
the workflow's OIDC token (the `id-token: write` permission) for a short-lived,
scoped publish credential, and mints provenance automatically.

Configured on npmjs.com under the package's **Settings → Trusted Publisher**:

- Provider: **GitHub Actions**
- Repository: `hawkeyexl/docmeta`
- Workflow filename: **`release.yml`** (exact, case-sensitive)

Requirements baked into the workflow: a GitHub-hosted runner, npm CLI ≥ 11.5.1
(Node 24 bundles a new enough npm), `@semantic-release/npm` ≥ 13, and
`repository.url` in `package.json` matching the repo. Do **not** add
`registry-url` to `setup-node` or any `NPM_TOKEN`/`NODE_AUTH_TOKEN`: a written-out
auth token in `.npmrc` shadows OIDC and breaks the publish.

## Pushing the release commit past branch protection

`main` has a ruleset requiring all changes to go through a pull request. The
default `GITHUB_TOKEN` can't bypass it, so `@semantic-release/git`'s direct push
of the release commit is rejected with `GH013`. To fix this, the release runs as
a **GitHub App** that is the sole bypass actor on the ruleset.

### One-time setup

1. **Create a GitHub App** (Settings → Developer settings → GitHub Apps → New).
   - Name: e.g. `docmeta-release-bot`.
   - Homepage URL: the repo URL (any valid URL works).
   - Uncheck **Webhook → Active**.
   - **Repository permissions:**
     - Contents: **Read and write** (release commit, tag, GitHub Release)
     - Issues: **Read and write** (comment on released issues)
     - Pull requests: **Read and write** (comment on released PRs)
   - Where can this App be installed: **Only on this account**.

2. **Generate a private key** for the App (App settings → Private keys →
   Generate) and note the **App ID** (shown at the top of the App settings).

3. **Install the App** on the `hawkeyexl/docmeta` repository
   (App settings → Install App → choose the repo).

4. **Add repository secrets** (repo Settings → Secrets and variables → Actions):
   - `RELEASE_APP_ID` — the App ID from step 2.
   - `RELEASE_APP_PRIVATE_KEY` — the full contents of the `.pem` private key.

5. **Add the App as a bypass actor** on the `main` ruleset
   (repo Settings → Rules → Rulesets → `main` → **Bypass list** → Add bypass →
   select the App). Set its bypass mode to **Always** — the release pushes
   directly, not through a PR.

   Equivalent via the API (replace `<APP_ID>`; ruleset id is `18181715`):

   ```bash
   gh api repos/hawkeyexl/docmeta/rulesets/18181715 > /tmp/rs.json
   jq '.bypass_actors += [{"actor_id": <APP_ID>, "actor_type": "Integration", "bypass_mode": "always"}]' \
     /tmp/rs.json > /tmp/rs.new.json
   gh api repos/hawkeyexl/docmeta/rulesets/18181715 --method PUT --input /tmp/rs.new.json
   ```

   For an `"Integration"` bypass actor, `actor_id` is the **App ID** (the same
   value as `RELEASE_APP_ID`).

The workflow mints a short-lived token from this App
(`actions/create-github-app-token`) and hands it to semantic-release as
`GITHUB_TOKEN`, so the release commit is authored by the App and bypasses the
ruleset. The release commit message ends with `[skip ci]`, so it doesn't
re-trigger the workflow.
