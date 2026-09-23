# Architecture

Clean Code Review is one Next.js project on Vercel with an eve agent inside it.
There is no database and no account. A review is a pure function of the code
submitted, so everything that persists is a cache.

Two models do the work, both through the Vercel AI Gateway. Jev
(`typesafe-ai/jev`) is an AI SDK *evaluation* model: it answers the question set
for one file in a single call and returns probabilities and scores, never prose.
Luna (`openai/gpt-5.6-luna-fast`) writes the words from Jev's findings and the
code.

Bun 1.4 installs and runs the scripts. The functions run Node.js 24, which eve
requires.

## How a review flows

One durable eve session per browser tab, and two turn kinds over it.

1. A **judge** turn sends the files as JSON.
   [`jev-model.ts`](../agent/lib/judging/jev-model.ts) dispatches it, fans out
   one `evaluate()` call per window of each file to Jev — twice per window
   where there are comments to strip — at most eight in flight at once, and
   replies with the answers. Each file's answer says how many of its windows
   answered, so the page can show a file Jev judged only in part and offer to
   ask again; the windows that did answer come back from the cache.
2. A **summarize** turn sends the files and the answers. Luna runs one call per
   six files plus one overall part, in parallel, streamed as they are written.
3. The page paints one card per file: the rows Jev was asked about, the answer
   to each, and Luna's paragraph.

The page clears the session history before every turn, so the model cannot
anchor on code no longer on screen. Cancelling a turn aborts the model calls.
Editing one file re-judges only that file.

A pull request is fetched on the server, split per file by
[`patch.ts`](../agent/lib/judging/patch.ts), and narrowed to the files worth
judging by [`select.ts`](../agent/lib/judging/select.ts) — at most 24 code
files, the largest changes first.

The MCP endpoint runs the same pipeline in one request, with no session and no
tab ([`mcp-review.ts`](../src/mcp/mcp-review.ts)). Every step keys its caches
the way the page does, so the two share judgments and review parts in both
directions.

## Where things live

| Layer | Where |
|---|---|
| Questions, groups, conditional rows | [`agent/lib/judging/questions.ts`](../agent/lib/judging/questions.ts) |
| Jev calls and per-file caching | [`agent/lib/judging/judge.ts`](../agent/lib/judging/judge.ts) |
| Model adapter for eve, and the page's spend brake | [`agent/lib/judging/jev-model.ts`](../agent/lib/judging/jev-model.ts) |
| Diff parsing | [`agent/lib/judging/patch.ts`](../agent/lib/judging/patch.ts) |
| Skip rules and file selection | [`agent/lib/review/review.ts`](../agent/lib/review/review.ts), [`agent/lib/judging/select.ts`](../agent/lib/judging/select.ts) |
| Luna calls, batching, streaming order | [`agent/lib/review/reviewer.ts`](../agent/lib/review/reviewer.ts), [`agent/lib/review/reviewer-prompt.ts`](../agent/lib/review/reviewer-prompt.ts) |
| GitHub fetcher | [`agent/lib/github/github.ts`](../agent/lib/github/github.ts), [`src/pull-request/pull-request.tsx`](../src/pull-request/pull-request.tsx) (page), [`src/app/api/github-pr/route.ts`](../src/app/api/github-pr/route.ts) (scripts) |
| Recent pull requests for the landing chips | [`agent/lib/github/recent.ts`](../agent/lib/github/recent.ts), walked hourly by [`agent/schedules/recent-pull-requests.ts`](../agent/schedules/recent-pull-requests.ts) and read by [`src/app/api/recent-prs/route.ts`](../src/app/api/recent-prs/route.ts) |
| MCP server and its one-request review | [`src/app/api/mcp/route.ts`](../src/app/api/mcp/route.ts), [`src/mcp/mcp-server.ts`](../src/mcp/mcp-server.ts), [`src/mcp/mcp-review.ts`](../src/mcp/mcp-review.ts) |
| Page state and the two turns | [`src/review/useReview.ts`](../src/review/useReview.ts) |

[`questions.ts`](../agent/lib/judging/questions.ts) is the single source of
truth for the question set. Change a question there and the prompt, the payload
and the meters change together. Rows are conditional: the test row only on test
paths, the Boy Scout row only on diffs.

## Boundaries

- `agent/` never imports `src/` or `examples/`.
- [`select.ts`](../agent/lib/judging/select.ts) is imported by the page, so it
  stays free of server-only code.
