'use client';

import { useEffect, useRef, useState } from 'react';

import type { Question } from '@/agent/lib/judging/questions';
import type { Answer, Answers } from '@/agent/lib/judging/schema';

import { deltaText, isMeaningful } from './display';

/** How long a row stays lit after a meaningful change. */
const HOLD_MS = 1800;

export interface Changes {
  changed: Record<string, true>;
  delta: Record<string, string>;
}

const NONE: Changes = { changed: {}, delta: {} };

/**
 * Watch the answers and light up the rows whose judgment actually moved. This
 * is the whole demo: without it, 16 bars twitch at once and the eye has nothing
 * to follow. Rows stay lit for HOLD_MS, so a change is visible even while the
 * next turn is already on the wire.
 */
export function useChanges(
  answers: Answers | null | undefined,
  meta: readonly Question[],
): Changes {
  const prev = useRef<Record<string, Answer>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [state, setState] = useState<Changes>(NONE);

  useEffect(() => {
    if (!answers) {
      return;
    }
    const changed: string[] = [];
    const delta: Record<string, string> = {};
    for (const m of meta) {
      const before = prev.current[m.id];
      const after = answers[m.id];
      if (!isMeaningful(before, after)) {
        continue;
      }
      changed.push(m.id);
      const text = deltaText(m, before, after);
      if (text) {
        delta[m.id] = text;
      }
    }
    prev.current = { ...answers };
    if (!changed.length) {
      return;
    }
    setState((s) => ({
      changed: {
        ...s.changed,
        ...Object.fromEntries(changed.map((id) => [id, true as const])),
      },
      delta: { ...s.delta, ...delta },
    }));
    // Deliberately not cleaned up on re-run: a row lit at t=0 must still be lit
    // when the next answer arrives and this effect runs again.
    for (const id of changed) {
      clearTimeout(timers.current[id]);
      timers.current[id] = setTimeout(() => {
        setState((s) => {
          const next = { ...s.changed };
          delete next[id];
          // The text goes with the light: a later flash with nothing to say
          // must not inherit the last thing this row said.
          const delta = { ...s.delta };
          delete delta[id];
          return { changed: next, delta };
        });
      }, HOLD_MS);
    }
  }, [answers, meta]);

  return state;
}
