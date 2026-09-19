import type { Question } from '@/agent/lib/judging/questions';
import type { Answer } from '@/agent/lib/judging/schema';

import { answerDetail, answerHeadline, levelsOf } from './display';

const PERCENT = 100;

/** A yes/no probability at or above this reads as "yes". */
const EVEN_ODDS = 0.5;

// Deliberately plain: no ticks or colour scale; a row says more in words.
function Bar({ value }: { value: number }) {
  const width = Math.max(0, Math.min(1, value)) * PERCENT;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-track">
      <div
        className="h-full rounded-full bg-ink motion-safe:transition-transform motion-safe:duration-300"
        style={{ transform: `translateX(${width - PERCENT}%)` }}
      />
    </div>
  );
}

/** For a scale without levels. */
const HALF_FULL = 0.5;

function headlineClass(finding: boolean, quiet: boolean): string {
  if (quiet) {
    return 'text-muted';
  }
  return finding ? 'text-bad' : 'text-ink';
}

/** yes/no: P(yes); score: position on the scale; choice: the chosen option's probability. */
function fill(meta: Question, answer: Answer | undefined): number {
  if (!answer) {
    return 0;
  }
  if (answer.type === 'noul') {
    return answer.noul;
  }
  if (answer.type === 'choice') {
    return answer.probabilities[answer.choice] ?? 0;
  }
  const levels = levelsOf(meta);
  return levels.length > 1 ? answer.score / (levels.length - 1) : HALF_FULL;
}

/**
 * Below 420px of group width the row splits into two lines, because three
 * columns would clip the label and headline. Those are never cut; the
 * "NN% sure" detail truncates first. A container query, because a group's
 * column width depends on the card, not the viewport.
 *
 * Every yes/no question is phrased so yes is a finding: "yes" rows stay dark
 * and red, "no" rows fade, so what is wrong stands out.
 */
export function Meter({
  meta,
  answer,
  changed,
  delta,
}: {
  meta: Question;
  answer: Answer | undefined;
  changed?: boolean;
  delta?: string;
}) {
  const finding =
    meta.type === 'noul' && answer?.type === 'noul' && answer.noul >= EVEN_ODDS;
  const quiet =
    meta.type === 'noul' && answer?.type === 'noul' && answer.noul < EVEN_ODDS;
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded px-1.5 py-1 @[420px]/group:grid-cols-[11rem_minmax(0,1fr)_10rem] ${
        changed ? 'row-flash' : ''
      }`}
      data-changed={changed ? '1' : undefined}
      data-finding={finding ? '1' : undefined}
      data-q={meta.id}
      data-type={meta.type}
    >
      <span className="text-sm text-muted @[420px]/group:order-1">
        {meta.label}
      </span>
      <span
        className="flex min-w-0 items-baseline justify-end gap-1.5 @[420px]/group:order-3"
        data-value="true"
      >
        {changed && delta ? (
          <span className="truncate text-xs text-muted">{delta}</span>
        ) : (
          <span className="truncate text-xs text-subtle">
            {answerDetail(answer)}
          </span>
        )}
        <span
          className={`shrink-0 text-sm font-semibold ${headlineClass(finding, quiet)}`}
        >
          {answerHeadline(meta, answer)}
        </span>
      </span>
      <div
        className="col-span-2 @[420px]/group:order-2 @[420px]/group:col-span-1"
        data-track="true"
        style={quiet ? { opacity: 0.35 } : undefined}
      >
        <Bar value={fill(meta, answer)} />
      </div>
    </div>
  );
}
