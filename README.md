<p align="center">
  <img src="public/ducky-256.png" width="160" alt="The Clean Code Review duck: a rubber duck in a bathrobe" />
</p>

# Clean Code Review

**Clean Code, judged by a model that does not write prose.**
Point it at a GitHub pull request, a diff or a codebase. Every code file
is scored against 34 questions from Robert C. Martin's *Clean Code* by
[Jev](https://vercel.com/ai-gateway/models/jev), TypeSafe's evaluation
model, and a short review is written from those findings. It runs on
[eve](https://eve.dev), Vercel's agent framework, and deploys as one
Next.js project.

- **Typed judgments, not opinions** — Jev answers each question with a
  calibrated probability (34 per file, one call, about half a second).
  A lit row is a finding; the bars move as you edit.
- **The review is evidence-first** — Luna writes two sentences per file
  and a decision for the whole change, from Jev's findings, in parallel
  parts streamed as they are written. 300 characters per file, by
  instruction, not truncation.
- **Real pull requests** — type `owner/repo` and a number, or open
  `/owner/repo/pull/123` directly; the diff is split per file, generated
  and binary files are skipped, the largest 24 code files are judged, the
  PR description is rendered as markdown and the address is a permalink.
- **Everything is editable** — whole files and diff hunks alike, and only
  the file you touched is re-judged. Around sixty file types are
  highlighted, each grammar fetched the first time a review needs it.
- **Documentation is read, not judged** — a README or a changelog in the
  change gets a card with its own highlighting and no verdict, because
  none of the 34 questions is a question about prose.
- **Cheap to run** — a 24-file PR costs about $0.03 to judge and
  review; judgments and review parts are cached for an hour.

🌐 **Live:** <https://clean-code-review.vercel.app>

## Quick start

You need [Bun](https://bun.sh) 1.4 and Node.js 24 (eve's runtime), and a
Vercel account for the AI Gateway credential.

```sh
bun install
bunx eve link --non-interactive --project <your-project>   # pulls the gateway credential into .env.local
bun run dev                                                 # Next.js + eve on http://localhost:3000
```

Then open <http://localhost:3000>, type a public PR as `owner/repo` and its
number, or pick an example.

Check the agent without a browser:

```sh
bun run judge http://localhost:3000            # judge every preset through eve
bun run review http://localhost:3000 0         # judge + streamed review of preset 0
bun run review http://localhost:3000 https://github.com/vercel/ai/pull/20851
bun run jev 1                                  # one preset straight to Jev, no eve
```

## Development

```sh
bun run check       # Biome, TypeScript and knip, in parallel
bun run check:fix   # format, sort and autofix what Biome can
```

A lefthook pre-commit hook runs `check:fix` over the staged files and restages
what it changed; GitHub Actions runs `bun run check` on every push to `main`
and every pull request.

## How it works

```
browser ──── judge turn ────▶ eve session ──▶ Jev, one call per file (parallel)
        ◀── 34 answers/file ──               typesafe-ai/jev via AI Gateway
browser ──── summarize turn ─▶ eve session ──▶ Luna, one call per 6 files + 1 overall
        ◀── streamed review ──               openai/gpt-5.6-luna-fast via AI Gateway
```

- One durable eve session per browser tab. A **judge** turn sends the
  files as JSON; the agent's model fans out one `evaluate()` call per
  file to Jev and replies with the answers. A **summarize** turn sends
  the files and the answers; the model runs the Luna calls in parallel
  and streams the combined review as its reply. Cancelling the turn
  aborts the calls.
- Jev is an AI SDK *evaluation* model, not a chat model, so
  [`agent/lib/jev-model.ts`](agent/lib/jev-model.ts) is a small
  adapter that lets eve treat it as the agent's model. Everything else
  eve provides works unchanged: durable sessions, streaming, limits,
  Agent Runs.
- [`agent/lib/questions.ts`](agent/lib/questions.ts) is the single
  source of truth. Change a question there and the prompt, the payload
  and the meters change together. Rows are conditional: the test row
  only on test paths, the Boy Scout row only on diffs.
- Per-file review parts read the file first, then apply Jev's findings
  on top; the overall part sees only the findings for every file.

| Layer | Where |
|---|---|
| Questions, groups, conditional rows | `agent/lib/questions.ts` |
| Jev calls and per-file caching | `agent/lib/judge.ts` |
| Luna calls, batching, streaming order | `agent/lib/reviewer.ts`, `agent/lib/reviewer-prompt.ts` |
| Model adapter for eve | `agent/lib/jev-model.ts` |
| Diff parsing, skip rules, file selection | `agent/lib/patch.ts`, `agent/lib/review.ts`, `agent/lib/select.ts` |
| GitHub PR fetcher | `agent/lib/github.ts`, `app/api/github-pr/route.ts` |
| Page state and the two turns | `lib/useReview.ts` |

## Deploy

The repository is Git-connected: a push to `main` deploys production.
For a manual deploy from the linked project:

```sh
bun run deploy          # eve deploy → vercel deploy --prod
```

The deployment authenticates to the AI Gateway with the project's OIDC
identity; no API key is stored. Set `GITHUB_TOKEN` in the project to
raise the GitHub rate limit for PR fetches. `vercel.json` pins Bun 1.4
for installs (Vercel's default Bun cannot read a 1.4 lockfile); the
functions themselves run on Node.js 24, which eve requires.

## Abuse limits

The page talks to the agent anonymously, so the deployment carries four
brakes, outside in:

| Brake | Setting |
|---|---|
| Vercel Firewall rate limits, per client IP | `/eve/v1/session` 30/10 min · `/api/github-pr`, `/owner/repo/pull/N` and server actions 20/10 min each · `/eve/v1/*` 120/min |
| AI Gateway budget on the project | $15 per week (`vercel ai-gateway budgets set project clean-code-review --limit 15 --refresh-period weekly`) |
| Per-session spend cap | `maxTokenCostUsdPerSession` in `agent/agent.ts` |
| In-agent per-address limit on new sessions | `agent/channels/eve.ts`, best effort, one instance's memory |

## Limits

24 code files per review, 16,000 characters per file, public GitHub
repositories only. Images, binaries, lockfiles, minified and generated
files are skipped. Markdown, plain text, reStructuredText and AsciiDoc
are prose: up to 10 of them are shown with the review, read-only, and
none of them is sent to either model.

## License

MIT
