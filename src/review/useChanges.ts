'use client';

import { useEffect, useRef, useState } from 'react';

import type { Question } from '@/agent/lib/judging/questions';
import type { Answer, Answers } from '@/agent/lib/judging/schema';

import { deltaText, isMeaningfulChange } from './display';

const ROW_LIT_MS = 1800;

export interface Changes {
  changed: Record<string, true>;
  delta: Record<string, string>;
}

const NONE: Changes = { changed: {}, delta: {} };

/**
 * Lights only rows whose judgment meaningfully moved; otherwise every bar
 * twitches at once and the eye has nothing to follow.
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

      if (!isMeaningfulChange(before, after)) {
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
    // Not cleared on re-run: a lit row must stay lit when the next answer arrives.
    for (const id of changed) {
      clearTimeout(timers.current[id]);
      timers.current[id] = setTimeout(() => {
        setState((s) => {
          const next = { ...s.changed };

          delete next[id];
          // A later flash with no delta must not inherit this one's text.
          const delta = { ...s.delta };

          delete delta[id];

          return { changed: next, delta };
        });
      }, ROW_LIT_MS);
    }
  }, [answers, meta]);

  return state;
}
