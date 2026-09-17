/**
 * The reviewer: Luna writes the prose half of the review from Jev's findings.
 *
 * A review is split into parts — batches of files, plus one overall part with
 * the decision — and every part is one model call, all started at once
 * through the AI Gateway. The parts are streamed back to the caller in a
 * fixed order (overall first, then the batches), so the combined text is
 * always a well-formed review even while it is still arriving: a part that
 * finished early simply flushes when its turn comes. Each part is cached for
 * an hour on its own.
 */
import { streamText } from "ai";
import { cacheGet, cacheKey, cacheSet } from "./cache";
import type { SummarizeInput } from "./prompt";
import { questionById, SMELL_IDS } from "./questions";
import { REVIEWER_INSTRUCTIONS } from "./reviewer-prompt";
import { parseSummaryText, REVIEW_BATCH_SIZE, REVIEWER_MODEL, type ReviewPart } from "./summary";

/** Bump when the reviewer's instructions change, so cached parts expire. */
const REVIEW_VERSION = 10;

/** How much of a file a file part is shown; the findings carry the rest. */
const FILE_EXCERPT_CHARS = 8_000;

/** What the reviewer is told: Jev's findings per file, in words, and nothing else. */
function reviewerMessage(input: SummarizeInput, mode: ReviewPart["role"]): string {
  const files = input.files.map((file) => {
    const answers = input.judgments[file.path] ?? {};
    const findings = SMELL_IDS.filter((id) => answers[id]?.type === "noul" && (answers[id] as { noul: number }).noul >= 0.5)
      .map((id) => ({ smell: questionById(id)?.label ?? id, probability: (answers[id] as { noul: number }).noul }))
      .sort((a, b) => b.probability - a.probability);
    const scales = Object.fromEntries(
      Object.entries(answers)
        .filter(([, a]) => a.type === "score")
        .map(([id, a]) => {
          const q = questionById(id);
          const sc = (a as { score: number }).score;
          return [q?.label ?? id, q?.type === "score" ? q.levels[Math.max(0, Math.min(4, Math.round(sc)))] : sc];
        }),
    );
    if (mode === "overall") return { path: file.path, kind: file.patch ? "diff" : "file", findings: findings.slice(0, 5), scales };
    // A file part reads the file first, then applies the judge's findings to it.
    const code = file.content.length > FILE_EXCERPT_CHARS ? `${file.content.slice(0, FILE_EXCERPT_CHARS)}\n… (truncated)` : file.content;
    return { path: file.path, kind: file.patch ? "diff" : "file", code, findings, scales };
  });
  return JSON.stringify({ mode, ...(mode === "overall" && input.pr ? { title: input.pr.title, body: input.pr.body?.slice(0, 2_000) } : {}), files });
}

export interface PlannedPart {
  part: ReviewPart;
  message: string;
  key: string;
}

/** Overall first, then batches of files, in order. */
export function planParts(input: SummarizeInput): PlannedPart[] {
  const parts: PlannedPart[] = [];
  const overall = { role: "overall" as const, index: 0, paths: input.files.map((f) => f.path) };
  const overallMessage = reviewerMessage(input, "overall");
  parts.push({ part: overall, message: overallMessage, key: cacheKey("review-part", { v: REVIEW_VERSION, model: REVIEWER_MODEL, message: overallMessage }) });
  for (let i = 0; i * REVIEW_BATCH_SIZE < input.files.length; i++) {
    const files = input.files.slice(i * REVIEW_BATCH_SIZE, (i + 1) * REVIEW_BATCH_SIZE);
    const message = reviewerMessage({ ...input, files }, "files");
    parts.push({ part: { role: "files", index: i, paths: files.map((f) => f.path) }, message, key: cacheKey("review-part", { v: REVIEW_VERSION, model: REVIEWER_MODEL, message }) });
  }
  return parts;
}

export interface ReviewUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** True when every part came from the cache. */
  cached: boolean;
}

/**
 * Run the review. `emit` receives text in order; the returned promise settles
 * with the full text and the usage once every part is done.
 */
export async function runReview(input: SummarizeInput, emit: (delta: string) => void, signal?: AbortSignal): Promise<{ text: string; usage: ReviewUsage }> {
  const planned = planParts(input);
  const usage: ReviewUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, cached: true };

  // Start every uncached part now; each one buffers until it is its turn to stream.
  const runs = await Promise.all(
    planned.map(async (p) => {
      const hit = await cacheGet<string>(p.key);
      if (hit) return { kind: "hit" as const, p, text: hit };
      usage.cached = false;
      const buffer: string[] = [];
      const sink: { listener: ((delta: string) => void) | null } = { listener: null };
      const stream = streamText({
        model: REVIEWER_MODEL,
        system: REVIEWER_INSTRUCTIONS,
        prompt: p.message,
        abortSignal: signal,
      });
      const done = (async () => {
        for await (const delta of stream.textStream) {
          if (sink.listener) sink.listener(delta);
          else buffer.push(delta);
        }
        const u = await stream.usage;
        const meta = await stream.providerMetadata;
        usage.inputTokens += u?.inputTokens ?? 0;
        usage.outputTokens += u?.outputTokens ?? 0;
        usage.costUsd += Number((meta?.gateway as { cost?: string } | undefined)?.cost ?? 0);
      })();
      return {
        kind: "run" as const,
        p,
        attach(fn: (delta: string) => void) {
          for (const d of buffer.splice(0)) fn(d);
          sink.listener = fn;
        },
        done,
      };
    }),
  );

  const chunks: string[] = [];
  for (const run of runs) {
    const write = (delta: string) => {
      chunks.push(delta);
      emit(delta);
    };
    if (run.kind === "hit") {
      write(ensureTrailingNewline(run.text));
      continue;
    }
    run.attach(write);
    await run.done;
    write("\n");
    const text = chunks.join("");
    // Cache this part on its own: its text is everything written since it started.
    const own = partText(text, run.p.part);
    if (own) await cacheSet(run.p.key, own, "luna-review-part");
  }
  return { text: chunks.join(""), usage };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

/** The slice of the combined text that belongs to one part, re-serialised. */
function partText(all: string, part: ReviewPart): string | null {
  const parsed = parseSummaryText(all);
  if (part.role === "overall") return parsed.overall ? `Decision: ${parsed.decision}\n## Overall\n${parsed.overall}\n` : null;
  const sections = parsed.files.filter((f) => part.paths.includes(f.path));
  if (!sections.length) return null;
  return sections.map((f) => `## ${f.path}\n${f.summary}\n`).join("");
}
