'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

import { applyChoice, nextChoice, readChoice, type ThemeChoice } from './theme';

/** Labels name the current state, not the next one. */
const FACES: Record<ThemeChoice, { Icon: typeof Sun; label: string }> = {
  dark: { Icon: Moon, label: 'Dark theme' },
  light: { Icon: Sun, label: 'Light theme' },
  system: { Icon: Monitor, label: 'System theme' },
};

/**
 * Renders "system" on the server and first client render (the only state that
 * cannot mismatch); the inline script has already themed `<html>`, and the
 * stored choice is read in an effect.
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>('system');

  useEffect(() => {
    setChoice(readChoice());
  }, []);

  const { Icon, label } = FACES[choice];

  return (
    <button
      aria-label={`${label}. Change the theme.`}
      className="inline-flex min-h-10 min-w-10 cursor-pointer items-center justify-center gap-1.5 rounded-md text-muted hover:text-ink lg:min-h-8 lg:min-w-8"
      data-theme-toggle={choice}
      onClick={() => {
        // From storage, not state: two clicks in one task would otherwise step
        // off the same stale value.
        const next = nextChoice(readChoice());

        applyChoice(next);
        setChoice(next);
      }}
      title={`${label} — click to change`}
      type="button"
    >
      <Icon aria-hidden="true" size={14} />
    </button>
  );
}
