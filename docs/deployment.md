# Deployment

The repository is Git-connected to the Vercel project `clean-code-review`. A
push to `main` deploys production; a pull request gets a preview. GitHub Actions
runs `bun run check` on both, in parallel with Vercel's own build.

For a manual deploy from a linked checkout:

```sh
bun run deploy          # eve deploy, which deploys the linked project to production
```

## Build

`vercel.json` carries one setting:

```json
{ "installCommand": "bun install --frozen-lockfile" }
```

It is spelled out because the obvious alternative broke production silently.
Vercel's build image now runs Bun 1.4.1 natively and reads a lockfile written by
1.4. The previous pinned `bunx bun@1.4.0 install` started exiting 1 with no
message after that image change, and every production deploy from `c5a992d`
onwards failed at install. Nothing surfaced: the last good build kept serving,
so five commits looked deployed and were not. Commit `fc00642` fixed it. Do not
re-pin the installer; if the lockfile ever needs a Bun that the build image does
not have, raise it in `packageManager` and check a deploy actually landed.

The functions run Node.js 24, from `engines.node` in `package.json`. eve
requires it.

## Check that a deploy landed

A green push is not evidence. Two cheap checks, in order:

```sh
bunx vercel ls clean-code-review --prod
```

The newest entry must be `Ready`, and its age must match the push. An `Error`
row means the build failed and the previous deployment is still serving.

Then check that the running site is the build you expect. The page hashes its
CSS per build, so a token or class added in this change should be present in the
served stylesheet:

```sh
curl -s https://clean-code-review.vercel.app \
  | grep -o '/_next/static/[^"]*\.css' | head -1
```

Match on `/_next/static/`, not on a directory below it: production serves
`/_next/static/immutable/chunks/<hash>.css` and a local `next start` does not,
so a narrower pattern prints nothing against production — which reads exactly
like the failure this section is for.

Fetch that stylesheet and grep it for something the change introduced. If the
old file is still served, the deploy did not land whatever the dashboard says.

## Environment

There are deliberately no environment variables to set for the models. The
deployment authenticates to the AI Gateway with the project's OIDC identity, so
no API key is stored anywhere, and a fork gets nothing usable from the repository
alone.

`vercel env ls` currently prints none for this project. Two are supported:

| Variable | Effect |
|---|---|
| `GITHUB_TOKEN` | Raises this deployment's own rate limit with GitHub for pull request fetches. Unset today, so fetches are anonymous. It grants no access a signed-out visitor would not have, and it is never a visitor's token. Setting it makes `/privacy` wrong, so update that page too. |
| `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SOURCE_URL` | Override the canonical origin and the source link, for a fork. |

Locally, `bunx eve link --non-interactive --project <name>` pulls the gateway
credential into `.env.local`. That file is not committed.

## Budgets and rules live outside the repository

Two things that bound this deployment are project settings, not code, so a
rollback does not restore them:

- The AI Gateway budget, $15 per week:
  `vercel ai-gateway budgets set project clean-code-review --limit 15 --refresh-period weekly`
- The six Vercel Firewall rate-limit rules. `bunx vercel firewall rules list`
  prints the live configuration; the rules and their limits are in
  [architecture.md](architecture.md).

## Rollback

Promote the last good deployment from the Vercel dashboard, or pass its URL from
the `vercel ls` output above:

```sh
bunx vercel rollback <deployment-url>
bunx vercel rollback status clean-code-review
```

Rolling back restores the build only. The Runtime Cache survives deploys, so
judgments and review parts written by the bad build stay readable for up to an
hour; they are keyed by content and a version number, so a changed question set
or reviewer prompt invalidates them on its own.
