"use client";

import { useEffect, useState } from "react";
import { DARK_QUERY, type Theme } from "./theme";

/** What `<html data-theme>` and the system between them currently mean. */
function currentTheme(): Theme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "dark" || chosen === "light") return chosen;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/**
 * The resolved theme, for the parts of the page CSS cannot colour — shiki's
 * tokens are inline `style` attributes, so the highlighter has to be told.
 *
 * It starts at "light" so that the first client render matches the server's,
 * and corrects itself in an effect; nothing tokenised is on screen that early,
 * because the highlighter is fetched in an effect too.
 *
 * Two sources are watched, because either can move under the page: the
 * attribute (the toggle, in this tab) and the media query (the system, while
 * this page is following it).
 */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    function sync() {
      setTheme(currentTheme());
    }
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia(DARK_QUERY);
    media.addEventListener("change", sync);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", sync);
    };
  }, []);

  return theme;
}
