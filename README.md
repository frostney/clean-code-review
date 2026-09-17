# Clean Code Review

Live: https://clean-code-review.vercel.app
Source: https://github.com/frostney/clean-code-review

Type a GitHub pull request into the field at the top — the address is already
on screen as `github.com/` `owner/repo` `/pull/` `123`, with only those two
parts left to fill in, public repositories only — or paste a diff, drop in a
single file, or pick one of the sample codebases. Every file gets its own 34
Clean Code judgments — 31 yes/no smells grouped by the chapters of *Clean
Code*, plus function size, nesting and a verdict — from **Jev**, TypeSafe AI's
System One evaluation model. Then **Luna** writes the review in words: a
paragraph per file, a paragraph for the whole change, and an approve / comment /
request changes decision.

The page reads like the "files changed" tab of a code review, with the
judgments as the review: a verdict and a smell count per file, a verdict for
the whole change, and bars that move when the code moves. Every example stays
editable in place — a whole file, or the body of a diff — is re-judged on every
pause, and re-reviewed once the code stops moving. A card folds to its header
from the chevron beside its name, "Collapse all" folds the review, the sidebar
unfolds a file and scrolls to it, and "Findings" inside a card hides the meters
and leaves the paragraph.

Both models reach the page through one [eve](https://eve.dev) agent on Vercel,
so a whole codebase is one turn, a fraction of a cent, and usually lands in
well under a second; the prose follows a few seconds later.

It descends from Steve Krouse's [TypeSafe demo](https://typesafe-demo.val.run/)
with two substitutions: the subject is code instead of prose, and TypeSafe is
reached through the Vercel AI Gateway and an eve agent instead of the TypeSafe
API directly.

## How it works

```
browser ──POST /eve/v1/session──▶ eve agent (Vercel Workflow)
   judge turn                        └─ judge.ts ──▶ AI Gateway: typesafe-ai/jev
                                         ├─ file 1 ─┐
                                         ├─ file 2  ├─ in parallel
                                         └─ file n ─┘
        ◀── NDJSON stream ────────  message.completed { 34 answers per file }

   summarize turn ──────────────▶  reviewer.ts, inside the model step
                                     ├─ overall ─┐  decision + summary
                                     ├─ files 0  ├─ all started at once,
                                     ├─ files 1  │  6 files each,
                                     └─ …       ─┘  AI Gateway: …/luna-fast
        ◀── the turn's own stream ─  message.appended { messageDelta } ×800
              …parts flushed in order: overall first, then the batches…
        ◀── message.completed ─────  the whole review as one text
```

- `agent/lib/questions.ts` is the single source of truth: the 34 questions,
  their types (`noul` yes/no probability, `score` on a 5-level scale) and the
  ten groups, which follow the chapters of Robert C. Martin's *Clean Code*:
  Names, Functions, Comments, Formatting, Objects & data, Error handling, Unit
  tests, Classes, Smells, and a Verdict group. The questions Jev is asked, the
  payload type (`agent/lib/schema.ts`) and the meters on screen are all derived
  from it.
- Every yes/no question is phrased so that **yes is a finding**, which is what
  lets a card count its smells: a row Jev puts at even odds or better keeps its
  dark bar and says "Yes" in red, and the rest fade. The badge beside the
  overall decision is the total across the review.
- Some rows are conditional (`questionsFor(file)`): "Leaves it worse than
  found" is a question about a change, so it is only asked of a diff, and
  "Unclear or multi-assert tests" only of a path that looks like a test. A row
  that was not asked is never rendered — a blank row would read as a clean
  bill of health — and a chapter with nothing to ask is left out of the card.
- Images, binaries, lockfiles and generated paths never become a card:
  `partitionJudgeable` in `agent/lib/review.ts` is applied on every way in
  (presets, paste, GitHub) and the agent applies the same rule on its side, so
  what was left out is reported in a notice rather than silently missing.
- A turn's message is a **review**: a list of files, each either a whole file or
  that file's section of a unified diff (`agent/lib/review.ts`,
  `agent/lib/patch.ts`). `agent/lib/judge.ts` evaluates each one with
  `evaluate({ model: "typesafe-ai/jev", state, questions })` and runs them in
  parallel, so a five-file codebase costs one turn and about as long as one file.
- **Luna writes the prose, from the findings alone.** A summarize turn carries
  the files and Jev's answers, and the turn's reply *is* the review: the model
  step runs the reviewer (`agent/lib/reviewer.ts`, prompt in
  `agent/lib/reviewer-prompt.ts`) against `openai/gpt-5.6-luna-fast` through the
  AI Gateway. The reviewer never sees the code: its input is each file's path,
  its kind, and the smells Jev put at even odds or better, so it writes about
  what was found rather than about lines it cannot read, and it may not add a
  finding of its own.
- It answers in **plain text** in a fixed layout — a `Decision:` line, an
  `## Overall` section, then one `## <path>` section per file, **300 characters
  at most each** (`agent/lib/summary.ts`) — rather than as structured output,
  because text can be read while it is still being written.
  `parseSummaryText(text, partial)` tolerates a section that stops
  mid-sentence, so the page runs it on every delta.
