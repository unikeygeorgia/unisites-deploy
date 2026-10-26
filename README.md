# Unisites deploy

Builds a repository on GitHub Actions and puts the result on
[Unisites](https://app.unisites.ge): every push to the site's branch becomes a
new version there, with its commit, and the build's log shows on the site's
page as it runs.

Connect the repository on app.unisites.ge ("New site" → GitHub). The site's
Versions page gives the workflow to add, `.github/workflows/unisites.yml`:

```yaml
name: Unisites
on:
  push:
    branches: ["main"]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
  unisites:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: unikeygeorgia/unisites-deploy@v1
```

There is no key or secret. The step asks GitHub for an OIDC token for this
run, and Unisites accepts an upload only for the sites that follow this
repository's branch. How the site is built (install, build, the folder it
ends up in) is set on Unisites; anything not set is worked out from the
repository (`npm ci`, `pnpm`, `yarn`, `npm run build`, `dist/`).

An app with a server (Next.js on [vinext](https://github.com/cloudflare/vinext))
is built the same way; its build is a Worker (Cloudflare's Build Output,
`.cloudflare/output/v0/workers/default`), which Unisites deploys as the app's
own Worker, with the bindings and secrets set there. Its database schema is
its `migrations/*.sql` (next to `package.json`), applied on Unisites in order,
each once, before the version goes live.

## Without GitHub Actions: a computer, or Cloudflare Workers Builds

The same command builds and uploads anywhere else with the site's **deploy
key**: app.unisites.ge → the site → Settings → "Deploy keys" → "Make a key".
The key is shown once; keep it like a password.

On a computer, inside the repository, on the site's branch, with everything
committed and pushed:

```bash
UNISITES_KEY=usk_… npx -y github:unikeygeorgia/unisites-deploy
```

On Cloudflare Workers Builds (a Worker connected to the repository): set
`UNISITES_KEY` as a build secret, and the build command to
`npx -y github:unikeygeorgia/unisites-deploy`. The branch and commit come from
`WORKERS_CI_BRANCH` and `WORKERS_CI_COMMIT_SHA`.

Either way, the commit must already be on GitHub, on one of the site's
branches, so every version names a commit anyone can read; a key uploads to
its own site only. `UNISITES_URL` points it at another Unisites.
