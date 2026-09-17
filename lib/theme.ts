/**
 * Which paper the page is on, and who decided.
 *
 * No `"use client"` here on purpose, and no React: the layout is a server
 * component and needs the script string below as a string, not as a reference
 * into the browser bundle. The hook that watches all this lives next door in
 * `useTheme.ts`, which does carry the directive.
 *
 * Three choices, not two: "system" is a real answer — most people never touch
 * the control and want the page to follow the desk lamp — so the toggle cycles
 * through it rather than treating it as the absence of a choice.
 *
 * The choice lives in `localStorage` and on `<html data-theme>`; the palette in
 * `globals.css` reads the attribute, and the attribute is set before first
 * paint by `THEME_SCRIPT` below. "system" removes the attribute rather than
 * writing one, which is what hands the page back to `prefers-color-scheme`.
 */
export type ThemeChoice = "system" | "light" | "dark";

/** What the page is actually rendered in, once the choice has been resolved. */
export type Theme = "light" | "dark";

export const THEME_KEY = "clean-code-review:theme";

/** system → light → dark → system. */
export const THEME_ORDER: readonly ThemeChoice[] = ["system", "light", "dark"];

export function nextChoice(choice: ThemeChoice): ThemeChoice {
  return THEME_ORDER[(THEME_ORDER.indexOf(choice) + 1) % THEME_ORDER.length];
}

/** The media query the page follows when nobody has chosen. */
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The one line that runs before the page is painted.
 *
 * It is inlined into the document rather than shipped in a module because a
 * module arrives a network round trip after the first paint, and a page that
 * paints white and then turns black has already told the reader it forgot.
 * Storage can throw — Safari's private mode, a blocked third-party context —
 * and a page that will not render because it could not read a preference is a
 * worse failure than a page in the wrong colour, hence the catch.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;

/** The stored choice, or "system" when there is none or storage is closed. */
export function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") return stored;
  } catch {
    // A page that cannot remember still has to render.
  }
  return "system";
}

/** Write the choice down and put it on `<html>`, where the palette reads it. */
export function applyChoice(choice: ThemeChoice): void {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Remembering is a convenience; the page is already in the right colour.
  }
}
