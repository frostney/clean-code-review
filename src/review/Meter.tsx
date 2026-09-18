import type { Question } from '@/agent/lib/judging/questions';
import type { Answer } from '@/agent/lib/judging/schema';

import { detail, headline, levelsOf } from './display';

/** A fill is a fraction, and CSS wants it as a percentage. */
const PERCENT = 100;

/** Jev's yes/no answers are odds; at even odds or better the answer is "yes". */
const EVEN_ODDS = 0.5;

/**
 * One bar, used by every question. Ink fill on a light track, nothing else —
 * no ticks, no dots, no chips, no colour scale. If a row needs to say more, it
 * says it in words.
 */
function Bar({ value }: { value: number }) {
  const width = Math.max(0, Math.min(1, value)) * PERCENT;
  return (
    <div className="h-2 w-full rounded-full bg-track">
      <div
        className="h-full rounded-full bg-ink"
        style={{ transition: 'width 300ms', width: `${width}%` }}
      />
    </div>
  );
}

/** A scale with no levels to place the answer on is drawn half full. */
const HALF_FULL = 0.5;

/** A flagged smell is loud, a cleared one is quiet, everything else is plain. */
function headlineClass(finding: boolean, quiet: boolean): string {
  if (quiet) {
    return 'text-muted';
  }
  return finding ? 'text-bad' : 'text-ink';
}

/**
 * How full the bar is. Each question type has one natural "how much": for a
 * yes/no it's the probability of yes, for a scale it's how far up the scale,
 * for a choice it's how much the winner won by.
 */
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
 * One question, one row.
 *
 * Wide enough, it is a single line — label, bar, answer — and the columns line
 * up down the group so its judgments read as a single scan. In a narrow column
 * squeezing three columns in clips exactly the two words that carry the
 * judgment ("Mixes abstracti…", "Self-d…"). Under 420px the row becomes two
 * lines instead: label and answer on the first, the full-width bar under them.
 * Neither the label nor the headline is ever cut; the "NN% sure" hint is what
 * gives way when the line is short, because it is the least of the three.
 *
 * Polarity is the point: every yes/no question is phrased so that **yes is a
 * finding**. A row Jev answers "yes" to keeps its dark bar and says so in the
 * danger colour; a "no" fades its bar and mutes its word. At a glance you see
 * what is wrong with the file — the dark rows — rather than thirty-odd
 * equally loud ones.
 *
 * The breakpoint is a container query on the group, not a viewport one: the
 * review sits under the code, one column of groups or two depending on how
 * wide the card is, and what a row can fit depends on its group's column.
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
      <span className="text-[13px] text-muted @[420px]/group:order-1">
        {meta.label}
      </span>
      <span
        className="flex min-w-0 items-baseline justify-end gap-1.5 @[420px]/group:order-3"
        data-value="true"
      >
        {changed && delta ? (
          <span className="truncate text-tiny text-muted">{delta}</span>
        ) : (
          <span className="truncate text-tiny text-muted/70">
            {detail(answer)}
          </span>
        )}
        <span
          className={`shrink-0 text-[13px] font-semibold ${headlineClass(finding, quiet)}`}
        >
          {headline(meta, answer)}
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
