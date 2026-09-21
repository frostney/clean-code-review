# Judging functions and classes instead of files

Spike, 2026-09-20, measured at commit `34073fc`. A spike is a point-in-time
investigation and is not updated; later work supersedes it rather than edits
it.

Today Jev judges a whole file and returns one probability per question. Several
questions are about a function or a class, not a file: "does more than one
thing", "too many arguments", "long function", "hidden side effects", "feature
envy", "class does too much". The question was whether judging each unit
separately is more accurate, and whether it is worth the money.

**It is not worth a full unit-level pass.** The number that decides it: a
median unit is 291 characters, and a call about it sends 1,444 input tokens of
which **1,368 are the question list**. 95% of the spend is the questions, so
cost tracks the number of units, not the amount of code — 6.6x the judging
bill for 14 new flags out of 116, most of which are a unit missing the context
that made it fine. A narrow targeted pass at ~+35% is worth considering; the
sketch is at the end.

## What it costs

Measured against the AI Gateway (`typesafe-ai/jev`, the live 32 questions,
gateway-reported cost, all calls in one parallel batch, no cache hits).

| File | Chars | Whole file | Units | Unit by unit | Ratio |
| --- | --- | --- | --- | --- | --- |
| `agent/lib/judging/judge.ts` | 7,640 | $0.000145 | 12 | $0.000756 | 5.2x |
| `agent/lib/spend/spend.ts` | 15,467 | $0.000241 | 19 | $0.001280 | 5.3x |
| `src/review/FileCard.tsx` | 14,566 | $0.000224 | 11 | $0.000762 | 3.4x |
| `src/review/useReview.ts` | 43,685 | $0.000245 | 30 | $0.002805 | 11.4x |
| Total | | **$0.000854** | 72 | **$0.005603** | **6.6x** |

Input tokens fit `1368 + 0.261 × chars` (least squares over the 72 unit calls).
The intercept is the question list; the slope is 3.8 characters per token.

Extrapolated to a 24-file review, at the 11.0 top-level units per file this
repo's ten largest source files average:

- whole file, as today: 24 calls, **~$0.005**
- unit by unit: 264 calls, **~$0.021**

Across all 103 `.ts`/`.tsx` files the repo averages 3.8 units per file, which
would put unit judging at ~$0.007 — but a review keeps the 24 *most-changed*
files, so 264 calls is the figure to plan for. Against the page's $0.40/hour
budget, a review's judging goes from ~1.3% to ~5.3% of the hour; with Luna's
summary on top, reviews per hour fall from roughly 20 to roughly 11.

Latency is not the problem while the fan-out holds: 43 unit calls in parallel
returned in 1,366 ms against 984 ms for three whole files (per call p50 457 ms,
p90 999 ms; 22.9 s if run serially). Reliability might be: one of those 43
calls came back `GatewayInternalServerError`. A review makes 24 concurrent
calls today and would make 264.

## Splitting

TypeScript 6.0.3 is already installed and `ts.createSourceFile` is enough — no
program, no type checker, no `tsconfig`. Cost is negligible: **103 files,
477 KB, 396 top-level units in 127 ms** (1.2 ms per file) against a ~450 ms
model call. Two caveats: `typescript` is a *dev* dependency today, and
`lib/typescript.js` is 9.1 MB, so using it in the agent means shipping it in
the function bundle.

Over ten sampled files (the four above plus `review.ts`, `language.ts`,
`ReviewProvider.tsx`, `useCardWindow.ts`, `cache.ts`, `Toast.tsx`): 110
top-level units, median 8 per file, min 2, max 30. Unit sizes
p10/p50/p90/max = 102 / 291 / 1,162 / 24,942 characters. 57 of 110 units are
under 300 characters; one unit in the whole repo exceeds the 16,000-character
per-file clamp.

The gap that matters is coverage. Top-level units account for 72% of the
sampled characters and **60% across the repo** — `language.ts` 22%,
`review.ts` 45%, `spend.ts` 60%. The other 40% is imports, module doc comments,
types, constant tables and regexes, which is exactly where magic numbers, noise
comments, dead code and half the naming questions live. Unit judging can
therefore only be *added* to file judging, never substituted for it, so its
cost is additive.

## What unit-level judging actually says

Agreement over the 4 files × 29 boolean questions, counting a probability over
0.5 as a finding and taking the highest-scoring unit as the file's unit-level
answer: **86% (100 of 116)** — 56 flagged both ways, 44 clear both ways, 2
only at file level, 14 only at unit level.

It localises correctly. The unit that scores highest is, in every one of the
four files, the unit a reviewer would name:

- `createSpendBrake` (`spend.ts` L320–487) tops long function 94%, does more
  than one thing 92%, swallowed errors 95%, tangled error handling 91%, mixed
  abstraction levels 81%.
- `judgeFile` (`judge.ts` L115–155) tops does more than one thing 86%, long
  function 75%, tangled error handling 85%, hard to test 77%.
- `FileCard` (`FileCard.tsx` L397–537) tops long function 85%, does more than
  one thing 73%, and is the worst unit on function size (1.0) and verdict
  (1.8).
- `useReview` (`useReview.ts` L702–1486) tops long function 98%, does more
  than one thing 95%, hidden side effects 86%, swallowed errors 97%, and is
  the worst unit on nesting (1.2) and verdict (1.1).

