/**
 * The page's review pipeline in one request. Every step (PR cache key, file
 * opening, patch headers, `parseReview`) matches the page's, so the
 * content-keyed judge and review caches are shared in both directions.
 * No `next/headers`, React `cache` or `server-only`: scripts import this too.
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
  judgeEstimateUsd,
  judgeReview,
  judgeSettleUsd,
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
  reviewEstimateUsd,
  reviewSettleUsd,
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

// Same TTL and key as `src/pull-request/pull-request.tsx`, repeated because
// that module is server-only.
const PULL_REQUEST_CACHE_SECONDS = 60;

function storedBytes(pr: PullRequestReview): number {
  return Buffer.byteLength(JSON.stringify(pr));
}

// The reviewer has no timeout of its own, and a hung call holds the function
// open until the platform kills it.
const REVIEW_TIMEOUT_MS = 60_000;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
/** Where `14:00` sits in an ISO timestamp. */
const CLOCK_FROM = 11;
const CLOCK_TO = 16;

// Shared by all MCP callers across instances; the page has its own budget in
// `agent/lib/judging/jev-model.ts`.
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

/** `fetchPullRequest`'s user-facing messages; anything else is a fault and is not passed on. */
const GITHUB_MESSAGES =
  /^(Pull request not found|GitHub rate limit|GitHub returned \d+|That pull request's diff is too large|That is not a GitHub pull request)/;

interface Opened {
  review: OpenReview;
  /** Paths a pull request's diff names that the splitter dropped, with the reason. */
  dropped: { path: string; reason: NotJudgedReason }[];
  source: ReviewOutput['source'];
  pr?: { title: string; body: string; url: string };
  prFromCache: boolean | null;
  unlistedFiles: number;
}

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

function droppedReason(section: string, path: string): NotJudgedReason {
  if (/^\+\+\+ \/dev\/null/m.test(section)) {
    return 'deleted';
  }
  if (!/^@@ /m.test(section)) {
    return 'no_hunks';
  }
  return skipReason({ content: section, path }) ?? 'generated';
}

// The page shows these as a count; an agent gets the paths.
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
  const capped = selectReviewFiles(split).overCap.map((path) => ({
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

// Headers restored as `ReviewProvider` does, so the judge sees the page's bytes.
function sentFiles(review: OpenReview): ReviewFile[] {
  return review.files.map((file) => {
    const header = review.headers[file.path];
    if (!file.patch || !header || !file.content.trim()) {
      return file;
    }
    return { ...file, content: withPatchHeader(header, file.content) };
  });
}

const TOP_LEVEL = 4;

type LabelledAnswer = ReviewOutput['files'][number]['answers'][string];

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

/** The gateway reports costs to six decimals. */
const COST_PRECISION = 1e6;
const usd = (n: number) => Math.round(n * COST_PRECISION) / COST_PRECISION;

/**
 * Reserved separately: Luna is most of a call's cost, and Jev's answers are
 * returned even when the budget cannot cover her. Spend is settled on every path.
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
        /* Not streamed: the text is read once complete. */
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
    await admission.hold.settle(reviewSettleUsd(usage));
  }
}

function cutOffWhat(files: number, overall: boolean): string {
  const paragraphs = `the paragraphs marked reviewIncomplete (${files})`;
  if (files && overall) {
    return `the overall paragraph and ${paragraphs} are`;
  }
  return files ? `${paragraphs} are` : 'the overall paragraph is';
}

async function reviewOpened(
  opened: Opened,
  signal: AbortSignal,
  started: number,
): Promise<ReviewOutput> {
  const sent = sentFiles(opened.review);
  // As the page's judge turn: no prose, no empty files.
  const code = sent
    .filter((f) => !isProsePath(f.path) && f.content.trim())
    .slice(0, REVIEW_LIMITS.maxFiles);
  const empty = sent
    .filter((f) => !(isProsePath(f.path) || f.content.trim()))
    .map((f) => ({ path: f.path, reason: 'empty' as const }));
  if (!code.length) {
    throw new ReviewError('Nothing in that input is code to judge.');
  }

  // Estimates uncached files only, so a fully cached review is always served.
  const admission = await spend.reserve(await judgeEstimateUsd(code));
  if (!admission.ok) {
    throw new ReviewError(budgetSpent(admission));
  }

  let judged: Awaited<ReturnType<typeof judgeReview>>;
  try {
    judged = await judgeReview({ files: code }, signal);
  } catch (err) {
    // Only a JudgeFailedError settles at its real (often zero) cost; any other
    // fault keeps the reservation.
    if (err instanceof JudgeFailedError) {
      await admission.hold.settle(err.spentUsd);
    }
    throw new ReviewError(
      'Jev could not judge any of these files. Try again in a minute.',
    );
  }
  await admission.hold.settle(judgeSettleUsd(judged));
  // Parsed as the page parses a judge turn, so review-part cache keys match.
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
