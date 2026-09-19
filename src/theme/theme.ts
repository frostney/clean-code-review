/**
 * No `"use client"` and no React: the server layout needs `THEME_SCRIPT` as a
 * string. "system" removes `data-theme`, handing the page back to
 * `prefers-color-scheme`.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'clean-code-review:theme';

/** system → light → dark → system. */
const THEME_ORDER: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export function nextChoice(choice: ThemeChoice): ThemeChoice {
  return THEME_ORDER[(THEME_ORDER.indexOf(choice) + 1) % THEME_ORDER.length];
}

export const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Inlined so it runs before first paint (a module would flash the wrong theme).
 * Storage can throw (Safari private mode, blocked contexts): wrong colour beats
 * no render.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;

export function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light' || stored === 'system') {
      return stored;
    }
  } catch {
    // Storage unavailable: fall back to system.
  }
  return 'system';
}

export function applyChoice(choice: ThemeChoice): void {
  if (choice === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = choice;
  }
  try {
    if (choice === 'system') {
      localStorage.removeItem(THEME_KEY);
    } else {
      localStorage.setItem(THEME_KEY, choice);
    }
  } catch {
    // Storage unavailable: the page is already in the right colour.
  }
}
