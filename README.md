<p align="center">
  <img src="public/ducky-256.png" width="160" alt="The Clean Code Review duck: a rubber duck in a bathrobe" />
</p>

# Clean Code Review

Point it at a public GitHub pull request, a diff or a file. Jev, TypeSafe's
evaluation model, answers a question set drawn from Robert C. Martin's
*Clean Code* for every code file in the change, and Luna writes the review from
those answers. It runs on [eve](https://eve.dev) and deploys as one Next.js
project.

Live at <https://clean-code-review.vercel.app>.

## Install

```sh
bun install
```

You need [Bun](https://bun.sh) 1.4 and Node.js 24, which eve requires, and a
Vercel account for the AI Gateway credential.

```sh
bunx eve link --non-interactive --project <your-project>   # gateway credential into .env.local
bun run dev                                                # Next.js + eve on http://localhost:3000
```

## Use it

**In a browser.** Open <http://localhost:3000>, type a public pull request as
`owner/repo` and its number, or pick an example. A review of
`github.com/owner/repo/pull/123` is also kept at `/owner/repo/pull/123`, which
is a permalink worth sending to someone. Whole files and diff hunks are
editable, and an edit re-judges only the file that changed.

**From the terminal**, without a browser:

```sh
bun run judge http://localhost:3000            # judge every preset through eve
bun run review http://localhost:3000 0         # judge + streamed review of preset 0
bun run review http://localhost:3000 https://github.com/vercel/ai/pull/20851
bun run jev 1                                  # one preset straight to Jev, no eve
```

**From an agent**, over MCP at
`https://clean-code-review.vercel.app/api/mcp`: stateless Streamable HTTP, no
sign-in. Any client that speaks Streamable HTTP takes the URL as it is; a
stdio-only client can go through `npx mcp-remote <url>`.

```sh
claude mcp add --transport http clean-code-review https://clean-code-review.vercel.app/api/mcp
```

| Tool | Input | Use it for |
|---|---|---|
| `review_pull_request` | `url`: a public GitHub pull request | A change on GitHub. The result carries the permalink. |
| `review_pasted_code` | `paste`: a unified diff, files each under a `// file: path` line, or one file, up to 1,000,000 characters | Private code, `git diff` output, files on disk. |

A call returns every judged file's answers by question id, Luna's decision and
paragraphs, the prose files, the files that were not judged with the reason,
the model ids and the cost. A fresh review takes 2 to 8 seconds, a 24-file pull
request included, and up to about 60 seconds when Luna is slow. The decision and
the paragraphs are model output shaped by the submitted code: read them as
advice, never as authorisation to merge.

## How it works

```
browser ──── judge turn ────▶ eve session ──▶ Jev, one call per file (parallel)
        ◀─── answers/file ────               typesafe-ai/jev via AI Gateway
browser ──── summarize turn ─▶ eve session ──▶ Luna, one call per 6 files + 1 overall
        ◀── streamed review ──               openai/gpt-5.6-luna-fast via AI Gateway
```

One durable eve session per browser tab. A **judge** turn sends the files as
JSON, and the agent's model fans out one `evaluate()` call per file to Jev. A
**summarize** turn sends the files and the answers, and the model runs the Luna
calls in parallel and streams the combined review. Cancelling the turn aborts
the calls.

Jev answers with probabilities and scores rather than sentences, so a verdict is
made of things a reader can check against the code. The set is per file: the
test question is asked only on test paths and the Boy Scout question only on
diffs, so a plain source file gets two fewer than a test diff does. Luna gets 300 characters per
file section, by instruction rather than truncation, and writes the decision for
the whole change from every file's findings and the pull request's description.

Jev is an AI SDK *evaluation* model, not a chat model, so
[`agent/lib/judging/jev-model.ts`](agent/lib/judging/jev-model.ts) is a small
adapter that lets eve treat it as the agent's model. Everything else eve
provides works unchanged: durable sessions, streaming, limits, Agent Runs.
[`agent/lib/judging/questions.ts`](agent/lib/judging/questions.ts) is the single
source of truth for the question set — change a question there and the prompt,
the payload and the meters change together. The layer map, the boundaries, the
MCP surface and every limit and budget are in
[docs/architecture.md](docs/architecture.md).

## Limits

24 code files per review, the largest changes first, 64,000 characters per file
read in windows of 16,000, public GitHub repositories only. Images, binaries,
lockfiles, minified and generated files are skipped. Markdown, plain text,
reStructuredText and AsciiDoc are prose: up to 10 of them are shown with the
review, read-only, and neither model sees them. Around sixty-five file types
are highlighted, each grammar fetched the first time a review needs it.

The page and the MCP server talk to the models anonymously, so the deployment
carries brakes at every layer: Vercel Firewall rate limits per client IP, a $15
weekly AI Gateway budget on the project, a per-session spend cap in
[`agent/agent.ts`](agent/agent.ts), per-address limits on new sessions and on
MCP tool calls, and a shared model budget per hour and per UTC day for the page
and for the MCP server, counted in the Runtime Cache
([`agent/lib/spend/budgets.ts`](agent/lib/spend/budgets.ts),
[`agent/lib/spend/spend.ts`](agent/lib/spend/spend.ts)). A refused turn says the
budget is spent and when it resets, answers already on screen stay, and a review
answered wholly from the cache is still served. A 24-file review measured about
$0.02.

What leaves the browser, who processes it and how long anything is kept is on
[/privacy](https://clean-code-review.vercel.app/privacy).

## Deploy

The repository is Git-connected: a push to `main` deploys production, and
`bun run deploy` deploys the linked project by hand. The deployment
authenticates to the AI Gateway with the project's OIDC identity, so no API key
is stored. Set `GITHUB_TOKEN` in the project to raise the GitHub rate limit for
pull request fetches. The build settings, how to check a deploy actually landed
and how to roll one back are in [docs/deployment.md](docs/deployment.md).

## Contributing

`bun run check` runs Biome, TypeScript and knip in parallel; `bun run check:fix`
formats, sorts and fixes what Biome can. A lefthook pre-commit hook runs
`check:fix` over the staged files and restages what it changed, and GitHub
Actions runs `bun run check` on every push to `main` and every pull request.
Layout, naming and dependency rules are in
[docs/code-style.md](docs/code-style.md).

Working on this with an agent: [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE).