The last one is the strongest argument for the idea, for a reason unrelated to
units: `useReview.ts` is 43,685 characters, the clamp cuts it at 16,000 (37%),
and the `useReview` hook **starts at character 18,741** — the current
file-level verdict for that file is formed without ever seeing the 785-line
hook the file exists for. That is why its file-level `swallowed_errors` is 19%
while the hook alone answers 97%.

Three other findings only the unit pass saw look real: `failureMayHaveBilled`'s
`cancelled: boolean` reads as a flag argument at 91% against 37% for the file;
`reportedCost` returns null at 93% against 34%; `FileCard`'s `codeSpace` 80%
against 45%.

Against that, the predicted failure is plainly there. A unit judged alone has
lost what made it fine:

- **Feature envy fires on 49 of 72 units (68%)**, against 54–62% for the four
  whole files. Every helper that takes an object and reads its fields looks
  envious with its module removed. As a localiser it is worthless.
- **Magic numbers on 31 of 72.** `stateChars` — `file.patch ? 2 *
  file.content.length : file.content.length` — answers 84% alone against 63%
  for the whole file, because the reason for the 2 is in the comment above it
  and in `spend.ts`.
- **Names.** `spend.ts` answers 26% for names hiding intent; 9 of its 19 units
  answer over 50%, `jevFailedCallUsd` highest at 70%. The module comment that
  says who Jev and Luna are belongs to no unit.

Scores cannot be aggregated by averaging. Unit means for function size are
3.1–3.7 where the files answer 1.8–2.5; judged alone a 300-character helper
is "Tiny" and "Ship it". The **minimum** over units does track the file answer
(1.0–1.8 against 1.8–2.5) and is the only defensible roll-up.

Giving each unit its file's preamble back does not fix this and costs more.
Judging `spend.ts` again with the imports, module doc and constants prepended
to each of its 20 units cost $0.002368 — 3.1x the plain unit pass and **9.8x
the whole file** — and collapsed localisation: inconsistent naming, tangled
error handling, magic numbers, feature envy and dead code each flagged **20 of
20 units**. With shared context every unit inherits the file's verdict, which is
the thing unit judging was supposed to improve on.

## Recommendation

Do not add a general unit-level pass. It costs 6.6x, agrees with the file-level
answer 86% of the time, and its disagreements are more often context loss than
insight.

If localisation is wanted, the affordable shape is a **targeted second pass**,
and it was measured. Asking only the six unit-scoped questions instead of all
32 drops the fixed overhead from 1,368 to ~449 tokens per call:

| Unit | Chars | Tokens | Cost |
| --- | --- | --- | --- |
| `createSpendBrake` | 5,309 | 1,879 | $0.000079 |
| `FileCard` | 3,827 | 1,444 | $0.000061 |
| `judgeFile` | 1,162 | 784 | $0.000033 |
| `reportedCost` | 214 | 505 | $0.000021 |

The answers match the full 32-question unit run within a few points (`judgeFile`
86/77/66/75 against 86/76/64/75), so the short list loses nothing.

Sketch, if it is built:

- **Trigger.** Only for a file whose file-level answer to `long_function`,
  `does_more_than_one_thing` or `class_does_too_much` is over ~0.7, and only
  its three largest units. On a 24-file review with half the files flagged that
  is ~36 calls, **~$0.0018**, about +35% on judging — not 300%.
- **Shape.** `ReviewResult.files[path]` keeps its `answers` unchanged and gains
  `units?: { name, kind, line, endLine, answers }[]`, carrying only the six
  unit-scoped ids. Nothing a unit says overrides a file meter; the file answer
  stays the headline and the unit answer is the address.
- **UI.** The card marks the unit's first line (`line`), reusing the line
  addressing `FileCard` already has, and labels it with the unit name — "long
  function · `createSpendBrake` · line 320".
- **The clamp.** `REVIEW_LIMITS.maxCharsPerFile` stays as it is. Units are
  taken from the *unclamped* file, so the pass reaches code the file-level
  clamp cuts — for `useReview.ts` that is the 63% of the file no judgement has
  ever seen. A unit over 16,000 characters is clamped like a file; exactly one
  unit in 396 across this repo is (the `useReview` hook, 24,942).

## Open questions

- **Patch mode.** The splitter needs parseable source. A review in patch mode
  holds hunks, and `afterImage` reconstructs only the changed regions, so a
  parse would see truncated bodies. Either measure what `ts.createSourceFile`
  recovers from a partial file, or skip the pass for patch files — which is
  most real reviews, and may on its own sink the idea.
- **Shipping `typescript`.** 9.1 MB in the function bundle for a parse that
  only needs top-level spans. A brace/indent splitter would be worse on `.tsx`
  but might be good enough to pick the three largest units.
- **Which questions.** Only six were probed. Long function and "does more than
  one thing" localise cleanly; `class_does_too_much` did not (46–58% on the
  units a reviewer would blame), and feature envy should be excluded outright.
- **Whether it is wanted.** The file-level pass already names the right file
  and, for 86% of questions, gives the same answer. The user-visible gain is an
  address, not a verdict.

Total gateway spend for this spike: $0.0090.