- [`mcp-review.ts`](../src/mcp/mcp-review.ts) avoids `next/headers`, React
  `cache` and `server-only`, because the scripts import it too.
- [`mcp-facts.ts`](../src/mcp/mcp-facts.ts) is kept apart from the server so
  `src/proxy.ts` does not pull the review pipeline into the proxy bundle, and
  [`agent-markdown.ts`](../src/site/agent-markdown.ts) is React-free for the
  same reason.
- Every public figure — file caps, windows, budgets — is exported from the
  module that enforces it and imported by whatever quotes it. The FAQ,
  `/privacy`, `llms.txt` and the Markdown twins never retype a number.

## The MCP surface

`/api/mcp` is stateless Streamable HTTP with no sign-in. It has two tools:
`review_pull_request` takes a public GitHub pull request URL, and
`review_pasted_code` takes a unified diff or files, up to 1,000,000 characters.

A server card sits at `/api/mcp/server-card` and the AI Catalog at
`/.well-known/ai-catalog.json` lists it. Both follow the server card proposal
(SEP-2127, `modelcontextprotocol/experimental-ext-server-card`), which is not
yet part of the MCP specification, so both are advisory. The card deliberately
lists no tools: a client asks the server. The server is deliberately not listed
in the MCP Registry.

JSON-RPC batches are refused with HTTP 400 in
[`route.ts`](../src/app/api/mcp/route.ts) before the handler runs. Each `tools/call`
in a batch would start a review behind a single Firewall-counted request. MCP
dropped batches in 2025-06-18, but the SDK's stateless path still accepts them.

The route's `maxDuration` is 120 seconds. The written review is given 60 of
them; past that the call returns what it has with the reason.

## Limits and budgets

The page and the MCP server talk to the models anonymously, so the deployment
carries brakes at four layers: the Vercel Firewall, per-address counters in the
app, the shared spend budgets, and the AI Gateway budget on the project.

### Vercel Firewall

Seven custom rules, all rate limits keyed by client IP over a fixed window. A rule
that needs an exact path uses an anchored regex; a path-plus-method condition
was tried and never matched.

| Rule | Limit | Matches |
|---|---|---|
| Rate limit session creation | 30 per 10 min | `^/eve/v1/session/?$` |
| Rate limit GitHub PR fetches | 20 per 10 min | path prefix `/api/github-pr` |
| Rate limit agent traffic | 120 per min | path prefix `/eve/v1/` |
| Rate limit pull request permalinks | 20 per 10 min | `^/[^/]+/[^/]+/pull/[0-9]+/?$` |
| Rate limit server actions | 20 per 10 min | request carries a `next-action` header |
| Rate limit the MCP endpoint | 10 per 10 min | `^/api/mcp/?$` |
| Rate limit the recent pull request list | 60 per 10 min | `^/api/recent-prs/?$` |

Of the managed rules, Bot Protection is off, AI Bots are allowed, and BotID is
on basic. `bunx vercel firewall rules list` prints the live configuration.

### In-app counters

Best effort, in one instance's memory, and therefore not quotas: serverless
instances do not share them.

| Brake | Setting |
|---|---|
| New sessions per address | 30 per 10 min, [`agent/channels/eve.ts`](../agent/channels/eve.ts), from [`session-facts.ts`](../agent/lib/infra/session-facts.ts) |
| GitHub fetches per address | 20 per 10 min, [`src/pull-request/throttle.ts`](../src/pull-request/throttle.ts), shared by the server action and `/api/github-pr` so both count one window |
| MCP tool calls per address | 10 per 10 min, [`src/mcp/mcp-server.ts`](../src/mcp/mcp-server.ts) |
| Recent pull request list per address | 60 per 10 min, [`src/landing/recent-throttle.ts`](../src/landing/recent-throttle.ts), counted apart from GitHub fetches so page loads cannot refuse a reader the pull request they pasted |
| Per-session spend cap | `maxTokenCostUsdPerSession`, $0.50, [`agent/agent.ts`](../agent/agent.ts) |
| Session lifetime | `sessionTimeoutMs`, one hour |

The two throttle-based counters — GitHub fetches and MCP calls — share
[`createThrottle`](../src/pull-request/throttle.ts), so both count an IPv6
address by its /64, because a host is handed a whole /64 and can rotate within
it, and both put a request that arrives with no address into one shared bucket
rather than letting it pass unseen. The session brake is separate: it keys on
the raw address and, when no address header is present, does not count the
request at all. Each counter tracks at most 10,000 addresses; the throttle
evicts the least recently seen, and the session brake clears the map.

