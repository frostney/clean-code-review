"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { applyChoice, nextChoice, readChoice, type ThemeChoice } from "@/lib/theme";

/** One icon and one word per choice, so the button says what it is, not what it will do. */
const FACES: Record<ThemeChoice, { Icon: typeof Sun; label: string }> = {
  system: { Icon: Monitor, label: "System theme" },
  light: { Icon: Sun, label: "Light theme" },
  dark: { Icon: Moon, label: "Dark theme" },
};

/**
 * The paper the page is on: system, light, dark, and round again.
 *
 * It renders "system" on the server and on the first client render, which is
 * the only state that cannot be wrong at that point — the stored choice is
 * already on `<html>` by then (the inline script in the layout put it there),
 * so the page is in the right colour while this button catches up in an
 * effect. That is why the button reads the choice rather than owning it.
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    setChoice(readChoice());
  }, []);

  const { Icon, label } = FACES[choice];

  return (
    <button
      type="button"
      data-theme-toggle={choice}
      title={`${label} — click to change`}
      aria-label={`${label}. Change the theme.`}
      onClick={() => {
        // The step is taken from what is written down, not from what this
        // component last rendered: two clicks inside one task — a stuck key, a
        // test driving the button — would otherwise both step off the same
        // stale value and the cycle would lose a position.
        const next = nextChoice(readChoice());
        applyChoice(next);
        setChoice(next);
      }}
      className="-my-1 inline-flex min-h-10 min-w-10 cursor-pointer items-center justify-center gap-1.5 rounded-md text-muted hover:text-ink lg:my-0 lg:min-h-8 lg:min-w-8"
    >
      <Icon size={14} aria-hidden="true" />
    </button>
  );
}
