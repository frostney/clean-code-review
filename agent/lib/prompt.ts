import { filesFromPatch, looksLikePatch } from './patch';
import { QUESTIONS } from './questions';
import {
  clampReview,
  partitionJudgeable,
  REVIEW_LIMITS,
  type ReviewFile,
  type ReviewInput,
} from './review';
import type { Answers } from './schema';

/**
 * The agent's standing instructions. Jev never reads a system prompt — each
 * question carries its own — so this describes the agent to eve's tooling
 * (Agent Runs, `eve info`) and to whoever opens the project.
 */
export function buildInstructions(): string {
  return [
    '# Clean Code Review',
    '',
    "This agent's model is Jev, TypeSafe AI's System One evaluation model, reached through the Vercel AI Gateway.",
    `A judge turn's user message is a review: up to ${REVIEW_LIMITS.maxFiles} files (whole files or per-file unified-diff hunks) of at most ${REVIEW_LIMITS.maxCharsPerFile} characters each, as JSON, or a single code snippet or diff as plain text. Every file is evaluated against the ${QUESTIONS.length} Clean Code questions in agent/lib/questions.ts in parallel, and the reply is a JSON payload of calibrated answers per file.`,
    "A summarize turn's user message carries the files and their judgments; the reviewer (Luna, through the AI Gateway) writes the prose review from those findings in parallel parts, and the turn streams the combined text as its reply.",
    'There is no conversation beyond these two turn kinds.',
    '',
    ...QUESTIONS.map((q) => `- ${q.id} (${q.type}): ${q.label}`),
  ].join('\n');
}

/** A judge turn: the review as JSON. */
export function judgeMessage(input: ReviewInput): string {
  return JSON.stringify({ kind: 'judge', ...clampReview(input) });
}

export interface SummarizeInput extends ReviewInput {
  /** Jev's answers per path, as the page holds them. */
  judgments: Record<string, Answers>;
  pr?: { title: string; body?: string; url?: string };
}

/** A summarize turn: files, their judgments, and the pull request if there is one. */
export function summarizeMessage(input: SummarizeInput): string {
  const clamped = clampReview(input);
  return JSON.stringify({
    files: clamped.files,
    judgments: input.judgments,
    kind: 'summarize',
    pr: input.pr,
  });
}

export type ParsedMessage =
  | { kind: 'judge'; input: ReviewInput }
  | { kind: 'summarize'; input: SummarizeInput }
  | { kind: 'other'; text: string };

/**
 * Read a user message back. JSON with a `kind` is the page's format; plain
 * text (the eve TUI, curl) is judged as one file, or as a diff when it looks
 * like one. Anything else — framework notifications about background tasks,
 * for instance — is "other" and gets a bare acknowledgement.
 */
/** The answers the page already has, when it sent any. */
function readJudgments(raw: unknown): Record<string, Answers> {
  return raw && typeof raw === 'object' ? (raw as Record<string, Answers>) : {};
}

/** The pull request a review came from, when the message names one. */
function readPullRequest(raw: unknown): SummarizeInput['pr'] {
  return raw &&
    typeof raw === 'object' &&
    typeof (raw as { title?: unknown }).title === 'string'
    ? (raw as SummarizeInput['pr'])
    : undefined;
}

/**
 * The page's own format: a JSON object naming a `kind` and the files. Null
 * when the text is not that — not JSON at all, or JSON without usable files —
 * which is what sends the caller on to the plain-text readings.
 */
function parseJsonMessage(trimmed: string): ParsedMessage | null {
  let raw: {
    kind?: unknown;
    files?: unknown;
    judgments?: unknown;
    pr?: unknown;
  };
  try {
    raw = JSON.parse(trimmed) as typeof raw;
  } catch {
    /* not JSON: fall through */
    return null;
  }
  const files = readFiles(raw.files);
  if (!files) {
    return null;
  }
  if (raw.kind === 'summarize') {
    return {
      input: {
        ...clampReview({ files }),
        judgments: readJudgments(raw.judgments),
        pr: readPullRequest(raw.pr),
      },
      kind: 'summarize',
    };
  }
  if (raw.kind === 'judge' || raw.kind === undefined) {
    return { input: clampReview({ files }), kind: 'judge' };
  }
  return null;
}

export function parseMessage(text: string): ParsedMessage {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const json = parseJsonMessage(trimmed);
    if (json) {
      return json;
    }
  }
  if (looksLikePatch(trimmed)) {
    return {
      input: clampReview({ files: filesFromPatch(trimmed) }),
      kind: 'judge',
    };
  }
  if (looksLikeCode(trimmed)) {
    return {
      input: clampReview({ files: [{ content: trimmed, path: 'snippet' }] }),
      kind: 'judge',
    };
  }
  return { kind: 'other', text: trimmed };
}

function readFiles(raw: unknown): ReviewFile[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const files = raw
    .filter(
      (f): f is { path: unknown; content: unknown; patch?: unknown } =>
        f !== null && typeof f === 'object',
    )
    .filter((f) => typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => ({
      content: f.content as string,
      path: f.path as string,
      ...(f.patch === true ? { patch: true } : {}),
    }));
  // The page applies the same rule; this is the guard for any other caller.
  return partitionJudgeable(files).judgeable;
}

/** A rough tell for code versus prose, so a framework notification is not judged as a snippet. */
function looksLikeCode(text: string): boolean {
  if (/^(\[Task state\]|Background task)/.test(text)) {
    return false;
  }
  return /[{};=()]|^\s*(def |class |import |function |const |let |var |public |fn |func )/m.test(
    text,
  );
}
