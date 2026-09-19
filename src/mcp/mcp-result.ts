// Every file not judged is listed with its reason: a review that silently
// leaves files out reads as a review of the whole change.
import { z } from 'zod';

const probability = z.number().min(0).max(1);

const noulAnswer = z.object({
  group: z
    .string()
    .describe('The Clean Code chapter this question belongs to.'),
  label: z.string().describe('The question, as the page labels its row.'),
  probability: probability.describe(
    'Probability that the statement in the label is true. Every yes/no question is phrased so that yes is a finding; at 0.5 or more the page lights the row.',
  ),
  type: z.literal('noul'),
});

const scoreAnswer = z.object({
  confidence: probability
    .optional()
    .describe("Jev's own certainty in this score, when it reported one."),
  group: z
    .string()
    .describe('The Clean Code chapter this question belongs to.'),
  label: z.string().describe('The question, as the page labels its row.'),
  level: z
    .string()
    .describe('The level the score rounds to, in words from `levels`.'),
  levels: z
    .array(z.string())
    .describe('The five levels of this scale, from 0 to 4.'),
  probabilities: z
    .record(z.string(), z.number())
    .optional()
    .describe(
      'The distribution the score was taken from, keyed by level index "0" to "4" (see `levels`).',
    ),
  score: z
    .number()
    .describe('Position on the five-level scale, 0 to 4, fractions allowed.'),
  type: z.literal('score'),
});

const judgedFile = z.object({
  answers: z
    .record(z.string(), z.discriminatedUnion('type', [noulAnswer, scoreAnswer]))
    .describe(
      'Every answer Jev gave for this file, keyed by question id. Rows that do not apply to a file are absent: the Boy Scout row is asked of diffs only, the test row of test files only.',
    ),
  cached: z
    .boolean()
    .describe(
      "True when Jev's answers came from the one-hour cache rather than a fresh evaluation.",
    ),
  kind: z
    .enum(['diff', 'file'])
    .describe(
      'A diff is judged as the code after the change, with the change beside it.',
    ),
  path: z.string(),
  review: z
    .string()
    .nullable()
    .describe("Luna's paragraph on this file, or null when none was written."),
  reviewIncomplete: z
    .boolean()
    .describe(
      "True when Luna's paragraph on this file was cut off: its part ran into its output ceiling twice, so `review` is as far as it got, or null when it got no further than the file before.",
    ),
  truncated: z
    .boolean()
    .describe(
      'True when the file was cut to the per-file character cap before it was judged.',
    ),
});

const NOT_JUDGED_REASONS = [
  'binary',
  'generated',
  'no_hunks',
  'deleted',
  'empty',
  'over_code_cap',
  'over_prose_cap',
  'judge_failed',
] as const;

export type NotJudgedReason = (typeof NOT_JUDGED_REASONS)[number];

const NOT_JUDGED_TEXT: Record<NotJudgedReason, string> = {
  binary: 'an image or binary file',
  deleted: 'deleted by the change, so there is no code after it to judge',
  empty: 'empty',
  generated: 'a lockfile, bundle, snapshot or other generated file',
  judge_failed: 'Jev did not answer for it',
  no_hunks: 'no changed lines: a binary, a pure rename or a mode change',
  over_code_cap: 'past the cap on code files per review',
  over_prose_cap: 'past the cap on prose files per review',
};

const pullRequestSource = z.object({
  changedFiles: z
    .number()
    .describe('Files GitHub reports the pull request touches.'),
  kind: z.literal('pull_request'),
  permalink: z
    .string()
    .describe(
      'Where the same review opens in a browser, as a link worth sending to a person.',
    ),
  title: z.string(),
  url: z.string().describe('The pull request on GitHub.'),
});

const pasteSource = z.object({
  kind: z.literal('paste'),
});

