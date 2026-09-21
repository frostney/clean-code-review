import { filesFromPatch, looksLikePatch } from '../judging/patch';
import { QUESTIONS } from '../judging/questions';
import type { Answers } from '../judging/schema';
import {
  clampReview,
  MAX_JUDGED_CHARS,
  partitionJudgeable,
  REVIEW_LIMITS,
  type ReviewFile,
  type ReviewInput,
} from './review';

/**
 * Jev never reads a system prompt (each question carries its own), so this is
 * only for eve's tooling (Agent Runs, `eve info`) and human readers.
 */
export function buildInstructions(): string {
  return [
    '# Clean Code Review',
    '',
    "This agent's model is Jev, TypeSafe AI's System One evaluation model, reached through the Vercel AI Gateway.",
    `A judge turn's user message is a review: up to ${REVIEW_LIMITS.maxFiles} files (whole files or per-file unified-diff hunks) of at most ${REVIEW_LIMITS.maxCharsPerFile} characters each, as JSON, or a single code snippet or diff as plain text. Every file is evaluated against the ${QUESTIONS.length} Clean Code questions in agent/lib/judging/questions.ts in parallel, and the reply is a JSON payload of calibrated answers per file.`,
    "A summarize turn's user message carries the files and their judgments; the reviewer (Luna, through the AI Gateway) writes the prose review from those findings in parallel parts, and the turn streams the combined text as its reply.",
    'Images, binaries and generated files are left out on both sides, and prose files (markdown, text, reStructuredText, AsciiDoc) are shown with a review but never judged: the questions are about code.',
    'There is no conversation beyond these two turn kinds.',
    '',
    ...QUESTIONS.map((q) => `- ${q.id} (${q.type}): ${q.label}`),
  ].join('\n');
}

export function judgeMessage(input: ReviewInput): string {
  return JSON.stringify({
    kind: 'judge',
    ...clampReview(input, MAX_JUDGED_CHARS),
  });
}

export interface SummarizeInput extends ReviewInput {
  judgments: Record<string, Answers>;
  pr?: { title: string; body?: string; url?: string };
}

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

function readJudgments(raw: unknown): Record<string, Answers> {
  return raw && typeof raw === 'object' ? (raw as Record<string, Answers>) : {};
}

function readPullRequest(raw: unknown): SummarizeInput['pr'] {
  return raw &&
    typeof raw === 'object' &&
    typeof (raw as { title?: unknown }).title === 'string'
    ? (raw as SummarizeInput['pr'])
    : undefined;
}

/** Null when not JSON or without usable files, so the caller tries the plain-text readings. */
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
    return { input: clampReview({ files }, MAX_JUDGED_CHARS), kind: 'judge' };
  }
  return null;
}

/**
 * Plain text (eve TUI, curl) is judged as a snippet or diff. Anything else,
 * such as framework notifications about background tasks, is `other`.
 */
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
      input: clampReview({ files: filesFromPatch(trimmed) }, MAX_JUDGED_CHARS),
      kind: 'judge',
    };
  }
  if (looksLikeCode(trimmed)) {
    return {
      input: clampReview(
        { files: [{ content: trimmed, path: 'snippet' }] },
        MAX_JUDGED_CHARS,
      ),
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
  // Guards callers other than the page; prose is dropped because it is never judged.
  return partitionJudgeable(files).judgeable;
}

/** Keeps framework notifications from being judged as snippets. */
function looksLikeCode(text: string): boolean {
  if (/^(\[Task state\]|Background task)/.test(text)) {
    return false;
  }
  return /[{};=()]|^\s*(def |class |import |function |const |let |var |public |fn |func )/m.test(
    text,
  );
}