The public figures are exported from the module that enforces them:
[`throttle.ts`](../src/pull-request/throttle.ts),
[`mcp-facts.ts`](../src/mcp/mcp-facts.ts) and
[`session-facts.ts`](../agent/lib/infra/session-facts.ts), the last kept out of
`agent/channels/` because eve reads every file there as a channel.

### Spend

| Budget | Limit |
|---|---|
| Page, all tabs together | $0.40 per hour, $1.00 per UTC day |
| MCP, all callers together | $0.25 per hour, $1.00 per UTC day |
| AI Gateway, on the project | $15 per week |

The caps are global rather than per address because a per-address limit cannot
protect the weekly gateway budget. Both daily caps total $14 a week, which fits
under it. A fresh 24-file review measured about $0.02; the worst MCP call
measured about $0.06. Caps live in
[`budgets.ts`](../agent/lib/spend/budgets.ts) and are counted in the Vercel
Runtime Cache by [`spend.ts`](../agent/lib/spend/spend.ts).

A refused page turn says this hour's or today's review budget is spent and when
it resets, the answers on screen stay, and a turn answered wholly from the cache
is still served. The MCP endpoint refuses with the same reset time, and also still serves
a wholly cached review.

### Reserve and settle

Work reserves a worst-case estimate before any model runs, so concurrent callers
see it at once, then settles to what the work plausibly cost. A cancelled or
failed call is charged its prompt and whatever it streamed, and nothing when it
was never sent or was turned away — a 4xx, a rate limit, no connection. Settling
at the worst case would let cancelled work lock the page. Zero-cost work is
never refused.

Two constraints follow from the store:

- **A lost update.** The Runtime Cache has no atomic increment, so reserve and
  settle are unlocked read-add-writes. Two turns landing within one round trip
  of each other read the same total and one write is lost. The brake narrows the
  window to a round trip, not to zero; a burst is bounded by the Firewall.
- **Fail closed.** The Runtime Cache client answers a failed read with null,
  exactly as for a missing key. Each scope therefore keeps a marker key naming
  the counters it has written: a missing marker is written and read back to
  prove the store answers, and a named counter that still reads missing is
  treated as evicted. When the marker cannot be read back, or the Runtime Cache
  is memory-only, uncached work is refused a minute at a time. Write failures
  are silent in that client, so lost writes go uncounted.

The counters are per region, so the caps are global only while the project runs
in one region.

### Luna's output ceiling

At most 4,000 output tokens for a batch of files and 2,000 for the overall part
([`reviewer.ts`](../agent/lib/review/reviewer.ts)). Measured peaks were 816 and
183, so the ceilings sit about five and ten times above them. This is a safety
net against untrusted code keeping the model writing, not a length rule — the
prompt owns length, at 300 characters per file section. A part that reaches the
ceiling is written once more with twice the room. A part cut off even then is
shown as far as it got, marked incomplete, and never cached.

## Caches

Nothing cached is keyed by anything about the caller
([`cache.ts`](../agent/lib/infra/cache.ts)). The two model caches are keyed by a
hash of their content; the pull request cache is keyed by a public URL.

| What | For | Key | Holds |
|---|---|---|---|
| Jev's answers for one file | 1 hour | the file's content, path, question ids and a question-set version | the answers only; the code is in the key and no further |
| One Luna review part | 1 hour | the exact prompt, the model id and a review version | the written part |
| A fetched pull request | 1 minute | its GitHub URL | the whole `PullRequestReview`: title, description, diff, avatar URL and changed-file count |
| The recent pull request list | 3 hours | one fixed key | up to five `{repo, number, title, url}`, or an empty list, with when the list was fetched and when a walk last finished. Written only by the hourly schedule, read by every visitor, so no reader ever calls GitHub. A walk that finds nothing keeps the list it had, and a list goes three hours after the walk that found it, so one missed cron run costs nothing visible |

The Vercel Runtime Cache backs all four on a deployment: per region, shared
across instances, and it survives deploys. Off Vercel, or when the Runtime Cache
is not configured, the first three fall back to process memory, because a cache
miss there only repeats work. The recent pull request list does not: a walk
stored in one instance's memory reaches no reader, so without a shared store
the schedule calls nothing and readers get an empty list, the same fail-closed
rule the spend counters follow. Values above 2,000,000 bytes are not stored,
because an oversized `set` fails silently.