- **A review is written in parallel parts.** `planParts` makes one Luna call per
  batch of `REVIEW_BATCH_SIZE` files (`role: "files"`), plus one `role: "overall"`
  call that writes the decision and the overall paragraph from every file's
  findings — so a 24-file pull request takes about as long as a six-file one.
  All of them start at once; a part that finishes early buffers until its turn
  comes, and the parts are flushed into the turn's reply in a fixed order — the
  overall first, then the batches — so the growing text is a well-formed review
  at every moment.
- The page reads that text off **the turn's own response**: `message.appended`
  deltas are appended to a buffer and re-parsed with `parseSummaryText(buffer,
  true)`, so the decision badge and the overall paragraph land first and each
  file's card fills in as it is written; `message.completed` carries the whole
  text and is the authoritative result the review settles on. There is no second
  turn and no second stream. A review in flight is cancelled with
  `session.cancel()` — the turn ends with `turn.cancelled`, the Luna calls are
  aborted with it, and the session takes the next turn straight away — whenever
  a judge turn is about to change the answers it was written from.
- Judgments and reviews are both **cached for an hour**, keyed by what was
  judged and by the findings the reviewer was given (`agent/lib/cache.ts`), a
  review one part at a time. On Vercel that is the Runtime Cache — per region,
  shared across function instances, surviving deploys — and anywhere else the
  same code falls back to this process's memory. A cached part is written
  straight into the reply instead of being generated, so a wholly cached review
  arrives in one burst, costs nothing, and the header says "from cache" — which
  is exactly how the page knows: a summarize step whose `usage.costUsd` is zero
  made no model call at all. A review only some of whose parts are cached gets
  those instantly and generates the rest.
- Judge turns and summarize turns share one session per tab and take it in
  turns. The first summary runs as soon as a review's judgments land; after an
  edit it waits two seconds for the code to settle, and only the files whose
  judgments actually moved are re-reviewed — the rest keep the paragraph they
  already had.
- Jev is not a chat model. It does not take a system prompt or produce prose: it
  evaluates one piece of state against typed questions and returns calibrated
  answers — a probability for a yes/no, a position on the levels and the
  distribution behind it, plus its own per-question confidence.
  The AI SDK exposes it as `experimental_evaluate`, not as a language model.
- eve's `model` slot only takes language models, so `agent/lib/jev-model.ts` is a
  small `LanguageModelV4` adapter: it reads the newest user message as a review,
  fans the files out to Jev, and returns the answers as the assistant's text — a
  JSON payload the browser reads with `parseReview`. Everything else eve gives a
  session (durability, streaming, per-session limits, Agent Runs, the
  same-origin HTTP surface) works unchanged.
- `agent/agent.ts` installs that model, turns default tools off (a judgment is a
  pure function of the file), and caps each browser tab's session at **$0.50**
  (`maxTokenCostUsdPerSession`, mirrored for the browser in `lib/budget.ts`).
  Jev's answers cost a fraction of a cent; Luna's prose costs cents, so the cap
  is what a tab may spend on both together.
- A GitHub pull request is the page's first input, not a panel behind a button.
  There is no page title above it: the field is the top of the page and is the
  address itself, with its fixed parts already printed and only the variable
  ones left to type: `github.com/` `owner/repo` `/pull/` `123`. Enter in either
  box judges it, a whole URL pasted into the first box is taken apart and fills
  both, and the number box takes digits only.
  Below it, on one line, sit the second ways in: "Or choose one of the examples:"
  and the five preset buttons, then "Paste code or a diff", which opens a modal
  `<dialog>` — one textarea for a diff, a file, or several files marked up with
  `// file:` lines, judged on submit rather than on every pause, with Escape, the
  close button and a click on the backdrop all ending it and handing focus back
  to the link that opened it. A pull request arrives through
  `GET /api/github-pr?url=…`
  (`app/api/github-pr/route.ts` over `agent/lib/github.ts`), which returns the
  title, body, unified diff and changed-file count, or an error with status
  400, 429 or 502. **Public repositories only** — a private PR comes back as
  "not found" rather than an invitation to sign in. `GITHUB_TOKEN` is optional
  and only raises the rate limit. The diff is split per file, generated and
  non-code files are dropped, and the largest 24 by changed lines are judged;
  a diff over 4 MB is refused rather than buffered.
- `agent/channels/eve.ts` admits anonymous browser traffic with `none()`: this
  is a public demo with no accounts in front of it.
- The browser holds one durable eve session per tab. Each turn is
  `session.clear()` then `session.send(review)`, so earlier files never bias the
  next answer and history stays flat. The first turn carries every file; an edit
  carries **only the file that changed**, and its judgment is merged back by
  path — which is why editing one file leaves every other card still.
