/**
 * One Clean Code review, start to finish, for a caller without a browser.
 *
 * The page runs a review as two agent turns driven from a browser tab; the MCP
 * endpoint runs the same functions in one request. Every step is the page's
 * own: the pull request is fetched through the same one-minute cache under the
 * same key, the files are opened by `src/review/open-review.ts` exactly as the page
 * opens them, a patch gets its headers back the way `ReviewProvider` puts them
 * back, and the answers are read back through `parseReview` as the page reads
 * them. That is what makes the judge and review-part caches, which are keyed on
 * content, shared in both directions: a pull request reviewed here comes back
 * from the cache on the page, and the other way round.
 *
 * Nothing here imports `next/headers`, React's `cache` or `server-only`, so it
 * runs inside a route handler and from a script alike.
 */

import {
  fetchPullRequest,
  NOT_A_PULL_REQUEST,
  type PullRequestReview,
  parsePullRequest,
} from '@/agent/lib/github/github';
import { cached, cacheKey } from '@/agent/lib/infra/cache';
import {
  JudgeFailedError,
  judgeChargeUsd,
  judgeEstimateUsd,
  judgeReview,
} from '@/agent/lib/judging/judge';
import { filesFromPatch } from '@/agent/lib/judging/patch';
import { GROUPS, questionById } from '@/agent/lib/judging/questions';
import { type Answers, parseReview } from '@/agent/lib/judging/schema';
import { selectReviewFiles } from '@/agent/lib/judging/select';
import {
  isProsePath,
  REVIEW_LIMITS,
  type ReviewFile,
  skipReason,
} from '@/agent/lib/review/review';
import {
  emptyReviewUsage,
  planReview,
  reviewChargeUsd,
  reviewEstimateUsd,
  runReview,
} from '@/agent/lib/review/reviewer';
import { parseSummaryText, REVIEWER_MODEL } from '@/agent/lib/review/summary';
import {
  dollars,
  MCP_DAILY_BUDGET_USD,
  MCP_HOURLY_BUDGET_USD,
} from '@/agent/lib/spend/budgets';
import { createSpendBrake, type SpendRefusal } from '@/agent/lib/spend/spend';
import { pullRequestPath } from '@/src/pull-request/address';
import { withPatchHeader } from '@/src/review/diff';
import {
  cappedText,
  fromPaste,
  fromPullRequest,
  type OpenReview,
} from '@/src/review/open-review';
import { filesFromPaste, uniquePaths } from '@/src/review/paste';
import { SITE } from '@/src/site/site';

import type { NotJudgedReason, ReviewOutput } from './mcp-result';

/** A review that could not be made, with the reason in words an agent can act on. */
export class ReviewError extends Error {
  override readonly name = 'ReviewError';
}

/**
 * The page's pull request cache: a minute, under `cacheKey('pull-request',
 * canonical URL)`. `src/pull-request/pull-request.tsx` holds the same two facts; they are
 * repeated here rather than imported because that module is server-only React.
 */
const PULL_REQUEST_CACHE_SECONDS = 60;

/** What the pull request would weigh in the cache, as `src/pull-request/pull-request.tsx` measures it. */
function storedBytes(pr: PullRequestReview): number {
  return Buffer.byteLength(JSON.stringify(pr));
}

/**
 * How long Luna may take over the written review. Jev has its own timeout and
 * retry per file; the reviewer has none of its own, and a call that waits on it
 * forever holds a function open until the platform ends it.
 */
const REVIEW_TIMEOUT_MS = 60_000;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
/** Where `14:00` sits in an ISO timestamp. */
const CLOCK_FROM = 11;
const CLOCK_TO = 16;

/**
 * Every caller of this endpoint together, per hour and per UTC day, across
 * every instance: see `agent/lib/spend/spend.ts`. The page's reviews count against
 * a budget of their own, in `agent/lib/judging/jev-model.ts`.
 */
const spend = createSpendBrake('mcp', {
  dayUsd: MCP_DAILY_BUDGET_USD,
  hourUsd: MCP_HOURLY_BUDGET_USD,
});