export const reviewOutputSchema = z.object({
  cache: z
    .object({
      judgedFromCache: z
        .number()
        .describe("How many files' answers came from the cache."),
      pullRequest: z
        .boolean()
        .nullable()
        .describe(
          'True when the pull request came from the one-minute cache rather than from GitHub. Null for a paste.',
        ),
      review: z
        .boolean()
        .describe(
          'True when every part of the written review came from the cache.',
        ),
    })
    .describe(
      'What was answered from the cache instead of being computed again.',
    ),
  costUsd: z
    .object({
      judge: z.number(),
      review: z.number(),
      total: z.number(),
    })
    .describe(
      'What this call cost at the AI Gateway, in US dollars. Cached work costs nothing.',
    ),
  decision: z
    .enum(['approve', 'comment', 'request_changes'])
    .nullable()
    .describe(
      "Luna's decision for the whole change, or null when the review was not written.",
    ),
  files: z
    .array(judgedFile)
    .describe('Every judged code file, in the order of the change.'),
  models: z.object({
    judge: z.string().describe('The model that answered the questions.'),
    reviewer: z.string().describe('The model that wrote the review.'),
  }),
  ms: z
    .number()
    .describe('Wall time of the call on the server, in milliseconds.'),
  notices: z
    .array(z.string())
    .describe(
      'Anything a reader should know about this review, in words: caps applied, a review that did not finish.',
    ),
  notJudged: z
    .array(
      z.object({
        path: z.string(),
        reason: z.enum(NOT_JUDGED_REASONS),
      }),
    )
    .describe('Files of the input that were not judged, and why.'),
  overall: z
    .string()
    .nullable()
    .describe(
      "Luna's overall paragraph, or null when the review was not written.",
    ),
  overallIncomplete: z
    .boolean()
    .describe(
      'True when the overall paragraph was cut off at its output ceiling twice, so `overall` is as far as it got.',
    ),
  prose: z
    .array(z.object({ path: z.string(), truncated: z.boolean() }))
    .describe(
      'Markdown, plain text and other prose files. The page shows them beside the review; none of the questions is about prose, so they are never judged or sent to a model.',
    ),
  source: z.discriminatedUnion('kind', [pullRequestSource, pasteSource]),
  unlistedFiles: z
    .number()
    .describe(
      'Files GitHub counts in the pull request that its diff does not show at all. Always 0 for a paste.',
    ),
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
type JudgedFile = ReviewOutput['files'][number];
type AnswerOutput = JudgedFile['answers'][string];

const PERCENT = 100;
const percent = (p: number) => `${Math.round(p * PERCENT)}%`;

/** Same finding threshold as the page. */
const EVEN_ODDS = 0.5;

const COST_DIGITS = 4;

function answerLine(id: string, a: AnswerOutput): string {
  if (a.type === 'noul') {
    return `${id} (${a.label}): ${percent(a.probability)}`;
  }
  const spread = a.probabilities
    ? `; ${Object.entries(a.probabilities)
        .map(([level, p]) => `${level} ${percent(p)}`)
        .join(', ')}`
    : '';
  return `${id} (${a.label}): ${a.level}, score ${a.score.toFixed(2)}${spread}`;
}

function fileText(file: JudgedFile): string {
  const entries = Object.entries(file.answers);
  const findings = entries
    .filter(([, a]) => a.type === 'noul' && a.probability >= EVEN_ODDS)
    .sort(
      ([, a], [, b]) =>
        (b.type === 'noul' ? b.probability : 0) -
        (a.type === 'noul' ? a.probability : 0),
    );
  const scales = entries.filter(([, a]) => a.type === 'score');
  const rest = entries.filter(
    ([, a]) => a.type === 'noul' && a.probability < EVEN_ODDS,
  );
  const flags = [
    file.kind,
    file.cached ? 'answers from cache' : null,
    file.truncated ? 'truncated' : null,
    file.reviewIncomplete ? 'review cut off' : null,
  ].filter(Boolean);
  return [
    `### ${file.path} (${flags.join(', ')})`,
    file.review ?? '(No paragraph was written for this file.)',
    '',
    `Findings: ${findings.length ? '' : 'none at even odds or better.'}`,
    ...findings.map(([id, a]) => `- ${answerLine(id, a)}`),
    'Scales:',
    ...scales.map(([id, a]) => `- ${answerLine(id, a)}`),
    `Other answers: ${rest.map(([id, a]) => answerLine(id, a)).join('; ') || 'none.'}`,
  ].join('\n');
}

function sourceText(result: ReviewOutput): string[] {
  if (result.source.kind === 'paste') {
    return ['# Clean Code review of pasted code'];
  }
  return [
    `# Clean Code review: ${result.source.title}`,
    `Pull request: ${result.source.url}`,
    `Permalink: ${result.source.permalink}`,
  ];
}

function leftOutText(result: ReviewOutput): string[] {
  const lines: string[] = [];
  if (result.prose.length) {
    lines.push(
      '## Prose, shown and not judged',
      ...result.prose.map(
        (p) => `- ${p.path}${p.truncated ? ' (truncated)' : ''}`,
      ),
    );
  }
  if (result.notJudged.length || result.unlistedFiles) {
    lines.push(
      '## Not judged',
      ...result.notJudged.map(
        (f) => `- ${f.path}: ${NOT_JUDGED_TEXT[f.reason]}`,
      ),
      ...(result.unlistedFiles
        ? [
            `- ${result.unlistedFiles} more files GitHub counts that the diff does not show.`,
          ]
        : []),
    );
  }
  return lines;
}

/** For clients that read only text content. */
export function renderReviewText(result: ReviewOutput): string {
  return [
    ...sourceText(result),
    '',
    `Decision: ${result.decision ?? 'none (the review was not written)'}`,
    '',
    '## Overall',
    result.overall ?? '(The overall paragraph was not written.)',
    ...(result.overallIncomplete
      ? ['(Cut off: this paragraph is as far as Luna got.)']
      : []),
    '',
    ...result.notices.map((n) => `Note: ${n}`),
    '## Files',
    ...result.files.map(fileText),
    '',
    ...leftOutText(result),
    '',
    `Models: ${result.models.judge} judged, ${result.models.reviewer} wrote the review.`,
    `Cost: $${result.costUsd.total.toFixed(COST_DIGITS)} (judge $${result.costUsd.judge.toFixed(COST_DIGITS)}, review $${result.costUsd.review.toFixed(COST_DIGITS)}). ${result.cache.judgedFromCache} of ${result.files.length} files answered from cache; review ${result.cache.review ? 'from cache' : 'written fresh'}. ${result.ms} ms.`,
  ].join('\n');
}