- The code views are highlighted with [shiki](https://shiki.style) using its
  JavaScript regex engine, so there is no WASM to fetch and a card colours
  itself the moment it appears. A patch keeps its diff semantics — two gutters,
  a background per line kind — and the code inside each line is still
  highlighted as the file's own language.
- Both kinds of example are edited the same way: a transparent textarea over the
  highlighted layer. What a patch offers for editing is its hunks; the
  `diff --git`/`index`/`---`/`+++` headers are lifted off for the screen and put
  back on the way to the agent, so what it parses is a section git could have
  written. The diff is re-read on every keystroke, so the gutters, the
  backgrounds and the `+a −d` count follow the text rather than the other way
  round.
- `next.config.ts` wraps the app with `withEve()`, so the agent and the page are
  one Next.js project, one dev server, one Vercel deployment.

Large changes are reviewed in parallel inside the summarize turn: one Luna
call per batch of six files plus one for the decision and overall text, all
started at once through the AI Gateway and streamed back in a fixed order as
the turn's own reply, so the page reads a single growing text. Each part is
cached on its own for an hour. A 24-file pull request is fully reviewed in
about four seconds locally, the first text landing after about two and a half;
cancelling the turn aborts the calls.

## Run it locally

Node 24 and the Vercel CLI (installed as a dev dependency) are the only
prerequisites. Link a Vercel project once so an AI Gateway credential lands in
`.env.local`:

```bash
npm install
npx eve link --non-interactive --project <your-project-name>
npm run dev
```

Open http://localhost:3000. `npm run dev` starts Next.js and the eve dev
server together and proxies `/eve/v1/*` to the agent.

To exercise the agent without a browser:

```bash
npx tsx scripts/judge-once.ts            # against `npx eve dev --no-ui` on :2000
npx tsx scripts/judge-once.ts http://localhost:3000
```

It sends every preset review and prints steps, latency, tokens, cost and a few
headline answers per file. It fails if any preset comes back with fewer
judgments than files, if a file is missing any of the questions that apply to
it, or if a turn takes more than one step.

To exercise the summarize turn the same way the page does — judge a preset or a
pull request, send the judgments back, and read the review off the turn's own
response as it streams:

```bash
npx tsx scripts/summary-once.ts                          # preset 1
npx tsx scripts/summary-once.ts http://localhost:3000 1
npx tsx scripts/summary-once.ts http://localhost:3000 https://github.com/vercel/ai/pull/20851
```

It prints how the turn ended, how many deltas it carried and when the first and
last of them landed, what the review cost and whether it came from the cache,
then the parsed decision, the overall paragraph and every file's note. It exits
non-zero unless the turn streamed to completion, every file was summarised and
the overall was written.

To check Jev itself, with no eve in the loop — it proves the gateway
credential, times one evaluation and prints the raw answer shape:

```bash
npx tsx --env-file=.env.local scripts/jev-once.ts                  # preset 0
npx tsx --env-file=.env.local scripts/jev-once.ts [index | path/to/file]
```

And the usual two:

```bash
npm run typecheck
npm run build
```

## Deploy

```bash
npm run deploy
```

`eve deploy` runs `vercel deploy --prod` for the linked project. The deployment
authenticates to the AI Gateway with the project's OIDC identity, so no API key
is needed. The footer's "view source" link points at
https://github.com/frostney/clean-code-review; set `NEXT_PUBLIC_SOURCE_URL` to
point it somewhere else.

## Abuse limits

The channel admits anonymous traffic, so the deployment carries four brakes,
from the outside in:

- **Vercel Firewall rate limits** (published on the project, per client IP):
  `POST /eve/v1/session` 30 per 10 minutes, `/api/github-pr` 20 per 10
  minutes, and everything under `/eve/v1/` 120 per minute. Excess requests get
  a 429 before they reach a function. Manage them with `vercel firewall rules`.
- **An AI Gateway budget** of $15 per week on the project
  (`vercel ai-gateway budgets set project clean-code-review --limit 15
  --refresh-period weekly`). When it is spent the gateway answers 402 and
  reviews stop until the week rolls over.
- **A per-session spend cap** (`maxTokenCostUsdPerSession` in
  `agent/agent.ts`), one durable session per browser tab.
- **A best-effort per-address limit on new sessions** inside the agent
  (`agent/channels/eve.ts`), counted in one function instance's memory.

## Change the questions

Edit `agent/lib/questions.ts`. Adding, removing or rewording a question updates
what Jev is asked, the payload, the smell count and the UI together. A question
has to stay one of the two types Jev answers here: `noul` (a yes/no phrased so
that **yes is a finding**) or `score` on its five levels. Give it a `group`
from `GROUPS`, and an `appliesTo` of `"patch"` or `"test"` when it is only a
question about a change or about a test.

## Change the examples

Edit `agent/lib/presets.ts`. A preset is a label, a one-line blurb and a list of
files; the pull request is stored as a single unified diff and split per file
with `filesFromPatch` at module load. `scripts/judge-once.ts` reads the same
list, so a new example is covered by the smoke test the moment it is added.
