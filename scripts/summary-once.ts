/**
 * End-to-end judge then summarize, streaming the review as the page does.
 *
 *   bun run review [host] [preset-index | github PR url]
 */
import { Client } from 'eve/client';

import { fetchPullRequest } from '../agent/lib/github/github';
import { filesFromPatch } from '../agent/lib/judging/patch';
import { parseReview } from '../agent/lib/judging/schema';
import { selectReviewFiles } from '../agent/lib/judging/select';
import { judgeMessage, summarizeMessage } from '../agent/lib/review/prompt';
import { isProsePath } from '../agent/lib/review/review';
import { parseSummaryText } from '../agent/lib/review/summary';
import { PRESETS } from '../examples/presets';

const COST_DIGITS = 5;

const OVERALL_PREVIEW_CHARS = 200;
const FILE_PREVIEW_CHARS = 100;

const host = process.argv[2] ?? 'http://127.0.0.1:2000';
const which = process.argv[3] ?? '1';
const client = new Client({ host });
let files = PRESETS[Number(which)]?.files;
let pr: { title: string; body: string; url: string } | undefined;
if (which.startsWith('http')) {
  const fetched = await fetchPullRequest(which);
  files = selectReviewFiles(filesFromPatch(fetched.diff)).kept.filter(
    (f) => !isProsePath(f.path),
  );
  pr = { body: fetched.body, title: fetched.title, url: fetched.url };
  console.log(`PR "${fetched.title}": judging ${files.length} files`);
}
if (!files) {
  console.error('unknown preset');
  process.exit(1);
}

const t0 = performance.now();
const { session, response } = await client.sessions.create({
  message: judgeMessage({ files }),
});
const judged = await response.result();
const review = parseReview(judged.message);
console.log(
  `judge: ${judged.status} ${Math.round(performance.now() - t0)} ms files=${Object.keys(review?.files ?? {}).length}`,
);
if (!review) {
  process.exit(1);
}

const judgments = Object.fromEntries(
  Object.entries(review.files).map(([p, f]) => [p, f.answers]),
);
const t1 = performance.now();
const ms = () => Math.round(performance.now() - t1);
await session.clear();
const resp = await session.send(summarizeMessage({ files, judgments, pr }));
let buffer = '';
let deltas = 0;
let firstDeltaMs = 0;
let lastDeltaMs = 0;
let final = '';
let meta: { cached?: boolean; model?: string } | undefined;
let cost = 0;
let status = 'streaming';
for await (const e of resp) {
  if (e.type === 'message.appended') {
    buffer += String(e.data.messageDelta ?? '');
    deltas++;
    if (!firstDeltaMs) {
      firstDeltaMs = ms();
    }
    lastDeltaMs = ms();
  }
  if (e.type === 'step.completed') {
    meta = (
      e.data.providerMetadata as
        | { judge?: { cached?: boolean; model?: string } }
        | undefined
    )?.judge;
    cost += e.data.usage?.costUsd ?? 0;
  }
  if (e.type === 'message.completed') {
    final = String(e.data.message ?? '');
  }
  if (e.type === 'turn.failed' || e.type === 'session.failed') {
    status = 'failed';
  }
  if (e.type === 'turn.cancelled') {
    status = 'cancelled';
  }
  if (e.type === 'session.waiting') {
    break;
  }
}
console.log(
  `summarize: ${status}; deltas=${deltas} first=${firstDeltaMs} ms last=${lastDeltaMs} ms done=${ms()} ms; cached=${meta?.cached ?? '?'} model=${meta?.model ?? '?'} cost=$${cost.toFixed(COST_DIGITS)}`,
);
const summary = parseSummaryText(final || buffer);
console.log('decision:', summary.decision);
console.log('overall:', summary.overall.slice(0, OVERALL_PREVIEW_CHARS));
for (const f of summary.files) {
  console.log(
    `  ${f.path} (${f.summary.length} chars): ${f.summary.slice(0, FILE_PREVIEW_CHARS)}`,
  );
}
const missing = files
  .filter((f) => !summary.files.some((s) => s.path === f.path))
  .map((f) => f.path);
console.log(
  `files summarised: ${summary.files.length}/${files.length}${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`,
);
process.exit(
  missing.length || !summary.overall || status !== 'streaming' ? 1 : 0,
);
