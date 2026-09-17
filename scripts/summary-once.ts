/**
 * Exercise the summarize turn end to end: judge a preset (or a GitHub PR),
 * send the judgments back for a review, and read the review as it streams on
 * the turn's own response, exactly as the page does. Prints timings, the
 * parsed result, and whether it came from the cache.
 *
 *   npx tsx scripts/summary-once.ts [host] [preset-index | github PR url]
 */
import { Client } from "eve/client";
import { fetchPullRequest, selectReviewFiles } from "../agent/lib/github";
import { filesFromPatch } from "../agent/lib/patch";
import { PRESETS } from "../agent/lib/presets";
import { judgeMessage, summarizeMessage } from "../agent/lib/prompt";
import { parseReview } from "../agent/lib/schema";
import { parseSummaryText } from "../agent/lib/summary";

const host = process.argv[2] ?? "http://127.0.0.1:2000";
const which = process.argv[3] ?? "1";
const client = new Client({ host });
let files = PRESETS[Number(which)]?.files;
let pr: { title: string; body: string; url: string } | undefined;
if (which.startsWith("http")) {
  const fetched = await fetchPullRequest(which);
  files = selectReviewFiles(filesFromPatch(fetched.diff)).kept;
  pr = { title: fetched.title, body: fetched.body, url: fetched.url };
  console.log(`PR "${fetched.title}": judging ${files.length} files`);
}
if (!files) {
  console.error("unknown preset");
  process.exit(1);
}

const t0 = performance.now();
const { session, response } = await client.sessions.create({ message: judgeMessage({ files }) });
const judged = await response.result();
const review = parseReview(judged.message);
console.log(`judge: ${judged.status} ${Math.round(performance.now() - t0)} ms files=${Object.keys(review?.files ?? {}).length}`);
if (!review) process.exit(1);

const judgments = Object.fromEntries(Object.entries(review.files).map(([p, f]) => [p, f.answers]));
const t1 = performance.now();
const ms = () => Math.round(performance.now() - t1);
await session.clear();
const resp = await session.send(summarizeMessage({ files, judgments, pr }));
let buffer = "";
let deltas = 0;
let first = 0;
let last = 0;
let final = "";
let meta: { cached?: boolean; model?: string } | undefined;
let cost = 0;
let status = "streaming";
for await (const e of resp) {
  const d: any = (e as any).data ?? {};
  if (e.type === "message.appended") {
    buffer += String(d.messageDelta ?? "");
    deltas++;
    if (!first) first = ms();
    last = ms();
  }
  if (e.type === "step.completed") {
    meta = d.providerMetadata?.judge;
    cost += d.usage?.costUsd ?? 0;
  }
  if (e.type === "message.completed") final = String(d.message ?? "");
  if (e.type === "turn.failed" || e.type === "session.failed") status = "failed";
  if (e.type === "turn.cancelled") status = "cancelled";
  if (e.type === "session.waiting") break;
}
console.log(`summarize: ${status}; deltas=${deltas} first=${first} ms last=${last} ms done=${ms()} ms; cached=${meta?.cached ?? "?"} model=${meta?.model ?? "?"} cost=$${cost.toFixed(5)}`);
const summary = parseSummaryText(final || buffer);
console.log("decision:", summary.decision);
console.log("overall:", summary.overall.slice(0, 200));
for (const f of summary.files) console.log(`  ${f.path} (${f.summary.length} chars): ${f.summary.slice(0, 100)}`);
const missing = files.filter((f) => !summary.files.some((s) => s.path === f.path)).map((f) => f.path);
console.log(`files summarised: ${summary.files.length}/${files.length}${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
process.exit(missing.length || !summary.overall || status !== "streaming" ? 1 : 0);
