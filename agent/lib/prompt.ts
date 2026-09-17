import { filesFromPatch, looksLikePatch } from "./patch";
import { QUESTIONS } from "./questions";
import { clampReview, partitionJudgeable, REVIEW_LIMITS, type ReviewFile, type ReviewInput } from "./review";
import type { Answers } from "./schema";

/**
 * The agent's standing instructions. Jev never reads a system prompt — each
 * question carries its own — so this describes the agent to eve's tooling
 * (Agent Runs, `eve info`) and to whoever opens the project.
 */
export function buildInstructions(): string {
  return [
    "# Clean Code Review",
    "",
    "This agent's model is Jev, TypeSafe AI's System One evaluation model, reached through the Vercel AI Gateway.",
    `A judge turn's user message is a review: up to ${REVIEW_LIMITS.maxFiles} files (whole files or per-file unified-diff hunks) of at most ${REVIEW_LIMITS.maxCharsPerFile} characters each, as JSON, or a single code snippet or diff as plain text. Every file is evaluated against the ${QUESTIONS.length} Clean Code questions in agent/lib/questions.ts in parallel, and the reply is a JSON payload of calibrated answers per file.`,
    "A summarize turn's user message carries the files and their judgments; the reviewer (Luna, through the AI Gateway) writes the prose review from those findings in parallel parts, and the turn streams the combined text as its reply.",
    "There is no conversation beyond these two turn kinds.",
    "",
    ...QUESTIONS.map((q) => `- ${q.id} (${q.type}): ${q.label}`),
  ].join("\n");
}

/** A judge turn: the review as JSON. */
export function judgeMessage(input: ReviewInput): string {
  return JSON.stringify({ kind: "judge", ...clampReview(input) });
}

export interface SummarizeInput extends ReviewInput {
  /** Jev's answers per path, as the page holds them. */
  judgments: Record<string, Answers>;
  pr?: { title: string; body?: string; url?: string };
}

/** A summarize turn: files, their judgments, and the pull request if there is one. */
export function summarizeMessage(input: SummarizeInput): string {
  const clamped = clampReview(input);
  return JSON.stringify({ kind: "summarize", files: clamped.files, judgments: input.judgments, pr: input.pr });
}

export type ParsedMessage =
  | { kind: "judge"; input: ReviewInput }
  | { kind: "summarize"; input: SummarizeInput }
  | { kind: "other"; text: string };

/**
 * Read a user message back. JSON with a `kind` is the page's format; plain
 * text (the eve TUI, curl) is judged as one file, or as a diff when it looks
 * like one. Anything else — framework notifications about background tasks,
 * for instance — is "other" and gets a bare acknowledgement.
 */
export function parseMessage(text: string): ParsedMessage {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const raw = JSON.parse(trimmed) as { kind?: unknown; files?: unknown; judgments?: unknown; pr?: unknown };
      const files = readFiles(raw.files);
      if (raw.kind === "summarize" && files) {
        const judgments = raw.judgments && typeof raw.judgments === "object" ? (raw.judgments as Record<string, Answers>) : {};
        const pr = raw.pr && typeof raw.pr === "object" && typeof (raw.pr as { title?: unknown }).title === "string" ? (raw.pr as SummarizeInput["pr"]) : undefined;
        return { kind: "summarize", input: { ...clampReview({ files }), judgments, pr } };
      }
      if ((raw.kind === "judge" || raw.kind === undefined) && files) return { kind: "judge", input: clampReview({ files }) };
    } catch {
      /* not JSON: fall through */
    }
  }
  if (looksLikePatch(trimmed)) return { kind: "judge", input: clampReview({ files: filesFromPatch(trimmed) }) };
  if (looksLikeCode(trimmed)) return { kind: "judge", input: clampReview({ files: [{ path: "snippet", content: trimmed }] }) };
  return { kind: "other", text: trimmed };
}

function readFiles(raw: unknown): ReviewFile[] | null {
  if (!Array.isArray(raw)) return null;
  const files = raw
    .filter((f): f is { path: unknown; content: unknown; patch?: unknown } => !!f && typeof f === "object")
    .filter((f) => typeof f.path === "string" && typeof f.content === "string")
    .map((f) => ({ path: f.path as string, content: f.content as string, ...(f.patch === true ? { patch: true } : {}) }));
  // The page applies the same rule; this is the guard for any other caller.
  return partitionJudgeable(files).judgeable;
}

/** A rough tell for code versus prose, so a framework notification is not judged as a snippet. */
function looksLikeCode(text: string): boolean {
  if (/^(\[Task state\]|Background task)/.test(text)) return false;
  return /[{};=()]|^\s*(def |class |import |function |const |let |var |public |fn |func )/m.test(text);
}