/** `in 23 minutes`, `in 5 hours 3 minutes`. */
function until(when: Date, now: Date): string {
  const minutes = Math.max(
    1,
    Math.ceil((when.getTime() - now.getTime()) / MS_PER_MINUTE),
  );
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  const parts = [
    hours ? `${hours} hour${hours === 1 ? '' : 's'}` : '',
    rest ? `${rest} minute${rest === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `in ${parts.join(' ')}`;
}

/** Why the budget says no, and when to come back, in words an agent can act on. */
function budgetSpent(check: SpendRefusal): string {
  const now = new Date();
  const at = check.resetsAt.toISOString().slice(CLOCK_FROM, CLOCK_TO);
  if (check.window === 'unavailable') {
    return `This endpoint cannot read its model budget right now, so it is not starting new model work. Call again ${until(check.resetsAt, now)}; a review whose answers are all cached is served meanwhile.`;
  }
  const window = check.window === 'hour' ? 'this hour' : 'today (UTC)';
  const per = check.window === 'hour' ? 'per hour' : 'per UTC day';
  return `This endpoint's model budget for ${window} is spent: ${dollars(check.capUsd)} ${per}, shared by every caller. It resets at ${at} UTC, ${until(check.resetsAt, now)}. Call again after that; a review whose answers are all cached is served even while the budget is spent.`;
}

/** The messages `fetchPullRequest` writes for a person. Anything else is a fault, not a reason. */
const GITHUB_MESSAGES =
  /^(Pull request not found|GitHub rate limit|GitHub returned \d+|That pull request's diff is too large|That is not a GitHub pull request)/;

/** Where the review comes from, and the files as the page opened them. */
interface Opened {
  review: OpenReview;
  /** Paths a pull request's diff names that the splitter dropped, with the reason. */
  dropped: { path: string; reason: NotJudgedReason }[];
  source: ReviewOutput['source'];
  pr?: { title: string; body: string; url: string };
  prFromCache: boolean | null;
  unlistedFiles: number;
}

/** The pull request, from the page's own one-minute cache or from GitHub. */
async function fetchCachedPullRequest(
  input: string,
): Promise<{ pr: PullRequestReview; hit: boolean; url: string }> {
  const ref = parsePullRequest(input);
  if (!ref) {
    throw new ReviewError(NOT_A_PULL_REQUEST);
  }
  try {
    const { value, hit } = await cached(
      cacheKey('pull-request', ref.url),
      'pull request',
      () => fetchPullRequest(ref.url),
      PULL_REQUEST_CACHE_SECONDS,
      storedBytes,
    );
    return { hit, pr: value, url: ref.url };
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    throw new ReviewError(
      GITHUB_MESSAGES.test(message)
        ? message
        : 'Could not fetch that pull request from GitHub. Try again in a minute.',
    );
  }
}

/** One `diff --git` section's target path, or null when it names none. */
function sectionPath(section: string): string | null {
  const target = /^\+\+\+ (?:b\/)?([^\t\n]+)/m.exec(section)?.[1]?.trim();
  const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
  return target === '/dev/null'
    ? (header?.[1] ?? null)
    : target || header?.[2] || null;
}

/** Why the diff splitter left one section out. */
function droppedReason(section: string, path: string): NotJudgedReason {
  if (/^\+\+\+ \/dev\/null/m.test(section)) {
    return 'deleted';
  }
  if (!/^@@ /m.test(section)) {
    return 'no_hunks';
  }
  return skipReason({ content: section, path }) ?? 'generated';
}

/**
 * Every file the pull request's diff names that `filesFromPatch` did not turn
 * into a file, with the reason. The page reports these as a bare count; an
 * agent gets the paths.
 */
function droppedFromDiff(
  diff: string,
  kept: readonly ReviewFile[],
): { dropped: Opened['dropped']; sections: number } {
  const keptPaths = new Set(kept.map((f) => f.path));
  const sections = diff
    .replace(/\r\n?/g, '\n')
    .split(/^(?=diff --git )/m)
    .filter((s) => s.startsWith('diff --git '));
  const dropped: Opened['dropped'] = [];
  for (const section of sections) {
    const path = sectionPath(section);
    if (path && !keptPaths.has(path)) {
      dropped.push({ path, reason: droppedReason(section, path) });
    }
  }
  return { dropped, sections: sections.length };
}

/** A public pull request, opened the way the page opens one. */
async function openPullRequest(input: string): Promise<Opened> {
  const { pr, hit, url } = await fetchCachedPullRequest(input);
  const review = fromPullRequest(
    {
      avatarUrl: pr.avatarUrl,
      body: null,
      bodyText: pr.body,
      changedFiles: pr.changedFiles,
      diff: pr.diff,
      title: pr.title,
      url: pr.url,
    },
    'mcp',
  );
  const split = filesFromPatch(pr.diff);
  const { dropped, sections } = droppedFromDiff(pr.diff, split);
  const capped = selectReviewFiles(split).dropped.map((path) => ({
    path,
    reason: isProsePath(path)
      ? ('over_prose_cap' as const)
      : ('over_code_cap' as const),
  }));
  if (!review) {
    throw new ReviewError(
      'Nothing in that pull request is code to judge: every file it changes is prose, generated, binary or deleted.',
    );
  }
  return {
    dropped: [...dropped, ...capped],
    pr: { body: pr.body, title: pr.title, url: pr.url },
    prFromCache: hit,
    review,
    source: {
      changedFiles: pr.changedFiles,
      kind: 'pull_request',
      permalink: `${SITE.url}${pullRequestPath(url) ?? ''}`,
      title: pr.title,
      url: pr.url,
    },
    unlistedFiles: Math.max(0, pr.changedFiles - sections),
  };
}

/** A paste, opened the way the page's paste dialog opens one. */
function openPaste(text: string): Opened {
  const review = fromPaste(text, 'mcp');
  if (!review) {
    throw new ReviewError('The paste holds no code to judge.');
  }
  const shown = new Set(review.files.map((f) => f.path));
  const unique = uniquePaths(
    filesFromPaste(text).filter((f) => skipReason(f) === null),
  );
  const capped = unique
    .filter((f) => !shown.has(f.path))
    .map((f) => ({
      path: f.path,
      reason: isProsePath(f.path)
        ? ('over_prose_cap' as const)
        : ('over_code_cap' as const),
    }));
  return {
    dropped: [
      ...review.skipped.map((s) => ({ path: s.path, reason: s.reason })),
      ...capped,
    ],
    prFromCache: null,
    review,
    source: { kind: 'paste' },
    unlistedFiles: 0,
  };
}

/**
 * The files as they reach the agent: a patch with its headers put back on, as
 * `ReviewProvider` sends it, so the judge sees byte for byte what the page's
 * judge turn would have sent.
 */
function sentFiles(review: OpenReview): ReviewFile[] {
  return review.files.map((file) => {
    const header = review.headers[file.path];
    if (!file.patch || !header || !file.content.trim()) {
      return file;
    }
    return { ...file, content: withPatchHeader(header, file.content) };
  });
}

/** The top of each scale, so a fractional score names a level. */
const TOP_LEVEL = 4;

type LabelledAnswer = ReviewOutput['files'][number]['answers'][string];

/** One of Jev's answers, labelled as the page labels its row. Null for a row no question owns. */
function labelledAnswer(id: string, a: Answers[string]): LabelledAnswer | null {
  const q = questionById(id);
  if (!q) {
    return null;
  }
  const group = GROUPS.find((g) => g.id === q.group)?.title ?? q.group;
  if (a.type === 'noul') {
    return { group, label: q.label, probability: a.noul, type: 'noul' };
  }
  if (a.type !== 'score' || q.type !== 'score') {
    return null;
  }
  return {
    group,
    label: q.label,
    level: q.levels[Math.max(0, Math.min(TOP_LEVEL, Math.round(a.score)))],
    levels: [...q.levels],
    score: a.score,
    type: 'score',
    ...(a.probabilities ? { probabilities: a.probabilities } : {}),
    ...(a.confidence === undefined ? {} : { confidence: a.confidence }),
  };
}

/** Jev's answers for one file, keyed by question id. */
function labelled(answers: Answers): Record<string, LabelledAnswer> {
  const out: Record<string, LabelledAnswer> = {};
  for (const [id, a] of Object.entries(answers)) {
    const row = labelledAnswer(id, a);
    if (row) {
      out[id] = row;
    }
  }
  return out;
}

/** Rounded to the precision the gateway reports costs in. */
const COST_PRECISION = 1e6;
const usd = (n: number) => Math.round(n * COST_PRECISION) / COST_PRECISION;

/**
 * Luna's written review, or the reason there is none. Reserved for separately,
 * because Luna is most of a call's cost and Jev's answers may have spent the
 * rest of the budget; Jev's answers are returned either way. Whatever the
 * parts cost, finished, failed or cut off by the timeout, is settled.
 */
async function writeReview(
  input: Parameters<typeof planReview>[0],
  signal: AbortSignal,
): Promise<{
  summary: ReturnType<typeof parseSummaryText> | null;
  usage: { cached: boolean; costUsd: number };
  notice?: string;
}> {
  const none = { summary: null, usage: { cached: false, costUsd: 0 } };
  const plan = await planReview(input);
  const admission = await spend.reserve(reviewEstimateUsd(plan));
  if (!admission.ok) {
    return {
      ...none,
      notice: `Luna's written review was not started. ${budgetSpent(admission)} Jev's answers are complete.`,
    };
  }
  const timeout = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
  const usage = emptyReviewUsage();
  try {
    const written = await runReview(
      plan,
      () => {
        /* One request, one reply: the whole text is read once it is done. */
      },
      AbortSignal.any([signal, timeout]),
      usage,
    );
    return { summary: parseSummaryText(written.text), usage: written.usage };
  } catch {
    if (signal.aborted) {
      throw new ReviewError('The call was cancelled.');
    }
    const retry =
      "Jev's answers are complete. Call again to retry: the answers come back from the cache.";
    return {
      ...none,
      notice: timeout.aborted
        ? `The written review did not finish within ${REVIEW_TIMEOUT_MS / MS_PER_SECOND} seconds. ${retry}`
        : `Luna could not write the review: the model call failed. ${retry}`,
    };
  } finally {
    await admission.hold.settle(reviewChargeUsd(usage));
  }
}

/** What a cut-off notice names: the file paragraphs, the overall paragraph, or both. */
function cutOffWhat(files: number, overall: boolean): string {
  const paragraphs = `the paragraphs marked reviewIncomplete (${files})`;
  if (files && overall) {
    return `the overall paragraph and ${paragraphs} are`;
  }
  return files ? `${paragraphs} are` : 'the overall paragraph is';
}

/** Judge the opened files, write the review, and put it all in one result. */
async function reviewOpened(
  opened: Opened,
  signal: AbortSignal,
  started: number,
): Promise<ReviewOutput> {
  const sent = sentFiles(opened.review);
  // What the page's judge turn sends: code, never prose, never an empty file.
  const code = sent
    .filter((f) => !isProsePath(f.path) && f.content.trim())
    .slice(0, REVIEW_LIMITS.maxFiles);
  const empty = sent
    .filter((f) => !(isProsePath(f.path) || f.content.trim()))
    .map((f) => ({ path: f.path, reason: 'empty' as const }));
  if (!code.length) {
    throw new ReviewError('Nothing in that input is code to judge.');
  }

  // Reserved before any model work, for the files the cache has no answers
  // for. A review that is wholly cached reserves nothing and is always served.
  const admission = await spend.reserve(await judgeEstimateUsd(code));
  if (!admission.ok) {
    throw new ReviewError(budgetSpent(admission));
  }

  let judged: Awaited<ReturnType<typeof judgeReview>>;
  try {
    judged = await judgeReview({ files: code }, signal);
  } catch (err) {
    // Every file failed: settled at what those attempts plausibly cost, which
    // is nothing for a gateway that turned them away. Anything else is a
    // fault here, and keeps the reservation.
    if (err instanceof JudgeFailedError) {
      await admission.hold.settle(err.spentUsd);
    }
    throw new ReviewError(
      'Jev could not judge any of these files. Try again in a minute.',
    );
  }
  await admission.hold.settle(judgeChargeUsd(judged));
  // Read back exactly as the page reads a judge turn's reply, so the answers
  // Luna is given, and the review-part cache keys made from them, match.
  const answers =
    parseReview(JSON.stringify({ kind: 'judged', ...judged.result }))?.files ??
    {};
  const summarized = code.filter(
    (f) => Object.keys(answers[f.path]?.answers ?? {}).length,
  );
  const failed = code
    .filter((f) => !summarized.includes(f))
    .map((f) => ({ path: f.path, reason: 'judge_failed' as const }));

  const notices = [cappedText(opened.review)].filter(
    (n): n is string => n !== null,
  );
  const reviewInput = {
    files: summarized,
    judgments: Object.fromEntries(
      summarized.map((f) => [f.path, answers[f.path]?.answers ?? {}]),
    ),
    pr: opened.pr,
  };
  const written = await writeReview(reviewInput, signal);
  if (written.notice) {
    notices.push(written.notice);
  }
  const { summary, usage: review } = written;

  const paragraphs = new Map(summary?.files.map((f) => [f.path, f.summary]));
  const cutOff = new Set(
    summary?.files.filter((f) => f.incomplete).map((f) => f.path),
  );
  if (cutOff.size || summary?.overallIncomplete) {
    notices.push(
      `Luna ran into its output limit twice on part of this review, so ${cutOffWhat(
        cutOff.size,
        summary?.overallIncomplete === true,
      )} as far as it got. That part is not cached: call again to have it written afresh.`,
    );
  }
  const files = summarized.map((f) => ({
    answers: labelled(answers[f.path]?.answers ?? {}),
    cached: judged.result.files[f.path]?.cached === true,
    kind: f.patch ? ('diff' as const) : ('file' as const),
    path: f.path,
    review: paragraphs.get(f.path) || null,
    reviewIncomplete: cutOff.has(f.path),
    truncated: opened.review.truncated[f.path] === true,
  }));
  return {
    cache: {
      judgedFromCache: files.filter((f) => f.cached).length,
      pullRequest: opened.prFromCache,
      review: summary !== null && review.cached,
    },
    costUsd: {
      judge: usd(judged.cost),
      review: usd(review.costUsd),
      total: usd(judged.cost + review.costUsd),
    },
    decision: summary ? summary.decision : null,
    files,
    models: { judge: judged.result.model, reviewer: REVIEWER_MODEL },
    ms: Math.round(performance.now() - started),
    notices,
    notJudged: [...opened.dropped, ...empty, ...failed],
    overall: summary?.overall || null,
    overallIncomplete: summary?.overallIncomplete === true,
    prose: opened.review.files
      .filter((f) => isProsePath(f.path))
      .map((f) => ({
        path: f.path,
        truncated: opened.review.truncated[f.path] === true,
      })),
    source: opened.source,
    unlistedFiles: opened.unlistedFiles,
  };
}

/** Review a public GitHub pull request. Throws `ReviewError` with a reason an agent can act on. */
export async function reviewPullRequest(
  url: string,
  signal: AbortSignal,
): Promise<ReviewOutput> {
  const started = performance.now();
  return reviewOpened(await openPullRequest(url), signal, started);
}

/** Review pasted code: a unified diff, one file, or files marked with `// file:` lines. */
export async function reviewPaste(
  text: string,
  signal: AbortSignal,
): Promise<ReviewOutput> {
  const started = performance.now();
  return reviewOpened(openPaste(text), signal, started);
}
