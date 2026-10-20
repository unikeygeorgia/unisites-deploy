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

An app with a server is built the same way; its build is a Worker, which
Unisites deploys as the app's own Worker, with the bindings and secrets set
there. The step finds the build in this order:

1. Cloudflare's Build Output, `.cloudflare/output/v0/workers/default`, as
   [vinext](https://github.com/cloudflare/vinext) writes it;
2. the Wrangler build the Cloudflare Vite plugin wrote, as
   `.wrangler/deploy/config.json` names it (Astro with `@astrojs/cloudflare`,
   React Router, any Vite project): its `wrangler.json`'s folder and its
   assets' folder go up side by side (Astro's `dist/server/` and
   `dist/client/`, or `dist/client/` alone when every page is pre-rendered);
3. the repository's own `wrangler.jsonc` or `wrangler.json` with a `main`
   module (a plain Worker, SvelteKit, OpenNext): bundled with
   `wrangler deploy --dry-run`, its config written beside it, its assets
   beside that. A `wrangler.toml` is not read: write the config as JSON.

Unisites reads the build's `wrangler.json`: the main module, the assets and
their `.assetsignore`, the compatibility settings, and the bindings by name
(the app's own D1, R2 and KV namespaces are made by Unisites, whatever ids
the config gives). Its database schema is its `migrations/*.sql`, from the
config's `migrations_dir` or `migrations/` next to `package.json`, applied on
Unisites in order, each once, before the version goes live.
